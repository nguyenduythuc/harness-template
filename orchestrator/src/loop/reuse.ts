// Reuse event (docs/plan.md, "Thước đo khác"): a task reuses the library when
//   (a) a file of the adopted H′ has at least 30% of its non-boilerplate lines in one library entry of
//       the same component (containment, as in App. E.2 of the paper), or
//   (b) the composer kept or revised an edit whose notes cite a lesson as [L:<domain>/<entry>].
// Boilerplate lines are lines that appear in more than 1/5 of the library entries.

import fs from "node:fs";
import path from "node:path";
import type { HTree } from "../kernel/htree.js";

export const CONTAINMENT_MIN = 0.3;

function significant(line: string): string | null {
  const t = line.trim();
  return t.length >= 8 ? t : null;
}

/** Added lines of each library entry patch, keyed by entry, with the H path of each line's file. */
export function libraryLines(libraryDir: string): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  if (!fs.existsSync(libraryDir)) return out;
  for (const domain of fs.readdirSync(libraryDir, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(libraryDir, domain.name), { withFileTypes: true })) {
      const patch = path.join(libraryDir, domain.name, entry.name, "H.patch");
      if (!entry.isDirectory() || !fs.existsSync(patch)) continue;
      const byFile = new Map<string, Set<string>>();
      let file = "";
      for (const line of fs.readFileSync(patch, "utf8").split("\n")) {
        const m = line.match(/^\+\+\+ b\/(.+)$/);
        if (m && m[1]) {
          file = m[1];
          continue;
        }
        if (line.startsWith("+") && !line.startsWith("+++") && file) {
          const s = significant(line.slice(1));
          if (s) byFile.set(file, (byFile.get(file) ?? new Set()).add(s));
        }
      }
      out.set(`${domain.name}/${entry.name}`, byFile);
    }
  }
  return out;
}

/** Lesson IDs of the library entries (the `id:` line of each EXPERIENCE.md), keyed by "<domain>/<entry>". */
export function libraryIds(libraryDir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(libraryDir)) return out;
  for (const domain of fs.readdirSync(libraryDir, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(libraryDir, domain.name), { withFileTypes: true })) {
      const file = path.join(libraryDir, domain.name, entry.name, "EXPERIENCE.md");
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      const id = fs.readFileSync(file, "utf8").match(/^id:\s*(L[0-9a-f]{12})\s*$/m)?.[1];
      if (id) out.set(`${domain.name}/${entry.name}`, id);
    }
  }
  return out;
}

/**
 * The library entries that a task reused: the lesson ID when the entry has one, else "<domain>/<entry>".
 * An empty list means no reuse event.
 */
export function reuseMatches(base: HTree, adopted: HTree, libraryDir: string, notes: string[]): string[] {
  const ids = libraryIds(libraryDir);
  const lib = libraryLines(libraryDir);
  const name = (key: string): string => ids.get(key) ?? key;
  const hits = new Set<string>();
  const composerNotes = notes[notes.length - 1] ?? "";
  for (const line of composerNotes.split("\n")) {
    if (!/^\s*(kept|revised)\b/i.test(line)) continue;
    for (const m of line.matchAll(/\[L:([^\]]+)\]/g)) {
      const key = (m[1] ?? "").trim();
      // A cite counts only when the entry exists: a model can cite a lesson that is not in the library.
      if (key && (ids.has(key) || lib.has(key))) hits.add(name(key));
    }
  }
  if (!lib.size) return [...hits].sort();
  const counts = new Map<string, number>();
  for (const byFile of lib.values()) {
    const seen = new Set<string>();
    for (const lines of byFile.values()) for (const l of lines) seen.add(l);
    for (const l of seen) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const boilerplate = new Set([...counts].filter(([, n]) => lib.size >= 5 && n > lib.size / 5).map(([l]) => l));

  for (const [rel, data] of adopted) {
    const before = base.get(rel);
    if (before && before.equals(data)) continue;
    const lines = data
      .toString("utf8")
      .split("\n")
      .map(significant)
      .filter((l): l is string => l !== null && !boilerplate.has(l));
    if (!lines.length) continue;
    for (const [key, byFile] of lib) {
      const entryLines = byFile.get(rel);
      if (!entryLines) continue;
      const hit = lines.filter((l) => entryLines.has(l)).length;
      if (hit / lines.length >= CONTAINMENT_MIN) hits.add(name(key));
    }
  }
  return [...hits].sort();
}

export function reuseEvent(base: HTree, adopted: HTree, libraryDir: string, notes: string[]): boolean {
  return reuseMatches(base, adopted, libraryDir, notes).length > 0;
}
