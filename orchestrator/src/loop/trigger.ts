// Decision 1 (production only): run the improvement loop for this task? (docs/plan.md, "Bộ rule quyết định")
// The orchestrator reads the signals from the reference trace. It never reads a score.

import type { NormalTrace, ToolCall } from "../kernel/trace.js";

export interface TriggerOptions {
  toolErrorsMin: number;
  /** p75 of steps and tokens of earlier runs of the same task_type, or null when there are fewer runs than the minimum. */
  p75: { steps: number; tokens: number } | null;
}

export interface TriggerResult {
  weak: boolean;
  signals: string[];
}

const CHECK_CMD = /\b(test|tsc|typecheck|type-check|lint|eslint|build|jest|vitest|playwright)\b/;
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function isCheck(c: ToolCall): boolean {
  return (c.name === "Bash" || c.name === "PowerShell") && CHECK_CMD.test(String(c.input.command ?? ""));
}

function failed(c: ToolCall): boolean {
  return c.isError || /exit code [1-9]\d*/i.test(c.output);
}

export function signals(trace: NormalTrace, tokens: number, opt: TriggerOptions): TriggerResult {
  const out: string[] = [];
  const top = trace.toolCalls.filter((c) => !c.parent);

  const checks = top.filter(isCheck);
  const lastCheck = checks[checks.length - 1];
  if (lastCheck && failed(lastCheck)) out.push("check_failed: the last check command of the executor failed");

  const errors = top.filter((c) => c.isError).length;
  if (errors >= opt.toolErrorsMin) out.push(`tool_errors: ${errors} tool errors (threshold ${opt.toolErrorsMin})`);

  if (opt.p75) {
    if (top.length > opt.p75.steps) out.push(`steps_over_p75: ${top.length} steps > p75 ${opt.p75.steps}`);
    if (tokens > opt.p75.tokens) out.push(`tokens_over_p75: ${tokens} tokens > p75 ${opt.p75.tokens}`);
  }

  const written = new Set<string>();
  let reopened = false;
  for (const c of top) {
    const p = String(c.input.file_path ?? "");
    if (WRITE_TOOLS.has(c.name) && p) written.add(p);
    if (c.name === "Read" && written.has(p)) reopened = true;
  }
  if (written.size > 0 && checks.length === 0 && !reopened) out.push("no_self_verify: the executor wrote files but ran no check and reopened no file");

  return { weak: out.length > 0, signals: out };
}

/** 75th percentile (nearest-rank). */
export function p75(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.75 * s.length) - 1)] as number;
}
