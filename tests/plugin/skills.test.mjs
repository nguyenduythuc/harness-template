// Tests of the plugin skills against the Agent Skills specification (https://agentskills.io/specification),
// and of the role settings switch for inline skill shell.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const plugin = path.resolve(import.meta.dirname, "..", "..", "plugins", "harness");
const skillsDir = path.join(plugin, "skills");
// Fields of the specification, plus two Claude Code fields that the plugin needs on purpose.
const SPEC_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
const CLAUDE_CODE_KEYS = ["disable-model-invocation", "argument-hint"];

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "frontmatter");
  const keys = {};
  for (const line of m[1].split("\n")) {
    const k = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (k) keys[k[1]] = k[2].replace(/^"(.*)"$/, "$1");
  }
  return { keys, body: m[2] };
}

for (const dir of fs.readdirSync(skillsDir)) {
  test(`plugin skill ${dir} follows the specification`, () => {
    const { keys, body } = frontmatter(fs.readFileSync(path.join(skillsDir, dir, "SKILL.md"), "utf8"));
    assert.equal(keys.name, dir, "name equals the directory");
    assert.match(dir, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(dir.length <= 64);
    assert.ok(keys.description && keys.description.length <= 1024, "description of 1-1024 characters");
    assert.match(keys.description, /\bUse (it|this skill) when\b|\bUse it (after|once)\b/, "the description says when to use the skill");
    for (const k of Object.keys(keys)) assert.ok([...SPEC_KEYS, ...CLAUDE_CODE_KEYS].includes(k), `unknown key ${k}`);
    assert.ok(body.split("\n").length < 500, "body under 500 lines");
    assert.doesNotMatch(body, /```!|(^|\s)!`[^`]+`/m, "no inline shell");
  });
}

test("every role settings file turns off inline skill shell", () => {
  for (const f of ["executor.json", "editor.json", "reader.json", "judge.json"]) {
    const s = JSON.parse(fs.readFileSync(path.join(plugin, "settings", f), "utf8"));
    assert.equal(s.disableSkillShellExecution, true, f);
  }
});
