// The H tree: the editable surface of the execution harness, independent of where it sits.
//
// In a project, H lives at project paths (harness/*.md, .claude/skills/...). R roles edit a copy in a
// staging folder with a flat layout (H/instructions.md, H/skills/...). The flat layout keeps the
// copy away from .claude/, which Claude Code protects from headless writes (docs/plan.md, K20).
// Library entries store a patch between two H trees, together with the tree hash of the base.

import fs from "node:fs";
import path from "node:path";
import { git, gitBuffer, run } from "../util/exec.js";
import { ensureDir, sha256 } from "../util/fs.js";

/** Map between project paths and H paths. Order matters: exact files first, then prefixes. */
export const H_FILES: ReadonlyArray<readonly [project: string, h: string]> = [
  ["harness/instructions.md", "instructions.md"],
  ["harness/guardrails.md", "guardrails.md"],
  ["harness/tool-guidance.md", "tool-guidance.md"],
  ["harness/memory.md", "memory.md"],
];
export const H_PREFIXES: ReadonlyArray<readonly [project: string, h: string]> = [
  ["harness/scripts/", "scripts/"],
  [".claude/skills/", "skills/"],
  [".claude/agents/", "agents/"],
];

/** Project-relative glob list of the H surface. Equal to the default loop_owned list. */
export const H_SURFACE_GLOBS = [...H_FILES.map(([p]) => p), ...H_PREFIXES.map(([p]) => p + "**")];

function isPinnedPath(rel: string): boolean {
  return rel.split("/").some((s) => s.startsWith("pinned-"));
}

/** H path of a project path, or null when the file is not part of H. pinned- files and .gitkeep are never part of H. */
export function projectToH(rel: string): string | null {
  if (isPinnedPath(rel) || rel.endsWith("/.gitkeep") || rel === ".gitkeep") return null;
  for (const [p, h] of H_FILES) if (rel === p) return h;
  for (const [p, h] of H_PREFIXES) if (rel.startsWith(p) && rel.length > p.length) return h + rel.slice(p.length);
  return null;
}

/** Project path of an H path, or null when the H path is not on the surface. */
export function hToProject(rel: string): string | null {
  for (const [p, h] of H_FILES) if (rel === h) return p;
  for (const [p, h] of H_PREFIXES) if (rel.startsWith(h) && rel.length > h.length) return p + rel.slice(h.length);
  return null;
}

/** An H tree: H path -> file content. */
export type HTree = Map<string, Buffer>;

/** Read H from a project checkout on disk. */
export function readHFromProject(projectDir: string): HTree {
  const tree: HTree = new Map();
  const add = (rel: string): void => {
    const h = projectToH(rel);
    if (h) tree.set(h, fs.readFileSync(path.join(projectDir, rel)));
  };
  for (const [p] of H_FILES) if (fs.existsSync(path.join(projectDir, p))) add(p);
  for (const [p] of H_PREFIXES) {
    const dir = path.join(projectDir, p);
    if (!fs.existsSync(dir)) continue;
    for (const rel of walk(dir)) add(p + rel);
  }
  return tree;
}

/** Read H from a git commit of the project, without a checkout. */
export function readHFromGit(repoDir: string, ref: string): HTree {
  const tree: HTree = new Map();
  const listed = git(["ls-tree", "-r", "--name-only", ref, "--", "harness", ".claude"], repoDir).split("\n").filter(Boolean);
  for (const rel of listed) {
    const h = projectToH(rel);
    if (h) tree.set(h, gitBuffer(["show", `${ref}:${rel}`], repoDir));
  }
  return tree;
}

/** Read an H tree from a flat H folder (staging layout). */
export function readHFromDir(hDir: string): HTree {
  const tree: HTree = new Map();
  if (!fs.existsSync(hDir)) return tree;
  for (const rel of walk(hDir)) {
    if (hToProject(rel) && !isPinnedPath(rel)) tree.set(rel, fs.readFileSync(path.join(hDir, rel)));
  }
  return tree;
}

/** Write an H tree into a flat H folder. */
export function writeHToDir(tree: HTree, hDir: string): void {
  ensureDir(hDir);
  for (const [rel, data] of tree) {
    const abs = path.join(hDir, rel);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, data);
  }
}

/**
 * Put an H tree into a workspace at project paths. Removes H files of the workspace that the tree
 * does not have, so a deleted component is deleted in the run too. The orchestrator does this copy,
 * not an agent, so the .claude/ protected path does not apply.
 */
