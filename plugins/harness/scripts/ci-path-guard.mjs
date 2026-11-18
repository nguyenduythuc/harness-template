#!/usr/bin/env node
// CI owner-rule check for a pull request (enforcement layer 5).
// The scaffold copies this file and lib/ownership.mjs to .github/harness/ in the project
// (.gitlab/harness/ for a GitLab project).
//
// Usage: node ci-path-guard.mjs --base <sha> --head <sha> --labels "a,b" --author-type User
//
// Rules: each kind of PR touches only its own kind of file.
//   deliverable PR (no special label): task code, plus one new harness/reports/runs/<run-id>.json
//   h0-promotion: loop-owned files only
//   library:      harness/library/** only
//   owner-change, harness-upgrade, threshold-change: pinned- and exception paths, human author only
//   gate-change:  needed for any change to a gate config file, and for any edit that loosens the gate
// The script reads its rules (loop_owned, gate_config_files) from the BASE commit, so a PR cannot
// change the rules that judge it.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { classify, isPinned, matchGlob, parseYamlList, DEFAULT_LOOP_OWNED } from "./lib/ownership.mjs";

export const OWNER_LABELS = ["owner-change", "harness-upgrade", "threshold-change"];

/** Patterns in added lines that loosen a gate. */
export const LOOSENING = [
  { name: "skipped test", re: /\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|describe|test)\s*\(/ },
  { name: "@ts-ignore", re: /@ts-ignore\b/ },
  { name: "@ts-nocheck", re: /@ts-nocheck\b/ },
  { name: "eslint-disable", re: /eslint-disable/ },
];

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Check the changes of one PR. Pure function.
 * @param {{changes: {status: string, path: string, oldPath?: string}[], labels: string[], authorType: string,
 *          loopOwned: string[], gateConfigFiles: string[], addedLines: string[],
 *          skills: {path: string, name: string}[]}} input
 * @returns {{violations: string[], notes: string[]}}
 */
export function checkChanges(input) {
  const labels = new Set((input.labels || []).filter(Boolean));
  const human = String(input.authorType || "").toLowerCase() !== "bot";
  const loopOwned = input.loopOwned && input.loopOwned.length ? input.loopOwned : DEFAULT_LOOP_OWNED;
  const violations = [];
  const notes = [];
  const ownerLabel = OWNER_LABELS.some((l) => labels.has(l));

  const paths = [];
  for (const c of input.changes || []) {
    paths.push({ status: c.status[0], path: c.path });
    if (c.oldPath) paths.push({ status: "D", path: c.oldPath });
  }

  for (const { status, path: p } of paths) {
    const cls = classify(p, loopOwned);
    const isLibrary = p.startsWith("harness/library/");
    const isReport = p.startsWith("harness/reports/");
    const isRunReport = status === "A" && /^harness\/reports\/runs\/[^/]+\.json$/.test(p);

    if (cls === "pinned" || cls === "exception") {
      if (!(human && ownerLabel)) {
        violations.push(`${p}: ${cls} path. It needs a human author and one of the labels ${OWNER_LABELS.join(", ")}.`);
      }
      if (status === "A" && isPinned(p) && !labels.has("owner-change")) {
        violations.push(`${p}: a new pinned- file needs the owner-change label.`);
      }
      continue;
    }
    if (cls === "loop-owned") {
      if (!labels.has("h0-promotion")) violations.push(`${p}: loop-owned file. Only an h0-promotion PR changes it.`);
      continue;
    }
    if (isLibrary) {
      if (!labels.has("library")) violations.push(`${p}: library file. Only the weekly library PR changes it.`);
      continue;
    }
    if (isReport) {
      if (!isRunReport) violations.push(`${p}: a PR can only add one new harness/reports/runs/<run-id>.json.`);
      continue;
    }
    if (labels.has("h0-promotion") || labels.has("library")) {
      violations.push(`${p}: task code. An h0-promotion or library PR cannot change task code.`);
    }
  }

  const gateFiles = paths.filter((c) => (input.gateConfigFiles || []).some((g) => matchGlob(g, c.path))).map((c) => c.path);
  if (gateFiles.length && !labels.has("gate-change")) {
    violations.push(`Gate config changed (${[...new Set(gateFiles)].join(", ")}). It needs the gate-change label.`);
  }

  const counts = {};
  for (const line of input.addedLines || []) {
    for (const { name, re } of LOOSENING) if (re.test(line)) counts[name] = (counts[name] || 0) + 1;
  }
  const deletedTests = paths.filter((c) => c.status === "D" && TEST_FILE.test(c.path)).length;
  if (deletedTests) counts["deleted test file"] = deletedTests;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    const detail = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
    if (labels.has("gate-change")) notes.push(`Edits that loosen the gate (allowed by gate-change): ${detail}.`);
    else violations.push(`Edits that loosen the gate: ${detail}. They need the gate-change label and a human review.`);
  }

  const pinnedNames = new Map();
  for (const s of input.skills || []) if (isPinned(s.path) && s.name) pinnedNames.set(s.name, s.path);
  for (const s of input.skills || []) {
    if (!isPinned(s.path) && s.name && pinnedNames.has(s.name)) {
      violations.push(`${s.path}: skill name "${s.name}" is the name of the pinned skill ${pinnedNames.get(s.name)}. A loop-owned skill cannot shadow it.`);
    }
  }
  for (const s of input.skills || []) {
    if (isPinned(s.path) && !s.name) violations.push(`${s.path}: a pinned- skill must set "name" in its frontmatter.`);
  }

  return { violations, notes };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function gitShowOrEmpty(ref, file) {
  try {
    return git(["show", `${ref}:${file}`]);
  } catch {
    return "";
  }
}

