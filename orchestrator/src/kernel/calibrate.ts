// Judge calibration (docs/plan.md, "Calibrate judge trước khi dùng"). The judge is part of the ruler,
// so a human checks it against human labels before any score counts:
//   - at least 50 criterion judgments, with Cohen's kappa >= 0.6 between the judge and the human;
//   - at least 10 pairs of deliverables of one task that the human does not call a tie, with the
//     judge order equal to the human order in at least 8 of 10.
//
// Steps: `harness calibrate template` writes label files with empty answers in the eval store. The
// human reads each deliverable.diff and fills in the answers. `harness calibrate check` compares.
// All files stay in the eval store. No agent reads them.

import fs from "node:fs";
import path from "node:path";
import { listTaskIds, loadTask } from "./evalstore.js";
import { mulberry32 } from "./stats.js";
import { ensureDir, readJsonl, writeJson } from "../util/fs.js";

export const CALIBRATION_GATE = { judgments: 50, kappa: 0.6, pairs: 10, pairAgreement: 0.8 };

interface ScoreRow {
  kind: string;
  task: string;
  runId: string;
  scored: boolean;
  score: number | null;
  criteria?: { id: string; pass: boolean }[];
  diff?: string | null;
}

export interface LabelRow {
  run_id: string;
  task: string;
  criterion: string;
  text: string;
  diff: string;
  /** The human fills in true or false. */
  pass: boolean | null;
}

export interface PairRow {
  task: string;
  run_a: string;
  run_b: string;
  diff_a: string;
  diff_b: string;
  /** The human fills in "a" (a is better), "b" or "tie". */
  human: "a" | "b" | "tie" | null;
}

