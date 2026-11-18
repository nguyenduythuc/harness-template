// Human-run admin commands. Each command that changes a pinned- file writes a proposal next to it
// (<file>.harness-proposed). The human reviews the proposal, moves it over the file and commits it
// in a PR with the label that the CI path guard asks for.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import { requirePhase } from "./config.js";
import { initEvalStore, listTaskIds, loadSplit, loadTask, makeSplit, writeSplit } from "./evalstore.js";
import type { Split } from "./evalstore.js";
import { readHFromGit, validateH } from "./htree.js";
import type { Lock } from "./lock.js";
import { compareVersions, lockPath, runtimeIdentity } from "./lock.js";
import { git, gitOk } from "../util/exec.js";

export const PROPOSED_SUFFIX = ".harness-proposed";

function writeProposal(file: string, value: unknown): string {
  const out = file + PROPOSED_SUFFIX;
  fs.writeFileSync(out, JSON.stringify(value, null, 2) + "\n");
  return out;
}

/**
 * Files that the scaffold copies from the plugin into the project. The scaffold is create-only, so a
 * fix in the plugin never reaches a project by itself. Found on the trial monorepo: an old copy of
 * ownership.mjs failed the project linter after the plugin had the fix (R10).
 */
export const CI_COPY_SOURCES: [name: string, pluginRel: string][] = [
  ["ci-path-guard.mjs", "scripts/ci-path-guard.mjs"],
  ["lib/ownership.mjs", "scripts/lib/ownership.mjs"],
];

export type CiHost = "github" | "gitlab";
export const CI_GUARD_DIR: Record<CiHost, string> = { github: ".github/harness", gitlab: ".gitlab/harness" };

/**
 * The CI host of a project. The same rule as plugins/harness/scripts/lib/ci-host.mjs: files of the
 * project first, then the remote "origin". The default is "github".
 */
export function ciHost(projectDir: string): CiHost {
  const has = (rel: string): boolean => fs.existsSync(path.join(projectDir, rel));
  if (has(".gitlab/harness") || has(".gitlab-ci.yml")) return "gitlab";
  if (has(".github/harness") || has(".github/workflows")) return "github";
  let url = "";
  try {
    url = /\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/.exec(fs.readFileSync(path.join(projectDir, ".git", "config"), "utf8"))?.[1] ?? "";
  } catch {
    // No .git/config (a worktree or no repo): use the default.
  }
  return /gitlab/i.test(url) ? "gitlab" : "github";
}

/** The CI guard copies of a project: project path and plugin path. */
export function ciCopies(projectDir: string): [projectRel: string, pluginRel: string][] {
  const dir = CI_GUARD_DIR[ciHost(projectDir)];
  return CI_COPY_SOURCES.map(([name, src]) => [`${dir}/${name}`, src]);
}

/** The CI copies of the project that differ from the plugin of the template checkout. */
export function staleCiCopies(projectDir: string, pluginDir: string): string[] {
  return ciCopies(projectDir).filter(([rel, src]) => {
    const file = path.join(projectDir, rel);
    return fs.existsSync(file) && fs.readFileSync(file, "utf8") !== fs.readFileSync(path.join(pluginDir, src), "utf8");
  }).map(([rel]) => rel);
}

/** Propose a lock for the plugin and orchestrator of the template checkout. An upgrade starts a new epoch. */
export function proposeUpgrade(ctx: Ctx, claudeCodeMin?: string): { file: string; changes: string[]; copies: string[] } {
  const rt = runtimeIdentity(ctx.user.template_dir);
  const old = ctx.lock;
  const min = claudeCodeMin && compareVersions(claudeCodeMin, old.claude_code_min) > 0 ? claudeCodeMin : old.claude_code_min;
  const next: Lock = { ...old, plugin: { name: "harness", ...rt.plugin }, orchestrator: { name: "harness-orchestrator", ...rt.orchestrator }, claude_code_min: min };
  const changes: string[] = [];
  for (const part of ["plugin", "orchestrator"] as const) {
    if (old[part].content_hash !== next[part].content_hash) changes.push(`${part}: ${old[part].version ?? "?"} (${(old[part].content_hash ?? "none").slice(0, 12)}) -> ${next[part].version ?? "?"} (${(next[part].content_hash ?? "none").slice(0, 12)})`);
  }
  if (min !== old.claude_code_min) changes.push(`claude_code_min: ${old.claude_code_min} -> ${min}`);
  const copies: string[] = [];
  for (const rel of staleCiCopies(ctx.pp.projectDir, ctx.tp.pluginDir)) {
    const src = (ciCopies(ctx.pp.projectDir).find(([r]) => r === rel) as [string, string])[1];
    const out = path.join(ctx.pp.projectDir, rel) + PROPOSED_SUFFIX;
    fs.copyFileSync(path.join(ctx.tp.pluginDir, src), out);
    copies.push(out);
    changes.push(`${rel}: differs from the plugin. Move ${rel}${PROPOSED_SUFFIX} over it`);
  }
  return { file: writeProposal(lockPath(ctx.pp.projectDir), next), changes, copies };
}

/**
 * Propose h0_sha = HEAD in the lock (end of Phase 1). After the merge, H0 comes from this SHA only,
 * and a change to H0 goes through decision 5.
 */
export function proposeFreezeH0(ctx: Ctx): { file: string; sha: string } {
  requirePhase(ctx.config, 1, "freeze-h0");
  const dirty = git(["status", "--porcelain"], ctx.pp.projectDir).trim();
  if (dirty) throw new Error("The working tree has changes. Commit or stash them first: H0 must be a commit.");
  const sha = git(["rev-parse", "HEAD"], ctx.pp.projectDir).trim();
  const problems = validateH(readHFromGit(ctx.pp.projectDir, sha));
  if (problems.length) throw new Error(`H0 at ${sha.slice(0, 12)} is not valid:\n` + problems.map((p) => "  - " + p).join("\n"));
  return { file: writeProposal(lockPath(ctx.pp.projectDir), { ...ctx.lock, h0_sha: sha }), sha };
}

/** Make an eval store skeleton and a git repo in it. */
export function evalInit(dir: string): { created: string[]; git: boolean } {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  const created = initEvalStore(abs);
  let madeGit = false;
  if (!gitOk(["rev-parse", "--git-dir"], abs)) {
    git(["init", "-q"], abs);
    madeGit = true;
  }
  return { created, git: madeGit };
}

/**
 * Make the dev/holdout split. A split that has holdout tasks is final: a new split would let tasks
 * that the loop learned from move into the holdout. Only new tasks join, by the same stratified rule.
 */
export function evalSplit(store: string): { split: Split; added: string[] } {
  const old = loadSplit(store);
  const ids = listTaskIds(store);
  const known = new Set([...old.dev, ...old.holdout]);
  const fresh = ids.filter((id) => !known.has(id));
  const tasks = fresh.map((id) => ({ id, taskType: loadTask(store, id).meta.task_type }));
  const part = makeSplit(tasks, old.seed + known.size);
  const split: Split = { seed: old.seed, dev: [...old.dev, ...part.dev].sort(), holdout: [...old.holdout, ...part.holdout].sort() };
  writeSplit(store, split);
  return { split, added: fresh };
}
