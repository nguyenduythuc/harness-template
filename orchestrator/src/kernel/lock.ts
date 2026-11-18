// harness/pinned-harness.lock: the versions and hashes of the plugin and orchestrator that a project
// uses, and the SHA of its frozen H0. The orchestrator compares them before it opens a session.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { gitOk, git } from "../util/exec.js";
import { hashDir, readJson } from "../util/fs.js";

export interface LockPart {
  name?: string;
  version: string | null;
  git_sha: string | null;
  content_hash: string | null;
}

export interface Lock {
  lock_version: 1;
  created_at: string;
  plugin: LockPart;
  orchestrator: LockPart;
  claude_code_min: string;
  h0_sha: string | null;
  generated?: string[];
}

export function lockPath(projectDir: string): string {
  return path.join(projectDir, "harness", "pinned-harness.lock");
}

export function readLock(projectDir: string): Lock | null {
  const l = readJson<Lock | null>(lockPath(projectDir), null);
  return l && l.lock_version === 1 ? l : null;
}

/** Compare dotted versions. Returns <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The Claude Code version that the installed Agent SDK bundles. */
export function bundledClaudeCodeVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // The package "exports" field does not list package.json, so resolve the entry file and go up.
    const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
    const pkgPath = path.join(path.dirname(entry), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { claudeCodeVersion?: string; version?: string };
    return pkg.claudeCodeVersion ?? null;
  } catch {
    return null;
  }
}

export function gitHead(dir: string): string | null {
  return gitOk(["rev-parse", "HEAD"], dir) ? git(["rev-parse", "HEAD"], dir).trim() : null;
}

export interface RuntimeIdentity {
  plugin: LockPart;
  orchestrator: LockPart;
  claude_code_version: string | null;
}

/** Versions and hashes of the plugin and orchestrator in the template checkout. */
export function runtimeIdentity(templateDir: string): RuntimeIdentity {
  const pluginDir = path.join(templateDir, "plugins", "harness");
  const orchDir = path.join(templateDir, "orchestrator");
  const pluginManifest = readJson<{ version?: string }>(path.join(pluginDir, ".claude-plugin", "plugin.json"), {});
  const orchPkg = readJson<{ version?: string }>(path.join(orchDir, "package.json"), {});
  const sha = gitHead(templateDir);
  return {
    plugin: { name: "harness", version: pluginManifest.version ?? null, git_sha: sha, content_hash: fs.existsSync(pluginDir) ? hashDir(pluginDir) : null },
    orchestrator: { version: orchPkg.version ?? null, git_sha: sha, content_hash: fs.existsSync(path.join(orchDir, "src")) ? hashDir(path.join(orchDir, "src")) : null },
    claude_code_version: bundledClaudeCodeVersion(),
  };
}

/**
 * Compare the runtime with the lock. In dev mode (Phases 1-3, plugin loaded with --plugin-dir),
 * a hash difference is a note, not a problem: the run records the SHA, and only runs with the same SHA
 * are comparable.
 */
export function checkRuntime(lock: Lock | null, rt: RuntimeIdentity, dev: boolean): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!lock) {
    problems.push("harness/pinned-harness.lock is missing or not valid. Run /harness:init.");
    return { problems, notes };
  }
  if (!rt.claude_code_version) problems.push("The Agent SDK is not installed, so the Claude Code version is unknown.");
  else if (compareVersions(rt.claude_code_version, lock.claude_code_min) < 0) {
    problems.push(`Claude Code ${rt.claude_code_version} is older than the minimum ${lock.claude_code_min} in the lock.`);
  }
  for (const part of ["plugin", "orchestrator"] as const) {
    const want = lock[part].content_hash;
    const have = rt[part].content_hash;
    if (want && have && want !== have) {
      const msg = `The ${part} on this machine (${have.slice(0, 12)}) differs from the lock (${want.slice(0, 12)}).`;
      if (dev) notes.push(msg + " Dev mode: the run records the SHA instead.");
      else problems.push(msg + " Run /harness:upgrade or use the locked version.");
    }
  }
  return { problems, notes };
}
