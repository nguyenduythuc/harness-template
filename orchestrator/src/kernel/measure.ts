// Measurement (docs/plan.md, "Thước đo"): the parts that every eval command shares, and measure (Phase 0):
// frozen H0 runs, m per dev task, which give sigma_run and the MDE80 table. The eval round of the loop
// (loop/round.ts) uses runAndScore with its own run function.
// Scores go to the eval store only. The CLI prints the outcome and the report path, never a score of a task.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import { ConfigError } from "./config.js";
import type { EvalTask, Weights } from "./evalstore.js";
import { appendScore, canaryHits, loadCanaries, loadSplit, loadTask, loadWeights } from "./evalstore.js";
import type { HTree } from "./htree.js";
import type { RunPaths } from "./paths.js";
import type { Deps, TaskInput, TaskResult } from "./run.js";
import { runFrozen } from "./run.js";
import { RunLog } from "./runs.js";
import { SessionRunner } from "./runner.js";
import type { ScoreResult } from "./scoring.js";
import { scoreDeliverable } from "./scoring.js";
import { mde80, pooledSigmaRun, sdOfDiff } from "./stats.js";
import { ensureDir, removeDir, writeJson } from "../util/fs.js";
import { epochOf } from "./epoch.js";
import crypto from "node:crypto";

export class CanaryLeak extends Error {}

export interface RoundEnv {
  ctx: Ctx;
  store: string;
  weights: Weights;
  judgeMd: string;
  canaries: string[];
  reportDir: string;
  reportRel: string;
}

