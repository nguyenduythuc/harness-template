// Unit tests of the pure parts of the orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Budget } from "../src/kernel/budget.js";
import { parseProjectConfig } from "../src/kernel/config.js";
import { canaryHits, initEvalStore, loadTask, makeSplit } from "../src/kernel/evalstore.js";
import { signalWarnings } from "../src/kernel/measure.js";
import { pairArms, taskFlips } from "../src/loop/round.js";
import type { ArmRun } from "../src/kernel/measure.js";
import type { HTree } from "../src/kernel/htree.js";
import { diffH, hToProject, inventory, projectToH, promptSize, treeHash, unsafeH, validateH } from "../src/kernel/htree.js";
import { compareVersions } from "../src/kernel/lock.js";
import { classifyPath } from "../src/kernel/ownership.js";
import { reuseEvent, reuseMatches } from "../src/loop/reuse.js";
import { linearScore, parseRubric, rubricScore, score, sDet } from "../src/kernel/score.js";
import { mde80, pairedRule, passProbability, pooledSigmaRun, sdOfDiff, t90 } from "../src/kernel/stats.js";
import { componentsUsed, normalizeTrace } from "../src/kernel/trace.js";
import { componentStats, reportText, UNUSED_MIN_RUNS } from "../src/kernel/report.js";
import type { ProjectReport } from "../src/kernel/report.js";
import type { RunRecord } from "../src/kernel/runs.js";
import { p75, signals } from "../src/loop/trigger.js";
import { hashDir } from "../src/util/fs.js";
import { runShell } from "../src/util/exec.js";
import { keyLines } from "../src/kernel/evalcheck.js";
import { runGate, summary } from "../src/kernel/gate.js";
import { noneGateKeys, todoGateKeys } from "../src/kernel/config.js";
import { installPack, listPacks, mergeJson } from "../src/kernel/pack.js";
import { ciGuardCheck } from "../src/kernel/doctor.js";
import { ciCopies, ciHost } from "../src/kernel/admin.js";
import { evidence } from "../src/kernel/evidence.js";
import type { ProjectConfig } from "../src/kernel/config.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const pluginDir = path.join(repoRoot, "plugins", "harness");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "harness-unit-"));
const near = (a: number, b: number, tol: number, msg?: string): void => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} ${a} is not within ${tol} of ${b}`);
const tree = (o: Record<string, string>): HTree => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

// --- stats ---------------------------------------------------------------------------------

test("t90 matches scipy and the Cornish-Fisher tail", () => {
  near(t90(1), 3.0777, 1e-4);
  near(t90(9), 1.383, 1e-3);
  near(t90(29), 1.3114, 1e-4);
  near(t90(40), 1.3031, 1e-3);
  near(t90(120), 1.2886, 1e-3);
  assert.throws(() => t90(0));
});

test("paired rule outcomes", () => {
  assert.equal(pairedRule([10, 12, 9, 11, 10], 3).outcome, "pass");
  assert.equal(pairedRule([-10, -12, -9, -11, -10], 3).outcome, "worse");
  assert.equal(pairedRule([1, 1.2, 0.8, 1.1, 0.9], 3).outcome, "fail");
  assert.equal(pairedRule([10, -8, 15, -12, 4], 3).outcome, "inconclusive");
  // A gain above zero but below delta_min is not a pass, even with a tight interval.
  assert.notEqual(pairedRule([2, 2.1, 1.9, 2, 2], 3).outcome, "pass");
});

test("MDE80 matches the table in docs/plan.md", () => {
  near(mde80(5, 16, 3), 17.1, 0.3, "n5 sd16");
  near(mde80(10, 12, 3), 8.5, 0.3, "n10 sd12");
  near(mde80(10, 8, 3), 5.8, 0.3, "n10 sd8");
  near(mde80(20, 8, 3), 4.5, 0.3, "n20 sd8");
  near(passProbability(10, 12, 3, 4), 0.39, 0.03, "P(pass) gain 4");
  near(passProbability(5, 12, 3, 4), 0.27, 0.03, "P(pass) gain 4, n5");
  near(sdOfDiff(5, 10, 3), 9.6, 0.05);
});

test("pooled sigma_run", () => {
  near(pooledSigmaRun([[10, 12, 14], [50, 52, 54]]), 2, 1e-9);
  assert.equal(pooledSigmaRun([[1], []]), 0);
});

// --- score ---------------------------------------------------------------------------------

test("score parts", () => {
  assert.equal(linearScore(-5, 50), 1);
  assert.equal(linearScore(25, 50), 0.5);
  assert.equal(linearScore(80, 50), 0);
  const w = { hidden_tests: 0.6, lint: 0.2, bundle: 0.1, load: 0.1 };
  near(sDet({ hidden_tests: 1, lint: 0 }, w), 0.75, 1e-9);
  assert.equal(sDet({}, w), 0);
  assert.throws(() => sDet({ lint: 2 }, w));
  assert.equal(score({ scoreGate: 0, sDet: 1, sRub: 1, wDet: 0.5, wRub: 0.5 }), 0);
  assert.equal(score({ scoreGate: 1, sDet: 1, sRub: 0.5, wDet: 0.5, wRub: 0.5 }), 75);
});

test("rubric parse and score", () => {
  const c = parseRubric("intro\n- [spec] (2) Does what the task asks\n- [tests] (1) Adds a test\nnot a line");
  assert.deepEqual(c.map((x) => x.id), ["spec", "tests"]);
  const r = rubricScore(c, [{ id: "spec", pass: true }, { id: "tests", pass: false }]);
  near(r.value, 2 / 3, 1e-9);
  assert.deepEqual(rubricScore(c, [{ id: "spec", pass: true }]).missing, ["tests"]);
  assert.throws(() => parseRubric("- [a] (1) x\n- [a] (1) y"));
});

// --- budget and trigger ---------------------------------------------------------------------

test("budget shares the remainder and keeps headroom", () => {
  const b = new Budget(5, 1000, 0.5);
  near(b.allocate(2), 2.25, 1e-9);
  b.record(4.4, { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal(b.exhausted(), false);
  b.record(0.2, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal(b.exhausted(), true);
  const t = new Budget(100, 50, 0);
  t.record(0, { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.equal(t.exhausted(), true);
});

function fakeTrace(calls: { name: string; input: Record<string, unknown>; output?: string; isError?: boolean }[]) {
  const msgs: unknown[] = [];
  calls.forEach((c, i) => {
    msgs.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }] } });
    msgs.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: c.isError ?? false, content: c.output ?? "" }] } });
  });
  return normalizeTrace(msgs);
}

test("decision 1 signals", () => {
  const ok = fakeTrace([
    { name: "Write", input: { file_path: "/w/a.ts" } },
    { name: "Bash", input: { command: "npm test" }, output: "ok" },
  ]);
  assert.equal(signals(ok, 100, { toolErrorsMin: 3, p75: null }).weak, false);
  const failedCheck = fakeTrace([
    { name: "Write", input: { file_path: "/w/a.ts" } },
    { name: "Bash", input: { command: "npm test" }, output: "Exit code 1", isError: true },
  ]);
  assert.ok(signals(failedCheck, 100, { toolErrorsMin: 3, p75: null }).signals.some((s) => s.startsWith("check_failed")));
  const noVerify = fakeTrace([{ name: "Write", input: { file_path: "/w/a.ts" } }]);
  assert.ok(signals(noVerify, 100, { toolErrorsMin: 3, p75: null }).signals.some((s) => s.startsWith("no_self_verify")));
  assert.ok(signals(ok, 5000, { toolErrorsMin: 3, p75: { steps: 1, tokens: 1000 } }).signals.length === 2);
  assert.equal(p75([1, 2, 3, 4]), 3);
  assert.equal(p75([]), 0);
});

// --- H tree --------------------------------------------------------------------------------

test("H paths map both ways and skip pinned files", () => {
  assert.equal(projectToH("harness/instructions.md"), "instructions.md");
  assert.equal(projectToH(".claude/skills/x/SKILL.md"), "skills/x/SKILL.md");
  assert.equal(projectToH(".claude/skills/pinned-x/SKILL.md"), null);
  assert.equal(projectToH("harness/pinned-guardrails.md"), null);
  assert.equal(projectToH("src/a.ts"), null);
  assert.equal(hToProject("skills/x/SKILL.md"), ".claude/skills/x/SKILL.md");
  assert.equal(hToProject("other.md"), null);
});

test("validateH finds missing names, descriptions, triggers and scripts", () => {
  const good = tree({
    "instructions.md": "Use the release skill for releases. Run scripts/check.sh first.",
    "skills/release/SKILL.md": "---\nname: release\ndescription: Make a release\n---\nSteps",
    "scripts/check.sh": "#!/bin/sh\n",
  });
  assert.deepEqual(validateH(good), []);
  const bad = tree({
    "instructions.md": "Run scripts/missing.sh.",
    "skills/a/SKILL.md": "---\nname: b\n---\n",
    "skills/c/SKILL.md": "no frontmatter",
    "pinned-x.md": "x",
  });
  const p = validateH(bad).join("\n");
  assert.match(p, /scripts\/missing\.sh/);
  assert.match(p, /name must be "a"/);
  assert.match(p, /needs a description/);
  assert.match(p, /skills\/c\/SKILL\.md has no frontmatter/);
  assert.match(p, /pinned-/);
  assert.match(p, /no trigger line/);
});

test("validateH applies the name and length rules of the Agent Skills specification", () => {
  const skill = (name: string, fm: string): Record<string, string> => ({ [`skills/${name}/SKILL.md`]: `---\n${fm}\n---\nSteps` });
  const check = (name: string, fm: string, always = `When x, use the \`${name}\` skill.`): string =>
    validateH(tree({ "instructions.md": always, ...skill(name, fm) })).join("\n");
  assert.equal(check("pdf-tools", "name: pdf-tools\ndescription: >-\n  Fill PDF forms.\n  Use when a task names a PDF."), "");
  assert.equal(check("pdf-tools", 'name: "pdf-tools"\ndescription: "Fill PDF forms."\nlicense: MIT\nmetadata:\n  author: x'), "");
  assert.match(check("PDF", "name: PDF\ndescription: d"), /a-z, 0-9 and single hyphens/);
  assert.match(check("pdf--tools", "name: pdf--tools\ndescription: d"), /single hyphens/);
  assert.match(check("-pdf", "name: -pdf\ndescription: d"), /no hyphen at the start/);
  assert.match(check("a".repeat(65), `name: ${"a".repeat(65)}\ndescription: d`), /1-64 characters/);
  assert.match(check("pdf", `name: pdf\ndescription: ${"x".repeat(1025)}`), /1025 characters\. The limit is 1024/);
  assert.match(check("pdf", 'name: pdf\ndescription: ""'), /needs a description/);
  assert.match(check("pdf", `name: pdf\ndescription: d\ncompatibility: ${"x".repeat(501)}`), /compatibility must have 1-500/);
  // The trigger line needs the whole name: "pdf" in "pdf-tools" does not count.
  assert.match(check("pdf", "name: pdf\ndescription: d", "Use the pdf-tools skill."), /no trigger line/);
});

