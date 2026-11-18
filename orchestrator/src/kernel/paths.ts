// Paths of a project, of one run, and of the plugin in the template checkout.

import crypto from "node:crypto";
import path from "node:path";
import { ensureDir } from "../util/fs.js";

export interface ProjectPaths {
  projectDir: string;
  harnessDir: string;
  runsDir: string;
  reportsDir: string;
  libraryDir: string;
  configFile: string;
  lockFile: string;
}

export function projectPaths(projectDir: string): ProjectPaths {
  const p = path.resolve(projectDir);
  const harnessDir = path.join(p, "harness");
  return {
    projectDir: p,
    harnessDir,
    runsDir: path.join(harnessDir, "runs"),
    reportsDir: path.join(harnessDir, "reports", "runs"),
    libraryDir: path.join(harnessDir, "library"),
    configFile: path.join(harnessDir, "pinned-config.yaml"),
    lockFile: path.join(harnessDir, "pinned-harness.lock"),
  };
}

export interface TemplatePaths {
  templateDir: string;
  pluginDir: string;
  rolesDir: string;
  settingsDir: string;
}

export function templatePaths(templateDir: string): TemplatePaths {
  const pluginDir = path.join(templateDir, "plugins", "harness");
  return { templateDir, pluginDir, rolesDir: path.join(pluginDir, "roles"), settingsDir: path.join(pluginDir, "settings") };
}

/** Per-run folders. Everything except the run record lives under the work root, outside every repo. */
export interface RunPaths {
  runId: string;
  /** project/harness/runs/<runId>: run record, traces, events. Only the orchestrator writes here. */
  recordDir: string;
  tracesDir: string;
  /** work_root/<runId>: workspaces, staging, contexts, policies, per-session config dirs. */
  workDir: string;
  logsDir: string;
  policiesDir: string;
}

export function newRunId(taskSlug: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const slug = taskSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";
  return `${ts}-${slug}-${crypto.randomBytes(2).toString("hex")}`;
}

export function runPaths(pp: ProjectPaths, workRoot: string, runId: string): RunPaths {
  const recordDir = path.join(pp.runsDir, runId);
  const workDir = path.join(workRoot, runId);
  return {
    runId,
    recordDir,
    tracesDir: path.join(recordDir, "traces"),
    workDir,
    logsDir: path.join(workDir, "logs"),
    policiesDir: path.join(workDir, "policies"),
  };
}

export function sessionDirs(rp: RunPaths, label: string): { workspace: string; staging: string; configDir: string; scratch: string } {
  return {
    workspace: path.join(rp.workDir, "ws", label),
    staging: path.join(rp.workDir, "staging", label),
    configDir: ensureDir(path.join(rp.workDir, "config", label)),
    scratch: path.join(rp.workDir, "scratch", label),
  };
}
