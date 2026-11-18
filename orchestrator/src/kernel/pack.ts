// Tool packs: sets of project files (hooks, agents, MCP config, CI gate, test preset) that the
// template keeps in packs/<name>/. `harness pack install <name>` copies one pack into a project.
//
// Rules of the installer (the same as the scaffold):
//   - A file that the project does not have: the installer creates it.
//   - A file that the project has: the installer writes <file>.harness-proposed. It never writes
//     the file. A human compares and moves the proposal.
//   - package.json: the installer never changes it. It prints the scripts and packages to add.
//
// Layout of a pack:
//   pack.json          name, description, packageJson { scripts, devDependencies }, manual [steps]
//   files/**           for each project
//   files.github/**    only for a GitHub project      files.gitlab/**   only for a GitLab project
//   append/**          lines to add to a file that the scaffold made (for example pinned-guardrails.md)
// Text in files.github/ and files.gitlab/ can use {{install}}, {{gate.build}}, {{gate.typecheck}},
// {{gate.lint}} and {{gate.test}}.

import fs from "node:fs";
import path from "node:path";
import { ciHost, PROPOSED_SUFFIX } from "./admin.js";
import type { CiHost } from "./admin.js";
import { GATE_NONE, loadProjectConfig } from "./config.js";

export interface PackManifest {
  name: string;
  description: string;
  packageJson?: { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  manual?: string[];
}

export interface PackResult {
  pack: string;
  ci: CiHost;
  created: string[];
  proposed: string[];
  skipped: string[];
  /** Steps that a human does: package.json changes and the manual list of the pack. */
  manual: string[];
}

const MERGE_JSON = new Set([".claude/settings.json", ".mcp.json"]);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const go = (d: string): void => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) go(p);
      else out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  go(dir);
  return out.sort();
}

export function listPacks(templateDir: string): PackManifest[] {
  const root = path.join(templateDir, "packs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, "pack.json")))
    .map((e) => readManifest(path.join(root, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readManifest(packDir: string): PackManifest {
  const file = path.join(packDir, "pack.json");
  if (!fs.existsSync(file)) throw new Error(`${packDir} has no pack.json.`);
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as PackManifest;
  if (!m.name || !m.description) throw new Error(`${file} needs a name and a description.`);
  return m;
}

/** Deep merge for settings files: objects merge, arrays keep each different item once, the pack wins on a scalar. */
export function mergeJson(base: unknown, add: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(add)) {
    const seen = new Set(base.map((x) => JSON.stringify(x)));
    return [...base, ...add.filter((x) => !seen.has(JSON.stringify(x)))];
  }
  if (base && add && typeof base === "object" && typeof add === "object" && !Array.isArray(base) && !Array.isArray(add)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(add as Record<string, unknown>)) out[k] = k in out ? mergeJson(out[k], v) : v;
    return out;
  }
  return add;
}

function installCommand(projectDir: string): string {
  const has = (f: string): boolean => fs.existsSync(path.join(projectDir, f));
  if (has("yarn.lock")) return "yarn install --frozen-lockfile";
  if (has("pnpm-lock.yaml")) return "corepack enable && pnpm install --frozen-lockfile";
  return "npm ci";
}

/** Values for {{...}} in the CI files. A gate command that is not set gives a line that fails with a clear text. */
export function renderVars(projectDir: string): Record<string, string> {
  let gate: Record<string, string> = {};
  try {
    gate = loadProjectConfig(projectDir).gate as unknown as Record<string, string>;
  } catch {
    // No harness config yet: each gate value becomes a TODO line.
  }
  const cmd = (k: string): string => {
    const v = String(gate[k] ?? "").trim();
    if (v === GATE_NONE) return `echo "no ${k} check in this project"`;
    if (!v || v === "TODO") return `echo "TODO: set gate.${k} in harness/pinned-config.yaml, then copy the command here" && exit 1`;
    return v;
  };
  return { install: installCommand(projectDir), "gate.build": cmd("build"), "gate.typecheck": cmd("typecheck"), "gate.lint": cmd("lint"), "gate.test": cmd("test") };
}

function render(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([a-z.]+)\}\}/g, (all, k: string) => vars[k] ?? all);
}

