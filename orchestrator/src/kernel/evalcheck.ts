// harness eval-check: check the ruler before a measurement uses tokens (C33). No agent session runs.
// For each eval task:
//   1. Make the eval workspace at base_sha with H0, and run workspace_setup.
//   2. Run the gate at base. A command that fails at base fails in every run, for every arm.
//   3. Run the hidden tests at base. A pass rate of 1 at base means that they do not measure the task.
//   4. Copy tasks/<id>/solution/ (a correct deliverable: files at their repo paths) over the workspace.
//      Run the gate and the hidden tests again. The solution must pass the gate and every hidden test.
//      (The folder is not called "reference": a reference run is the first run of a task.)
// Found live: a wrong hidden test command (L-tests) and a wrong Node in the gate shell (R7) gave 0 for
// every deliverable. Both show here in minutes, without tokens.
// The report goes to the eval store only (<eval_store>/checks/). It holds pass rates.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import type { EvalTask } from "./evalstore.js";
import { listTaskIds, loadTask } from "./evalstore.js";
import type { GateResult, ShellRunner } from "./gate.js";
import { runGate } from "./gate.js";
import { readHFromGit } from "./htree.js";
import { claudeBlock, pinnedGuardrails } from "./run.js";
import { hiddenTestRate } from "./scoring.js";
import { runShell } from "../util/exec.js";
import { ensureDir, readJson, removeDir, writeJson } from "../util/fs.js";
import { evalWorkspace, runWorkspaceSetup } from "./workspace.js";

export type CheckLevel = "OK" | "WARN" | "FAIL";

export interface TaskCheck {
  task: string;
  level: CheckLevel;
  lines: string[];
  seconds: number;
}

export interface EvalCheckReport {
  kind: "eval_check";
  at: string;
  h0_sha: string;
  ok: boolean;
  tasks: TaskCheck[];
}

const secs = (ms: number): string => (ms / 1000).toFixed(1);
const rate = (r: number | null): string => (r === null ? "none" : r.toFixed(2));
/**
 * The lines of a command output that say what went wrong: error lines first, else the last lines.
 * Found live (R7): the last lines of a vitest startup error are stack frames, and the cause is above them.
 */
export function keyLines(s: string | null | undefined, n = 3): string {
  const lines = (s ?? "")
    // Test runners color their output. Remove the ANSI color codes, so that the line reads as text.
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const errors = lines.filter((l) => /error|cannot|not found|not ok|unsupported/i.test(l) && !/^at /.test(l));
  return (errors.length ? errors.slice(-n) : lines.slice(-n)).join(" | ").slice(0, 400);
}

/** Remove the hidden tests and their report from a workspace, so that the next gate does not run them. */
function removeHidden(ws: string, task: EvalTask): void {
  const ht = task.meta.hidden_tests;
  if (!ht) return;
  removeDir(path.join(ws, ht.copy_to));
  if (ht.report_file) fs.rmSync(path.join(ws, ht.report_file), { force: true });
}

