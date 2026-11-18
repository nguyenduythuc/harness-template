// Executor workspaces (docs/plan.md, "Hai chế độ chạy", B3).
//   - Production: a git worktree outside the repo folder, at the H0 SHA of the lock. The orchestrator
//     removes harness/library/, harness/reports/ and the pinned config files from the working tree.
//     The history stays readable through the shared .git; that is acceptable because production does not measure.
//   - Eval: a new folder from `git archive` at base_sha (no history, no remote), with the H under test
//     copied in, then committed as the base so that diffs work.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { git, gitOk, runShell } from "../util/exec.js";
import { ensureDir, removeDir } from "../util/fs.js";
import type { HTree } from "./htree.js";
import { applyHToWorkspace, H_FILES, H_PREFIXES } from "./htree.js";

/** Paths that never belong to a deliverable: the H surface, the harness bookkeeping, and pinned config. */
export const NON_DELIVERABLE = [
  ...H_FILES.map(([p]) => p),
  ...H_PREFIXES.map(([p]) => p.replace(/\/$/, "")),
  ".claude/commands",
  "harness/library",
  "harness/reports",
  "harness/runs",
  "harness/pinned-config.yaml",
  "harness/pinned-harness.lock",
  "__hidden_tests__",
];

const STRIP_FROM_WORKSPACE = ["harness/library", "harness/reports", "harness/runs", "harness/pinned-config.yaml", "harness/pinned-harness.lock"];

export interface Overlay {
  /** Content of harness/pinned-guardrails.md that CLAUDE.md imports. */
  pinnedGuardrails: string;
  /** The harness import block for CLAUDE.md. */
  claudeBlock: string;
}

function strip(dir: string): void {
  for (const rel of STRIP_FROM_WORKSPACE) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
}

function commitBase(dir: string, message: string): string {
  if (!fs.existsSync(path.join(dir, ".git"))) git(["init", "-q"], dir);
  git(["-c", "user.name=harness", "-c", "user.email=harness@localhost", "add", "-A"], dir);
  git(["-c", "user.name=harness", "-c", "user.email=harness@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

/** Production workspace: a detached worktree at `sha`. Returns the base commit for the deliverable diff. */
export function productionWorkspace(projectDir: string, sha: string, dest: string, h: HTree | null): string {
  ensureDir(path.dirname(dest));
  if (fs.existsSync(dest)) throw new Error(`workspace ${dest} exists`);
  git(["worktree", "add", "--detach", "-q", dest, sha], projectDir);
  strip(dest);
  if (h) applyHToWorkspace(h, dest);
  else for (const d of [".claude/skills", ".claude/agents", ".claude/commands"]) ensureDir(path.join(dest, d));
  return sha;
}

/** Eval workspace: archive at base_sha, overlay H and the pinned harness files, commit as base. */
export function evalWorkspace(projectDir: string, baseSha: string, dest: string, h: HTree, overlay: Overlay): string {
  ensureDir(dest);
  const tar = path.join(path.dirname(dest), `.${path.basename(dest)}.tar`);
  git(["archive", "--format=tar", "-o", tar, baseSha], projectDir);
  git(["-c", "core.autocrlf=false", "init", "-q"], dest);
  // tar is on every platform that the sandbox supports (macOS, Linux, WSL2).
  const unpacked = spawnSync("tar", ["-xf", tar, "-C", dest], { stdio: "ignore" }).status === 0;
  fs.rmSync(tar, { force: true });
  if (!unpacked) throw new Error("tar could not unpack the archive");
  strip(dest);
  applyHToWorkspace(h, dest);
  const pg = path.join(dest, "harness", "pinned-guardrails.md");
  ensureDir(path.dirname(pg));
  fs.writeFileSync(pg, overlay.pinnedGuardrails);
  const claude = path.join(dest, "CLAUDE.md");
  const existing = fs.existsSync(claude) ? fs.readFileSync(claude, "utf8") : "";
  if (!existing.includes("<!-- harness:begin")) fs.writeFileSync(claude, (existing ? existing.replace(/\s*$/, "") + "\n\n" : "") + overlay.claudeBlock);
  return commitBase(dest, `harness eval base ${baseSha}`);
}


/** The deliverable diff of a workspace against its base: task code only. */
export function deliverableDiff(dir: string, baseRef: string): string {
  git(["add", "-A"], dir);
  const excludes = NON_DELIVERABLE.map((p) => `:(exclude)${p}`);
  return git(["diff", "--cached", "--binary", "--no-color", baseRef, "--", ".", ...excludes], dir);
}

/** Changed paths of the deliverable. */
export function deliverablePaths(dir: string, baseRef: string): string[] {
  git(["add", "-A"], dir);
  const excludes = NON_DELIVERABLE.map((p) => `:(exclude)${p}`);
  return git(["diff", "--cached", "--name-only", baseRef, "--", ".", ...excludes], dir).split("\n").filter(Boolean);
}

/** Apply a deliverable diff to a workspace (for example, a reference deliverable into a fresh checkout). */
export function applyDiff(dir: string, diff: string): void {
  if (!diff.trim()) return;
  git(["apply", "--binary", "--whitespace=nowarn", "-"], dir, diff);
}

/** Remove a workspace. A production workspace is a worktree, so git removes it. */
export function removeWorkspace(projectDir: string, dir: string): void {
  if (gitOk(["worktree", "list"], projectDir) && git(["worktree", "list", "--porcelain"], projectDir).includes(dir)) {
    gitOk(["worktree", "remove", "--force", dir], projectDir);
  }
  removeDir(dir);
}

/** Copy the hidden tests of an eval task into a workspace, after the executor finished. */
export function copyHiddenTests(hiddenDir: string, workspace: string, copyTo: string): void {
  const dst = path.join(workspace, copyTo);
  fs.cpSync(hiddenDir, dst, { recursive: true });
}

export interface SetupStep {
  command: string;
  code: number;
  durationMs: number;
}

/**
 * Run the workspace_setup commands of the project in a new workspace (C31). A workspace is a fresh
 * checkout without node_modules. The commands run in the workspace with HARNESS_PROJECT_DIR set, with
 * the rights of the user, like the gate. Returns the steps and an error text for the first failure.
 */
export async function runWorkspaceSetup(
  commands: string[],
  dir: string,
  projectDir: string,
  timeoutS: number,
  shell: typeof runShell = runShell,
  label = "workspace",
): Promise<{ steps: SetupStep[]; error: string | null }> {
  const steps: SetupStep[] = [];
  for (const command of commands) {
    const r = await shell(command, { cwd: dir, timeoutMs: timeoutS * 1000, tailChars: 2000, env: { ...process.env, HARNESS_PROJECT_DIR: projectDir } });
    steps.push({ command, code: r.timedOut ? 124 : r.code, durationMs: r.durationMs });
    if (r.code !== 0 || r.timedOut) {
      const last = (r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ");
      return { steps, error: `workspace setup failed for ${label}: \`${command}\` exited ${r.timedOut ? "on timeout" : r.code}. Last output: ${last}` };
    }
  }
  return { steps, error: null };
}
