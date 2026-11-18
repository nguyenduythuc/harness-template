// Tests of the CI owner-rule check (enforcement layer 5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addedLinesOf, checkChanges, parseNameStatus, skillName } from "../../plugins/harness/scripts/ci-path-guard.mjs";

const base = { labels: [], authorType: "User", loopOwned: [], gateConfigFiles: ["**/package.json", "**/jest.config.*"], addedLines: [], skills: [] };
const run = (over) => checkChanges({ ...base, ...over });
const A = (path) => ({ status: "A", path });
const M = (path) => ({ status: "M", path });

test("a deliverable PR with task code and one new run report passes", () => {
  const r = run({ changes: [M("src/a.ts"), A("src/b.ts"), A("harness/reports/runs/20261023-x.json")] });
  assert.deepEqual(r.violations, []);
});
test("a deliverable PR cannot change a run report or other reports", () => {
  assert.equal(run({ changes: [M("harness/reports/runs/old.json")] }).violations.length, 1);
  assert.equal(run({ changes: [A("harness/reports/summary.md")] }).violations.length, 1);
});
test("pinned and exception paths need a human and an owner label", () => {
  assert.equal(run({ changes: [M("harness/pinned-config.yaml")] }).violations.length, 1);
  assert.equal(run({ changes: [M("CLAUDE.md")], labels: ["owner-change"] }).violations.length, 0);
  assert.equal(run({ changes: [M("CLAUDE.md")], labels: ["owner-change"], authorType: "Bot" }).violations.length, 1);
  assert.equal(run({ changes: [M("harness/pinned-harness.lock")], labels: ["harness-upgrade"] }).violations.length, 0);
});
test("a new pinned- file needs owner-change", () => {
  const r = run({ changes: [A("harness/pinned-extra.md")], labels: ["threshold-change"] });
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /owner-change/);
});
test("loop-owned files change only in an h0-promotion PR", () => {
  assert.equal(run({ changes: [M("harness/instructions.md")] }).violations.length, 1);
  assert.equal(run({ changes: [M("harness/instructions.md"), M(".claude/skills/x/SKILL.md")], labels: ["h0-promotion"] }).violations.length, 0);
  assert.equal(run({ changes: [M("harness/instructions.md"), M("src/a.ts")], labels: ["h0-promotion"] }).violations.length, 1);
});
test("library files change only in a library PR, without task code", () => {
  assert.equal(run({ changes: [A("harness/library/x/y/EXPERIENCE.md")] }).violations.length, 1);
  assert.equal(run({ changes: [A("harness/library/x/y/EXPERIENCE.md")], labels: ["library"] }).violations.length, 0);
  assert.equal(run({ changes: [A("harness/library/x/y/EXPERIENCE.md"), M("src/a.ts")], labels: ["library"] }).violations.length, 1);
});
test("a rename checks the old path too", () => {
  const r = run({ changes: parseNameStatus("R100\tharness/instructions.md\tsrc/moved.md") });
  assert.equal(r.violations.length, 1);
});
test("gate config and gate loosening need gate-change", () => {
  assert.equal(run({ changes: [M("package.json")] }).violations.length, 1);
  assert.equal(run({ changes: [M("package.json")], labels: ["gate-change"] }).violations.length, 0);
  const loosen = { changes: [M("src/a.test.ts")], addedLines: ["it.skip('x', () => {})", "// @ts-ignore", "/* eslint-disable */"] };
  assert.equal(run(loosen).violations.length, 1);
  const allowed = run({ ...loosen, labels: ["gate-change"] });
  assert.equal(allowed.violations.length, 0);
  assert.equal(allowed.notes.length, 1);
  assert.equal(run({ changes: [{ status: "D", path: "src/__tests__/a.ts" }] }).violations.length, 1);
});
test("a loop-owned skill cannot shadow a pinned skill name", () => {
  const skills = [
    { path: ".claude/skills/pinned-deploy/SKILL.md", name: "deploy" },
    { path: ".claude/skills/deploy-fast/SKILL.md", name: "deploy" },
  ];
  assert.equal(run({ changes: [M("src/a.ts")], skills }).violations.length, 1);
  assert.equal(run({ changes: [M("src/a.ts")], skills: [{ path: ".claude/skills/pinned-x/SKILL.md", name: "" }] }).violations.length, 1);
});
test("helpers", () => {
  assert.deepEqual(addedLinesOf("+++ b/x\n+new\n-old\n context"), ["new"]);
  assert.equal(skillName("---\nname: deploy\ndescription: d\n---\nbody"), "deploy");
  assert.equal(skillName("no frontmatter"), "");
  assert.deepEqual(parseNameStatus("M\ta.ts\nA\tb.ts\n"), [
    { status: "M", path: "a.ts" },
    { status: "A", path: "b.ts" },
  ]);
});
