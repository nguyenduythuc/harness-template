#!/usr/bin/env node
// Check the layer rule of the orchestrator (ARCHITECTURE.md). Imports go one way only:
//   util <- kernel <- loop <- extras <- cli.ts
// kernel runs and measures a fixed harness. loop is the improvement loop. extras are the parts that
// wait for evidence (lesson store, dashboard, library). Exit code 1 on a bad import.

import fs from "node:fs";
import path from "node:path";

const src = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src");
const ALLOWED = {
  util: ["util"],
  kernel: ["util", "kernel"],
  loop: ["util", "kernel", "loop"],
  extras: ["util", "kernel", "loop", "extras"],
};

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

const problems = [];
for (const file of files(src)) {
  const rel = path.relative(src, file);
  const layer = rel.split(path.sep)[0];
  if (!(layer in ALLOWED)) continue; // cli.ts is the composition root: it may import every layer.
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/(?:from\s+|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
    const target = path.relative(src, path.resolve(path.dirname(file), m[1]));
    const tLayer = target.split(path.sep)[0];
    if (target.startsWith("..") || !(ALLOWED[layer] ?? []).includes(tLayer)) problems.push(`${rel}: imports ${m[1]} (layer ${layer} may import ${ALLOWED[layer].join(", ")})`);
  }
}
if (problems.length) {
  process.stderr.write("Layer rule broken (see ARCHITECTURE.md):\n" + problems.map((p) => "  - " + p).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("layers: ok\n");