test("validateH and unsafeH refuse hooks, MCP servers, tool approvals and inline shell", () => {
  const always = "When x, use the `fmt` skill.";
  const withSkill = (fm: string, body = "Steps"): HTree => tree({ "instructions.md": always, "skills/fmt/SKILL.md": `---\nname: fmt\ndescription: d\n${fm}\n---\n${body}` });
  for (const fm of ["hooks:\n  PreToolUse: []", "allowed-tools: Bash(*)", "model: opus", "context: fork"]) {
    const key = fm.split(":")[0] as string;
    assert.match(unsafeH(withSkill(fm)).join("\n"), new RegExp(`key "${key}" is not allowed`), fm);
  }
  // A key cannot hide behind quotes, a flow mapping or a duplicate.
  assert.match(unsafeH(withSkill('"hooks": {}')).join("\n"), /not a plain "key: value" line/);
  assert.match(unsafeH(withSkill("{hooks: {}}")).join("\n"), /not a plain "key: value" line/);
  assert.match(unsafeH(withSkill("name: other")).join("\n"), /duplicate/);
  // A nested key under metadata is a string value, not a hook.
  assert.deepEqual(unsafeH(withSkill("metadata:\n  hooks: none")), []);
  // The block ends at the first "---", as in Claude Code. A block with no end fails closed.
  assert.match(unsafeH(withSkill("x: a---\nhooks: {}")).join("\n"), /key "x" is not allowed/);
  assert.match(unsafeH(tree({ "skills/fmt/SKILL.md": "---\nname: fmt\nhooks: {}\nSteps" })).join("\n"), /no closing "---"/);
  assert.match(unsafeH(tree({ "skills/fmt/SKILL.md": "\uFEFF---\r\nname: fmt\r\nhooks: {}\r\n---\r\n" })).join("\n"), /key "hooks"/);
  assert.equal(validateH(tree({ "instructions.md": always, "skills/fmt/SKILL.md": "---\nname: fmt # the formatter\ndescription: d\n---\n" })).length, 0);
  assert.match(unsafeH(withSkill("", "Context: !`git log -3`")).join("\n"), /inline shell/);
  assert.match(unsafeH(withSkill("", "```!\ncat ~/.ssh/id_rsa\n```")).join("\n"), /inline shell/);
  assert.deepEqual(unsafeH(withSkill("", "Run `npm test`. Do not stop!")), []);

  const agent = (fm: string): HTree => tree({ "agents/scout.md": `---\n${fm}\n---\nYou read files.` });
  assert.deepEqual(validateH(agent("name: scout\ndescription: Reads files\ntools: Read, Grep\nmaxTurns: 5")), []);
  for (const fm of ["mcpServers:\n  x:\n    command: sh", "permissionMode: acceptEdits", "hooks: {}", "isolation: worktree"]) {
    assert.ok(unsafeH(agent(`name: scout\ndescription: d\n${fm}`)).length > 0, fm);
  }
  assert.match(validateH(agent("description: d")).join("\n"), /agents\/scout\.md: frontmatter needs a name/);
  assert.match(validateH(tree({ "agents/scout.md": "no frontmatter" })).join("\n"), /has no frontmatter/);
});

