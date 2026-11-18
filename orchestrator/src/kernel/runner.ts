// SessionRunner: builds, runs and records every session of one run, inside one task budget.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import { Budget } from "./budget.js";
import type { RunPaths } from "./paths.js";
import { sessionDirs } from "./paths.js";
import type { Role } from "./roles.js";
import { buildSession, defaultReadDeny } from "./roles.js";
import type { RunLog, SessionRecord } from "./runs.js";
import type { QueryFn, SessionOutcome } from "./session.js";
import { runSession, toRecord } from "./session.js";
import { readJsonl } from "../util/fs.js";
import { classifyPath } from "./ownership.js";

export interface RunOpts {
  role: Role;
  label: string;
  cwd: string;
  prompt: string;
  writeRoots: string[];
  protectAbs?: string[];
  sandboxDenyWrite?: string[];
  /** Number of sessions that start at the same time and share the remaining budget. */
  concurrent?: number;
  /** Retry once after a crash or an error result (never after a budget stop). Default true. */
  retry?: boolean;
  outputSchema?: Record<string, unknown>;
}

export class SessionRunner {
  readonly sessions: SessionRecord[] = [];
  readonly instructionHashes: Record<string, string> = {};
  budgetStop = false;

  constructor(
    readonly ctx: Ctx,
    readonly rp: RunPaths,
    readonly log: RunLog,
    readonly budget: Budget,
    readonly mode: "production" | "eval",
    readonly queryFn?: QueryFn,
  ) {}

  static budgetFor(ctx: Ctx): Budget {
    return new Budget(ctx.config.budget.usd, ctx.config.budget.tokens, ctx.config.budget.headroom_usd);
  }

  /** Paths that no agent session reads: the eval store, the lesson store, the run records of the project, transcripts. */
  readDeny(): string[] {
    return [
      ...(this.ctx.user.eval_store ? [this.ctx.user.eval_store] : []),
      ...(this.ctx.lessonStore ? [this.ctx.lessonStore.path] : []),
      this.ctx.pp.runsDir,
      ...defaultReadDeny(),
    ];
  }

  /** Run one session. Returns null when the budget cannot start it. */
  async run(o: RunOpts): Promise<SessionOutcome | null> {
    if (this.budget.exhausted()) {
      this.budgetStop = true;
      this.log.event("budget_skip", { label: o.label, role: o.role });
      return null;
    }
    const cap = this.budget.allocate(o.concurrent ?? 1);
    let out = await this.once(o, o.label, cap);
    if (out.status === "error" && o.retry !== false && !this.budget.exhausted()) {
      this.log.event("session_retry", { label: o.label, errors: out.errors });
      out = await this.once(o, `${o.label}-retry`, Math.min(cap, this.budget.allocate(1)));
    }
    if (out.status === "budget_stop") this.budgetStop = true;
    return out;
  }

  private async once(o: RunOpts, label: string, capUsd: number): Promise<SessionOutcome> {
    const dirs = sessionDirs(this.rp, label);
    const spec = buildSession({
      role: o.role,
      label,
      cwd: o.cwd,
      config: this.ctx.config,
      template: this.ctx.tp,
      configDir: dirs.configDir,
      logsDir: this.rp.logsDir,
      policiesDir: this.rp.policiesDir,
      mode: this.mode,
      writeRoots: o.writeRoots,
      readDeny: this.readDeny(),
      maxBudgetUsd: capUsd,
      claudeCodeMin: this.ctx.lock.claude_code_min,
      passEnv: this.ctx.user.pass_env,
      ...(o.protectAbs ? { protectAbs: o.protectAbs } : {}),
      ...(o.sandboxDenyWrite ? { sandboxDenyWrite: o.sandboxDenyWrite } : {}),
      ...(o.outputSchema ? { outputSchema: o.outputSchema } : {}),
    });
    this.log.event("session_start", { label, role: o.role, cap_usd: capUsd });
    const out = await runSession({
      spec,
      prompt: o.prompt,
      tracePath: this.log.tracePath(label),
      timeoutMs: this.ctx.config.session.timeout_s * 1000,
      ...(this.queryFn ? { queryFn: this.queryFn } : {}),
    });
    this.budget.record(out.costUsd, out.usage);
    this.sessions.push(toRecord(out));
    for (const row of readJsonl<{ file?: string; sha256?: string | null }>(spec.instructionsLog)) {
      if (row.file && row.sha256) this.instructionHashes[row.file] = row.sha256;
    }
    this.log.event("session_end", { label, role: o.role, status: out.status, cost_usd: out.costUsd, turns: out.numTurns, errors: out.errors });
    return out;
  }
}

/**
 * Concrete absolute paths in a workspace that the executor sandbox must not write. The Linux and
 * WSL2 sandbox skips entries with wildcards, so the orchestrator expands every rule here (B11).
 */
export function protectedPathsIn(workspace: string, loopOwned: string[]): string[] {
  const out = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      const cls = classifyPath(r, loopOwned);
      if (cls !== "task") {
        out.add(abs);
        if (ent.isDirectory() && cls !== "loop-owned") continue;
      }
      if (ent.isDirectory()) walk(abs, r);
    }
  };
  walk(workspace, "");
  // Files that do not exist yet but must never appear.
  for (const rel of [".claude/settings.local.json", ".mcp.json", "CLAUDE.local.md"]) out.add(path.join(workspace, rel));
  return [...out].sort();
}
