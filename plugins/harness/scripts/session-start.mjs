#!/usr/bin/env node
// SessionStart and Setup hook (docs/plan.md, option C of "Plugin tự sinh harness cho project").
//   - In an orchestrated session (HARNESS_ROLE is set) the hook does nothing and prints nothing.
//   - In a project that has not opted in, it prints one reminder line for the human.
//   - In a project that has opted in (.claude/settings.json enables harness@...), it runs the
//     create-only scaffold and the fast checks. The full doctor runs separately: /harness:doctor.
// With --setup (claude --init-only in CI) it prints plain text instead of hook JSON.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, quickCheck } from "./scaffold.mjs";
import { readStdinJson, readJson, emit } from "./lib/io.mjs";

const setupMode = process.argv.includes("--setup");

/** True when the committed project settings enable the harness plugin. */
export function optedIn(projectDir) {
  const s = readJson(path.join(projectDir, ".claude", "settings.json"), null);
  if (!s || !s.enabledPlugins) return false;
  return Object.entries(s.enabledPlugins).some(([k, v]) => k.startsWith("harness@") && v === true);
}

async function main() {
  if (process.env.HARNESS_ROLE) return;
  let input = {};
  try {
    input = await readStdinJson();
  } catch {
    input = {};
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (!optedIn(projectDir)) {
    const msg = "harness: this project has not opted in. Run /harness:init to set it up.";
    if (setupMode) process.stdout.write(msg + "\n");
    else emit({ systemMessage: msg });
    return;
  }

  const r = scaffold({ projectDir, pluginRoot });
  const problems = quickCheck({ projectDir, pluginRoot });
  const lines = [];
  if (r.created.length) lines.push(`harness: created ${r.created.length} file(s).`);
  if (r.proposed.length) lines.push(`harness: wrote proposals for existing files: ${r.proposed.join(", ")}. Run /harness:init to apply them.`);
  for (const p of problems) lines.push(`harness: ${p}`);
  if (r.created.length || r.proposed.length) lines.push("harness: run /harness:doctor before the first run.");
  if (!lines.length) return;

  const skillsCreated = r.created.some((f) => f.startsWith(".claude/skills/"));
  if (setupMode) {
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  emit({ systemMessage: lines.join("\n"), hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: skillsCreated } });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // A SessionStart failure must not stop the human session. Report it and continue.
    emit({ systemMessage: `harness: the session-start check failed: ${err && err.message ? err.message : err}` });
  });
}
