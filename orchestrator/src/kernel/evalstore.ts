// The eval store: a private repo outside every project (docs/plan.md, layout "Eval store").
// No agent reads it. Only the orchestrator (to give rubric and evidence to the judge), the judge and
// the human read it. The orchestrator path comes from the user config, never from a project file.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { appendJsonl, ensureDir, writeIfMissing, writeJson, readJson } from "../util/fs.js";
import { mulberry32 } from "./stats.js";
import type { Criterion, SDetWeights } from "./score.js";
import { parseRubric } from "./score.js";

export const WeightsSchema = z.object({
  w_det: z.number().min(0),
  w_rub: z.number().min(0),
  delta_min: z.number().positive(),
  delta_target: z.number().positive(),
  s_det_weights: z.object({ hidden_tests: z.number().min(0), lint: z.number().min(0), bundle: z.number().min(0), load: z.number().min(0) }),
  bundle_max_increase_kb: z.number().positive(),
  load_max_increase_ms: z.number().positive(),
  min_gain_per_mtok: z.number().min(0),
  /** Phase 6, route "more efficient": the score of R′ may drop by at most this many points (90% lower bound of E3). */
  delta_eff: z.number().positive().default(5),
  /** Phase 6, route "more efficient": the tokens of R′ for each task, as a fraction of the tokens of R, at most. */
  efficiency_token_ratio_max: z.number().positive().max(1).default(0.85),
});
export type Weights = z.infer<typeof WeightsSchema>;

export const MetaSchema = z.object({
  task_type: z.string().min(1),
  hidden_tests: z
    .object({
      copy_to: z.string().default("__hidden_tests__"),
      command: z.string(),
      report: z.enum(["jest-json", "exit-code"]).default("exit-code"),
      report_file: z.string().optional(),
    })
    .optional(),
  bundle: z.object({ command: z.string(), baseline_kb: z.number() }).optional(),
  load: z.object({ command: z.string(), baseline_ms: z.number() }).optional(),
});
export type TaskMeta = z.infer<typeof MetaSchema>;

export interface EvalTask {
  id: string;
  dir: string;
  taskMd: string;
  baseSha: string;
  criteria: Criterion[];
  meta: TaskMeta;
  hiddenTestsDir: string | null;
}

export interface Split {
  seed: number;
  dev: string[];
  holdout: string[];
}

const DEFAULT_WEIGHTS = `# Thresholds and weights. A human writes them BEFORE any measurement.
# Change them only through a reviewed commit in this repo, never during an open decision.
w_det: 0.5
w_rub: 0.5
delta_min: 3          # smallest gain that the rule adopts (points)
delta_target: 8       # MDE80 goal for the Phase 0 gate (points)
s_det_weights:
  hidden_tests: 0.6
  lint: 0.2
  bundle: 0.1
  load: 0.1
bundle_max_increase_kb: 50   # S_det bundle part is 0 at this increase or more
load_max_increase_ms: 200    # S_det load part is 0 at this increase or more
min_gain_per_mtok: 1         # Phase 5 gate: points of E1 per million extra tokens
delta_eff: 5                 # Phase 6 "more efficient" route: largest score drop allowed (90% lower bound of E3)
efficiency_token_ratio_max: 0.85   # Phase 6 "more efficient" route: tokens of R′ per task / tokens of R
`;

const DEFAULT_JUDGE = `You are the judge of one deliverable. You did not make it, and you do not know which harness made it.

You get:
- TASK: the request, word for word.
- RUBRIC: a list of criteria. Each has an id.
- EVIDENCE: the diff of the deliverable, and the results of the deterministic checks.

For each criterion, decide pass (true) or not (false) from the evidence only. If the evidence does not show that the criterion is met, the answer is false. Give one short reason per criterion.

Do not score style or length unless a criterion names it. Do not reward a longer diff.
Reply only with the JSON object that the output format asks for, with one entry for each criterion id.
`;

const README = `# Eval store

A private repo outside every project. No agent reads it. The harness orchestrator reads it to give the
rubric and the evidence to the judge, and writes score reports into reports/.

- tasks/<task-id>/: task.md, base_sha, rubric.md, meta.yaml, hidden-tests/, and optional solution/
  (a correct deliverable: files at their repo paths, for \`harness eval-check\`)
- split.json: dev and holdout task IDs, stratified by task_type, with the seed
- holdout-ledger.md: one line for each use of the holdout
- judge.md, weights.yaml: the judge prompt; weights and thresholds
- canaries.txt: unique strings that must never appear in an agent trace
- drafts/: draft tasks from merged PRs, waiting for review
- reports/: scores and reports of each eval round
- checks/: reports of \`harness eval-check\` (gate and hidden tests at base and on the reference)

rubric.md format, one criterion per line: \`- [criterion-id] (weight) criterion text\`
`;

