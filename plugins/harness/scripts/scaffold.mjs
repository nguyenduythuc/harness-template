#!/usr/bin/env node
// Create the harness files in a project. Create-only and idempotent (docs/plan.md, "Rule khi sinh"):
//   - The scaffold creates a file only when it is missing. It never overwrites a file.
//   - For a file that exists (CLAUDE.md, .claude/settings.json) it writes <file>.harness-proposed.
//     A human reads the proposal and applies it with /harness:init.
//   - A second run changes nothing and reports the files that exist.
//
// Usage: node scaffold.mjs <projectDir> [--dry-run] [--json]

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { detectStack } from "./detect-stack.mjs";
import { ciHost, CI_GUARD_DIR } from "./lib/ci-host.mjs";
import { hashDir } from "./checksum.mjs";
import { readJson } from "./lib/io.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_ROOT = path.resolve(HERE, "..");
export const BLOCK_BEGIN = "<!-- harness:begin";
export const PROPOSED_SUFFIX = ".harness-proposed";
export const CLAUDE_CODE_MIN = "2.1.295";

function listTemplateFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function gitSha(dir) {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Fill {{gate.x}} placeholders with the detected gate commands. */
export function renderConfig(text, stack) {
  return text.replace(/\{\{gate\.(\w+)\}\}/g, (_, k) => (stack.gate && stack.gate[k]) || "TODO");
}

/** Add the harness marketplace and plugin to existing settings. Keeps every existing value. */
export function mergeSettings(existing, template) {
  const out = JSON.parse(JSON.stringify(existing || {}));
  out.extraKnownMarketplaces = out.extraKnownMarketplaces || {};
  for (const [k, v] of Object.entries(template.extraKnownMarketplaces || {})) {
    if (!(k in out.extraKnownMarketplaces)) out.extraKnownMarketplaces[k] = v;
  }
  out.enabledPlugins = out.enabledPlugins || {};
  for (const [k, v] of Object.entries(template.enabledPlugins || {})) {
    if (!(k in out.enabledPlugins)) out.enabledPlugins[k] = v;
  }
  return out;
}

/** Read the plugin manifest version. */
export function pluginVersion(pluginRoot) {
  const m = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {});
  return m.version || null;
}

/**
 * Scaffold the harness files into `projectDir`.
 * @returns {{created: string[], proposed: string[], skipped: string[], todo: string[], stack: object}}
 */
/** AGENTS.md files below the root, 3 levels deep at most, outside node_modules and hidden folders. */
function nestedAgentsFiles(projectDir) {
  const out = [];
  const walk = (rel, depth) => {
    if (depth > 3) return;
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(projectDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.name === "AGENTS.md" && rel) out.push(r);
    }
  };
  walk("", 0);
  return out.sort();
}