test("validateH resolves scripts and references of a skill in the skill folder", () => {
  const base = {
    "instructions.md": "When x, use the `pdf` skill. Run scripts/shared.sh.",
    "scripts/shared.sh": "#!/bin/sh\n",
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: d\n---\n1. Run `scripts/fill.py`.\n2. Run scripts/shared.sh.\n3. Read [the errors](references/errors.md) if the fill fails.",
    "skills/pdf/scripts/fill.py": "print(1)\n",
    "skills/pdf/references/errors.md": "x\n",
  };
  assert.deepEqual(validateH(tree(base)), []);
  const { ["skills/pdf/references/errors.md"]: _r, ["skills/pdf/scripts/fill.py"]: _s, ...missing } = base;
  const p = validateH(tree(missing)).join("\n");
  assert.match(p, /skills\/pdf\/references\/errors\.md is named in skills\/pdf\/SKILL\.md but is missing/);
  assert.match(p, /scripts\/fill\.py is named in skills\/pdf\/SKILL\.md but is missing \(looked in skills\/pdf\/scripts\/ and scripts\/\)/);
});

test("inventory and component use: Skill, Read of SKILL.md, Agent and Bash", () => {
  const h = tree({
    "instructions.md": "x",
    "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: d\n---\n",
    "skills/deploy/scripts/check.sh": "#!/bin/sh\n",
    "skills/lint-fix/SKILL.md": "---\nname: lint-fix\ndescription: d\n---\n",
    "agents/scout.md": "---\nname: scout\ndescription: d\n---\n",
    "scripts/count.py": "print(1)\n",
  });
  const inv = inventory(h);
  assert.deepEqual(inv, { skills: ["deploy", "lint-fix"], agents: ["scout"], scripts: [".claude/skills/deploy/scripts/check.sh", "harness/scripts/count.py"] });
  const call = (id: string, name: string, input: Record<string, unknown>, parent: string | null = null): unknown[] => [
    { type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", parent_tool_use_id: parent, message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
  ];
  const trace = normalizeTrace([
    ...call("1", "Skill", { skill: "deploy" }),
    ...call("2", "Skill", { skill: "harness:report" }),
    ...call("3", "Read", { file_path: "/w/.claude/skills/lint-fix/SKILL.md" }),
    ...call("4", "Agent", { subagent_type: "general-purpose", description: "x", prompt: "y" }),
    ...call("5", "Bash", { command: "bash .claude/skills/deploy/scripts/check.sh && npm test" }, "4"),
  ]);
  assert.deepEqual(componentsUsed(trace, inv), { skills: ["deploy", "lint-fix"], agents: [], scripts: [".claude/skills/deploy/scripts/check.sh"] });
  const withAgent = normalizeTrace(call("6", "Agent", { subagent_type: "scout", description: "x", prompt: "y" }));
  assert.deepEqual(componentsUsed(withAgent, inv).agents, ["scout"]);
});

test("the report lists component use and flags skills that no run used", () => {
  const use = (skills: string[]) => ({ skills, agents: [], scripts: [] });
  const rec = (used: string[]): RunRecord => ({ components: { reference: { available: use(["deploy", "lint-fix"]), used: use(used) } } }) as unknown as RunRecord;
  const records = [rec(["deploy"]), rec([]), rec(["deploy"]), rec([]), rec(["deploy"]), { components: undefined } as unknown as RunRecord];
  const c = componentStats(records);
  assert.equal(c.runs, 5);
  assert.deepEqual(c.stats, [
    { kind: "skill", name: "lint-fix", runs: 5, used: 0 },
    { kind: "skill", name: "deploy", runs: 5, used: 3 },
  ]);
  const base: ProjectReport = { runs: 6, byOutcome: {}, improveRate: null, budgetStopRate: null, reuseRate: null, meanTokens: null, meanCostUsd: null, last: [], componentRuns: c.runs, components: c.stats };
  const text = reportText(base);
  assert.match(text, /skill deploy: used in 3 of 5 runs/);
  assert.match(text, new RegExp(`Never used in ${UNUSED_MIN_RUNS} or more runs: skill lint-fix\\.`));
  assert.doesNotMatch(reportText({ ...base, componentRuns: 0, components: [] }), /H components/);
});

test("taskFlips shows lost, gained and unstable criteria per task, worst first", () => {
  const run = (arm: string, task: string, index: number, score: number, gatePass: boolean, crit: Record<string, boolean>): ArmRun => ({
    arm, task, index, runId: `${arm}-${task}-${index}`, scored: true, reason: null, score, tokens: 1, gatePass,
    criteria: Object.entries(crit).map(([id, pass]) => ({ id, pass })),
  });
  const runs = [
    run("new", "t1", 0, 80, true, { spec: true, date: true }),
    run("new", "t1", 1, 60, true, { spec: true, date: false }),
    run("old", "t1", 0, 70, true, { spec: true, date: true }),
    run("old", "t1", 1, 70, true, { spec: true, date: true }),
    run("new", "t2", 0, 90, true, { spec: true }),
    run("old", "t2", 0, 50, false, { spec: false }),
  ];
  const f = taskFlips(runs, "new", "old");
  assert.deepEqual(f.map((x) => x.task), ["t1", "t2"]);
  // t1 has the same mean (70 = 70) but lost the date check in one of two runs.
  assert.deepEqual(f[0], { task: "t1", newMean: 70, oldMean: 70, diff: 0, gateNew: "2/2", gateOld: "2/2", lost: ["date 2/2→1/2"], gained: [], unstable: ["date (new 1/2)"] });
  assert.deepEqual(f[1]?.gained, ["spec 0/1→1/1"]);
  assert.equal(f[1]?.gateOld, "0/1");
});

test("signalWarnings flags hidden tests that fail in every run while the judge passes everything", () => {
  const run = (task: string, index: number, hidden: number | null, allPass: boolean): ArmRun => ({
    arm: "h0", task, index, runId: `${task}-${index}`, scored: true, reason: null, score: 50, tokens: 1,
    criteria: [{ id: "a", pass: true }, { id: "b", pass: allPass }], hiddenTests: hidden,
    hiddenTail: "not ok 1 - __hidden_tests__\n# Error: Cannot find module '/w/__hidden_tests__'\n# tests 1\n# fail 1\n# cancelled 0\n# duration_ms 60",
  });
  const w = signalWarnings([run("t1", 0, 0, true), run("t1", 1, 0, true), run("t2", 0, 1, true), run("t3", 0, 0, false), run("t4", 0, null, true)]);
  assert.equal(w.length, 1);
  assert.match(w[0] ?? "", /^t1 \(h0\): the hidden tests failed in 2 of 2 runs, but the judge passed every criterion in 2 of them\..*Cannot find module/);
  assert.doesNotMatch(w[0] ?? "", /duration_ms/);
});

test("signalWarnings flags an arm that the task budget stopped in more than 5% of runs", () => {
  const run = (arm: string, task: string, index: number, stop: boolean): ArmRun => ({ arm, task, index, runId: `${arm}-${task}-${index}`, scored: true, reason: null, score: 80, tokens: 1, budgetStop: stop });
  const w = signalWarnings([run("h0", "c3", 0, false), run("pipeline", "c3", 0, true), run("h0", "c4", 0, false), run("pipeline", "c4", 0, false), run("pipeline", "c4", 1, true)]);
  assert.equal(w.length, 1);
  assert.match(w[0] ?? "", /^pipeline: the task budget stopped 2 of 3 runs \(c3 1\/1, c4 1\/2\)\. A stopped run gives the reference deliverable/);
  const few = Array.from({ length: 20 }, (_, i) => run("pipeline", "c3", i, i === 0));
  assert.deepEqual(signalWarnings(few), [], "1 of 20 is 5%: the plan allows it");
});

test("keyLines shows the cause of a startup error, not the stack frames (R7)", () => {
  const out = [
    "\x1b[31m⎯⎯⎯\x1b[39m\x1b[1m\x1b[41m Startup Error \x1b[49m\x1b[22m",
    "file:///w/node_modules/rolldown/dist/shared/rolldown-build.mjs:9",
    "import { formatWithOptions, styleText } from \"node:util\";",
    "SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'",
    "    at ModuleJob._instantiate (node:internal/modules/esm/module_job:123:21)",
    "    at async start (file:///w/node_modules/vitest/dist/chunks/cac.js:2339:27)",
  ].join("\n");
  assert.match(keyLines(out), /Startup Error \| SyntaxError: The requested module 'node:util' does not provide an export named 'styleText'$/);
  assert.equal(keyLines("a\nb\nc\nd"), "b | c | d");
});

test("a broken meta.yaml names its task", () => {
  const store = tmp();
  const d = path.join(store, "tasks", "t-div");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "meta.yaml"), 'task_type: x\nhidden_tests:\n  command: "node --test "a/*.js""\n');
  assert.throws(() => loadTask(store, "t-div"), /^Error: tasks\/t-div\/meta\.yaml is not valid: /);
});