export function applyHToWorkspace(tree: HTree, workspace: string): void {
  const current = readHFromProject(workspace);
  for (const h of current.keys()) {
    if (!tree.has(h)) {
      const p = hToProject(h);
      if (p) fs.rmSync(path.join(workspace, p), { force: true });
    }
  }
  for (const [h, data] of tree) {
    const p = hToProject(h);
    if (!p) continue;
    const abs = path.join(workspace, p);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, data);
  }
  // Claude Code loads the main checkout's .claude/ folders when a worktree lacks them (docs/plan.md, m8).
  for (const d of [".claude/skills", ".claude/agents", ".claude/commands"]) ensureDir(path.join(workspace, d));
}

/** Tree hash: SHA-256 over (path, NUL, bytes, NUL) in sorted path order. */
export function treeHash(tree: HTree): string {
  const parts: Buffer[] = [];
  for (const rel of [...tree.keys()].sort()) {
    parts.push(Buffer.from(rel + "\0"), tree.get(rel) as Buffer, Buffer.from("\0"));
  }
  return sha256(Buffer.concat(parts));
}

/** Unified diff between two H trees, with paths relative to the H root. */
export async function diffH(base: HTree, other: HTree, scratch: string): Promise<string> {
  const a = path.join(scratch, "a");
  const b = path.join(scratch, "b");
  fs.rmSync(scratch, { recursive: true, force: true });
  writeHToDir(base, a);
  writeHToDir(other, b);
  // The folders are named a and b, so --no-prefix gives the usual a/<path> and b/<path> headers.
  const r = await run("git", ["diff", "--no-index", "--no-color", "--no-prefix", "a", "b"], { cwd: scratch });
  fs.rmSync(scratch, { recursive: true, force: true });
  // git diff --no-index exits 1 when the trees differ.
  if (r.code > 1) throw new Error(`git diff failed: ${r.stderr}`);
  return r.stdout;
}

// --- Format rules of skills and subagents ---------------------------------------------------------
//
// Skills follow the Agent Skills specification (https://agentskills.io/specification). Claude Code
// also reads fields that are not in the specification. Some of them run code or change permissions:
// `hooks` (shell commands), `mcpServers` (a program that starts), `allowed-tools`, `permissionMode`,
// `model`, `effort`. Claude Code runs hooks and MCP servers outside the guard hook, and the role
// settings cannot turn off skill hooks without turning off the guard too. For this reason, an H skill or an H
// subagent can use only the keys in these lists. Hooks belong to the pinned layer (docs/plan.md).

/** Frontmatter keys of an H skill: the fields of the Agent Skills specification, without `allowed-tools`. */
export const SKILL_KEYS: readonly string[] = ["name", "description", "license", "compatibility", "metadata"];
/** Frontmatter keys of an H subagent (`agents/<name>.md`). */
export const AGENT_KEYS: readonly string[] = ["name", "description", "tools", "disallowedTools", "skills", "maxTurns", "color"];
/** Name rule of the specification: 1-64 characters, a-z, 0-9 and single hyphens, no hyphen at the start or the end. */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const COMPATIBILITY_MAX = 500;
/** Inline shell of a skill body: the two forms that Claude Code runs when it loads the skill. */
const INLINE_SHELL = [/```!/, /(?:^|\s)!`[^`]+`/m];

export interface Frontmatter {
  /** Top-level key -> its text value. A value on more lines is joined with spaces. */
  keys: Map<string, string>;
  /** Lines that are not a plain `key:` line, an indented line, a comment or a blank line. */
  badLines: string[];
  body: string;
}

/**
 * Split the YAML frontmatter into its top-level keys. The block ends at the first `---`, also in the
 * middle of a line, as in Claude Code 2.1.310 (`/^---\s*\n([\s\S]*?)---\s*\n?/`). The parser is strict
 * on purpose: it accepts only plain `key: value` lines and indented continuation lines. A quoted key,
 * a flow mapping, a merge key or a duplicate key goes into `badLines`, so a key cannot hide from the
 * key lists.
 */
export function parseFrontmatter(raw: string): Frontmatter | null {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
  if (!m) return null;
  const keys = new Map<string, string>();
  const badLines: string[] = [];
  let current: string | null = null;
  for (const line of (m[1] ?? "").split("\n")) {
    if (/^\s*$/.test(line) || line.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (current === null) badLines.push(line);
      else keys.set(current, `${keys.get(current) ?? ""} ${line.trim()}`.trim());
      continue;
    }
    const k = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
    if (!k || !k[1] || keys.has(k[1])) {
      badLines.push(line);
      current = null;
      continue;
    }
    current = k[1];
    keys.set(current, (k[2] ?? "").trim());
  }
  return { keys, badLines, body: text.slice(m[0].length) };
}

/** The text of a scalar value without quotes, a block indicator (`|`, `>-`, ...) or a trailing comment. */
function scalarText(value: string): string {
  let v = value.replace(/^[|>][0-9+-]*\s*/, "").trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, "");
}

