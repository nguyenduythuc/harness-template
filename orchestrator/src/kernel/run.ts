// One run of a task with a fixed harness: the workspace, the workspace setup, the executor session,
// the gate and the run record. The kernel runs H as it is. The improvement loop (loop/pipeline.ts)
// uses the same parts and adds the editors, the probes and the composer.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import type { GateResult, ShellRunner } from "./gate.js";
import { runGate, summary } from "./gate.js";
import type { HTree } from "./htree.js";
import { inventory, readHFromGit, treeHash, unsafeH } from "./htree.js";
import type { RunPaths } from "./paths.js";
import { newRunId, runPaths, sessionDirs } from "./paths.js";
import type { RunRecord } from "./runs.js";
import { addUsage, emptyUsage, RunLog, totalTokens } from "./runs.js";
import { protectedPathsIn, SessionRunner } from "./runner.js";
import type { QueryFn, SessionOutcome } from "./session.js";
import type { NormalTrace } from "./trace.js";
import { componentsUsed, readTrace } from "./trace.js";
import { git, runShell } from "../util/exec.js";
import { deliverableDiff, evalWorkspace, productionWorkspace, runWorkspaceSetup } from "./workspace.js";
import type { Overlay } from "./workspace.js";

export interface TaskInput {
  id: string;
  taskMd: string;
  taskType: string | null;
  mode: "production" | "eval";
  split: "dev" | "holdout" | null;
  /** Eval: the commit that the task starts from. Production: null (the task starts from H0). */
  baseSha: string | null;
  force: "improve" | "no-improve" | null;
  /** Eval baseline arm: run H0 only, with no improvement loop. */
  frozen?: boolean;
  /** Eval: an H tree to run instead of H0 (for example H0′ in decision 5). */
  hOverride?: HTree;
  /** Eval: run the loop with an empty library (the "E1 without library" arm of the Phase 3 gate). */
  noLibrary?: boolean;
}

/** What one executor run shows to the R roles: its trace and its deliverable diff. */
export interface RunView {
  trace: NormalTrace;
  diff: string;
  title: string;
}

/** A candidate harness of the improvement loop and its probe run. */
export interface CandidateView {
  id: string;
  h: HTree;
  diff: string;
  notes: string;
  run: RunView | null;
}

export interface TaskResult {
  record: RunRecord;
  runner: SessionRunner;
  /** The workspace that holds the deliverable that went forward, or null. */
  workspace: string | null;
  baseRef: string | null;
  diff: string;
  h0: HTree;
  composed: HTree | null;
  candidates: CandidateView[];
  xi: string;
  reference: RunView | null;
  /**
   * The gate result of `workspace`, so that eval scoring does not run the gate a second time on the
   * same folder (37–44 seconds per run on the trial monorepo, T3). Null when no gate ran.
   */
  gate: GateResult | null;
}

export interface Deps {
  queryFn?: QueryFn;
  shell?: ShellRunner;
  /**
   * Called after the run record is written, before the run_end event. The CLI uses it to write the
   * episode to the lesson store (extras). The kernel does not know what the hook does.
   */
  onRunEnd?: (a: { ctx: Ctx; task: TaskInput; result: TaskResult; hRun: HTree; log: RunLog; scratch: string }) => Promise<void>;
}

export function claudeBlock(ctx: Ctx): string {
  return fs.readFileSync(path.join(ctx.tp.pluginDir, "templates", "claude-md-block.md"), "utf8");
}

export function pinnedGuardrails(ctx: Ctx): string {
  try {
    return git(["show", `${ctx.h0Sha}:harness/pinned-guardrails.md`], ctx.pp.projectDir);
  } catch {
    return "(no pinned guardrails)\n";
  }
}

const EXECUTOR_PROMPT_SUFFIX = "\n\n---\nDo the task above in this repository. When you finish, write a short summary of the change.";

export interface ExecResult {
  out: SessionOutcome | null;
  ws: { dir: string; base: string };
  view: RunView;
}

/** The state of one task run. The kernel uses it for a frozen run; the loop uses it for every step. */
export class TaskRun {
  readonly runId: string;
  readonly rp: RunPaths;
  readonly log: RunLog;
  readonly runner: SessionRunner;
  readonly notes: string[];
  readonly h0: HTree;
  readonly hRun: HTree;
  readonly overlay: Overlay;
  readonly rec: RunRecord;
  readonly result: TaskResult;
  ref: ExecResult | null = null;

