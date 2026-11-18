// Tests of the benchmark history and dashboard.

import { test } from "node:test";
import { withEpisodes } from "../src/extras/episode.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { collectHistory, refreshDashboard, epochId, esc, estimatesSvg, templateLabel, writeBenchmarks } from "../src/extras/bench.js";
import type { BenchHistory } from "../src/extras/bench.js";
import { loadCtx } from "../src/kernel/ctx.js";
import { measure } from "../src/kernel/measure.js";
import { evalRound } from "../src/loop/round.js";
import { runTask } from "../src/loop/pipeline.js";
import { fakeQuery, fixture } from "./helpers.js";

test("labels, epochs and escaping", () => {
  assert.equal(templateLabel({ plugin_version: "0.1.0", plugin_sha: "abcdef1234567" }), "0.1.0@abcdef12");
  assert.equal(templateLabel(null), "?@unknown");
  const e = { h0_sha: "a", models: { executor: "x", editor: "y", judge: "z" }, claude_code_version: "2.1.295", plugin_sha: "s" };
  assert.equal(epochId(e), epochId({ ...e }));
  assert.notEqual(epochId(e), epochId({ ...e, claude_code_version: "2.1.300" }));
  assert.equal(esc(`<b a="1">&'`), "&lt;b a=&quot;1&quot;&gt;&amp;&#39;");
});

test("no data: no chart, and the page shows an empty state", () => {
  const h: BenchHistory = { schema: 1, generated_at: "2026-10-24T00:00:00Z", current: null, rounds: [], production: [], lessons: [] };
  assert.equal(estimatesSvg(h, 3), null);
});

test("measure, an eval round and a production run fill the one dashboard page", async () => {
  const f = await fixture(3);
  const ctx = loadCtx(f.project, { requireEvalStore: true });
  const q = fakeQuery();
  const m = await measure(ctx, { m: 2 }, withEpisodes({ queryFn: q }));
  assert.equal(m.dashboardPath, undefined, "the kernel does not write the dashboard");
  const d = refreshDashboard(ctx);
  assert.ok(d && fs.existsSync(d), "the CLI updates the dashboard after measure");
  const r = await evalRound(ctx, { split: "dev", decision: "phase 3 smoke <script>", m: 1, noLibraryArm: true }, withEpisodes({ queryFn: q }));
  assert.equal(r.dashboardPath, undefined);
  await runTask(ctx, { id: "prod", taskMd: "Do x.", taskType: "feature", mode: "production", split: null, baseSha: null, force: "improve" }, withEpisodes({ queryFn: q }));

  const out = writeBenchmarks(f.store, ctx, 3);
  assert.equal(out.dashboard, path.join(f.store, "benchmarks.html"), "one page, in the eval store");
  assert.equal(out.rounds, 2);
  const h = collectHistory(f.store, ctx);
  assert.deepEqual(h.rounds.map((x) => x.kind), ["measure", "round"]);
  const round = h.rounds[1];
  assert.deepEqual(round?.estimates.map((e) => e.name), ["E1", "E1 without library", "library effect"]);
  assert.ok(round?.arms.some((a) => a.arm === "pipeline" && a.meanScore !== null));
  assert.equal(h.rounds[0]?.epoch, h.current?.epoch, "both rounds are in the current epoch");
  assert.equal(h.production.length, 1);
  assert.equal(h.production[0]?.runs, 1);
  assert.ok(h.lessons.length >= 1, "efficiency rows from the lesson store");

  const html = fs.readFileSync(out.dashboard, "utf8");
  assert.doesNotMatch(html, /<script/i, "no JavaScript, and the decision text is escaped");
  assert.match(html, /phase 3 smoke &lt;script&gt;/);
  assert.match(html, /Ước lượng của từng đợt eval/);
  assert.match(html, /Lịch sử version/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.equal((html.match(/<svg /g) ?? []).length, 2, "the two charts are inside the page");
  assert.deepEqual(fs.readdirSync(f.store).filter((n) => /bench/i.test(n)), ["benchmarks.html"], "no other benchmark file");
  assert.equal(collectHistory(f.store, null).current, null, "the store alone has no current version");
  assert.equal(fs.existsSync(path.join(f.project, "benchmarks.html")), false, "nothing in the project");

  if (process.env.HARNESS_BENCH_SAMPLE) fs.copyFileSync(out.dashboard, process.env.HARNESS_BENCH_SAMPLE);
});
