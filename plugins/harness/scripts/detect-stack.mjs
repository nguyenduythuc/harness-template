#!/usr/bin/env node
// Detect the stack of a project from its files, and propose the gate commands.
// Usage: node detect-stack.mjs <projectDir>     (prints JSON)

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJson } from "./lib/io.mjs";

const SCRIPT_NAMES = {
  build: ["build"],
  typecheck: ["typecheck", "type-check", "check-types", "types", "tsc"],
  lint: ["lint"],
  test: ["test", "test:unit"],
};

function packageManager(dir) {
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
  return "npm";
}

function runCommand(pm, script, extraArgs) {
  const extra = extraArgs ? " " + extraArgs : "";
  if (pm === "npm") return `npm run ${script}${extraArgs ? " --" + extra : ""}`;
  return `${pm} ${script}${extra}`;
}

/**
 * @returns {{packageManager: string, workspaces: boolean, reactNative: boolean, next: boolean,
 *            gate: {build: string, typecheck: string, lint: string, test: string}, notes: string[]}}
 */
export function detectStack(projectDir) {
  const pkg = readJson(path.join(projectDir, "package.json"), null);
  const pm = packageManager(projectDir);
  const notes = [];
  const gate = { build: "TODO", typecheck: "TODO", lint: "TODO", test: "TODO" };
  if (!pkg) {
    notes.push("No package.json. Fill in the gate commands by hand.");
    return { packageManager: pm, workspaces: false, reactNative: false, next: false, gate, notes };
  }
  const scripts = pkg.scripts || {};
  for (const [key, names] of Object.entries(SCRIPT_NAMES)) {
    const name = names.find((n) => typeof scripts[n] === "string");
    if (!name) continue;
    let extra = "";
    if (key === "test" && /\bjest\b/.test(scripts[name])) {
      extra = "--no-watchman";
      notes.push("The test script uses jest. The gate adds --no-watchman, because watchman does not run in the sandbox.");
    }
    // A script that only prints a message and fails (for example "echo pick an env && exit 1") is not a check.
    if (key === "build" && /\bexit\s+[1-9]/.test(scripts[name])) {
      const alt = Object.keys(scripts).find((s) => /^build:(dev|ci|development|test)$/.test(s));
      if (alt) {
        gate.build = runCommand(pm, alt);
        notes.push(`The "build" script fails on purpose, so the gate uses "${alt}". Check that it needs no secret.`);
      } else notes.push('The "build" script fails on purpose. Set gate.build by hand, or write "none".');
      continue;
    }
    gate[key] = runCommand(pm, name, extra);
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const reactNative = "react-native" in deps || fs.existsSync(path.join(projectDir, "ios")) || fs.existsSync(path.join(projectDir, "android"));
  const next = "next" in deps;
  const workspaces =
    Array.isArray(pkg.workspaces) || (pkg.workspaces && typeof pkg.workspaces === "object") || fs.existsSync(path.join(projectDir, "pnpm-workspace.yaml"));
  if (reactNative) notes.push("React Native found. Native builds (xcodebuild, Gradle) can fail in the sandbox. Keep them out of the gate until Phase 1 tests them.");
  for (const [k, v] of Object.entries(gate)) if (v === "TODO") notes.push(`No script for "${k}". The doctor fails until a human fills it in.`);
  return { packageManager: pm, workspaces: Boolean(workspaces), reactNative, next, gate, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dir = path.resolve(process.argv[2] || process.cwd());
  process.stdout.write(JSON.stringify(detectStack(dir), null, 2) + "\n");
}