async function checkTask(ctx: Ctx, store: string, id: string, ws: string, shell: ShellRunner): Promise<TaskCheck> {
  const start = Date.now();
  const lines: string[] = [];
  let level: CheckLevel = "OK";
  const ok = (s: string): void => void lines.push(`OK   ${s}`);
  const warn = (s: string): void => {
    lines.push(`WARN ${s}`);
    if (level === "OK") level = "WARN";
  };
  const fail = (s: string): void => {
    lines.push(`FAIL ${s}`);
    level = "FAIL";
  };
  const done = (): TaskCheck => ({ task: id, level, lines, seconds: Math.round((Date.now() - start) / 100) / 10 });
  const gateLines = (g: GateResult, where: "base" | "solution"): void => {
    for (const c of g.commands) {
      const text = `${where}: ${c.key} ${c.code === 0 ? "passes" : `fails (exit ${c.code})`}, ${secs(c.durationMs)} s`;
      if (c.code === 0) ok(text);
      else if (where === "base") warn(`${text}. Every run starts with this failure. Last output: ${keyLines(g.tails[c.key])}`);
      else fail(`${text}. A correct deliverable must pass the gate. Last output: ${keyLines(g.tails[c.key])}`);
    }
  };

  let task: EvalTask;
  try {
    task = loadTask(store, id);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return done();
  }
  const timeoutMs = ctx.config.gate.timeout_s * 1000;
  try {
    const h0 = readHFromGit(ctx.pp.projectDir, ctx.h0Sha);
    evalWorkspace(ctx.pp.projectDir, task.baseSha, ws, h0, { pinnedGuardrails: pinnedGuardrails(ctx), claudeBlock: claudeBlock(ctx) });
    const setup = await runWorkspaceSetup(ctx.config.workspace_setup.commands, ws, ctx.pp.projectDir, ctx.config.workspace_setup.timeout_s, shell, id);
    if (setup.error) {
      fail(setup.error);
      return done();
    }
    if (setup.steps.length) ok(`workspace setup: ${setup.steps.length} command(s), ${secs(setup.steps.reduce((a, s) => a + s.durationMs, 0))} s`);

    const g0 = await runGate(ws, ctx.config.gate, shell);
    if (g0.todo.length) {
      fail(`the gate has TODO commands: ${g0.todo.join(", ")}`);
      return done();
    }
    gateLines(g0, "base");

    const hasHidden = Boolean(task.hiddenTestsDir && task.meta.hidden_tests);
    if (!hasHidden) warn("no hidden tests: S_det has no test part for this task");
    else {
      const h = await hiddenTestRate(task, ws, shell, timeoutMs);
      removeHidden(ws, task);
      if (h.rate === 1) warn("base: every hidden test passes at base, so the hidden tests do not measure the task");
      else ok(`base: hidden test pass rate ${rate(h.rate)}`);
    }

    const refDir = path.join(task.dir, "solution");
    if (!fs.existsSync(refDir)) {
      warn("no solution/ folder: the check cannot show that a correct deliverable gets the full score");
      return done();
    }
    fs.cpSync(refDir, ws, { recursive: true });
    const g1 = await runGate(ws, ctx.config.gate, shell);
    gateLines(g1, "solution");
    if (hasHidden) {
      const h = await hiddenTestRate(task, ws, shell, timeoutMs);
      removeHidden(ws, task);
      if (h.rate === 1) ok("solution: every hidden test passes");
      else fail(`solution: hidden test pass rate ${rate(h.rate)}. The hidden tests, the command in meta.yaml or the solution is wrong. Last output: ${keyLines(h.tail)}`);
    }
  } catch (err) {
    fail(`the check stopped: ${err instanceof Error ? err.message : String(err)}`);
  }
  return done();
}

/** Check each eval task (or the tasks in `only`). Writes the report to <eval_store>/checks/. */
export async function evalCheck(ctx: Ctx, opts: { only?: string[]; keepWork?: boolean; shell?: ShellRunner } = {}): Promise<{ report: EvalCheckReport; reportPath: string }> {
  const store = ctx.user.eval_store;
  if (!store) throw new Error("eval-check needs eval_store in the user config");
  const shell = opts.shell ?? runShell;
  const ids = listTaskIds(store).filter((id) => !opts.only || opts.only.includes(id));
  if (opts.only) {
    const missing = opts.only.filter((id) => !ids.includes(id));
    if (missing.length) throw new Error(`no such eval task: ${missing.join(", ")}`);
  }
  const at = new Date().toISOString();
  const stamp = at.replace(/[:.]/g, "-");
  const root = path.join(ctx.user.work_root, "eval-check", stamp);
  const tasks: TaskCheck[] = [];
  for (const id of ids) {
    const ws = path.join(root, id);
    try {
      tasks.push(await checkTask(ctx, store, id, ws, shell));
    } finally {
      if (!opts.keepWork) removeDir(ws);
    }
  }
  if (!opts.keepWork) removeDir(root);
  const report: EvalCheckReport = { kind: "eval_check", at, h0_sha: ctx.h0Sha, ok: tasks.length > 0 && !tasks.some((t) => t.level === "FAIL"), tasks };
  const reportPath = path.join(ensureDir(path.join(store, "checks")), `eval-check-${stamp}.json`);
  writeJson(reportPath, report);
  return { report, reportPath };
}

export function evalCheckText(r: EvalCheckReport): string {
  const out: string[] = [];
  for (const t of r.tasks) {
    out.push(`[${t.level}] ${t.task} (${t.seconds} s)`);
    for (const l of t.lines) out.push(`  ${l}`);
  }
  if (!r.tasks.length) out.push("The eval store has no tasks.");
  const n = (lv: CheckLevel): number => r.tasks.filter((t) => t.level === lv).length;
  out.push("", `${r.tasks.length} task(s): ${n("OK")} OK, ${n("WARN")} WARN, ${n("FAIL")} FAIL.${n("FAIL") ? " Fix each FAIL before `harness measure`: a wrong ruler gives a wrong sigma_run." : ""}`);
  return out.join("\n");
}

/** The newest eval-check report of the store, or null. */
export function latestEvalCheck(store: string): { file: string; report: EvalCheckReport } | null {
  const dir = path.join(store, "checks");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^eval-check-.*\.json$/.test(f))
    .sort();
  const last = files[files.length - 1];
  if (!last) return null;
  const report = readJson<EvalCheckReport | null>(path.join(dir, last), null);
  return report && report.kind === "eval_check" ? { file: path.join(dir, last), report } : null;
}
