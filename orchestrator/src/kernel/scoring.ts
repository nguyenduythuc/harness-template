// Score one eval deliverable: script part (gate, S_det) plus one judge call (S_rub).
// The result goes to the eval store only. A failure of the infrastructure or of the judge makes the
// run "unscored": the caller drops the pair from both arms and counts it (docs/plan.md, K12).

import fs from "node:fs";
import path from "node:path";
import type { EvalTask, Weights } from "./evalstore.js";
import type { GateResult, ShellRunner } from "./gate.js";
import { runGate } from "./gate.js";
import { buildJudgePrompt, JUDGE_SCHEMA, parseJudgeOutput } from "./judge.js";
import type { SessionRunner } from "./runner.js";
import { linearScore, rubricScore, score, sDet } from "./score.js";
import type { CriterionResult } from "./score.js";
import { runShell } from "../util/exec.js";
import { copyHiddenTests } from "./workspace.js";
import { readJson } from "../util/fs.js";

export interface ScoreResult {
  scored: boolean;
  reason: string | null;
  score: number | null;
  gate: GateResult;
  parts: { hidden_tests: number | null; lint: number | null; bundle: number | null; load: number | null; s_det: number; s_rub: number | null };
  criteria: CriterionResult[];
  /** The last lines of the hidden test output, so that a human can see why the tests failed (eval store only). */
  hiddenTail?: string | null;
}

function lastNumber(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?(?=[^\d]*$)/);
  return m ? Number(m[0]) : null;
}

export async function hiddenTestRate(task: EvalTask, ws: string, shell: ShellRunner, timeoutMs: number): Promise<{ rate: number | null; tail: string | null }> {
  const ht = task.meta.hidden_tests;
  if (!ht || !task.hiddenTestsDir) return { rate: null, tail: null };
  copyHiddenTests(task.hiddenTestsDir, ws, ht.copy_to);
  const r = await shell(ht.command, { cwd: ws, timeoutMs, tailChars: 4000 });
  // 2000 characters: the cause of a startup error is above several stack frames (R7).
  const tail = (r.stdout + "\n" + r.stderr).trim().slice(-2000);
  if (ht.report === "jest-json") {
    const file = path.join(ws, ht.report_file ?? path.join(ht.copy_to, "result.json"));
    const j = readJson<{ numTotalTests?: number; numPassedTests?: number } | null>(file, null);
    if (!j || !j.numTotalTests) return { rate: r.code === 0 ? 1 : 0, tail };
    return { rate: (j.numPassedTests ?? 0) / j.numTotalTests, tail };
  }
  return { rate: r.code === 0 && !r.timedOut ? 1 : 0, tail };
}

export interface ScoreArgs {
  runner: SessionRunner;
  task: EvalTask;
  weights: Weights;
  judgeMd: string;
  workspace: string;
  diff: string;
  label: string;
  shell?: ShellRunner;
  /**
   * The gate result that the pipeline got on this workspace. Scoring uses it and does not run the
   * gate again. CAUTION: when scoring moves to the clean container of D9, it must run the gate there.
   */
  gate?: GateResult | null;
}

export async function scoreDeliverable(a: ScoreArgs): Promise<ScoreResult> {
  const shell = a.shell ?? runShell;
  const cfg = a.runner.ctx.config;
  const gate = a.gate ?? (await runGate(a.workspace, cfg.gate, shell));
  const base: ScoreResult = {
    scored: false,
    reason: null,
    score: null,
    gate,
    parts: { hidden_tests: null, lint: null, bundle: null, load: null, s_det: 0, s_rub: null },
    criteria: [],
  };
  if (gate.todo.length) return { ...base, reason: `gate has TODO commands: ${gate.todo.join(", ")}` };

  const timeoutMs = cfg.gate.timeout_s * 1000;
  try {
    const ht = await hiddenTestRate(a.task, a.workspace, shell, timeoutMs);
    base.parts.hidden_tests = ht.rate;
    base.hiddenTail = ht.tail;
  } catch (err) {
    return { ...base, reason: `hidden tests failed to run: ${String(err)}` };
  }
  const lintCmd = gate.commands.find((c) => c.key === "lint");
  base.parts.lint = lintCmd ? (lintCmd.code === 0 ? 1 : 0) : null;
  if (a.task.meta.bundle) {
    const r = await shell(a.task.meta.bundle.command, { cwd: a.workspace, timeoutMs, tailChars: 2000 });
    const kb = r.code === 0 ? lastNumber(r.stdout) : null;
    base.parts.bundle = kb === null ? null : linearScore(kb - a.task.meta.bundle.baseline_kb, a.weights.bundle_max_increase_kb);
  }
  if (a.task.meta.load) {
    const r = await shell(a.task.meta.load.command, { cwd: a.workspace, timeoutMs, tailChars: 2000 });
    const ms = r.code === 0 ? lastNumber(r.stdout) : null;
    base.parts.load = ms === null ? null : linearScore(ms - a.task.meta.load.baseline_ms, a.weights.load_max_increase_ms);
  }
  base.parts.s_det = sDet(base.parts, a.weights.s_det_weights);

  const checks = [
    ...gate.commands.map((c) => ({ name: c.key, result: c.code === 0 ? "pass" : `fail (exit ${c.code})` })),
    ...(base.parts.hidden_tests !== null ? [{ name: "hidden tests pass rate", result: base.parts.hidden_tests.toFixed(2) }] : []),
  ];
  const prompt = buildJudgePrompt(a.judgeMd, a.task.taskMd, a.task.criteria, { diff: a.diff, checks });
  const judgeDir = path.join(a.runner.rp.workDir, "judge", a.label);
  fs.mkdirSync(judgeDir, { recursive: true });
  let results: CriterionResult[] | null = null;
  for (let attempt = 0; attempt < 2 && !results; attempt++) {
    const out = await a.runner.run({
      role: "judge",
      label: `judge-${a.label}${attempt ? "-again" : ""}`,
      cwd: judgeDir,
      prompt,
      writeRoots: [],
      outputSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
      retry: false,
    });
    if (!out) return { ...base, reason: "the budget stopped the judge" };
    if (out.status !== "ok") continue;
    const parsed = parseJudgeOutput(out.structured, out.resultText);
    if (parsed && rubricScore(a.task.criteria, parsed).missing.length === 0) results = parsed;
  }
  if (!results) return { ...base, reason: "the judge did not answer every criterion in two attempts" };
  const rub = rubricScore(a.task.criteria, results);
  base.parts.s_rub = rub.value;
  base.criteria = results;
  const value = score({ scoreGate: gate.scoreGate, sDet: base.parts.s_det, sRub: rub.value, wDet: a.weights.w_det, wRub: a.weights.w_rub });
  return { ...base, scored: true, score: Math.round(value * 100) / 100 };
}