export function openRound(ctx: Ctx, kind: string): RoundEnv {
  const store = ctx.user.eval_store;
  if (!store) throw new ConfigError("This command needs eval_store in the user config.");
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${kind}-${crypto.randomBytes(2).toString("hex")}`;
  const reportRel = path.join("reports", id);
  const reportDir = ensureDir(path.join(store, reportRel));
  return {
    ctx,
    store,
    weights: loadWeights(store),
    judgeMd: fs.readFileSync(path.join(store, "judge.md"), "utf8"),
    canaries: loadCanaries(store),
    reportDir,
    reportRel,
  };
}

/** Run paths for the judge sessions of one run. They live in the eval store, because the judge prompt holds the rubric. */
function scoringPaths(env: RoundEnv, res: TaskResult): RunPaths {
  const recordDir = path.join(env.reportDir, "judge", res.record.run_id);
  return {
    runId: res.record.run_id,
    recordDir,
    tracesDir: path.join(recordDir, "traces"),
    workDir: res.runner.rp.workDir,
    logsDir: path.join(res.runner.rp.workDir, "logs"),
    policiesDir: path.join(res.runner.rp.workDir, "policies"),
  };
}

/** Look for canary strings in every agent trace of a run. A hit means that an agent read the eval store. */
export function scanCanaries(tracesDir: string, canaries: string[]): string[] {
  if (!canaries.length || !fs.existsSync(tracesDir)) return [];
  const hits = new Set<string>();
  for (const f of fs.readdirSync(tracesDir)) {
    const text = fs.readFileSync(path.join(tracesDir, f), "utf8");
    for (const h of canaryHits(text, canaries)) hits.add(`${f}: ${h.slice(0, 20)}…`);
  }
  return [...hits];
}

/** A failure of the infrastructure, not of the agent: the run gets no score, and the pair drops out. */
function infraFailure(res: TaskResult): string | null {
  const ref = [...res.record.sessions].reverse().find((s) => s.label.startsWith("reference"));
  if (!ref) return "the reference session did not start";
  if (ref.status === "aborted_spec") return "the reference session failed the init check";
  if (ref.status === "error") return "the reference session ended with an error two times";
  if (!res.workspace) return "no workspace holds a deliverable";
  return null;
}

export interface ArmRun {
  arm: string;
  task: string;
  index: number;
  runId: string;
  scored: boolean;
  reason: string | null;
  score: number | null;
  tokens: number;
  /** Gate result and rubric criteria of the scored run (eval store only). */
  gatePass?: boolean | null;
  criteria?: { id: string; pass: boolean }[];
  hiddenTests?: number | null;
  hiddenTail?: string | null;
  /** The task budget stopped the run. A stopped pipeline run gives the reference deliverable. */
  budgetStop?: boolean;
}

/**
 * Warnings about the measurement itself. When the hidden tests fail in every run of a task while the
 * judge passes every criterion, the hidden test command is often wrong, and S_det is 0 for a reason
 * that is not the agent. A live measurement on 2026-10-25 had this: `node --test <dir>` on Node 22.
 */
export function signalWarnings(runs: ArmRun[]): string[] {
  const out: string[] = [];
  const keys = [...new Set(runs.map((r) => `${r.task}|${r.arm}`))];
  for (const key of keys) {
    const [task, arm] = key.split("|") as [string, string];
    const rs = runs.filter((r) => r.task === task && r.arm === arm && r.scored && r.hiddenTests !== null && r.hiddenTests !== undefined);
    if (!rs.length || rs.some((r) => (r.hiddenTests as number) > 0)) continue;
    const judgeAll = rs.filter((r) => (r.criteria ?? []).length > 0 && (r.criteria ?? []).every((c) => c.pass)).length;
    if (!judgeAll) continue;
    // Show the error lines first: the last lines of a test runner are often only its summary.
    const lines = (rs[rs.length - 1]?.hiddenTail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const errors = lines.filter((l) => /error|cannot|not ok|fail/i.test(l) && !/^# fail \d/.test(l));
    const tail = (errors.length ? errors : lines).slice(-3).join(" | ");
    out.push(`${task} (${arm}): the hidden tests failed in ${rs.length} of ${rs.length} runs, but the judge passed every criterion in ${judgeAll} of them. Check the hidden test command in meta.yaml before you trust S_det. Last output: ${tail || "(none)"}`);
  }
  // A budget stop ends the loop early, and the run gives the reference deliverable. Then the pair
  // compares H0 with H0, and E1 says nothing about the loop. The plan allows at most 5% of tasks.
  for (const arm of [...new Set(runs.map((r) => r.arm))]) {
    const rs = runs.filter((r) => r.arm === arm);
    const stopped = rs.filter((r) => r.budgetStop);
    if (!stopped.length || stopped.length / rs.length <= 0.05) continue;
    const perTask = [...new Set(stopped.map((r) => r.task))].map((t) => `${t} ${stopped.filter((r) => r.task === t).length}/${rs.filter((r) => r.task === t).length}`);
    out.push(`${arm}: the task budget stopped ${stopped.length} of ${rs.length} runs (${perTask.join(", ")}). A stopped run gives the reference deliverable, so these pairs do not measure the loop. Raise budget.tokens or budget.usd in harness/pinned-config.yaml after you read the token totals of the run records. Note: budget.tokens counts cache reads.`);
  }
  return out;
}

/** How one arm runs a task: runFrozen in the kernel, or the improvement loop. */
export type RunFn = (ctx: Ctx, task: TaskInput, deps: Deps) => Promise<TaskResult>;

export interface ArmOpts {
  frozen: boolean;
  hOverride?: HTree;
  noLibrary?: boolean;
  /** Runs after the canary scan and BEFORE the score exists, so that no score can reach it (B4). */
  beforeScore?: (runId: string) => Promise<void>;
}

export async function runAndScore(env: RoundEnv, task: EvalTask, split: "dev" | "holdout", arm: string, index: number, opts: ArmOpts, run: RunFn, deps: Deps, keepWork: boolean): Promise<ArmRun> {
  const ctx = env.ctx;
  const res = await run(
    ctx,
    {
      id: task.id,
      taskMd: task.taskMd,
      taskType: task.meta.task_type,
      mode: "eval",
      split,
      baseSha: task.baseSha,
      force: null,
      frozen: opts.frozen,
      ...(opts.hOverride ? { hOverride: opts.hOverride } : {}),
      ...(opts.noLibrary ? { noLibrary: true } : {}),
    },
    deps,
  );
  const leaks = scanCanaries(res.runner.rp.tracesDir, env.canaries);
  if (leaks.length) throw new CanaryLeak(`Canary strings appear in the traces of run ${res.record.run_id}: ${leaks.join("; ")}. An agent read the eval store. The round is not valid.`);

  if (opts.beforeScore) {
    try {
      await opts.beforeScore(res.record.run_id);
    } catch (err) {
      appendScore(env.reportDir, { kind: "note", run_id: res.record.run_id, note: `before-score hook failed: ${String(err)}` });
    }
  }

  let sr: ScoreResult | null = null;
  const infra = infraFailure(res);
  if (!infra && res.workspace) {
    const rp = scoringPaths(env, res);
    // Keep the evidence that the judge sees, so that a human can label the same evidence (judge calibration).
    ensureDir(rp.recordDir);
    fs.writeFileSync(path.join(rp.recordDir, "deliverable.diff"), res.diff);
    const runner = new SessionRunner(ctx, rp, new RunLog(rp), SessionRunner.budgetFor(ctx), "eval", deps.queryFn);
    sr = await scoreDeliverable({
      runner,
      task,
      weights: env.weights,
      judgeMd: env.judgeMd,
      workspace: res.workspace,
      diff: res.diff,
      label: arm,
      gate: res.gate,
      ...(deps.shell ? { shell: deps.shell } : {}),
    });
  }
  const row: ArmRun = {
    arm,
    task: task.id,
    index,
    runId: res.record.run_id,
    scored: Boolean(sr?.scored),
    reason: infra ?? sr?.reason ?? null,
    score: sr?.scored ? sr.score : null,
    tokens: res.record.totals.tokens,
    gatePass: sr?.gate.pass ?? null,
    criteria: (sr?.criteria ?? []).map((c) => ({ id: c.id, pass: c.pass })),
    hiddenTests: sr?.parts.hidden_tests ?? null,
    hiddenTail: sr?.hiddenTail ?? null,
    budgetStop: res.record.budget_stop,
  };
  appendScore(env.reportDir, {
    kind: "score",
    ...row,
    parts: sr?.parts ?? null,
    criteria: sr?.criteria ?? [],
    gate_pass: sr?.gate.pass ?? null,
    hidden_tests_tail: sr?.hiddenTail ?? null,
    outcome: res.record.outcome,
    diff: sr ? path.relative(env.store, path.join(env.reportDir, "judge", res.record.run_id, "deliverable.diff")) : null,
  });
  if (!keepWork) removeDir(res.runner.rp.workDir);
  return row;
}

export function devTasks(env: RoundEnv, split: "dev" | "holdout", only?: string[]): EvalTask[] {
  const s = loadSplit(env.store);
  const ids = (split === "dev" ? s.dev : s.holdout).filter((id) => !only || only.includes(id));
  if (!ids.length) throw new ConfigError(`The ${split} split is empty. Add tasks to the eval store, then run \`harness eval-split\`.`);
  return ids.map((id) => loadTask(env.store, id));
}