  constructor(
    readonly ctx: Ctx,
    readonly task: TaskInput,
    readonly deps: Deps = {},
  ) {
    this.runId = newRunId(task.id);
    this.rp = runPaths(ctx.pp, ctx.user.work_root, this.runId);
    this.log = new RunLog(this.rp);
    this.runner = new SessionRunner(ctx, this.rp, this.log, SessionRunner.budgetFor(ctx), task.mode, deps.queryFn);
    const started = new Date().toISOString();
    this.notes = [...ctx.notes];
    this.h0 = readHFromGit(ctx.pp.projectDir, ctx.h0Sha);
    this.hRun = task.hOverride ?? this.h0;
    // Hooks, MCP servers and inline shell in H run outside the guard. Refuse them, also in a human H0.
    const unsafe = unsafeH(this.hRun);
    if (unsafe.length) throw new Error("The harness of this run can run code outside the guard. Move the hook or the command to the pinned layer:\n" + unsafe.map((p) => "  - " + p).join("\n"));
    if (task.mode === "eval" && !task.baseSha) throw new Error("an eval task needs base_sha");
    this.overlay = { pinnedGuardrails: pinnedGuardrails(ctx), claudeBlock: claudeBlock(ctx) };
    this.log.event("run_start", { task: task.id, mode: task.mode, split: task.split, h0_sha: ctx.h0Sha });
    this.rec = {
      run_id: this.runId,
      task_id: task.id,
      task_type: task.taskType,
      mode: task.mode,
      split: task.split,
      started_at: started,
      ended_at: started,
      phase: ctx.config.phase,
      fingerprint: {
        claude_code_version: ctx.runtime.claude_code_version,
        models: ctx.config.models,
        h0_sha: ctx.h0Sha,
        h0_tree_hash: treeHash(this.h0),
        plugin: ctx.runtime.plugin,
        orchestrator: ctx.runtime.orchestrator,
        base_sha: task.baseSha,
        instruction_hashes: {},
        eval_image: process.env.HARNESS_EVAL_IMAGE ?? null,
      },
      sessions: [],
      totals: { costUsd: 0, tokens: 0, usage: emptyUsage() },
      budget_stop: false,
      decision1: null,
      reference: null,
      candidates: [],
      composed_tree_hash: null,
      gate: { composed: null, reference: null },
      outcome: "none",
      reuse_event: false,
      reuse_entries: [],
      notes: this.notes,
    };
    this.result = { record: this.rec, runner: this.runner, workspace: null, baseRef: null, diff: "", h0: this.h0, composed: null, candidates: [], xi: "", reference: null, gate: null };
  }

  private makeWs(label: string, h: HTree): { dir: string; base: string } {
    const dir = sessionDirs(this.rp, label).workspace;
    if (this.task.mode === "production") return { dir, base: productionWorkspace(this.ctx.pp.projectDir, this.ctx.h0Sha, dir, h === this.h0 ? null : h) };
    return { dir, base: evalWorkspace(this.ctx.pp.projectDir, this.task.baseSha as string, dir, h, this.overlay) };
  }

  // A workspace is a fresh checkout: it has no node_modules. The setup commands of the project install
  // them before the session (C31). They run with the rights of the user, like the gate.
  private async setupWs(label: string, dir: string): Promise<string | null> {
    const ws = this.ctx.config.workspace_setup;
    const r = await runWorkspaceSetup(ws.commands, dir, this.ctx.pp.projectDir, ws.timeout_s, this.deps.shell ?? runShell, label);
    for (const s of r.steps) this.log.event("workspace_setup", { label, command: s.command, code: s.code, duration_ms: s.durationMs });
    return r.error;
  }

  /** One executor session with harness `h` in a new workspace. */
  async execRun(label: string, h: HTree, concurrent = 1): Promise<ExecResult> {
    const ws = this.makeWs(label, h);
    const setupError = await this.setupWs(label, ws.dir);
    if (setupError) {
      this.notes.push(setupError);
      return { out: null, ws, view: { trace: readTrace(""), diff: "", title: label } };
    }
    const out = await this.runner.run({
      role: "executor",
      label,
      cwd: ws.dir,
      prompt: this.task.taskMd + EXECUTOR_PROMPT_SUFFIX,
      writeRoots: [ws.dir],
      protectAbs: [this.ctx.pp.runsDir],
      sandboxDenyWrite: protectedPathsIn(ws.dir, this.ctx.config.loop_owned),
      concurrent,
    });
    const view: RunView = { trace: out ? readTrace(out.tracePath) : readTrace(""), diff: out ? deliverableDiff(ws.dir, ws.base) : "", title: label };
    // Which skills, subagents and scripts of H this session used: the data to find dead weight in H.
    const available = inventory(h);
    (this.rec.components ??= {})[label] = { available, used: componentsUsed(view.trace, available) };
    // Keep each deliverable diff in the run record, so that Reflect can run after the workspace is gone.
    fs.writeFileSync(path.join(this.rp.recordDir, `${label}.diff`), view.diff);
    return { out, ws, view };
  }

