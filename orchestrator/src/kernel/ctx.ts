// The orchestrator context: every config and identity that a command needs, loaded and checked once.

import fs from "node:fs";
import path from "node:path";
import type { ProjectConfig, StoreConfig, UserConfig } from "./config.js";
import { ConfigError, loadProjectConfig, loadUserConfig, resolveLessonStore } from "./config.js";
import type { Lock, RuntimeIdentity } from "./lock.js";
import { checkRuntime, gitHead, readLock, runtimeIdentity } from "./lock.js";
import type { ProjectPaths, TemplatePaths } from "./paths.js";
import { projectPaths, templatePaths } from "./paths.js";
import { hasClaudeMdAncestor, ensureDir } from "../util/fs.js";
import { git } from "../util/exec.js";

export interface Ctx {
  pp: ProjectPaths;
  tp: TemplatePaths;
  user: UserConfig;
  config: ProjectConfig;
  lock: Lock;
  runtime: RuntimeIdentity;
  /** The commit of H0: the lock value once Phase 1 froze it, else HEAD of the project. */
  h0Sha: string;
  /** The lesson store of this machine (D10), or null when the user or the project turned it off. */
  lessonStore: StoreConfig | null;
  notes: string[];
}

/**
 * allowLockMismatch: only for `harness upgrade`. The upgrade exists to fix a lock that does not match
 * this checkout, so the mismatch becomes a note there, not an error. A missing lock is still an error.
 */
export function loadCtx(projectDir: string, opts: { requireEvalStore?: boolean; allowLockMismatch?: boolean } = {}): Ctx {
  const pp = projectPaths(projectDir);
  const user = loadUserConfig();
  const config = loadProjectConfig(pp.projectDir);
  const tp = templatePaths(user.template_dir);
  if (!fs.existsSync(tp.pluginDir)) throw new ConfigError(`template_dir ${user.template_dir} has no plugins/harness folder.`);
  const lock = readLock(pp.projectDir);
  const runtime = runtimeIdentity(user.template_dir);
  const { problems, notes } = checkRuntime(lock, runtime, user.dev);
  if (!lock || (problems.length && !opts.allowLockMismatch)) throw new ConfigError("The runtime does not match the lock:\n" + problems.map((p) => "  - " + p).join("\n"));

  ensureDir(user.work_root);
  const ancestor = hasClaudeMdAncestor(user.work_root);
  if (ancestor) throw new ConfigError(`work_root ${user.work_root} has an instruction file above it (${ancestor}). Claude Code would load it into every session. Choose another work_root.`);
  if (isInside(pp.projectDir, user.work_root)) throw new ConfigError("work_root must be outside the project.");
  if (user.eval_store) {
    if (isInside(pp.projectDir, user.eval_store)) throw new ConfigError("eval_store must be outside the project.");
    if (isInside(user.work_root, user.eval_store)) throw new ConfigError("eval_store must be outside work_root, where agent workspaces live.");
  } else if (opts.requireEvalStore) {
    throw new ConfigError("This command needs eval_store in the user config. Create the store with `harness eval-init <path>` first.");
  }

  const lessonStore = config.lesson_store === "off" ? null : resolveLessonStore(user);
  if (lessonStore) {
    const p = lessonStore.path;
    if (isInside(pp.projectDir, p) || isInside(p, pp.projectDir)) throw new ConfigError("lesson_store must be outside the project, and the project must be outside it.");
    if (isInside(user.work_root, p)) throw new ConfigError("lesson_store must be outside work_root, where agent workspaces live.");
    if (user.eval_store && (isInside(user.eval_store, p) || isInside(p, user.eval_store))) throw new ConfigError("lesson_store and eval_store must be separate folders.");
  }

  const head = gitHead(pp.projectDir);
  if (!head) throw new ConfigError(`${pp.projectDir} is not a git repository with a commit.`);
  const h0Sha = lock.h0_sha ?? head;
  if (lock.h0_sha) {
    // H0 comes from the SHA of the lock, never from a local branch that a worktree could move (m11).
    git(["cat-file", "-e", `${lock.h0_sha}^{commit}`], pp.projectDir);
  } else {
    notes.push("The lock has no h0_sha yet (Phases 0-1). H0 is HEAD of the project.");
  }
  return { pp, tp, user, config, lock, runtime, h0Sha, lessonStore, notes };
}

export function isInside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