export function installPack(packDir: string, projectDir: string, opts: { dryRun?: boolean } = {}): PackResult {
  const manifest = readManifest(packDir);
  const ci = ciHost(projectDir);
  const r: PackResult = { pack: manifest.name, ci, created: [], proposed: [], skipped: [], manual: [] };
  const write = (rel: string, content: string): void => {
    if (opts.dryRun) return;
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const propose = (rel: string, content: string): void => {
    const out = rel + PROPOSED_SUFFIX;
    const abs = path.join(projectDir, out);
    if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8") === content) {
      r.skipped.push(out);
      return;
    }
    write(out, content);
    r.proposed.push(out);
  };
  const place = (rel: string, content: string): void => {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) {
      write(rel, content);
      r.created.push(rel);
      return;
    }
    const existing = fs.readFileSync(abs, "utf8");
    let next = content;
    if (MERGE_JSON.has(rel)) {
      try {
        next = JSON.stringify(mergeJson(JSON.parse(existing), JSON.parse(content)), null, 2) + "\n";
        if (JSON.stringify(JSON.parse(next)) === JSON.stringify(JSON.parse(existing))) next = existing;
      } catch {
        next = content;
      }
    }
    if (next === existing) r.skipped.push(rel);
    else propose(rel, next);
  };

  for (const rel of walk(path.join(packDir, "files"))) place(rel, fs.readFileSync(path.join(packDir, "files", rel), "utf8"));
  const hostDir = path.join(packDir, `files.${ci}`);
  const vars = renderVars(projectDir);
  for (const rel of walk(hostDir)) place(rel, render(fs.readFileSync(path.join(hostDir, rel), "utf8"), vars));

  for (const rel of walk(path.join(packDir, "append"))) {
    const abs = path.join(projectDir, rel);
    if (!fs.existsSync(abs)) {
      r.manual.push(`${rel} is missing, so the pack did not add its lines. Run the scaffold first, then install the pack again.`);
      continue;
    }
    const existing = fs.readFileSync(abs, "utf8");
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const lines = fs.readFileSync(path.join(packDir, "append", rel), "utf8").split("\n").filter((l) => l.trim() && !have.has(l.trim()));
    if (!lines.length) r.skipped.push(rel);
    else propose(rel, existing.replace(/\s*$/, "") + "\n" + lines.join("\n") + "\n");
  }

  const pkgFile = path.join(projectDir, "package.json");
  const pkg = fs.existsSync(pkgFile) ? (JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }) : null;
  const want = manifest.packageJson ?? {};
  const scripts = Object.entries(want.scripts ?? {}).filter(([k]) => !pkg?.scripts?.[k]);
  const deps = Object.entries(want.devDependencies ?? {}).filter(([k]) => !pkg?.devDependencies?.[k] && !pkg?.dependencies?.[k]);
  if (deps.length) r.manual.push(`Add the dev packages with the package manager of the project: ${deps.map(([k, v]) => `${k}@${v}`).join(" ")}`);
  for (const [k, v] of scripts) r.manual.push(`Add to "scripts" in package.json: "${k}": "${v}"`);
  r.manual.push(...(manifest.manual ?? []));
  return r;
}

export function packText(r: PackResult): string {
  const part = (title: string, items: string[]): string => (items.length ? `${title}\n${items.map((i) => `  ${i}`).join("\n")}\n` : "");
  return (
    `Pack ${r.pack} (CI host: ${r.ci})\n` +
    part("Created:", r.created) +
    part("Proposed (compare, then move each file over the original):", r.proposed) +
    part("Not changed:", r.skipped) +
    part("Do by hand:", r.manual.map((m, i) => `${i + 1}. ${m}`))
  );
}