function frontmatterProblems(rel: string, fm: Frontmatter, allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of fm.badLines) {
    out.push(`${rel}: frontmatter line "${line.trim().slice(0, 60)}" is not a plain "key: value" line, or the key is a duplicate.`);
  }
  for (const key of fm.keys.keys()) {
    if (!allowed.includes(key)) {
      out.push(`${rel}: frontmatter key "${key}" is not allowed. Use only: ${allowed.join(", ")}. Hooks, MCP servers, tool approvals, permission modes and models belong to the pinned layer.`);
    }
  }
  return out;
}

function nameProblems(rel: string, name: string): string[] {
  if (name.length > NAME_MAX || !NAME_RE.test(name)) {
    return [`${rel}: name "${name.slice(0, 80)}" must have 1-${NAME_MAX} characters: a-z, 0-9 and single hyphens, with no hyphen at the start or the end.`];
  }
  return [];
}

/**
 * Problems that can run code or change permissions outside the guard. The pipeline refuses to start
 * a run with such a tree, also when a human wrote it.
 */
export function unsafeH(tree: HTree): string[] {
  const problems: string[] = [];
  for (const [rel, data] of tree) {
    const isSkill = /^skills\/[^/]+\/SKILL\.md$/.test(rel);
    const isAgent = /^agents\/[^/]+\.md$/.test(rel);
    if (!isSkill && !isAgent) continue;
    const text = data.toString("utf8");
    const fm = parseFrontmatter(text);
    if (!fm) {
      // Fail closed: a block that starts like frontmatter but does not parse here can parse in another reader.
      if (/^\uFEFF?---/.test(text)) problems.push(`${rel}: the frontmatter starts with "---" but has no closing "---".`);
      continue;
    }
    problems.push(...frontmatterProblems(rel, fm, isSkill ? SKILL_KEYS : AGENT_KEYS));
    if (isSkill && INLINE_SHELL.some((re) => re.test(fm.body))) {
      problems.push(`${rel}: inline shell (\`!\` blocks) runs when the skill loads, outside the guard. Put the command in a script and name the script in a step.`);
    }
  }
  return problems;
}

/** Problems that make a candidate tree invalid (docs/plan.md and the editor prompt: "rules that discard the proposal"). */
/**
 * @param projectHas optional: true when the project has this path at its root. A `scripts/` path
 *   that the project has (for example `scripts/test/check.test.mjs`) is a project file, not a missing
 *   script of H (C44).
 */