test("tree hash and diff", async () => {
  const a = tree({ "instructions.md": "one\n" });
  const b = tree({ "instructions.md": "one\ntwo\n" });
  assert.equal(treeHash(a), treeHash(tree({ "instructions.md": "one\n" })));
  assert.notEqual(treeHash(a), treeHash(b));
  const d = await diffH(a, b, path.join(tmp(), "d"));
  assert.match(d, /\+\+\+ b\/instructions\.md/);
  assert.match(d, /^\+two$/m);
  assert.equal(await diffH(a, a, path.join(tmp(), "d")), "");
  assert.equal(promptSize(b), 8);
});

test("reuse event: composer cites a lesson, or the adopted H contains a lesson", () => {
  const lib = tmp();
  const entry = path.join(lib, "testing", "run-jest-in-band");
  fs.mkdirSync(entry, { recursive: true });
  fs.writeFileSync(path.join(entry, "H.patch"), "# base-tree: x\n--- a/instructions.md\n+++ b/instructions.md\n@@ -1 +1,2 @@\n one\n+Run jest with --runInBand in this repo.\n");
  const base = tree({ "instructions.md": "one\n" });
  const adopted = tree({ "instructions.md": "one\nRun jest with --runInBand in this repo.\n" });
  assert.equal(reuseEvent(base, adopted, lib, ["", "added -> x -> step 3"]), true);
  assert.equal(reuseEvent(base, tree({ "instructions.md": "one\nSomething else entirely here.\n" }), lib, ["", ""]), false);
  assert.equal(reuseEvent(base, base, lib, ["", "kept [L:testing/run-jest-in-band] -> e -> step 2"]), true);
  assert.equal(reuseEvent(base, base, lib, ["", "kept [L:testing/not-in-the-library] -> e -> step 2"]), false, "a cite of a missing lesson is not a reuse");
  fs.writeFileSync(path.join(entry, "EXPERIENCE.md"), "# testing/run-jest-in-band\n\nid: L0123456789ab\n");
  assert.deepEqual(reuseMatches(base, adopted, lib, ["", ""]), ["L0123456789ab"]);
});