// ---------------------------------------------------------------------------------------------
// Phase 0: measure.

export interface MeasureReport {
  reportPath: string;
  sigmaRun: number;
  tasks: number;
  scoredRuns: number;
  unscoredRuns: number;
  holdoutN: number;
  table: { n: number; sigmaInt: number; sdDiff: number; mde80: number }[];
  gate: { n: number; mde80: number; deltaTarget: number; pass: boolean };
  /** Warnings about the measurement itself (see signalWarnings). */
  warnings: string[];
  /** The benchmark dashboard in the eval store. The CLI sets it (extras); the kernel does not write it. */
  dashboardPath?: string | null;
}

export async function measure(ctx: Ctx, opts: { m?: number; only?: string[]; keepWork?: boolean } = {}, deps: Deps = {}): Promise<MeasureReport> {
  const env = openRound(ctx, "measure");
  const m = opts.m ?? ctx.config.loop.m;
  const tasks = devTasks(env, "dev", opts.only);
  const groups: number[][] = [];
  const allRuns: ArmRun[] = [];
  let unscored = 0;
  let scored = 0;
  for (const t of tasks) {
    const scores: number[] = [];
    for (let i = 0; i < m; i++) {
      const r = await runAndScore(env, t, "dev", "h0", i, { frozen: true }, runFrozen, deps, opts.keepWork ?? false);
      allRuns.push(r);
      if (r.scored && r.score !== null) {
        scores.push(r.score);
        scored++;
      } else unscored++;
    }
    groups.push(scores);
  }
  const sigmaRun = pooledSigmaRun(groups);
  const holdoutN = loadSplit(env.store).holdout.length;
  const ns = [...new Set([tasks.length, holdoutN, 5, 10, 20].filter((n) => n >= 2))].sort((a, b) => a - b);
  const table: MeasureReport["table"] = [];
  for (const n of ns) {
    for (const sigmaInt of [0, 5, 10]) {
      const sdDiff = sdOfDiff(sigmaInt, sigmaRun, m);
      table.push({ n, sigmaInt, sdDiff: round1(sdDiff), mde80: round1(mde80(n, sdDiff, env.weights.delta_min)) });
    }
  }
  const gateN = Math.max(2, holdoutN);
  const gateMde = round1(mde80(gateN, sdOfDiff(5, sigmaRun, m), env.weights.delta_min));
  const report: MeasureReport = {
    reportPath: path.join(env.reportDir, "report.md"),
    sigmaRun: round1(sigmaRun),
    tasks: tasks.length,
    scoredRuns: scored,
    unscoredRuns: unscored,
    holdoutN,
    table,
    gate: { n: gateN, mde80: gateMde, deltaTarget: env.weights.delta_target, pass: gateMde <= env.weights.delta_target },
    warnings: signalWarnings(allRuns),
  };
  writeJson(path.join(env.reportDir, "measure.json"), { ...report, m, created_at: new Date().toISOString(), epoch: epochOf(ctx) });
  writeJson(path.join(env.store, "sigma.json"), { sigma_run: report.sigmaRun, m, measured_at: new Date().toISOString(), report: env.reportRel, epoch: epochOf(ctx) });
  fs.writeFileSync(report.reportPath, measureMarkdown(report, m));
  return report;
}

