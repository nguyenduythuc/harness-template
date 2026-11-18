// The eval round of the improvement loop (Phase 2+): the arms of one round, the paired rule, gain per
// Mtok and the holdout ledger. E1 compares the loop with frozen H0 on the same task, so it measures the
// value of running the loop on a task. It does not show that the harness got better: that is E2 (H0′
// frozen against H0 on holdout tasks that H0′ never saw).
// Scores go to the eval store only. The CLI prints the outcome and the report path, never a score of a task.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../kernel/ctx.js";
import { ConfigError, requirePhase } from "../kernel/config.js";
import type { Weights } from "../kernel/evalstore.js";
import { ledgerAppend } from "../kernel/evalstore.js";
import type { HTree } from "../kernel/htree.js";
import type { ArmRun } from "../kernel/measure.js";
import { CanaryLeak, devTasks, openRound, round1, runAndScore, signalWarnings, warningLines } from "../kernel/measure.js";
import type { Deps } from "../kernel/run.js";
import { runFrozen } from "../kernel/run.js";
import type { RuleResult } from "../kernel/stats.js";
import { mean, pairedRule } from "../kernel/stats.js";
import { writeJson } from "../util/fs.js";
import { epochOf } from "../kernel/epoch.js";
import { runTask } from "./pipeline.js";

