// Tests of the PreToolUse guard (enforcement layer 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decide } from "../../plugins/harness/scripts/guard.mjs";
import { DEFAULT_LOOP_OWNED } from "../../plugins/harness/scripts/lib/ownership.mjs";

const ws = "/work/run1/ws/reference";
const store = "/secret/eval-store";
const policy = {
  role: "executor",
  writeRoots: [ws],
  writeMode: "task",
  allowFiles: [],
  loopOwned: DEFAULT_LOOP_OWNED,
  protectAbs: ["/project/harness/runs"],
  readDeny: [store],
  bash: true,
  web: false,
  subagents: true,
  mcpAllow: [],
};
const write = (p) => ({ tool_name: "Write", cwd: ws, tool_input: { file_path: path.isAbsolute(p) ? p : path.join(ws, p), content: "x" } });
const bash = (command) => ({ tool_name: "Bash", cwd: ws, tool_input: { command } });
const agent = (input, pol = policy) => decide({ input, role: "executor", policy: pol, projectDir: ws, loopOwned: pol.loopOwned }).decision;

test("executor writes task code", () => assert.equal(agent(write("src/app.ts")), "none"));
test("executor cannot write pinned- files", () => {
  assert.equal(agent(write("harness/pinned-config.yaml")), "deny");
  assert.equal(agent(write("docs/pinned-notes/a.md")), "deny");
});
test("executor cannot write exception files", () => {
  for (const p of ["CLAUDE.md", "pkg/CLAUDE.local.md", "AGENTS.md", ".mcp.json", ".github/workflows/x.yml", ".husky/pre-commit", ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/x.sh", "pkg/.claude/skills/x/SKILL.md"]) {
    assert.equal(agent(write(p)), "deny", p);
  }
});
test("executor cannot write loop-owned files in task mode", () => {
  assert.equal(agent(write("harness/instructions.md")), "deny");
  assert.equal(agent(write(".claude/skills/x/SKILL.md")), "deny");
});
test("executor cannot write outside its roots or into protected paths", () => {
  assert.equal(agent(write("/tmp/x")), "deny");
  assert.equal(agent(write("/project/harness/runs/r/record.json")), "deny");
  assert.equal(agent(write("../other/x.ts")), "deny");
});
test("reads of the eval store are denied", () => {
  assert.equal(agent({ tool_name: "Read", cwd: ws, tool_input: { file_path: `${store}/canaries.txt` } }), "deny");
  assert.equal(agent({ tool_name: "Grep", cwd: ws, tool_input: { path: store, pattern: "x" } }), "deny");
  assert.equal(agent({ tool_name: "Read", cwd: ws, tool_input: { file_path: `${ws}/src/a.ts` } }), "none");
});
test("shell rules", () => {
  assert.equal(agent(bash("gh pr create")), "deny");
  assert.equal(agent(bash("cd x && gh api /user")), "deny");
  assert.equal(agent(bash(`cat ${store}/canaries.txt`)), "deny");
  assert.equal(agent(bash("sed -i s/a/b/ harness/pinned-guardrails.md")), "deny");
  assert.equal(agent(bash("echo x > harness/pinned-config.yaml")), "deny");
  assert.equal(agent(bash("cat harness/pinned-guardrails.md")), "none");
  assert.equal(agent(bash("npm test")), "none");
  assert.equal(agent(bash("echo high")), "none");
});
test("web, subagents and MCP follow the policy", () => {
  assert.equal(agent({ tool_name: "WebFetch", cwd: ws, tool_input: { url: "https://x" } }), "deny");
  assert.equal(agent({ tool_name: "Agent", cwd: ws, tool_input: {} }), "none");
  assert.equal(agent({ tool_name: "Agent", cwd: ws, tool_input: {} }, { ...policy, subagents: false }), "deny");
  assert.equal(agent({ tool_name: "mcp__github__create_pr", cwd: ws, tool_input: {} }), "deny");
});
test("a role without a policy is denied every tool (fail closed)", () => {
  const d = decide({ input: write("src/a.ts"), role: "executor", policy: null, projectDir: ws, loopOwned: [] });
  assert.equal(d.decision, "deny");
});
test("editor mode loop-owned writes only loop-owned files and notes", () => {
  const staging = "/work/run1/staging/edit-A/H";
  const ed = { ...policy, role: "invariant-editor", writeRoots: [staging], writeMode: "loop-owned", allowFiles: ["notes.md"], bash: false };
  const w = (rel) => ({ tool_name: "Write", cwd: staging, tool_input: { file_path: path.join(staging, rel), content: "x" } });
  assert.equal(decide({ input: w("harness/instructions.md"), role: "invariant-editor", policy: ed, projectDir: staging, loopOwned: ed.loopOwned }).decision, "none");
  assert.equal(decide({ input: w("notes.md"), role: "invariant-editor", policy: ed, projectDir: staging, loopOwned: ed.loopOwned }).decision, "none");
  assert.equal(decide({ input: w("src/a.ts"), role: "invariant-editor", policy: ed, projectDir: staging, loopOwned: ed.loopOwned }).decision, "deny");
  assert.equal(decide({ input: bash("ls"), role: "invariant-editor", policy: ed, projectDir: staging, loopOwned: ed.loopOwned }).decision, "deny");
});
test("human sessions: ask for protected files, never deny", () => {
  const human = (rel) => decide({ input: { tool_name: "Edit", cwd: "/p", tool_input: { file_path: path.join("/p", rel) } }, role: "", policy: null, projectDir: "/p", loopOwned: DEFAULT_LOOP_OWNED }).decision;
  assert.equal(human("harness/pinned-config.yaml"), "ask");
  assert.equal(human("CLAUDE.md"), "ask");
  assert.equal(human("harness/instructions.md"), "ask");
  assert.equal(human("src/a.ts"), "none");
  assert.equal(human("../outside.txt"), "none");
});