/** Make the skeleton of an eval store. Create-only: it never overwrites a file. Returns the created paths. */
export function initEvalStore(dir: string): string[] {
  const created: string[] = [];
  const mk = (rel: string, content: string): void => {
    if (writeIfMissing(path.join(dir, rel), content)) created.push(rel);
  };
  ensureDir(path.join(dir, "tasks"));
  ensureDir(path.join(dir, "drafts"));
  ensureDir(path.join(dir, "reports"));
  mk("README.md", README);
  mk("weights.yaml", DEFAULT_WEIGHTS);
  mk("judge.md", DEFAULT_JUDGE);
  mk("split.json", JSON.stringify({ seed: crypto.randomInt(1, 2 ** 31 - 1), dev: [], holdout: [] }, null, 2) + "\n");
  mk("holdout-ledger.md", "# Holdout ledger\n\n| date | decision | result | report |\n| --- | --- | --- | --- |\n");
  mk("canaries.txt", Array.from({ length: 5 }, () => `HARNESS-CANARY-${crypto.randomBytes(12).toString("hex")}`).join("\n") + "\n");
  mk("tasks/.gitkeep", "");
  mk("drafts/.gitkeep", "");
  mk("reports/.gitkeep", "");
  return created;
}

export function loadWeights(dir: string): Weights {
  const file = path.join(dir, "weights.yaml");
  const r = WeightsSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")) as unknown);
  if (!r.success) throw new Error(`${file} is not valid: ${r.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return r.data;
}

export function sDetWeights(w: Weights): SDetWeights {
  return w.s_det_weights;
}

export function listTaskIds(dir: string): string[] {
  const t = path.join(dir, "tasks");
  if (!fs.existsSync(t)) return [];
  return fs
    .readdirSync(t, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function loadTask(dir: string, id: string): EvalTask {
  const tdir = path.join(dir, "tasks", id);
  const read = (f: string): string => fs.readFileSync(path.join(tdir, f), "utf8");
  // Name the file in the error: a raw YAML or schema error does not say which task is wrong.
  let meta: TaskMeta;
  try {
    meta = MetaSchema.parse(YAML.parse(read("meta.yaml")) as unknown);
  } catch (err) {
    throw new Error(`tasks/${id}/meta.yaml is not valid: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const baseSha = read("base_sha").trim();
  if (!/^[0-9a-f]{7,40}$/.test(baseSha)) throw new Error(`tasks/${id}/base_sha is not a git SHA`);
  const criteria = parseRubric(read("rubric.md"));
  if (!criteria.length) throw new Error(`tasks/${id}/rubric.md has no criteria in the form "- [id] (weight) text"`);
  const hidden = path.join(tdir, "hidden-tests");
  return { id, dir: tdir, taskMd: read("task.md"), baseSha, criteria, meta, hiddenTestsDir: fs.existsSync(hidden) ? hidden : null };
}

export function loadSplit(dir: string): Split {
  return readJson<Split>(path.join(dir, "split.json"), { seed: 1, dev: [], holdout: [] });
}

/**
 * Stratified split by task_type: about 1/3 holdout in each stratum, and at least one holdout task in
 * each stratum. Deterministic for a seed.
 */
export function makeSplit(tasks: { id: string; taskType: string }[], seed: number): Split {
  const rand = mulberry32(seed);
  const byType = new Map<string, string[]>();
  for (const t of tasks) byType.set(t.taskType, [...(byType.get(t.taskType) ?? []), t.id]);
  const dev: string[] = [];
  const holdout: string[] = [];
  for (const type of [...byType.keys()].sort()) {
    const ids = [...(byType.get(type) as string[])].sort();
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
    }
    const k = Math.max(1, Math.round(ids.length / 3));
    holdout.push(...ids.slice(0, k));
    dev.push(...ids.slice(k));
  }
  return { seed, dev: dev.sort(), holdout: holdout.sort() };
}

export function writeSplit(dir: string, split: Split): void {
  writeJson(path.join(dir, "split.json"), split);
}

export function loadCanaries(dir: string): string[] {
  const f = path.join(dir, "canaries.txt");
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && !s.startsWith("#"));
}

/** Canary strings that appear in `text`. A hit means that an agent read the eval store. */
export function canaryHits(text: string, canaries: string[]): string[] {
  return canaries.filter((c) => text.includes(c));
}

/** Append one line to the holdout ledger. */
export function ledgerAppend(dir: string, decision: string, result: string, report: string): void {
  fs.appendFileSync(path.join(dir, "holdout-ledger.md"), `| ${new Date().toISOString().slice(0, 10)} | ${decision} | ${result} | ${report} |\n`);
}

/** Append one score line to an eval report. Scores live only here. */
export function appendScore(reportDir: string, row: Record<string, unknown>): void {
  appendJsonl(path.join(reportDir, "scores.jsonl"), { ts: new Date().toISOString(), ...row });
}
