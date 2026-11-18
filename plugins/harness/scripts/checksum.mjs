#!/usr/bin/env node
// Content hash of a directory tree. The lock file records it, and the orchestrator compares it before
// each session. Usage: node checksum.mjs <dir>    (prints the hex hash)
//
// The hash covers each file's relative path and bytes, in sorted order. It skips node_modules, dist,
// .git, coverage, logs and OS files, so a dependency install does not change the hash.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);
const SKIP_FILES = [/\.log$/, /^\.DS_Store$/];

/** Sorted relative paths of the files that the hash covers. */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name));
      } else if (ent.isFile()) {
        if (!SKIP_FILES.some((re) => re.test(ent.name))) out.push(path.relative(root, path.join(dir, ent.name)).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** SHA-256 over (relative path, NUL, bytes, NUL) for each file in sorted order. */
export function hashDir(root) {
  const h = crypto.createHash("sha256");
  for (const rel of listFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.stdout.write(hashDir(path.resolve(process.argv[2] || process.cwd())) + "\n");
}