export function validateH(tree: HTree, projectHas?: (rel: string) => boolean): string[] {
  const problems: string[] = [];
  const alwaysOn = ["instructions.md", "guardrails.md"].map((f) => (tree.get(f) ?? Buffer.alloc(0)).toString("utf8")).join("\n");
  const skillDirs = new Set<string>();
  for (const rel of tree.keys()) {
    if (isPinnedPath(rel)) problems.push(`${rel}: an R role cannot create a pinned- file.`);
    const m = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (m && m[1]) skillDirs.add(m[1]);
  }
  for (const name of skillDirs) {
    const rel = `skills/${name}/SKILL.md`;
    const fm = parseFrontmatter((tree.get(rel) as Buffer).toString("utf8"));
    if (!fm) {
      problems.push(`${rel} has no frontmatter.`);
      continue;
    }
    const fmName = scalarText(fm.keys.get("name") ?? "");
    if (fmName !== name) problems.push(`${rel}: frontmatter name must be "${name}".`);
    problems.push(...nameProblems(rel, name));
    const description = scalarText(fm.keys.get("description") ?? "");
    if (!description) problems.push(`${rel}: frontmatter needs a description.`);
    else if (description.length > DESCRIPTION_MAX) problems.push(`${rel}: the description has ${description.length} characters. The limit is ${DESCRIPTION_MAX}.`);
    const compat = fm.keys.has("compatibility") ? scalarText(fm.keys.get("compatibility") ?? "") : null;
    if (compat !== null && (compat.length === 0 || compat.length > COMPATIBILITY_MAX)) problems.push(`${rel}: compatibility must have 1-${COMPATIBILITY_MAX} characters.`);
    // The name must appear as a whole word: "a" in "a test" is not a trigger line for skill "a-b".
    const escaped = name.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    if (!new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`).test(alwaysOn)) problems.push(`skills/${name}: no trigger line. Name the skill in instructions.md or guardrails.md.`);
  }
  for (const [rel, data] of tree) {
    if (!/^agents\/[^/]+\.md$/.test(rel)) continue;
    const fm = parseFrontmatter(data.toString("utf8"));
    if (!fm) {
      problems.push(`${rel} has no frontmatter.`);
      continue;
    }
    const agentName = scalarText(fm.keys.get("name") ?? "");
    if (!agentName) problems.push(`${rel}: frontmatter needs a name.`);
    else problems.push(...nameProblems(rel, agentName));
    if (!scalarText(fm.keys.get("description") ?? "")) problems.push(`${rel}: frontmatter needs a description.`);
  }
  problems.push(...unsafeH(tree));
  problems.push(...missingFiles(tree, projectHas));
  return [...new Set(problems)];
}

/**
 * Files that the harness names but does not have. In a skill folder, `scripts/` and `references/`
 * are relative to the skill folder (the convention of the specification). A `scripts/` path can also
 * point to the shared `scripts/` folder of H. `assets/` is not checked, because many projects have
 * an `assets/` folder of their own.
 */
function missingFiles(tree: HTree, projectHas: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const clean = (s: string): string => s.replace(/[.,;:)`'"\]]+$/, "");
  for (const [file, data] of tree) {
    const text = data.toString("utf8");
    const skill = file.match(/^(skills\/[^/]+\/)/)?.[1] ?? null;
    for (const m of text.matchAll(/(?:^|[\s`(])(harness\/)?scripts\/([A-Za-z0-9_.\-/]+)/g)) {
      const name = clean(m[2] ?? "");
      if (!name || name.endsWith("/") || name.includes("*")) continue;
      const shared = `scripts/${name}`;
      const local = skill && !m[1] ? `${skill}scripts/${name}` : null;
      if (tree.has(shared) || (local && tree.has(local))) continue;
      if (!m[1] && projectHas(shared)) continue;
      out.push(local ? `${shared} is named in ${file} but is missing (looked in ${skill}scripts/ and scripts/).` : `${shared} is named in the harness but is missing.`);
    }
    if (!skill) continue;
    for (const m of text.matchAll(/(?:^|[\s`(])references\/([A-Za-z0-9_.\-/]+)/g)) {
      const name = clean(m[1] ?? "");
      if (!name || name.endsWith("/") || name.includes("*")) continue;
      const local = `${skill}references/${name}`;
      if (!tree.has(local)) out.push(`${local} is named in ${file} but is missing.`);
    }
  }
  return out;
}

/** The named components of an H tree. */
export interface HInventory {
  /** Skill names (the directory names). */
  skills: string[];
  /** Subagent names (the frontmatter name, else the file name). */
  agents: string[];
  /** Project paths of the scripts: `harness/scripts/...` and `.claude/skills/<name>/scripts/...`. */
  scripts: string[];
}

export function inventory(tree: HTree): HInventory {
  const skills: string[] = [];
  const agents: string[] = [];
  const scripts: string[] = [];
  for (const [rel, data] of tree) {
    const s = rel.match(/^skills\/([^/]+)\/SKILL\.md$/);
    if (s && s[1]) skills.push(s[1]);
    const a = rel.match(/^agents\/([^/]+)\.md$/);
    if (a && a[1]) agents.push(scalarText(parseFrontmatter(data.toString("utf8"))?.keys.get("name") ?? "") || a[1]);
    if (/^scripts\/./.test(rel) || /^skills\/[^/]+\/scripts\/./.test(rel)) scripts.push(hToProject(rel) as string);
  }
  return { skills: skills.sort(), agents: agents.sort(), scripts: scripts.sort() };
}

/** Total bytes of the always-on files plus every SKILL.md: the measure for the growth limit. */
export function promptSize(tree: HTree): number {
  let n = 0;
  for (const [rel, data] of tree) if (isPromptFile(rel)) n += data.length;
  return n;
}

/** True for the files that the growth limit counts: the always-on files and each SKILL.md. */
export function isPromptFile(rel: string): boolean {
  return ["instructions.md", "guardrails.md", "memory.md", "tool-guidance.md"].includes(rel) || /^skills\/[^/]+\/SKILL\.md$/.test(rel);
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + ent.name;
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel + "/"));
    else if (ent.isFile()) out.push(rel);
  }
  return out.sort();
}