// --- ownership and hash parity with the plugin ------------------------------------------------

test("TS ownership matches the plugin script", async () => {
  const mjs = (await import(pathToFileURL(path.join(pluginDir, "scripts", "lib", "ownership.mjs")).href)) as { classify: (r: string, g: string[]) => string; DEFAULT_LOOP_OWNED: string[] };
  const paths = [
    "src/a.ts",
    "harness/pinned-config.yaml",
    "docs/pinned-x/y.md",
    "CLAUDE.md",
    "pkg/CLAUDE.local.md",
    "AGENTS.md",
    ".mcp.json",
    "pkg/.mcp.json",
    ".github/workflows/x.yml",
    ".gitlab/harness/ci-path-guard.mjs",
    ".gitlab-ci.yml",
    "pkg/.gitlab-ci.yml",
    ".husky/pre-commit",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/rules/a.md",
    ".claude/hooks/a.sh",
    ".claude/commands/a.md",
    ".claude/skills/x/SKILL.md",
    ".claude/skills/pinned-x/SKILL.md",
    ".claude/agents/a.md",
    "pkg/.claude/skills/x/SKILL.md",
    "harness/instructions.md",
    "harness/scripts/a/b.sh",
    "harness/library/x/y/EXPERIENCE.md",
    "harness/reports/runs/x.json",
    "README.md",
  ];
  for (const p of paths) assert.equal(classifyPath(p, mjs.DEFAULT_LOOP_OWNED), mjs.classify(p, mjs.DEFAULT_LOOP_OWNED), p);
});

