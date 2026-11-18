// The statistical rule and the eval-set sizing (docs/plan.md, "Thước đo").
//
// For each task t, d_t = mean score of the new arm - mean score of the old arm, over m runs per arm.
// On n tasks, with a paired one-sided t interval at 90% (df = n - 1):
//   Pass:          lower bound > 0 and mean >= delta_min
//   Worse:         upper bound < 0                        (rollback, Phase 2 gate)
//   Fail:          upper bound < delta_min                (Worse is a special case of Fail)
//   Inconclusive:  every other result. Only Pass adopts a change.

/** One-sided 90% t quantiles for df = 1..30 (scipy.stats.t.ppf(0.9, df)). */
export const T90: readonly number[] = [
  3.07768, 1.88562, 1.63774, 1.53321, 1.47588, 1.43976, 1.41492, 1.39682, 1.38303, 1.37218, 1.36343, 1.35622, 1.35017, 1.34503, 1.34061, 1.33676,
  1.33338, 1.33039, 1.32773, 1.32534, 1.32319, 1.32124, 1.31946, 1.31784, 1.31635, 1.31497, 1.3137, 1.31253, 1.31143, 1.31042,
];

/** One-sided 90% t quantile. Above df = 30 the Cornish-Fisher correction of z keeps the error below 0.001. */
export function t90(df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error(`df must be a positive integer, got ${df}`);
  if (df <= T90.length) return T90[df - 1] as number;
  const z = 1.2815516;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df * df);
}

export function mean(xs: number[]): number {
  if (!xs.length) throw new Error("mean of an empty list");
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1). */
export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export type Outcome = "pass" | "fail" | "worse" | "inconclusive";

export interface RuleResult {
  n: number;
  mean: number;
  sd: number;
  se: number;
  lower: number;
  upper: number;
  outcome: Outcome;
}

/** Apply the paired rule to per-task differences d_t. */
export function pairedRule(diffs: number[], deltaMin: number): RuleResult {
  if (diffs.length < 2) throw new Error("the paired rule needs 2 or more tasks");
  const n = diffs.length;
  const m = mean(diffs);
  const s = sd(diffs);
  const se = s / Math.sqrt(n);
  const t = t90(n - 1);
  const lower = m - t * se;
  const upper = m + t * se;
  let outcome: Outcome;
  if (lower > 0 && m >= deltaMin) outcome = "pass";
  else if (upper < 0) outcome = "worse";
  else if (upper < deltaMin) outcome = "fail";
  else outcome = "inconclusive";
  return { n, mean: m, sd: s, se, lower, upper, outcome };
}

/** Per-task differences from scores of two arms: arms[task] = { new: number[], old: number[] }. */
export function taskDiffs(arms: Record<string, { new: number[]; old: number[] }>): number[] {
  return Object.values(arms)
    .filter((a) => a.new.length > 0 && a.old.length > 0)
    .map((a) => mean(a.new) - mean(a.old));
}

/** SD of d_t from its parts: sqrt(sigma_int^2 + 2 sigma_run^2 / m). */
export function sdOfDiff(sigmaInt: number, sigmaRun: number, m: number): number {
  return Math.sqrt(sigmaInt ** 2 + (2 * sigmaRun ** 2) / m);
}

/** Pooled within-task SD of repeated runs (sigma_run). groups[t] = scores of the m runs on task t. */
export function pooledSigmaRun(groups: number[][]): number {
  let num = 0;
  let den = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    num += (g.length - 1) * sd(g) ** 2;
    den += g.length - 1;
  }
  return den > 0 ? Math.sqrt(num / den) : 0;
}

/** mulberry32: the same PRNG as docs/flow-sheet.html, so both give the same MDE80. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const simCache = new Map<string, { zb: Float64Array; sz: Float64Array }>();

function standardSims(n: number, nsim: number, seed: number): { zb: Float64Array; sz: Float64Array } {
  const key = `${n}:${nsim}:${seed}`;
  const hit = simCache.get(key);
  if (hit) return hit;
  const r = mulberry32(seed + n * 101);
  let spare: number | null = null;
  const z = (): number => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = r();
    const v = r();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
  const zb = new Float64Array(nsim);
  const sz = new Float64Array(nsim);
  for (let i = 0; i < nsim; i++) {
    let s1 = 0;
    let s2 = 0;
    for (let j = 0; j < n; j++) {
      const x = z();
      s1 += x;
      s2 += x * x;
    }
    const m = s1 / n;
    zb[i] = m;
    sz[i] = Math.sqrt(Math.max(0, (s2 - n * m * m) / (n - 1)));
  }
  const out = { zb, sz };
  simCache.set(key, out);
  return out;
}

/**
 * For each simulated round, the smallest true gain at which the full rule passes. Sorted ascending.
 * A round passes at gain g when g > sd·(t·s_z/√n − z̄) and g ≥ delta_min − sd·z̄.
 */
export function passThresholds(n: number, sdDiff: number, deltaMin: number, nsim = 20000, seed = 9137): Float64Array {
  if (n < 2) throw new Error("n must be 2 or more");
  const { zb, sz } = standardSims(n, nsim, seed);
  const t = t90(n - 1);
  const q = Math.sqrt(n);
  const out = new Float64Array(nsim);
  for (let i = 0; i < nsim; i++) {
    const a = sdDiff * ((t * (sz[i] as number)) / q - (zb[i] as number));
    const b = deltaMin - sdDiff * (zb[i] as number);
    out[i] = a > b ? a : b;
  }
  out.sort();
  return out;
}

/** MDE80: the smallest true gain that the full rule finds in 80% of rounds. */
export function mde80(n: number, sdDiff: number, deltaMin: number, nsim = 20000, seed = 9137): number {
  const th = passThresholds(n, sdDiff, deltaMin, nsim, seed);
  return th[Math.floor(0.8 * th.length)] as number;
}

/** Probability that the rule gives Pass when the true gain is `gain`. */
export function passProbability(n: number, sdDiff: number, deltaMin: number, gain: number, nsim = 20000, seed = 9137): number {
  const th = passThresholds(n, sdDiff, deltaMin, nsim, seed);
  let lo = 0;
  let hi = th.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((th[mid] as number) < gain) lo = mid + 1;
    else hi = mid;
  }
  return lo / th.length;
}

/** The MDE80 table of the plan: rows n, columns SD of d_t. */
export function mdeTable(ns: number[], sds: number[], deltaMin: number): { n: number; values: number[] }[] {
  return ns.map((n) => ({ n, values: sds.map((s) => Math.round(mde80(n, s, deltaMin) * 10) / 10) }));
}
