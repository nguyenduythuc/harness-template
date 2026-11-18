// Run one agent session through the Agent SDK. The orchestrator checks the system/init message
// against the spec, writes the full message stream to the trace file, and reads usage and cost.

import fs from "node:fs";
import path from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { compareVersions } from "./lock.js";
import type { SessionRecord, SessionStatus, Usage } from "./runs.js";
import { emptyUsage } from "./runs.js";
import type { SessionSpec } from "./roles.js";
import { ensureDir } from "../util/fs.js";

/** The query function. Tests pass a fake one. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export const defaultQuery: QueryFn = (args) => sdkQuery(args);

export interface SessionOutcome extends SessionRecord {
  resultText: string;
  structured: unknown;
  initProblems: string[];
}

interface InitMessage {
  type: "system";
  subtype: "init";
  model?: string;
  tools?: string[];
  plugins?: { name: string; path: string }[];
  plugin_errors?: { plugin: string; message: string }[];
  claude_code_version?: string;
  mcp_servers?: { name: string }[];
}

/** Compare the init message with the spec. Returns the list of mismatches. */
export function checkInit(init: InitMessage, expect: SessionSpec["expect"]): string[] {
  const problems: string[] = [];
  if (init.model && !init.model.startsWith(expect.model) && !expect.model.startsWith(init.model)) {
    problems.push(`model is ${init.model}, expected ${expect.model}`);
  }
  if (!init.claude_code_version) problems.push("init has no claude_code_version");
  else if (compareVersions(init.claude_code_version, expect.claudeCodeMin) < 0) {
    problems.push(`Claude Code ${init.claude_code_version} is older than ${expect.claudeCodeMin}`);
  }
  const tools = init.tools ?? [];
  for (const t of expect.forbiddenTools) if (tools.includes(t)) problems.push(`tool ${t} is present but forbidden for this role`);
  if (expect.allowedTools) {
    const extra = tools.filter((t) => !expect.allowedTools!.includes(t) && !t.startsWith("mcp__") && t !== "Skill" && t !== "ToolSearch");
    if (extra.length) problems.push(`unexpected tools: ${extra.join(", ")}`);
  }
  if ((init.mcp_servers ?? []).length) problems.push(`MCP servers are present: ${(init.mcp_servers ?? []).map((s) => s.name).join(", ")}`);
  if (expect.plugin && !(init.plugins ?? []).some((p) => p.name === "harness")) problems.push("the harness plugin did not load, so the role guard does not run");
  for (const e of init.plugin_errors ?? []) problems.push(`plugin error (${e.plugin}): ${e.message}`);
  return problems;
}

function usageOf(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, number | null | undefined>;
  return {
    inputTokens: x.input_tokens ?? 0,
    outputTokens: x.output_tokens ?? 0,
    cacheReadTokens: x.cache_read_input_tokens ?? 0,
    cacheCreationTokens: x.cache_creation_input_tokens ?? 0,
  };
}

export interface RunSessionArgs {
  spec: SessionSpec;
  prompt: string;
  tracePath: string;
  timeoutMs: number;
  queryFn?: QueryFn;
}

/** Run one session to the end. Never throws: errors go into the outcome. */
export async function runSession(a: RunSessionArgs): Promise<SessionOutcome> {
  const queryFn = a.queryFn ?? defaultQuery;
  ensureDir(path.dirname(a.tracePath));
  const trace = fs.createWriteStream(a.tracePath, { flags: "a" });
  const controller = a.spec.options.abortController ?? new AbortController();
  const options: Options = { ...a.spec.options, abortController: controller };
  const start = Date.now();
  const out: SessionOutcome = {
    label: a.spec.label,
    role: a.spec.role,
    status: "ok",
    sessionId: null,
    model: null,
    claudeCodeVersion: null,
    numTurns: 0,
    durationMs: 0,
    costUsd: 0,
    usage: emptyUsage(),
    errors: [],
    tracePath: a.tracePath,
    resultText: "",
    structured: null,
    initProblems: [],
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, a.timeoutMs);
  let sawResult = false;
  try {
    for await (const msg of queryFn({ prompt: a.prompt, options })) {
      trace.write(JSON.stringify(msg) + "\n");
      const m = msg as unknown as Record<string, unknown>;
      if (m.type === "system" && m.subtype === "init") {
        const init = m as unknown as InitMessage;
        out.sessionId = (m.session_id as string) ?? null;
        out.model = init.model ?? null;
        out.claudeCodeVersion = init.claude_code_version ?? null;
        out.initProblems = checkInit(init, a.spec.expect);
        if (out.initProblems.length) {
          out.status = "aborted_spec";
          out.errors.push(...out.initProblems.map((p) => `init check: ${p}`));
          controller.abort();
          break;
        }
      } else if (m.type === "result") {
        sawResult = true;
        out.numTurns = (m.num_turns as number) ?? 0;
        out.costUsd = (m.total_cost_usd as number) ?? 0;
        out.usage = usageOf(m.usage);
        const sub = m.subtype as string;
        if (sub === "success") {
          out.resultText = (m.result as string) ?? "";
          out.structured = m.structured_output ?? null;
          if (m.is_error) {
            out.status = "error";
            out.errors.push("the result is marked as an error");
          }
        } else {
          out.status = sub === "error_max_budget_usd" ? "budget_stop" : sub === "error_max_turns" ? "max_turns" : "error";
          out.errors.push(...(((m.errors as string[]) ?? []) as string[]));
        }
      }
    }
  } catch (err) {
    if (out.status === "ok") out.status = timedOut ? "timeout" : "error";
    out.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
    // Wait for the flush: the caller reads the trace file right after this function returns.
    await new Promise<void>((resolve) => trace.end(() => resolve()));
  }
  if (timedOut && out.status === "ok") out.status = "timeout";
  if (!sawResult && out.status === "ok") {
    out.status = "error";
    out.errors.push("the session ended without a result message");
  }
  out.durationMs = Date.now() - start;
  return out;
}

/** Copy the useful part of an outcome into the run record. */
export function toRecord(o: SessionOutcome): SessionRecord {
  const { resultText: _r, structured: _s, initProblems: _i, ...rec } = o;
  return rec;
}

export function isRetryable(status: SessionStatus): boolean {
  return status === "error";
}