/** Every scored run with judge results, from every report of the eval store. */
export function scoredRuns(store: string): ScoreRow[] {
  const reports = path.join(store, "reports");
  if (!fs.existsSync(reports)) return [];
  const out: ScoreRow[] = [];
  for (const d of fs.readdirSync(reports, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const r of readJsonl<ScoreRow>(path.join(reports, d.name, "scores.jsonl"))) {
      if (r.kind === "score" && r.scored && r.score !== null && r.criteria?.length && r.diff) out.push(r);
    }
  }
  return out;
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const r = mulberry32(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * Write labels.jsonl and pairs.jsonl with empty answers. Takes up to `runs` runs (spread over the
 * tasks) and up to `pairs` pairs of runs of one task. The order is random for a seed, so the human
 * does not see the runs in the order of their scores.
 */
export function calibrationTemplate(store: string, opts: { runs?: number; pairs?: number; seed?: number } = {}): { dir: string; labels: number; pairs: number } {
  const seed = opts.seed ?? Date.now() % 2147483647;
  const all = shuffle(scoredRuns(store), seed);
  const known = new Set(listTaskIds(store));
  const byTask = new Map<string, ScoreRow[]>();
  for (const r of all) if (known.has(r.task)) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);

  // Round robin over the tasks, so that the labels cover many tasks.
  const picked: ScoreRow[] = [];
  const queues = [...byTask.values()].map((q) => [...q]);
  while (picked.length < (opts.runs ?? 12) && queues.some((q) => q.length)) {
    for (const q of queues) {
      const r = q.shift();
      if (r && picked.length < (opts.runs ?? 12)) picked.push(r);
    }
  }
  const labels: LabelRow[] = [];
  for (const r of picked) {
    const task = loadTask(store, r.task);
    for (const c of task.criteria) labels.push({ run_id: r.runId, task: r.task, criterion: c.id, text: c.text, diff: r.diff as string, pass: null });
  }
  const pairs: PairRow[] = [];
  for (const [task, rows] of byTask) {
    for (let i = 0; i + 1 < rows.length && pairs.length < (opts.pairs ?? 12); i += 2) {
      const a = rows[i] as ScoreRow;
      const b = rows[i + 1] as ScoreRow;
      pairs.push({ task, run_a: a.runId, run_b: b.runId, diff_a: a.diff as string, diff_b: b.diff as string, human: null });
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const dir = ensureDir(path.join(store, "calibration", stamp));
  fs.writeFileSync(path.join(dir, "labels.jsonl"), labels.map((l) => JSON.stringify(l)).join("\n") + (labels.length ? "\n" : ""));
  fs.writeFileSync(path.join(dir, "pairs.jsonl"), pairs.map((p) => JSON.stringify(p)).join("\n") + (pairs.length ? "\n" : ""));
  fs.writeFileSync(
    path.join(dir, "README.md"),
    [
      "# Judge calibration",
      "",
      "1. For each line of labels.jsonl: read task.md of the task, the criterion text, and the diff file (path relative to the eval store).",
      '   Set "pass" to true or false. Do not open scores.jsonl before you finish.',
      '2. For each line of pairs.jsonl: read both diffs. Set "human" to "a" (a is better), "b" or "tie".',
      "3. Run `harness calibrate check --dir <this folder>`.",
      "",
      `Gate: at least ${CALIBRATION_GATE.judgments} judgments with kappa >= ${CALIBRATION_GATE.kappa}, and at least ${CALIBRATION_GATE.pairs} pairs that are not a tie, with the judge order right in ${CALIBRATION_GATE.pairAgreement * 100}% of them.`,
      "",
    ].join("\n"),
  );
  writeJson(path.join(dir, "meta.json"), { seed, created_at: new Date().toISOString(), labels: labels.length, pairs: pairs.length });
  return { dir, labels: labels.length, pairs: pairs.length };
}

/** Cohen's kappa of two binary raters. Returns 1 when both raters agree on every item. */
export function cohenKappa(a: boolean[], b: boolean[]): number {
  if (a.length !== b.length || !a.length) throw new Error("kappa needs two lists of the same, non-zero length");
  const n = a.length;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.filter(Boolean).length / n;
  const pb = b.filter(Boolean).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  if (pe === 1) return po === 1 ? 1 : 0;
  return (po - pe) / (1 - pe);
}

export interface CalibrationResult {
  judgments: number;
  kappa: number | null;
  pairsUsed: number;
  pairsAgree: number;
  pairsTie: number;
  pass: boolean;
  problems: string[];
  disagreements: { run_id: string; criterion: string; judge: boolean; human: boolean }[];
}

export function checkCalibration(store: string, dir: string): CalibrationResult {
  const judge = new Map<string, boolean>();
  const scores = new Map<string, number>();
  for (const r of scoredRuns(store)) {
    scores.set(r.runId, r.score as number);
    for (const c of r.criteria ?? []) judge.set(`${r.runId}|${c.id}`, c.pass);
  }
  const problems: string[] = [];
  const human: boolean[] = [];
  const machine: boolean[] = [];
  const disagreements: CalibrationResult["disagreements"] = [];
  let unanswered = 0;
  for (const l of readJsonl<LabelRow>(path.join(dir, "labels.jsonl"))) {
    const j = judge.get(`${l.run_id}|${l.criterion}`);
    if (typeof l.pass !== "boolean") {
      unanswered++;
      continue;
    }
    if (j === undefined) continue;
    human.push(l.pass);
    machine.push(j);
    if (j !== l.pass) disagreements.push({ run_id: l.run_id, criterion: l.criterion, judge: j, human: l.pass });
  }
  if (unanswered) problems.push(`${unanswered} labels have no answer yet.`);
  const kappa = human.length ? cohenKappa(machine, human) : null;
  if (human.length < CALIBRATION_GATE.judgments) problems.push(`Only ${human.length} judgments. The gate needs at least ${CALIBRATION_GATE.judgments}.`);
  if (kappa !== null && kappa < CALIBRATION_GATE.kappa) problems.push(`Kappa is ${kappa.toFixed(2)}. The gate needs at least ${CALIBRATION_GATE.kappa}.`);

  let used = 0;
  let agree = 0;
  let ties = 0;
  for (const p of readJsonl<PairRow>(path.join(dir, "pairs.jsonl"))) {
    if (p.human === "tie") {
      ties++;
      continue;
    }
    if (p.human !== "a" && p.human !== "b") continue;
    const sa = scores.get(p.run_a);
    const sb = scores.get(p.run_b);
    if (sa === undefined || sb === undefined) continue;
    used++;
    // A judge tie on a pair that the human ranks counts as a wrong order.
    if ((p.human === "a" && sa > sb) || (p.human === "b" && sb > sa)) agree++;
  }
  if (used < CALIBRATION_GATE.pairs) problems.push(`Only ${used} pairs that are not a tie. The gate needs at least ${CALIBRATION_GATE.pairs}.`);
  else if (agree / used < CALIBRATION_GATE.pairAgreement) problems.push(`The judge order is right in ${agree} of ${used} pairs. The gate needs ${CALIBRATION_GATE.pairAgreement * 100}%.`);
  const pass = !problems.length;
  return { judgments: human.length, kappa: kappa === null ? null : Math.round(kappa * 1000) / 1000, pairsUsed: used, pairsAgree: agree, pairsTie: ties, pass, problems, disagreements };
}
