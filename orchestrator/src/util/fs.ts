// File helpers.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

/** Write a file only when it is missing. Returns true when the file was written. */
export function writeIfMissing(file: string, content: string | Buffer): boolean {
  if (fs.existsSync(file)) return false;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  return true;
}

export function appendJsonl(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
}

export function readJsonl<T = unknown>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIP_FILES = [/\.log$/, /^\.DS_Store$/];

/** Sorted relative file paths below `root`, with the same skip rules as plugins/harness/scripts/checksum.mjs. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name));
      } else if (ent.isFile() && !SKIP_FILES.some((re) => re.test(ent.name))) {
        out.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Content hash of a directory. Must give the same value as checksum.mjs (a test checks this). */
export function hashDir(root: string): string {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** Copy a directory tree. Skips node_modules and .git. */
export function copyDir(src: string, dst: string): void {
  ensureDir(dst);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/** True when any directory from `dir` up to the file system root holds a CLAUDE.md. */
export function hasClaudeMdAncestor(dir: string): string | null {
  let cur = path.resolve(dir);
  for (;;) {
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
      const f = path.join(cur, name);
      if (fs.existsSync(f)) return f;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Remove a directory tree. Never throws. */
export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort.
  }
}
