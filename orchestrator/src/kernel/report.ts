// harness report: a summary of the production runs of a project. It never shows a score: scores live
// in the eval store only, so a human who reads this report cannot tie a lesson or a run to a score.

import type { RunRecord } from "./runs.js";
import { readRunRecords, reportSummary } from "./runs.js";

export interface ProjectReport {
  runs: number;
  byOutcome: Record<string, number>;
  improveRate: number | null;
  budgetStopRate: number | null;
  reuseRate: number | null;
  meanTokens: number | null;
  meanCostUsd: number | null;
  last: Record<string, unknown>[];
  /** Runs whose record has the component use of the reference session. */
  componentRuns: number;
  /** For each skill, subagent and script of H: in how many reference runs H had it, and in how many the run used it. */
  components: ComponentStat[];
}

export interface ComponentStat {
  kind: "skill" | "agent" | "script";
  name: string;
  runs: number;
  used: number;
}

/** A skill or subagent is "never used" only after this many reference runs had it. */
export const UNUSED_MIN_RUNS = 5;

/**
 * Component use of the reference sessions. The reference session runs the H of the project as it is,
 * so its use shows dead weight: a skill or a subagent costs tokens in each run (its description and its
 * trigger line), also when no run uses it.
 */
export function componentStats(records: RunRecord[]): { runs: number; stats: ComponentStat[] } {
  const stats = new Map<string, ComponentStat>();
  let runs = 0;
  for (const r of records) {
    const c = r.components?.reference;
    if (!c) continue;
    runs++;
    for (const [kind, key] of [["skill", "skills"], ["agent", "agents"], ["script", "scripts"]] as const) {
      for (const name of c.available[key]) {
        const s = stats.get(`${kind}|${name}`) ?? { kind, name, runs: 0, used: 0 };
        s.runs++;
        if (c.used[key].includes(name)) s.used++;
        stats.set(`${kind}|${name}`, s);
      }
    }
  }
  return { runs, stats: [...stats.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.used / a.runs - b.used / b.runs || a.name.localeCompare(b.name)) };
}

const rate = (xs: RunRecord[], f: (r: RunRecord) => boolean): number | null => (xs.length ? Math.round((xs.filter(f).length / xs.length) * 1000) / 1000 : null);
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function projectReport(runsDir: string, opts: { last?: number; mode?: "production" | "eval" } = {}): ProjectReport {
  const all = readRunRecords(runsDir).filter((r) => !opts.mode || r.mode === opts.mode);
  const byOutcome: Record<string, number> = {};
  for (const r of all) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const withDecision = all.filter((r) => r.decision1);
  const tokens = avg(all.map((r) => r.totals.tokens));
  const cost = avg(all.map((r) => r.totals.costUsd));
  const comp = componentStats(all);
  return {
    runs: all.length,
    byOutcome,
    improveRate: rate(withDecision, (r) => Boolean(r.decision1?.ran)),
    budgetStopRate: rate(all, (r) => r.budget_stop),
    reuseRate: rate(all.filter((r) => r.composed_tree_hash), (r) => r.reuse_event),
    meanTokens: tokens === null ? null : Math.round(tokens),
    meanCostUsd: cost === null ? null : Math.round(cost * 10000) / 10000,
    last: all.slice(-(opts.last ?? 10)).map(reportSummary),
    componentRuns: comp.runs,
    components: comp.stats,
  };
}

export function reportText(r: ProjectReport): string {
  const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
  const lines = [
    `Runs: ${r.runs}`,
    `Outcomes: ${Object.entries(r.byOutcome).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
    `Decision 1 ran the loop: ${pct(r.improveRate)}`,
    `Budget stops: ${pct(r.budgetStopRate)}`,
    `Reuse events (runs with a composed H′): ${pct(r.reuseRate)}`,
    `Mean tokens per run: ${r.meanTokens ?? "n/a"}, mean cost: ${r.meanCostUsd === null ? "n/a" : "$" + r.meanCostUsd}`,
    "",
    ...componentLines(r),
    "Last runs:",
    ...r.last.map((s) => `  ${String(s.run_id)}  ${String(s.task_type ?? "-")}  outcome=${String(s.outcome)}  gate=${String(s.gate_pass)}  tokens=${String(s.tokens)}`),
    "",
    "Scores are not in this report. They are in the eval store.",
  ];
  return lines.join("\n");
}

function componentLines(r: ProjectReport): string[] {
  if (!r.componentRuns) return [];
  const unused = r.components.filter((s) => s.kind !== "script" && s.used === 0 && s.runs >= UNUSED_MIN_RUNS);
  return [
    `H components in the reference runs (${r.componentRuns} runs with data):`,
    ...(r.components.length ? r.components.map((s) => `  ${s.kind} ${s.name}: used in ${s.used} of ${s.runs} runs`) : ["  H has no skill, subagent or script."]),
    ...(unused.length
      ? [
          `Never used in ${UNUSED_MIN_RUNS} or more runs: ${unused.map((s) => `${s.kind} ${s.name}`).join(", ")}.`,
          "Each one costs tokens in every run. Remove it before freeze-h0, or later through decision 5 (H0′, measured by E2), unless a rare task needs it.",
        ]
      : []),
    "",
  ];
}
