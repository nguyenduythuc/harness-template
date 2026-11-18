// Score of one deliverable (docs/plan.md, "Score của một deliverable"):
//   score = 100 · gate · (w_det · S_det + w_rub · S_rub)
//   gate  = build and typecheck pass (1) or not (0)
//   S_det = weighted mean in [0, 1] of hidden-test pass rate, lint, bundle size and load time
//   S_rub = weighted rubric that the LLM judge scores
// Scores exist only in the eval store. No function here writes into the project.

export interface SDetWeights {
  hidden_tests: number;
  lint: number;
  bundle: number;
  load: number;
}

export interface SDetParts {
  hidden_tests?: number | null;
  lint?: number | null;
  bundle?: number | null;
  load?: number | null;
}

/** 1 when the value did not increase, 0 at `maxIncrease` or more, linear between. */
export function linearScore(increase: number, maxIncrease: number): number {
  if (increase <= 0) return 1;
  if (maxIncrease <= 0 || increase >= maxIncrease) return 0;
  return 1 - increase / maxIncrease;
}

/** Weighted mean of the measured parts. A part that was not measured drops out, and the weights renormalize. */
export function sDet(parts: SDetParts, w: SDetWeights): number {
  let num = 0;
  let den = 0;
  for (const k of ["hidden_tests", "lint", "bundle", "load"] as const) {
    const v = parts[k];
    if (v === undefined || v === null) continue;
    if (v < 0 || v > 1) throw new Error(`S_det part ${k} must be in [0, 1], got ${v}`);
    num += w[k] * v;
    den += w[k];
  }
  return den > 0 ? num / den : 0;
}

export interface Criterion {
  id: string;
  weight: number;
  text: string;
}

export interface CriterionResult {
  id: string;
  pass: boolean;
  reason?: string;
}

/** Weighted rubric result. `missing` lists criteria that the judge did not answer: the run is then unscored. */
export function rubricScore(criteria: Criterion[], results: CriterionResult[]): { value: number; missing: string[] } {
  const byId = new Map(results.map((r) => [r.id, r]));
  const missing = criteria.filter((c) => !byId.has(c.id)).map((c) => c.id);
  const total = criteria.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return { value: 0, missing };
  const passed = criteria.reduce((a, c) => a + (byId.get(c.id)?.pass ? c.weight : 0), 0);
  return { value: passed / total, missing };
}

export interface ScoreInput {
  scoreGate: 0 | 1;
  sDet: number;
  sRub: number;
  wDet: number;
  wRub: number;
}

export function score(i: ScoreInput): number {
  const wSum = i.wDet + i.wRub;
  if (wSum <= 0) throw new Error("w_det + w_rub must be positive");
  return 100 * i.scoreGate * ((i.wDet * i.sDet + i.wRub * i.sRub) / wSum);
}

/** Parse rubric.md lines of the form "- [criterion-id] (weight) criterion text". */
export function parseRubric(text: string): Criterion[] {
  const out: Criterion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[([\w.-]+)\]\s*\((\d+(?:\.\d+)?)\)\s*(.+?)\s*$/);
    if (m) out.push({ id: m[1] as string, weight: Number(m[2]), text: m[3] as string });
  }
  const ids = out.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`rubric has a duplicate criterion id: ${dup}`);
  return out;
}