export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function measureMarkdown(r: MeasureReport, m: number): string {
  const lines = [
    "# Phase 0 measurement",
    "",
    `- Dev tasks: ${r.tasks}, runs per task: ${m}`,
    `- Scored runs: ${r.scoredRuns}, unscored runs: ${r.unscoredRuns}`,
    `- sigma_run (pooled): ${r.sigmaRun}`,
    `- Holdout tasks: ${r.holdoutN}`,
    "",
    "## MDE80",
    "",
    "| n | sigma_int | SD of d_t | MDE80 |",
    "| --- | --- | --- | --- |",
    ...r.table.map((t) => `| ${t.n} | ${t.sigmaInt} | ${t.sdDiff} | ${t.mde80} |`),
    "",
    "## Phase 0 gate",
    "",
    `MDE80 at n = ${r.gate.n} holdout tasks and sigma_int = 5 is ${r.gate.mde80}. The target is ${r.gate.deltaTarget}. Result: ${r.gate.pass ? "PASS" : "FAIL"}.`,
    "",
    ...warningLines(r.warnings),
    r.gate.pass ? "" : "To pass: add holdout tasks (better than more runs, because more runs reduce only the sigma_run part), or write down that Success 1 can only show a gain of MDE80 or more.",
    "",
  ];
  return lines.join("\n");
}

export function warningLines(warnings: string[]): string[] {
  return warnings.length ? ["## Warnings about the measurement", "", ...warnings.map((w) => `- ${w}`), ""] : [];
}