export function scaffold({ projectDir, pluginRoot = DEFAULT_PLUGIN_ROOT, dryRun = false, now = new Date() }) {
  const result = { created: [], proposed: [], skipped: [], todo: [], stack: null, ci: null };
  const stack = detectStack(projectDir);
  const ci = ciHost(projectDir);
  result.ci = ci;
  result.stack = stack;
  result.todo = Object.entries(stack.gate).filter(([, v]) => v === "TODO").map(([k]) => k);

  const write = (rel, content) => {
    if (dryRun) return;
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const propose = (rel, content) => {
    const proposalRel = rel + PROPOSED_SUFFIX;
    const abs = path.join(projectDir, proposalRel);
    if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8") === content) {
      result.skipped.push(proposalRel);
      return;
    }
    write(proposalRel, content);
    result.proposed.push(proposalRel);
  };
  const createOnly = (rel, content) => {
    if (fs.existsSync(path.join(projectDir, rel))) {
      result.skipped.push(rel);
      return false;
    }
    write(rel, content);
    result.created.push(rel);
    return true;
  };

  // 1. Files from templates/project, path for path.
  const tplRoot = path.join(pluginRoot, "templates", "project");
  for (const rel of listTemplateFiles(tplRoot)) {
    if (ci !== "github" && rel.startsWith(".github/")) continue;
    let content = fs.readFileSync(path.join(tplRoot, rel), "utf8");
    if (rel === "harness/pinned-config.yaml") content = renderConfig(content, stack);
    if (rel === ".claude/settings.json") {
      const abs = path.join(projectDir, rel);
      if (fs.existsSync(abs)) {
        const existing = readJson(abs, null);
        if (existing === null) {
          result.skipped.push(rel);
          continue;
        }
        const merged = mergeSettings(existing, JSON.parse(content));
        if (JSON.stringify(merged) === JSON.stringify(existing)) result.skipped.push(rel);
        else propose(rel, JSON.stringify(merged, null, 2) + "\n");
        continue;
      }
    }
    createOnly(rel, content);
  }

  // 2. The CI guard and its library. The project runs them from the base branch.
  //    GitLab: the copies go to .gitlab/harness/, with a job file that the project includes.
  const guardDir = CI_GUARD_DIR[ci];
  createOnly(`${guardDir}/ci-path-guard.mjs`, fs.readFileSync(path.join(pluginRoot, "scripts", "ci-path-guard.mjs"), "utf8"));
  createOnly(`${guardDir}/lib/ownership.mjs`, fs.readFileSync(path.join(pluginRoot, "scripts", "lib", "ownership.mjs"), "utf8"));
  if (ci === "gitlab") {
    const job = ".gitlab/harness/harness-guard.gitlab-ci.yml";
    createOnly(job, fs.readFileSync(path.join(pluginRoot, "templates", "gitlab", job), "utf8"));
  }

  // 3. The import block in CLAUDE.md.
  const block = fs.readFileSync(path.join(pluginRoot, "templates", "claude-md-block.md"), "utf8");
  const claudeAbs = path.join(projectDir, "CLAUDE.md");
  // Claude Code reads CLAUDE.md, not AGENTS.md. A project that has AGENTS.md gets a CLAUDE.md that
  // imports it, so both tools read the same rules. Nested AGENTS.md files get the same, beside them.
  const hasAgents = fs.existsSync(path.join(projectDir, "AGENTS.md"));
  if (!fs.existsSync(claudeAbs)) {
    createOnly("CLAUDE.md", hasAgents ? `@AGENTS.md\n\n${block}` : `# ${path.basename(path.resolve(projectDir))}\n\n${block}`);
  } else {
    const existing = fs.readFileSync(claudeAbs, "utf8");
    if (existing.includes(BLOCK_BEGIN)) result.skipped.push("CLAUDE.md");
    else propose("CLAUDE.md", existing.replace(/\s*$/, "") + "\n\n" + block);
  }

  for (const rel of nestedAgentsFiles(projectDir)) {
    const dir = path.posix.dirname(rel);
    if (!fs.existsSync(path.join(projectDir, dir, "CLAUDE.md"))) createOnly(`${dir}/CLAUDE.md`, "@AGENTS.md\n");
  }

  // 4. The lock file: provenance of what the scaffold generated.
  const lockRel = "harness/pinned-harness.lock";
  if (!fs.existsSync(path.join(projectDir, lockRel))) {
    const lock = {
      lock_version: 1,
      created_at: now.toISOString(),
      plugin: { name: "harness", version: pluginVersion(pluginRoot), git_sha: gitSha(pluginRoot), content_hash: hashDir(pluginRoot) },
      orchestrator: { version: null, git_sha: null, content_hash: null },
      claude_code_min: CLAUDE_CODE_MIN,
      h0_sha: null,
      generated: [...result.created, lockRel].sort(),
    };
    createOnly(lockRel, JSON.stringify(lock, null, 2) + "\n");
  } else {
    result.skipped.push(lockRel);
  }
  return result;
}

/** Fast checks for SessionStart: required files exist, imports resolve, the plugin hash matches the lock. */
export function quickCheck({ projectDir, pluginRoot = DEFAULT_PLUGIN_ROOT }) {
  const problems = [];
  const claude = path.join(projectDir, "CLAUDE.md");
  if (fs.existsSync(claude)) {
    const text = fs.readFileSync(claude, "utf8");
    if (!text.includes(BLOCK_BEGIN)) problems.push("CLAUDE.md has no harness import block. Run /harness:init.");
    for (const m of text.matchAll(/^@(\S+)\s*$/gm)) {
      if (!fs.existsSync(path.join(projectDir, m[1]))) problems.push(`CLAUDE.md imports ${m[1]}, but the file is missing.`);
    }
  }
  const lock = readJson(path.join(projectDir, "harness", "pinned-harness.lock"), null);
  if (!lock) problems.push("harness/pinned-harness.lock is missing or not valid JSON.");
  else if (lock.plugin && lock.plugin.content_hash && lock.plugin.content_hash !== hashDir(pluginRoot)) {
    problems.push("The plugin on this machine differs from the version in harness/pinned-harness.lock. Run /harness:upgrade, or use the locked version.");
  }
  const config = path.join(projectDir, "harness", "pinned-config.yaml");
  if (fs.existsSync(config) && /:\s*"?TODO"?\s*$/m.test(fs.readFileSync(config, "utf8"))) {
    problems.push("harness/pinned-config.yaml has TODO values. A human must fill them in before the doctor passes.");
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());
  const r = scaffold({ projectDir: dir, dryRun: args.includes("--dry-run") });
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    for (const f of r.created) process.stdout.write(`created  ${f}\n`);
    for (const f of r.proposed) process.stdout.write(`proposed ${f}\n`);
    for (const f of r.skipped) process.stdout.write(`exists   ${f}\n`);
    for (const k of r.todo) process.stdout.write(`TODO     gate.${k} in harness/pinned-config.yaml\n`);
  }
}