test("TS hashDir matches checksum.mjs", async () => {
  const mjs = (await import(pathToFileURL(path.join(pluginDir, "scripts", "checksum.mjs")).href)) as { hashDir: (d: string) => string };
  assert.equal(hashDir(pluginDir), mjs.hashDir(pluginDir));
  const d = tmp();
  fs.mkdirSync(path.join(d, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(d, "node_modules", "x", "a.js"), "skip");
  fs.writeFileSync(path.join(d, "a.txt"), "a");
  assert.equal(hashDir(d), mjs.hashDir(d));
});

// --- config, eval store --------------------------------------------------------------------

function configText(over: (s: string) => string = (s) => s): string {
  const t = fs.readFileSync(path.join(pluginDir, "templates", "project", "harness", "pinned-config.yaml"), "utf8").replace(/\{\{gate\.(\w+)\}\}/g, "true");
  return over(t);
}

test("the config template parses, and the refinements hold", () => {
  const c = parseProjectConfig(configText());
  assert.equal(c.phase, 0);
  assert.equal(c.loop.m, 3);
  assert.throws(() => parseProjectConfig(configText((s) => s.replace("judge: claude-haiku-5-5", "judge: claude-sonnet-5-5"))), /judge model/);
  assert.throws(() => parseProjectConfig(configText((s) => s.replace("k_par: 1", "k_par: 2"))), /Phase 5/);
  assert.throws(() => parseProjectConfig(configText((s) => s.replace("phase: 0", "phase: 9"))));
});

test("split is stratified, deterministic, and has a holdout task in each stratum", () => {
  const tasks = [
    ...["a1", "a2", "a3", "a4", "a5", "a6"].map((id) => ({ id, taskType: "feature" })),
    ...["b1", "b2"].map((id) => ({ id, taskType: "bugfix" })),
    { id: "c1", taskType: "refactor" },
  ];
  const s1 = makeSplit(tasks, 42);
  assert.deepEqual(s1, makeSplit(tasks, 42));
  assert.equal(s1.dev.length + s1.holdout.length, tasks.length);
  for (const type of ["feature", "bugfix", "refactor"]) {
    assert.ok(s1.holdout.some((id) => tasks.find((t) => t.id === id)?.taskType === type), type);
  }
  assert.equal(s1.holdout.filter((id) => id.startsWith("a")).length, 2);
});

test("eval store init is create-only; canaries", () => {
  const d = tmp();
  const first = initEvalStore(d);
  assert.ok(first.includes("weights.yaml"));
  fs.writeFileSync(path.join(d, "weights.yaml"), "# mine\n");
  assert.deepEqual(initEvalStore(d), []);
  assert.equal(fs.readFileSync(path.join(d, "weights.yaml"), "utf8"), "# mine\n");
  const canaries = fs.readFileSync(path.join(d, "canaries.txt"), "utf8").trim().split("\n");
  assert.equal(canaries.length, 5);
  assert.deepEqual(canaryHits(`x ${canaries[2]} y`, canaries), [canaries[2]]);
});

test("pairArms drops a pair when either run has no score", () => {
  const r = (arm: string, task: string, index: number, score: number | null): ArmRun => ({ arm, task, index, runId: `${arm}-${task}-${index}`, scored: score !== null, reason: null, score, tokens: 0 });
  const runs = [r("new", "t1", 0, 80), r("old", "t1", 0, 70), r("new", "t1", 1, null), r("old", "t1", 1, 60), r("new", "t2", 0, 50), r("old", "t2", 0, 55)];
  const { arms, dropped } = pairArms(runs, "new", "old");
  assert.equal(dropped, 1);
  assert.deepEqual(arms.t1, { new: [80], old: [70] });
  assert.deepEqual(arms.t2, { new: [50], old: [55] });
});

test("version compare", () => {
  assert.ok(compareVersions("2.1.295", "2.1.295") === 0);
  assert.ok(compareVersions("2.1.300", "2.1.295") > 0);
  assert.ok(compareVersions("2.0.9", "2.1.0") < 0);
});

test("gate: \"none\" skips a check that the project does not have; empty or TODO fails (C39)", async () => {
  const ran: string[] = [];
  const fake = (async (command: string) => {
    ran.push(command);
    return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
  }) as unknown as typeof runShell;
  const gate = (test: string): ProjectConfig["gate"] => ({ build: "b", typecheck: "t", lint: "l", test, timeout_s: 60 });

  const none = await runGate("/ws", gate("none"), fake);
  assert.equal(none.pass, true);
  assert.equal(none.scoreGate, 1);
  assert.deepEqual(none.skipped, ["test"]);
  assert.deepEqual(none.todo, []);
  assert.deepEqual(ran, ["b", "t", "l"]);
  assert.deepEqual(summary(none).skipped, ["test"]);

  for (const v of ["", "  ", "TODO"]) {
    const g = await runGate("/ws", gate(v), fake);
    assert.equal(g.pass, false, `test: ${JSON.stringify(v)} must fail the gate`);
    assert.deepEqual(g.todo, ["test"]);
  }
  const all = await runGate("/ws", gate("t2"), fake);
  assert.equal(all.pass, true);
  assert.equal("skipped" in summary(all), false);

  const cfg = { gate: gate("none") } as ProjectConfig;
  assert.deepEqual(noneGateKeys(cfg), ["test"]);
  assert.deepEqual(todoGateKeys(cfg), []);
  assert.deepEqual(todoGateKeys({ gate: gate("") } as ProjectConfig), ["test"]);
});

test("runShell does not start a login shell: commands get the PATH of the harness (R7)", async () => {
  const login = await runShell("shopt -q login_shell");
  assert.equal(login.code, 1);
  const p = await runShell('printf %s "$PATH"', { env: { ...process.env, PATH: `/harness-r7-probe:${process.env.PATH ?? ""}` } });
  assert.ok(p.stdout.startsWith("/harness-r7-probe:"), p.stdout);
});

test("kernel and loop build without extras and without the CLI (ARCHITECTURE.md)", () => {
  const orch = path.resolve(import.meta.dirname, "..", "..");
  const dir = tmp();
  fs.cpSync(path.join(orch, "src"), path.join(dir, "src"), { recursive: true, filter: (p) => !p.includes(`${path.sep}extras`) && !p.endsWith("cli.ts") });
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ extends: path.join(orch, "tsconfig.json"), compilerOptions: { noEmit: true, rootDir: dir, typeRoots: [path.join(orch, "node_modules", "@types")] }, include: [path.join(dir, "src")] }));
  fs.symlinkSync(path.join(orch, "node_modules"), path.join(dir, "node_modules"));
  fs.copyFileSync(path.join(orch, "package.json"), path.join(dir, "package.json"));
  const r = spawnSync(process.execPath, [path.join(orch, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(dir, "tsconfig.json")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

const packsDir = path.resolve(import.meta.dirname, "..", "..", "..", "packs");

test("pack install: creates new files, proposes for existing files, never changes package.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pack-"));
  const pkg = JSON.stringify({ scripts: { build: "next build" }, devDependencies: { vitest: "^3.2.4" } });
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), "stages: [test]\n");
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "harness@harness-template": true } }));
  fs.mkdirSync(path.join(dir, "harness"));
  fs.writeFileSync(path.join(dir, "harness", "pinned-guardrails.md"), "# Guardrails\n1. Rule one.\n");

  const dry = installPack(path.join(packsDir, "base"), dir, { dryRun: true });
  assert.ok(dry.created.includes(".claude/hooks/block-env.mjs"));
  assert.equal(fs.existsSync(path.join(dir, ".claude", "hooks")), false);

  const r = installPack(path.join(packsDir, "base"), dir);
  assert.equal(r.ci, "gitlab");
  assert.ok(r.created.includes(".claude/agents/mr-reviewer.md"));
  assert.ok(r.created.includes(".gitlab/harness/gate.gitlab-ci.yml"));
  assert.equal(r.created.some((f) => f.startsWith(".github/")), false);
  // An existing settings file gets a merged proposal. The original does not change.
  assert.ok(r.proposed.includes(".claude/settings.json.harness-proposed"));
  const merged = JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json.harness-proposed"), "utf8")) as { enabledPlugins: object; hooks: { PreToolUse: unknown[] } };
  assert.deepEqual(merged.enabledPlugins, { "harness@harness-template": true });
  assert.equal(merged.hooks.PreToolUse.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")).hooks, undefined);
  // Rule lines go to a proposal of the pinned file, after the lines that exist.
  const rules = fs.readFileSync(path.join(dir, "harness", "pinned-guardrails.md.harness-proposed"), "utf8");
  assert.ok(rules.startsWith("# Guardrails\n1. Rule one.\n- Do not read"));
  assert.equal(fs.readFileSync(path.join(dir, "harness", "pinned-guardrails.md"), "utf8"), "# Guardrails\n1. Rule one.\n");
  // instructions.md is missing: the pack says so and does not make it.
  assert.ok(r.manual.some((m) => m.startsWith("harness/instructions.md is missing")));
  // The CI job gets the install command of the project. A gate that is not set fails with a clear line.
  const job = fs.readFileSync(path.join(dir, ".gitlab", "harness", "gate.gitlab-ci.yml"), "utf8");
  assert.match(job, /- yarn install --frozen-lockfile/);
  assert.match(job, /TODO: set gate\.build/);
  assert.equal(job.includes("{{"), false);

  const second = installPack(path.join(packsDir, "base"), dir);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.proposed, []);

  const web = installPack(path.join(packsDir, "web-next"), dir);
  assert.ok(web.created.includes("vitest.config.mts"));
  assert.ok(web.manual.some((m) => m.includes("jsdom@^26.1.0")));
  assert.equal(web.manual.some((m) => m.includes(" vitest@")), false, "vitest is in package.json already");
  assert.ok(web.manual.some((m) => m.includes('"test": "vitest run"')));
  assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), pkg);

  assert.deepEqual(listPacks(path.resolve(packsDir, "..")).map((m) => m.name), ["base", "mcp-work", "web-next"]);
  assert.deepEqual(mergeJson({ a: [1], b: { c: 1 } }, { a: [1, 2], b: { d: 2 } }), { a: [1, 2], b: { c: 1, d: 2 } });
});

