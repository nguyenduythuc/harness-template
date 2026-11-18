// Owner classes of project files. No dependencies: hooks run this on every tool call.
//
// Three classes (docs/plan.md, "Quy ước tiền tố pinned-"):
//   pinned     - a human owns the file. Agents never write it.
//   loop-owned - a file of H0. Only the improvement loop proposes changes, through an h0-promotion PR.
//   task       - all other files. The executor changes them for the task.
// Some file names come from the tool (CLAUDE.md, .claude/settings.json). They are "exceptions":
// the template treats them as pinned without the prefix.

import fs from "node:fs";
import path from "node:path";

/** Convert a path to forward slashes and remove a leading "./". */
export function normalize(p) {
  let s = String(p).replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** Path of `abs` relative to `root`, with forward slashes. Returns null when `abs` is outside `root`. */
export function relativeTo(root, abs) {
  const rel = normalize(path.relative(path.resolve(root), path.resolve(abs)));
  if (rel === "" ) return "";
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/** True when `abs` is `root` or inside it. */
export function isInside(root, abs) {
  return relativeTo(root, abs) !== null;
}

/**
 * Convert a glob to a RegExp. Supported: "**" (any number of path segments), "*" (inside one segment),
 * "?" (one character inside a segment), "{a,b}" (alternatives). Patterns match the full relative path.
 */
export function globToRegExp(glob) {
  const g = normalize(glob);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/";
        if (slashAfter) {
          re += "(?:[^/]+/)*"; // "**/" matches zero or more directories
          i += 2;
        } else {
          re += ".*"; // "**" at the end matches everything below
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
      } else {
        const alts = g.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += "(?:" + alts.join("|") + ")";
        i = end;
      }
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

const globCache = new Map();
/** True when the relative path `rel` matches `glob`. */
export function matchGlob(glob, rel) {
  let re = globCache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    globCache.set(glob, re);
  }
  return re.test(normalize(rel));
}

/** True when any segment of the relative path starts with "pinned-". A pinned- directory protects all files inside it. */
export function isPinned(rel) {
  return normalize(rel).split("/").some((seg) => seg.startsWith("pinned-"));
}

/** Files whose names the tool sets. The template protects them like pinned- files. */
export const EXCEPTION_RULES = [
  "**/CLAUDE*.md",
  "**/AGENTS.md",
  ".claude/settings*.json",
  ".claude/rules/**",
  ".claude/hooks/**",
  ".claude/commands/**",
  "(nested) <dir>/**/.claude/**",
  "**/.mcp.json",
  ".github/**",
  ".gitlab/**",
  ".gitlab-ci.yml",
  ".husky/**",
];

/** True when `rel` is an exception path (see EXCEPTION_RULES). */
export function isException(rel) {
  const r = normalize(rel);
  const segs = r.split("/");
  const base = segs[segs.length - 1];
  if (/^CLAUDE.*\.md$/.test(base)) return true;
  if (base === "AGENTS.md") return true;
  if (base === ".mcp.json") return true;
  if (segs[0] === ".github" || segs[0] === ".gitlab" || segs[0] === ".husky") return true;
  if (segs.length === 1 && base === ".gitlab-ci.yml") return true;
  if (segs[0] === ".claude") {
    if (segs.length === 2 && /^settings.*\.json$/.test(base)) return true;
    if (["rules", "hooks", "commands"].includes(segs[1])) return true;
  }
  // A .claude directory below the project root loads on demand, so it is an exception too.
  // One return, as in ownership.ts. The scaffold copies this file into each project, and the
  // project linter checks it: sonarjs/prefer-single-boolean-return failed on the trial monorepo.
  return segs.indexOf(".claude", 1) !== -1;
}

/** True when `rel` matches one of the loop-owned globs. A pinned- path is never loop-owned. */
export function isLoopOwned(rel, loopOwnedGlobs) {
  if (isPinned(rel)) return false;
  return (loopOwnedGlobs || []).some((g) => matchGlob(g, rel));
}

/** Owner class of a relative path: "pinned" | "exception" | "loop-owned" | "task". */
export function classify(rel, loopOwnedGlobs) {
  if (isPinned(rel)) return "pinned";
  if (isException(rel)) return "exception";
  if (isLoopOwned(rel, loopOwnedGlobs)) return "loop-owned";
  return "task";
}

/**
 * Read the `loop_owned:` list from harness/pinned-config.yaml without a YAML library.
 * The parser reads only a block list of plain or quoted strings directly under the key.
 */
export function parseLoopOwned(yamlText) {
  return parseYamlList(yamlText, "loop_owned");
}

/** Read a top-level block list (`key:` then `  - item` lines) from YAML text. */
export function parseYamlList(yamlText, key) {
  const lines = String(yamlText).split(/\r?\n/);
  const out = [];
  let inBlock = false;
  const head = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":\\s*$");
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!inBlock) {
      if (head.test(line)) inBlock = true;
      continue;
    }
    if (/^\s*$/.test(line)) continue;
    const m = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!m) break;
    out.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return out;
}

/** Loop-owned globs of a project. Returns the default list when the config file is missing. */
export function readLoopOwned(projectDir) {
  const file = path.join(projectDir, "harness", "pinned-config.yaml");
  try {
    const list = parseLoopOwned(fs.readFileSync(file, "utf8"));
    if (list.length > 0) return list;
  } catch {
    // Missing config: use the default list.
  }
  return DEFAULT_LOOP_OWNED.slice();
}

/** Default loop-owned globs. They match the template in templates/project/harness/pinned-config.yaml. */
export const DEFAULT_LOOP_OWNED = [
  "harness/instructions.md",
  "harness/guardrails.md",
  "harness/tool-guidance.md",
  "harness/memory.md",
  "harness/scripts/**",
  ".claude/skills/**",
  ".claude/agents/**",
];
