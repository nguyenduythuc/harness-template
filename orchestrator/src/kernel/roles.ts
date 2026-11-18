// Role specs: how the orchestrator launches each session (docs/plan.md, D6 = C, enforcement layers 1-4).
//
// Every session is explicit. The orchestrator sets the setting sources, the tools, the flag settings,
// the environment, the config directory and the plugin path. No session inherits user settings,
// auto memory, claude.ai connectors or a GH_TOKEN.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectConfig } from "./config.js";
import { ensureDir, writeJson } from "../util/fs.js";
import type { TemplatePaths } from "./paths.js";

export type Role = "executor" | "invariant-editor" | "domain-editor" | "composer" | "selector" | "reflector" | "consolidator" | "judge";

export const EDITING_ROLES: Role[] = ["invariant-editor", "domain-editor", "composer", "consolidator"];
export const READING_ROLES: Role[] = ["selector", "reflector"];

/** Environment variables that sessions can see. Everything else, GH_TOKEN included, stays out. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
  "ANTHROPIC_API_KEY",
  // The token of `claude setup-token` (a Claude subscription). Sessions use a fresh CLAUDE_CONFIG_DIR,
  // so the login of the Claude app does not reach them; this token or an API key must (C32).
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
];
export const ENV_DENYLIST = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

export interface GuardPolicy {
  role: Role;
  writeRoots: string[];
  writeMode: "task" | "loop-owned" | "any";
  allowFiles: string[];
  loopOwned: string[];
  protectAbs: string[];
  readDeny: string[];
  bash: boolean;
  web: boolean;
  subagents: boolean;
  mcpAllow: string[];
}

export interface SessionSpec {
  role: Role;
  label: string;
  options: Options;
  /** What the system/init message must show, or the orchestrator aborts the session. */
  expect: { model: string; plugin: boolean; allowedTools: string[] | null; forbiddenTools: string[]; claudeCodeMin: string };
  policyFile: string | null;
  guardLog: string;
  instructionsLog: string;
}

export interface BuildArgs {
  role: Role;
  label: string;
  cwd: string;
  config: ProjectConfig;
  template: TemplatePaths;
  configDir: string;
  logsDir: string;
  policiesDir: string;
  mode: "production" | "eval";
  /** Absolute paths where the role can write. */
  writeRoots: string[];
  /** Absolute paths that the role must not write, even inside its roots. */
  protectAbs?: string[];
  /** Absolute paths that the role must not read: eval store, other runs, transcripts. */
  readDeny: string[];
  /** Concrete absolute paths for the sandbox denyWrite list (globs already expanded). */
  sandboxDenyWrite?: string[];
  maxBudgetUsd: number;
  claudeCodeMin: string;
  passEnv?: string[];
  abortController?: AbortController;
  /** JSON schema for the judge result. */
  outputSchema?: Record<string, unknown>;
}

function readSettings(template: TemplatePaths, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(template.settingsDir, file), "utf8")) as Record<string, unknown>;
}

/** Role prompt text. Editing roles get the shared editing sections after their own prompt. */
export function rolePrompt(template: TemplatePaths, role: Role): string {
  if (role === "executor" || role === "judge") return "";
  const own = fs.readFileSync(path.join(template.rolesDir, `${role}.md`), "utf8");
  if (EDITING_ROLES.includes(role) && role !== "consolidator") {
    return own + "\n\n" + fs.readFileSync(path.join(template.rolesDir, "shared-editing.md"), "utf8");
  }
  return own;
}

/** Build the environment of a session from the allowlist. */
export function sessionEnv(extra: Record<string, string>, passEnv: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of [...ENV_ALLOWLIST, ...passEnv]) {
    if (ENV_DENYLIST.includes(k)) continue;
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...extra };
}

/** Paths that every agent session must not read: transcripts of other sessions on this machine. */
export function defaultReadDeny(): string[] {
  return [path.join(os.homedir(), ".claude", "projects")];
}

function settingsFor(a: BuildArgs): Record<string, unknown> {
  if (a.role === "executor") {
    const s = readSettings(a.template, "executor.json") as { sandbox: { filesystem: { denyWrite: string[]; denyRead: string[] }; network: { allowedDomains: string[] } } };
    s.sandbox.filesystem.denyWrite = [...new Set([...(a.sandboxDenyWrite ?? []), ...(a.protectAbs ?? [])])];
    s.sandbox.filesystem.denyRead = [...new Set(a.readDeny)];
    s.sandbox.network.allowedDomains = [...a.config.sandbox.allowed_domains];
    return s;
  }
  if (a.role === "judge") return readSettings(a.template, "judge.json");
  if (READING_ROLES.includes(a.role)) return readSettings(a.template, "reader.json");
  return readSettings(a.template, "editor.json");
}

