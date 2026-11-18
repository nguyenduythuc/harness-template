// Tests of the judge calibration helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { calibrationTemplate, checkCalibration, cohenKappa, scoredRuns } from "../src/kernel/calibrate.js";
import type { LabelRow, PairRow } from "../src/kernel/calibrate.js";
import { loadCtx } from "../src/kernel/ctx.js";
import { measure } from "../src/kernel/measure.js";
import { fakeQuery, fixture } from "./helpers.js";

test("Cohen's kappa", () => {
  assert.equal(cohenKappa([true, true, false, false], [true, true, false, false]), 1);
  // po = 0.75, pe = 0.5 * 0.25 + 0.5 * 0.75 = 0.5, kappa = 0.5
  assert.equal(cohenKappa([true, true, false, false], [true, false, false, false]), 0.5);
  assert.equal(cohenKappa([true, true], [true, true]), 1);
  assert.throws(() => cohenKappa([], []));
});

test("template and check: the judge evidence is in the eval store, and a matching human gives kappa 1", async () => {
  const f = await fixture(0);
  const ctx = loadCtx(f.project, { requireEvalStore: true });
  await measure(ctx, { m: 2 }, { queryFn: fakeQuery() });
  const runs = scoredRuns(f.store);
  assert.equal(runs.length, 4);
  for (const r of runs) assert.ok(fs.existsSync(path.join(f.store, r.diff as string)), "the judged diff is in the eval store");

  const t = calibrationTemplate(f.store, { runs: 4, pairs: 4, seed: 3 });
  assert.equal(t.labels, 8, "4 runs x 2 criteria");
  assert.equal(t.pairs, 2, "2 tasks x 1 pair");

  // The human gives the same answers as the judge, and ranks each pair by the judge score.
  const judge = new Map(runs.flatMap((r) => (r.criteria ?? []).map((c) => [`${r.runId}|${c.id}`, c.pass] as const)));
  const score = new Map(runs.map((r) => [r.runId, r.score as number]));
  const labelsFile = path.join(t.dir, "labels.jsonl");
  const labels = fs.readFileSync(labelsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as LabelRow);
  fs.writeFileSync(labelsFile, labels.map((l) => JSON.stringify({ ...l, pass: judge.get(`${l.run_id}|${l.criterion}`) })).join("\n") + "\n");
  const pairsFile = path.join(t.dir, "pairs.jsonl");
  const pairs = fs.readFileSync(pairsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as PairRow);
  fs.writeFileSync(
    pairsFile,
    pairs.map((p) => {
      const a = score.get(p.run_a) as number;
      const b = score.get(p.run_b) as number;
      return JSON.stringify({ ...p, human: a === b ? "tie" : a > b ? "a" : "b" });
    }).join("\n") + "\n",
  );

  const c = checkCalibration(f.store, t.dir);
  assert.equal(c.judgments, 8);
  assert.equal(c.kappa, 1);
  assert.equal(c.disagreements.length, 0);
  assert.equal(c.pass, false, "8 judgments and 2 pairs are below the gate");
  assert.ok(c.problems.some((p) => /at least 50/.test(p)));
  assert.ok(c.problems.some((p) => /at least 10/.test(p)));
});
