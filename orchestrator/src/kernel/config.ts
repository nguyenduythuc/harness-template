// Project config (harness/pinned-config.yaml) and user config (~/.config/harness/config.yaml).
// The project config is human-owned and committed. The user config holds machine paths, among them
// the eval store path, so no project file names the eval store (docs/plan.md, B1).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const PHASES = [0, 1, 2, 3, 4, 5] as const;

export const ProjectConfigSchema = z
  .object({
    version: z.literal(1),
    phase: z.number().int().min(0).max(5),
    mode: z.enum(["production", "eval"]),
    loop: z.object({
      k_par: z.number().int().min(1),
      k_seq: z.number().int().min(1),
      m: z.number().int().min(1),
    }),
    models: z.object({ executor: z.string().min(1), editor: z.string().min(1), judge: z.string().min(1) }),
    budget: z.object({ usd: z.number().positive(), tokens: z.number().int().positive(), headroom_usd: z.number().min(0) }),
    session: z.object({ max_turns: z.number().int().positive(), timeout_s: z.number().int().positive() }),
    trigger: z.object({ tool_errors_min: z.number().int().min(1), p75_min_runs: z.number().int().min(1) }),
    gate: z.object({
      build: z.string(),
      typecheck: z.string(),
      lint: z.string(),
      test: z.string(),
      timeout_s: z.number().int().positive(),
    }),
    gate_config_files: z.array(z.string()),
    growth_limit_pct: z.number().min(0),
    loop_owned: z.array(z.string()).min(1),
    sandbox: z.object({ allowed_domains: z.array(z.string()) }),
    /** "off" keeps every lesson and episode of this project out of the lesson store of the machine (D10). */
    lesson_store: z.enum(["on", "off"]).default("on"),
    /**
     * Commands that the orchestrator runs in each new workspace before an agent session, for example to
     * install dependencies. A workspace is a fresh checkout without node_modules (C31).
     */
    workspace_setup: z
      .object({ commands: z.array(z.string()).default([]), timeout_s: z.number().int().positive().default(900) })
      .default({ commands: [], timeout_s: 900 }),
  })
  .superRefine((c, ctx) => {
    if (c.models.judge === c.models.executor || c.models.judge === c.models.editor) {
      ctx.addIssue({ code: "custom", path: ["models", "judge"], message: "The judge model must differ from the executor and editor models (D4)." });
    }
    if (c.loop.k_par > 1 && c.phase < 5) {
      ctx.addIssue({ code: "custom", path: ["loop", "k_par"], message: "k_par > 1 needs the selector, which starts in Phase 5." });
    }
  });

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const UserConfigSchema = z.object({
  /** Absolute path of the eval store (a private repo outside every project). */
  eval_store: z.string().optional(),
  /** Absolute path where the orchestrator makes workspaces and staging folders. No CLAUDE.md may sit above it. */
  work_root: z.string(),
  /** Absolute path of the harness-template checkout (plugin and orchestrator source). */
  template_dir: z.string(),
  /** Phases 1-3: the plugin loads from the checkout. Runs record the SHA instead of comparing with the lock. */
  dev: z.boolean().default(false),
  /** Environment variables that the orchestrator passes to sessions, in addition to the fixed allowlist. */
  pass_env: z.array(z.string()).default([]),
  /**
   * The lesson store of this machine (D10): lessons and improvement steps of every project.
   * Omit it for the default folder, or set false to turn the store off.
   */
  lesson_store: z
    .union([
      z.literal(false),
      z.object({
        path: z.string().optional(),
        /** Also write one episode record for each improvement step. */
        episodes: z.boolean().default(true),
      }),
    ])
    .optional(),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

export class ConfigError extends Error {}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, "harness", "pinned-config.yaml");
}

export function parseProjectConfig(text: string, source = "pinned-config.yaml"): ProjectConfig {
  const raw = YAML.parse(text) as unknown;
  const r = ProjectConfigSchema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new ConfigError(`${source} is not valid:\n${issues}`);
  }
  return r.data;
}

export function loadProjectConfig(projectDir: string): ProjectConfig {
  const file = projectConfigPath(projectDir);
  if (!fs.existsSync(file)) throw new ConfigError(`${file} is missing. Run /harness:init in the project first.`);
  return parseProjectConfig(fs.readFileSync(file, "utf8"), file);
}

/** The gate value for a check that the project does not have, for example `test: "none"` (C39). */
export const GATE_NONE = "none";

/** Gate keys whose command is still TODO or empty. Each one makes the gate fail. */
export function todoGateKeys(c: ProjectConfig): string[] {
  return (["build", "typecheck", "lint", "test"] as const).filter((k) => c.gate[k].trim() === "" || c.gate[k].trim() === "TODO");
}

/** Gate keys set to "none": the project does not have this check, so the gate does not run it. */
export function noneGateKeys(c: ProjectConfig): string[] {
  return (["build", "typecheck", "lint", "test"] as const).filter((k) => c.gate[k].trim() === GATE_NONE);
}

export function userConfigPath(): string {
  return process.env.HARNESS_CONFIG || path.join(os.homedir(), ".config", "harness", "config.yaml");
}

export function loadUserConfig(file = userConfigPath()): UserConfig {
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `${file} is missing. Create it with at least:\n  work_root: /abs/path/harness-work\n  template_dir: /abs/path/harness-template\n  eval_store: /abs/path/harness-eval-<project>   # optional before Phase 0\nIf a user config exists in another place, set HARNESS_CONFIG to its path.${process.env.HARNESS_CONFIG ? "" : " HARNESS_CONFIG is not set."}`,
    );
  }
  const r = UserConfigSchema.safeParse(YAML.parse(fs.readFileSync(file, "utf8")) as unknown);
  if (!r.success) {
    throw new ConfigError(`${file} is not valid:\n` + r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  }
  for (const key of ["work_root", "template_dir", "eval_store"] as const) {
    const v = r.data[key];
    if (v && !path.isAbsolute(v)) throw new ConfigError(`${file}: ${key} must be an absolute path.`);
  }
  const ls = r.data.lesson_store;
  if (ls && ls.path && !path.isAbsolute(ls.path)) throw new ConfigError(`${file}: lesson_store.path must be an absolute path.`);
  return r.data;
}

/** The phase lock: refuse a step of a phase that the project has not reached. */
export function requirePhase(c: ProjectConfig, phase: number, step: string): void {
  if (c.phase < phase) {
    throw new ConfigError(`${step} starts in Phase ${phase}. The project is in Phase ${c.phase} (harness/pinned-config.yaml). Pass the gate of each earlier phase first.`);
  }
}

// The location of the lesson store of this machine (D10). The kernel needs it to deny reads of it in
// agent sessions. The store itself (extras/lessonstore.ts) creates the folder before its first write.
export interface StoreConfig {
  path: string;
  episodes: boolean;
}

/** The store of this machine from the user config, or null when the user turned it off. */
export function resolveLessonStore(user: UserConfig): StoreConfig | null {
  const ls = user.lesson_store;
  if (ls === false) return null;
  const base = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  return { path: ls?.path ?? path.join(base, "harness", "lessons"), episodes: ls?.episodes ?? true };
}