/** Parse `git diff --name-status -M` output. */
export function parseNameStatus(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    if (status.startsWith("R") || status.startsWith("C")) out.push({ status: status[0], oldPath: parts[1], path: parts[2] });
    else out.push({ status, path: parts[1] });
  }
  return out;
}

/** Added lines from a unified diff (without the leading "+"). */
export function addedLinesOf(diffText) {
  return String(diffText).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

/** The frontmatter `name` of a SKILL.md text, or "". */
export function skillName(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return "";
  const n = m[1].match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m);
  return n ? n[1].trim() : "";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.base || !a.head) {
    process.stderr.write("usage: ci-path-guard.mjs --base <sha> --head <sha> [--labels a,b] [--author-type User]\n");
    process.exit(2);
  }
  const range = `${a.base}...${a.head}`;
  const config = gitShowOrEmpty(a.base, "harness/pinned-config.yaml");
  const skillFiles = git(["ls-tree", "-r", "--name-only", a.head, "--", ".claude/skills"]).split("\n").filter((p) => p.endsWith("/SKILL.md"));
  const result = checkChanges({
    changes: parseNameStatus(git(["diff", "--name-status", "-M", range])),
    labels: String(a.labels || "").split(",").map((s) => s.trim()),
    authorType: a["author-type"] || "User",
    loopOwned: parseYamlList(config, "loop_owned"),
    gateConfigFiles: parseYamlList(config, "gate_config_files"),
    addedLines: addedLinesOf(git(["diff", "-U0", range])),
    skills: skillFiles.map((p) => ({ path: p, name: skillName(gitShowOrEmpty(a.head, p)) })),
  });
  for (const n of result.notes) process.stdout.write(`note: ${n}\n`);
  for (const v of result.violations) process.stdout.write(`violation: ${v}\n`);
  if (result.violations.length) {
    process.stdout.write(`harness-guard: ${result.violations.length} violation(s).\n`);
    process.exit(1);
  }
  process.stdout.write("harness-guard: the PR follows the owner rules.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
