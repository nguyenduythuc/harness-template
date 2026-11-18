// Run records. The orchestrator writes each record once, at the end of the run, and appends events
// while the run goes. Records never hold scores: scores go to the eval store only (docs/plan.md, "Ai thấy score").

import fs from "node:fs";
import path from "node:path";
import { appendJsonl, ensureDir, readJson, writeJson } from "../util/fs.js";
import type { RunPaths } from "./paths.js";
import type { ComponentUse } from "./trace.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Tokens that count against the budget: every token that the model processed or produced. */
export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

export type SessionStatus = "ok" | "error" | "aborted_spec" | "budget_stop" | "max_turns" | "timeout";

export interface SessionRecord {
  label: string;
  role: string;
  status: SessionStatus;
  sessionId: string | null;
  model: string | null;
  claudeCodeVersion: string | null;
  numTurns: number;
  durationMs: number;
  costUsd: number;
  usage: Usage;
  errors: string[];
  tracePath: string;
}

export interface Fingerprint {
  claude_code_version: string | null;
  models: { executor: string; editor: string; judge: string };
  h0_sha: string | null;
  h0_tree_hash: string;
  plugin: { version: string | null; git_sha: string | null; content_hash: string | null };
  orchestrator: { version: string | null; git_sha: string | null; content_hash: string | null };
  base_sha: string | null;
  /** SHA-256 of each instruction file that a session loaded (from the InstructionsLoaded hook). */
  instruction_hashes: Record<string, string>;
  /** Image digest of the clean eval environment (D9.B), when the run used one. */
  eval_image: string | null;
}

export interface RunRecord {
  run_id: string;
  task_id: string;
  task_type: string | null;
  mode: "production" | "eval";
  split: "dev" | "holdout" | null;
  started_at: string;
  ended_at: string;
  phase: number;
  fingerprint: Fingerprint;
  sessions: SessionRecord[];
  totals: { costUsd: number; tokens: number; usage: Usage };
  budget_stop: boolean;
  decision1: { ran: boolean; forced: "improve" | "no-improve" | null; signals: string[] } | null;
  /** Steps and tokens of the reference run. Decision 1 compares them with the p75 of earlier runs. */
  reference: { steps: number; tokens: number } | null;
  /** firstProblems: the problems that sent the editor into its one fix session (empty when the first try passed). */
  candidates: { label: string; valid: boolean; problems: string[]; firstProblems?: string[]; treeHash: string | null }[];
  composed_tree_hash: string | null;
  gate: { composed: GateSummary | null; reference: GateSummary | null };
  outcome: "composed" | "reference" | "none";
  reuse_event: boolean;
  /** Lesson IDs (or "<domain>/<entry>" for entries without an ID) that the adopted H′ reused. */
  reuse_entries: string[];
  /**
   * For each executor session (reference, probe-A, composed, ...): the skills, subagents and scripts
   * that its H had, and the ones that its trace used. Records from before 2026-10-25 do not have it.
   */
  components?: Record<string, { available: ComponentUse; used: ComponentUse }>;
  notes: string[];
}

export interface GateSummary {
  pass: boolean;
  scoreGate: 0 | 1;
  commands: { key: string; command: string; code: number; durationMs: number }[];
  /** Gate keys set to "none" in the config: the project does not have these checks (C39). */
  skipped?: string[];
}

export class RunLog {
  constructor(readonly rp: RunPaths) {
    ensureDir(rp.recordDir);
    ensureDir(rp.tracesDir);
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    appendJsonl(path.join(this.rp.recordDir, "events.jsonl"), { ts: new Date().toISOString(), type, ...data });
  }

  tracePath(label: string): string {
    return path.join(this.rp.tracesDir, `${label}.jsonl`);
  }

  /** Write the run record. A record is written once: a second write is an error. */
  writeRecord(rec: RunRecord): string {
    const file = path.join(this.rp.recordDir, "record.json");
    if (fs.existsSync(file)) throw new Error(`Run record ${file} exists. Run records are append-only.`);
    writeJson(file, rec);
    return file;
  }
}

/** The filtered summary that goes into harness/reports/runs/<run-id>.json and into the PR. No scores, no task text. */
export function reportSummary(rec: RunRecord): Record<string, unknown> {
  return {
    run_id: rec.run_id,
    task_type: rec.task_type,
    mode: rec.mode,
    started_at: rec.started_at,
    phase: rec.phase,
    claude_code_version: rec.fingerprint.claude_code_version,
    h0_tree_hash: rec.fingerprint.h0_tree_hash,
    plugin_sha: rec.fingerprint.plugin.git_sha,
    tokens: rec.totals.tokens,
    cost_usd: Math.round(rec.totals.costUsd * 10000) / 10000,
    sessions: rec.sessions.length,
    budget_stop: rec.budget_stop,
    decision1: rec.decision1,
    outcome: rec.outcome,
    gate_pass: rec.gate.composed?.pass ?? rec.gate.reference?.pass ?? null,
    reuse_event: rec.reuse_event,
    reference: rec.reference,
  };
}

/** Read every run record of a project. */
export function readRunRecords(runsDir: string): RunRecord[] {
  if (!fs.existsSync(runsDir)) return [];
  const out: RunRecord[] = [];
  for (const id of fs.readdirSync(runsDir)) {
    const rec = readJson<RunRecord | null>(path.join(runsDir, id, "record.json"), null);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}