test("packs: the hooks work, and no pack holds a token", () => {
  const hook = path.join(packsDir, "base", "files", ".claude", "hooks", "block-env.mjs");
  const decide = (tool_input: object): boolean => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input }), encoding: "utf8" }).stdout.includes('"deny"');
  assert.equal(decide({ file_path: "/p/.env.local" }), true);
  assert.equal(decide({ command: "cat .env | head" }), true);
  assert.equal(decide({ pattern: "**/.env*" }), true);
  assert.equal(decide({ pattern: "process.env.REST_ENDPOINT" }), false);
  assert.equal(decide({ file_path: "/p/.env.example" }), false);
  assert.equal(decide({ command: "yarn build" }), false);

  const all = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of all(packsDir)) {
    const text = fs.readFileSync(f, "utf8");
    assert.equal(/glpat-|ghp_|sk-ant-/.test(text), false, `${f} holds a token`);
  }
});

test("i18n-check of the web-next pack: finds a missing key, and a baseline accepts the old ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-i18n-"));
  fs.mkdirSync(path.join(dir, "tools"));
  fs.copyFileSync(path.join(packsDir, "web-next", "files", "tools", "i18n-check.mjs"), path.join(dir, "tools", "i18n-check.mjs"));
  for (const [l, o] of [["vi", { a: "1", b: { c: "2" }, old: "x" }], ["en", { a: "1", b: { c: "2" } }]] as const) {
    fs.mkdirSync(path.join(dir, "loc", l), { recursive: true });
    fs.writeFileSync(path.join(dir, "loc", l, "translation.json"), JSON.stringify(o));
  }
  const run = (...a: string[]) => spawnSync(process.execPath, ["tools/i18n-check.mjs", "loc", ...a], { cwd: dir, encoding: "utf8" });
  assert.equal(run().status, 1);
  assert.equal(run("--baseline").status, 0);
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(dir, "loc", "vi", "translation.json"), JSON.stringify({ a: "1", b: { c: "2", d: "3" }, old: "x" }));
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Missing in en: translation:b\.d/);
});