  /** The reference run: harness hRun, before any improvement. */
  async runReference(): Promise<ExecResult> {
    const ref = await this.execRun("reference", this.hRun);
    this.ref = ref;
    this.rec.reference = { steps: ref.view.trace.toolCalls.filter((c) => !c.parent).length, tokens: ref.out ? totalTokens(ref.out.usage) : 0 };
    this.result.reference = ref.view;
    return ref;
  }

  /** True when the reference session did not start or failed its init check. Adds a note. */
  referenceBroken(): boolean {
    const out = this.ref?.out;
    if (out && out.status !== "aborted_spec") return false;
    this.notes.push(`The reference session did not run correctly: ${out ? out.errors.join("; ") : "no budget"}.`);
    return true;
  }

  /**
   * Gate the deliverable (composed first, reference as the fallback), write the run record, and call
   * the run-end hook. `gateRef` is false when the reference session did not run.
   */
  async finish(gateRef: boolean, composedWs: { dir: string; base: string } | null): Promise<TaskResult> {
    const { ctx, rec, result, ref } = this;
    let composedGate: GateResult | null = null;
    let refGate: GateResult | null = null;
    if (composedWs) {
      composedGate = await runGate(composedWs.dir, ctx.config.gate, this.deps.shell);
      rec.gate.composed = summary(composedGate);
    }
    if (composedGate?.pass && composedWs) {
      rec.outcome = "composed";
      result.workspace = composedWs.dir;
      result.baseRef = composedWs.base;
      result.diff = deliverableDiff(composedWs.dir, composedWs.base);
      result.gate = composedGate;
    } else if (gateRef && ref?.out) {
      const g = await runGate(ref.ws.dir, ctx.config.gate, this.deps.shell);
      refGate = g;
      rec.gate.reference = summary(g);
      if (g.pass) {
        rec.outcome = "reference";
        result.workspace = ref.ws.dir;
        result.baseRef = ref.ws.base;
        result.diff = ref.view.diff;
        result.gate = g;
      } else {
        this.notes.push("Both the composed and the reference deliverable failed the gate. No PR. The two traces are in the run record.");
      }
    }
    if (this.task.mode === "eval" && rec.outcome === "none") {
      // Eval scores every deliverable: a failed gate gives a score of 0, not a missing score.
      const ws = composedWs ?? (ref?.out ? ref.ws : null);
      if (ws) {
        result.workspace = ws.dir;
        result.baseRef = ws.base;
        result.diff = deliverableDiff(ws.dir, ws.base);
        result.gate = composedWs ? composedGate : refGate;
      }
    }
    rec.sessions = this.runner.sessions;
    rec.totals.costUsd = this.runner.sessions.reduce((a, s) => a + s.costUsd, 0);
    rec.totals.usage = this.runner.sessions.reduce((a, s) => addUsage(a, s.usage), emptyUsage());
    rec.totals.tokens = totalTokens(rec.totals.usage);
    rec.budget_stop = this.runner.budgetStop;
    rec.fingerprint.instruction_hashes = this.runner.instructionHashes;
    rec.ended_at = new Date().toISOString();
    this.log.writeRecord(rec);
    if (this.deps.onRunEnd) {
      await this.deps.onRunEnd({ ctx, task: this.task, result, hRun: this.hRun, log: this.log, scratch: path.join(this.rp.workDir, "scratch", "episode") });
    }
    this.log.event("run_end", { outcome: rec.outcome, budget_stop: rec.budget_stop });
    return result;
  }
}

/** Run H as it is: the reference run and the gate, with no improvement loop. */
export async function runFrozen(ctx: Ctx, task: TaskInput, deps: Deps = {}): Promise<TaskResult> {
  const r = new TaskRun(ctx, { ...task, frozen: true }, deps);
  await r.runReference();
  if (r.referenceBroken()) return r.finish(false, null);
  return r.finish(true, null);
}