export interface RoundDeps extends Deps {
  /** Reflect on a dev run of the loop (Phase 3+), before its score exists. The CLI passes it (extras). */
  reflect?: (ctx: Ctx, runId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Phase 2+: one eval round.

export interface RoundOpts {
  split: "dev" | "holdout";
  decision: string;
  m?: number;
  /** Also run the pipeline with an empty library (Phase 3 gate: library effect). */
  noLibraryArm?: boolean;
  /** H0′ for E2 (decision 5). */
  h0Prime?: HTree;
  only?: string[];
  keepWork?: boolean;
  /** Holdout rounds run in the clean eval environment (D9). This flag allows a host run, with a note. */
  allowHost?: boolean;
}

export interface Estimate {
  name: string;
  newArm: string;
  oldArm: string;
  tasks: number;
  droppedPairs: number;
  rule: RuleResult | null;
}

export interface RoundReport {
  reportPath: string;
  split: "dev" | "holdout";
  estimates: Estimate[];
  gainPerMtok: number | null;
  notes: string[];
  /** The benchmark dashboard in the eval store, or null when it could not be written. */
  dashboardPath?: string | null;
  /** For each estimate: the change of each task, worst first. */
  tasks?: Record<string, TaskFlip[]>;
  /** Warnings about the measurement itself (see signalWarnings). */
  warnings?: string[];
}

/** The change of one task between two arms. Criteria counts are "passes / runs" of each arm. */
export interface TaskFlip {
  task: string;
  newMean: number | null;
  oldMean: number | null;
  diff: number | null;
  gateNew: string;
  gateOld: string;
  /** Criteria that pass in fewer runs of the new arm, as "id old→new". */
  lost: string[];
  gained: string[];
  /** Criteria that pass in some runs and fail in others of the same arm. One run per arm would miss them. */
  unstable: string[];
}

/**
 * The per-task view of an estimate. A mean can hide a task that lost a criterion: the article on
 * folding subagents found a broken check that showed in one of two runs only. Read the diffs of each
 * task in this list before you trust the mean.
 */
export function taskFlips(runs: ArmRun[], newArm: string, oldArm: string): TaskFlip[] {
  const out: TaskFlip[] = [];
  for (const task of [...new Set(runs.map((r) => r.task))]) {
    const a = runs.filter((r) => r.task === task && r.arm === newArm);
    const b = runs.filter((r) => r.task === task && r.arm === oldArm);
    if (!a.length || !b.length) continue;
    const scores = (xs: ArmRun[]): number[] => xs.filter((r) => r.scored && r.score !== null).map((r) => r.score as number);
    const gate = (xs: ArmRun[]): string => {
      const g = xs.filter((r) => r.gatePass !== null && r.gatePass !== undefined);
      return `${g.filter((r) => r.gatePass).length}/${g.length}`;
    };
    const counts = (xs: ArmRun[]): Map<string, { pass: number; n: number }> => {
      const m = new Map<string, { pass: number; n: number }>();
      for (const r of xs) {
        for (const c of r.criteria ?? []) {
          const e = m.get(c.id) ?? { pass: 0, n: 0 };
          e.n++;
          if (c.pass) e.pass++;
          m.set(c.id, e);
        }
      }
      return m;
    };
    const ca = counts(a);
    const cb = counts(b);
    const lost: string[] = [];
    const gained: string[] = [];
    const unstable: string[] = [];
    for (const id of [...new Set([...ca.keys(), ...cb.keys()])].sort()) {
      const x = ca.get(id);
      const y = cb.get(id);
      if (x && y) {
        const label = `${id} ${y.pass}/${y.n}→${x.pass}/${x.n}`;
        if (x.pass / x.n < y.pass / y.n) lost.push(label);
        else if (x.pass / x.n > y.pass / y.n) gained.push(label);
      }
      for (const [arm, e] of [[newArm, x], [oldArm, y]] as const) {
        if (e && e.pass > 0 && e.pass < e.n) unstable.push(`${id} (${arm} ${e.pass}/${e.n})`);
      }
    }
    const sa = scores(a);
    const sb = scores(b);
    const newMean = sa.length ? round1(mean(sa)) : null;
    const oldMean = sb.length ? round1(mean(sb)) : null;
    const diff = newMean !== null && oldMean !== null ? round1(newMean - oldMean) : null;
    out.push({ task, newMean, oldMean, diff, gateNew: gate(a), gateOld: gate(b), lost, gained, unstable });
  }
  return out.sort((p, q) => (p.diff ?? Infinity) - (q.diff ?? Infinity) || p.task.localeCompare(q.task));
}

/** Pair run i of the new arm with run i of the old arm; drop a pair when either run has no score. */
export function pairArms(runs: ArmRun[], newArm: string, oldArm: string): { arms: Record<string, { new: number[]; old: number[] }>; dropped: number } {
  const arms: Record<string, { new: number[]; old: number[] }> = {};
  let dropped = 0;
  const byKey = new Map(runs.map((r) => [`${r.arm}|${r.task}|${r.index}`, r]));
  for (const task of [...new Set(runs.map((r) => r.task))]) {
    const idx = [...new Set(runs.filter((r) => r.task === task).map((r) => r.index))];
    for (const i of idx) {
      const a = byKey.get(`${newArm}|${task}|${i}`);
      const b = byKey.get(`${oldArm}|${task}|${i}`);
      if (!a || !b) continue;
      if (!a.scored || !b.scored || a.score === null || b.score === null) {
        dropped++;
        continue;
      }
      const slot = (arms[task] ??= { new: [], old: [] });
      slot.new.push(a.score);
      slot.old.push(b.score);
    }
  }
  return { arms, dropped };
}

function estimate(runs: ArmRun[], name: string, newArm: string, oldArm: string, deltaMin: number): Estimate {
  const { arms, dropped } = pairArms(runs, newArm, oldArm);
  const diffs = Object.values(arms).filter((a) => a.new.length).map((a) => mean(a.new) - mean(a.old));
  return { name, newArm, oldArm, tasks: diffs.length, droppedPairs: dropped, rule: diffs.length >= 2 ? pairedRule(diffs, deltaMin) : null };
}

export async function evalRound(ctx: Ctx, opts: RoundOpts, deps: RoundDeps = {}): Promise<RoundReport> {
  requirePhase(ctx.config, opts.split === "holdout" ? 3 : 2, `An eval round on ${opts.split}`);
  if (opts.h0Prime) requirePhase(ctx.config, 5, "E2 (decision 5)");
  const notes: string[] = [];
  if (opts.split === "holdout" && !process.env.HARNESS_EVAL_IMAGE) {
    if (!opts.allowHost) throw new ConfigError("Holdout rounds run in the clean eval environment (D9). Set HARNESS_EVAL_IMAGE in that environment, or pass --allow-host to run here with a note in the report.");
    notes.push("This holdout round ran on the host, not in the clean eval environment (D9).");
  }
  const env = openRound(ctx, `round-${opts.split}`);
  const m = opts.m ?? ctx.config.loop.m;
  const tasks = devTasks(env, opts.split, opts.only);
  const runs: ArmRun[] = [];
  const keep = opts.keepWork ?? false;
  // Reflect on dev runs of the loop BEFORE the score exists, so that no score can reach the library (B4).
  const reflectDev = deps.reflect && opts.split === "dev" && ctx.config.phase >= 3 ? (runId: string) => (deps.reflect as NonNullable<RoundDeps["reflect"]>)(ctx, runId) : null;
  try {
    for (const t of tasks) {
      for (let i = 0; i < m; i++) {
        // Interleave the arms, so that drift of the API or of the machine hits each arm the same way.
        runs.push(await runAndScore(env, t, opts.split, "h0", i, { frozen: true }, runFrozen, deps, keep));
        runs.push(await runAndScore(env, t, opts.split, "pipeline", i, { frozen: false, ...(reflectDev ? { beforeScore: reflectDev } : {}) }, runTask, deps, keep));
        if (opts.noLibraryArm) runs.push(await runAndScore(env, t, opts.split, "pipeline-nolib", i, { frozen: false, noLibrary: true }, runTask, deps, keep));
        if (opts.h0Prime) runs.push(await runAndScore(env, t, opts.split, "h0prime", i, { frozen: true, hOverride: opts.h0Prime }, runFrozen, deps, keep));
      }
    }
  } catch (err) {
    if (err instanceof CanaryLeak) {
      fs.writeFileSync(path.join(env.reportDir, "report.md"), `# Eval round: NOT VALID\n\n${err.message}\n`);
      if (opts.split === "holdout") ledgerAppend(env.store, opts.decision, "not valid (canary leak)", env.reportRel);
    }
    throw err;
  }

  const dm = env.weights.delta_min;
  const estimates: Estimate[] = [estimate(runs, "E1", "pipeline", "h0", dm)];
  if (opts.noLibraryArm) {
    estimates.push(estimate(runs, "E1 without library", "pipeline-nolib", "h0", dm));
    estimates.push(estimate(runs, "library effect", "pipeline", "pipeline-nolib", dm));
  }
  if (opts.h0Prime) estimates.push(estimate(runs, "E2", "h0prime", "h0", dm));

  // Gain per Mtok = mean E1 / mean(tokens of the pipeline - tokens of H0), over the tasks of the round.
  let gainPerMtok: number | null = null;
  const e1 = estimates[0]?.rule;
  const tokenDiffs = tasks
    .map((t) => {
      const p = runs.filter((r) => r.task === t.id && r.arm === "pipeline").map((r) => r.tokens);
      const h = runs.filter((r) => r.task === t.id && r.arm === "h0").map((r) => r.tokens);
      return p.length && h.length ? mean(p) - mean(h) : null;
    })
    .filter((x): x is number => x !== null);
  if (e1 && tokenDiffs.length && mean(tokenDiffs) > 0) gainPerMtok = Math.round((e1.mean / (mean(tokenDiffs) / 1e6)) * 100) / 100;

  const tasksView: Record<string, TaskFlip[]> = Object.fromEntries(estimates.map((e) => [e.name, taskFlips(runs, e.newArm, e.oldArm)]));
  const report: RoundReport = { reportPath: path.join(env.reportDir, "report.md"), split: opts.split, estimates, gainPerMtok, notes, tasks: tasksView, warnings: signalWarnings(runs) };
  writeJson(path.join(env.reportDir, "round.json"), { ...report, decision: opts.decision, m, created_at: new Date().toISOString(), epoch: epochOf(ctx) });
  fs.writeFileSync(report.reportPath, roundMarkdown(report, opts.decision, m, env.weights));
  if (opts.split === "holdout") {
    ledgerAppend(env.store, opts.decision, estimates.map((e) => `${e.name}: ${e.rule?.outcome ?? "n/a"}`).join("; "), env.reportRel);
  }
  return report;
}

function roundMarkdown(r: RoundReport, decision: string, m: number, w: Weights): string {
  const f = (x: number): string => (Math.round(x * 10) / 10).toString();
  return [
    `# Eval round (${r.split})`,
    "",
    `- Decision: ${decision}`,
    `- Runs per arm and task: ${m}, delta_min: ${w.delta_min}`,
    ...r.notes.map((n) => `- Note: ${n}`),
    "",
    "| estimate | tasks | dropped pairs | mean | 90% lower | 90% upper | outcome |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...r.estimates.map((e) =>
      e.rule
        ? `| ${e.name} | ${e.tasks} | ${e.droppedPairs} | ${f(e.rule.mean)} | ${f(e.rule.lower)} | ${f(e.rule.upper)} | ${e.rule.outcome} |`
        : `| ${e.name} | ${e.tasks} | ${e.droppedPairs} | - | - | - | too few tasks |`,
    ),
    "",
    `Gain per Mtok: ${r.gainPerMtok ?? "n/a"} (minimum ${w.min_gain_per_mtok}).`,
    "",
    ...warningLines(r.warnings ?? []),
    ...r.estimates.flatMap((e) => taskTable(e, r.tasks?.[e.name] ?? [])),
    "Per-run scores are in scores.jsonl next to this file.",
    "",
  ].join("\n");
}

function taskTable(e: Estimate, flips: TaskFlip[]): string[] {
  if (!flips.length) return [];
  const cell = (xs: string[]): string => (xs.length ? xs.join("; ") : "-");
  const num = (x: number | null): string => (x === null ? "-" : String(x));
  return [
    `## Tasks: ${e.name} (${e.newArm} against ${e.oldArm}), worst first`,
    "",
    "| task | new | old | d_t | gate new | gate old | lost criteria | gained criteria | unstable criteria |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...flips.map((f) => `| ${f.task} | ${num(f.newMean)} | ${num(f.oldMean)} | ${num(f.diff)} | ${f.gateNew} | ${f.gateOld} | ${cell(f.lost)} | ${cell(f.gained)} | ${cell(f.unstable)} |`),
    "",
    "A lost criterion can hide under a positive mean. Read the diffs of each task with a lost or an unstable criterion before you decide.",
    "",
  ];
}

/** One line for the terminal: the outcome and the report path. No per-task score. */
export function roundOutcomeLine(r: RoundReport): string {
  return `${r.estimates.map((e) => `${e.name}: ${e.rule?.outcome ?? "too few tasks"}`).join(", ")}. Report: ${r.reportPath}`;
}