test("CI host: the doctor check and the guard copies follow GitHub or GitLab", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ci-"));
  assert.equal(ciHost(dir), "github");
  assert.equal(ciGuardCheck(dir).level, "FAIL");
  fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), "stages: [test]\n");
  assert.equal(ciHost(dir), "gitlab");
  assert.deepEqual(ciCopies(dir).map(([p]) => p), [".gitlab/harness/ci-path-guard.mjs", ".gitlab/harness/lib/ownership.mjs"]);
  assert.match(ciGuardCheck(dir).detail, /is missing/);
  fs.mkdirSync(path.join(dir, ".gitlab", "harness"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitlab", "harness", "ci-path-guard.mjs"), "");
  fs.writeFileSync(path.join(dir, ".gitlab", "harness", "harness-guard.gitlab-ci.yml"), "");
  const noInclude = ciGuardCheck(dir);
  assert.equal(noInclude.level, "FAIL");
  assert.match(noInclude.detail, /does not include/);
  fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), "include:\n  - local: .gitlab/harness/harness-guard.gitlab-ci.yml\n");
  assert.equal(ciGuardCheck(dir).level, "WARN");
});

test("evidence: counts commits, reverts and hot folders from the git history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ev-"));
  const g = (...a: string[]) => assert.equal(spawnSync("git", a, { cwd: dir }).status, 0, a.join(" "));
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  fs.mkdirSync(path.join(dir, "src", "components", "Form"), { recursive: true });
  const commit = (file: string, msg: string): void => {
    fs.appendFileSync(path.join(dir, file), "x\n");
    g("add", "-A");
    g("commit", "-qm", msg);
  };
  commit("src/components/Form/a.ts", "feat: form");
  commit("src/components/Form/a.ts", "fix: build error");
  commit("src/components/Form/a.test.ts", "Revert \"feat: form\"");
  commit("README.md", "docs");
  const e = evidence(dir, "1 year ago");
  assert.equal(e.commits, 4);
  assert.equal(e.reverts, 1);
  assert.equal(e.checkFixes, 1);
  assert.equal(e.testFiles, 1);
  assert.deepEqual(e.hotDirs[0], { dir: "src/components/Form", changes: 3 });
});