function policyFor(a: BuildArgs): GuardPolicy {
  const base = {
    role: a.role,
    writeRoots: a.writeRoots,
    allowFiles: [] as string[],
    loopOwned: a.config.loop_owned,
    protectAbs: a.protectAbs ?? [],
    readDeny: a.readDeny,
    mcpAllow: [] as string[],
  };
  if (a.role === "executor") return { ...base, writeMode: "task", bash: true, web: a.mode !== "eval", subagents: true };
  if (READING_ROLES.includes(a.role) || a.role === "judge") return { ...base, writeRoots: [], writeMode: "any", bash: false, web: false, subagents: false };
  // Editing roles write the flat H copy in their staging folder (see htree.ts).
  return { ...base, writeMode: "any", bash: false, web: false, subagents: false };
}

const EXECUTOR_FORBIDDEN_IN_EVAL = ["WebFetch", "WebSearch"];

/** Build the SDK options and the guard policy of one session. Writes the policy file. */
export function buildSession(a: BuildArgs): SessionSpec {
  ensureDir(a.logsDir);
  ensureDir(a.policiesDir);
  const guardLog = path.join(a.logsDir, `${a.label}.guard.jsonl`);
  const instructionsLog = path.join(a.logsDir, `${a.label}.instructions.jsonl`);
  const policyFile = path.join(a.policiesDir, `${a.label}.json`);
  writeJson(policyFile, policyFor(a));

  const restricted = a.role !== "executor";
  const env = sessionEnv(
    {
      HARNESS_ROLE: a.role,
      HARNESS_POLICY: policyFile,
      HARNESS_GUARD_LOG: guardLog,
      HARNESS_INSTRUCTIONS_LOG: instructionsLog,
      CLAUDE_CONFIG_DIR: a.configDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      ...(restricted ? { CLAUDE_CODE_RESTRICTED: "1" } : {}),
    },
    a.passEnv,
  );

  const model = a.role === "executor" ? a.config.models.executor : a.role === "judge" ? a.config.models.judge : a.config.models.editor;
  const options: Options = {
    cwd: a.cwd,
    model,
    env,
    settings: settingsFor(a) as Options["settings"],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    permissionPrompts: "none",
    maxTurns: a.role === "judge" ? 3 : a.config.session.max_turns,
    maxBudgetUsd: a.maxBudgetUsd,
  };
  if (a.abortController) options.abortController = a.abortController;
  if (a.role !== "judge") options.plugins = [{ type: "local", path: a.template.pluginDir }];

  let allowedTools: string[] | null = null;
  const forbidden: string[] = [];
  if (a.role === "executor") {
    options.settingSources = ["project"];
    options.tools = { type: "preset", preset: "claude_code" };
    options.systemPrompt = { type: "preset", preset: "claude_code" };
    options.permissionMode = "acceptEdits";
    options.disallowedTools = ["Bash(gh *)", ...(a.mode === "eval" ? EXECUTOR_FORBIDDEN_IN_EVAL : [])];
    if (a.mode === "eval") forbidden.push(...EXECUTOR_FORBIDDEN_IN_EVAL);
  } else if (a.role === "judge") {
    options.settingSources = [];
    options.tools = [];
    options.systemPrompt = "You are an independent judge. You score one deliverable against a rubric. You have no tools. Reply only in the requested JSON format.";
    if (a.outputSchema) options.outputFormat = { type: "json_schema", schema: a.outputSchema };
    // With outputFormat, the SDK adds the StructuredOutput tool. Without it in this list, the init check
    // aborted every judge session (found in a live measurement on 2026-10-25).
    allowedTools = a.outputSchema ? ["StructuredOutput"] : [];
  } else {
    options.settingSources = [];
    allowedTools = READING_ROLES.includes(a.role) ? ["Read", "Grep", "Glob"] : ["Read", "Grep", "Glob", "Edit", "Write"];
    options.tools = allowedTools;
    options.systemPrompt = rolePrompt(a.template, a.role);
    options.permissionMode = READING_ROLES.includes(a.role) ? "default" : "acceptEdits";
    forbidden.push("Bash", "PowerShell", "WebFetch", "WebSearch");
  }

  return {
    role: a.role,
    label: a.label,
    options,
    expect: { model, plugin: a.role !== "judge", allowedTools, forbiddenTools: forbidden, claudeCodeMin: a.claudeCodeMin },
    policyFile,
    guardLog,
    instructionsLog,
  };
}
