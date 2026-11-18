// The LLM judge: one call, no tools, in an isolated session (docs/plan.md, "Người chấm là một hệ 3 phần").
// The judge sees the task, the rubric and the evidence that scripts collected. It never sees the
// trajectory, and it does not know which harness made the deliverable.

import type { Criterion, CriterionResult } from "./score.js";

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, pass: { type: "boolean" }, reason: { type: "string" } },
        required: ["id", "pass"],
        additionalProperties: false,
      },
    },
  },
  required: ["criteria"],
  additionalProperties: false,
} as const;

export interface Evidence {
  diff: string;
  checks: { name: string; result: string }[];
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters cut]` : s;
}

export function buildJudgePrompt(judgeMd: string, taskMd: string, criteria: Criterion[], ev: Evidence): string {
  return [
    judgeMd.trim(),
    "",
    "## TASK",
    taskMd.trim(),
    "",
    "## RUBRIC",
    ...criteria.map((c) => `- [${c.id}] (weight ${c.weight}) ${c.text}`),
    "",
    "## EVIDENCE: deterministic checks",
    ...ev.checks.map((c) => `- ${c.name}: ${c.result}`),
    "",
    "## EVIDENCE: diff of the deliverable",
    "```diff",
    clip(ev.diff, 120000),
    "```",
  ].join("\n");
}

/** Parse the structured judge output. Returns null when it does not have the expected shape. */
export function parseJudgeOutput(structured: unknown, resultText: string): CriterionResult[] | null {
  let obj: unknown = structured;
  if (!obj && resultText) {
    const m = resultText.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  const list = (obj as { criteria?: unknown })?.criteria;
  if (!Array.isArray(list)) return null;
  const out: CriterionResult[] = [];
  for (const x of list) {
    const r = x as { id?: unknown; pass?: unknown; reason?: unknown };
    if (typeof r.id !== "string" || typeof r.pass !== "boolean") return null;
    out.push({ id: r.id, pass: r.pass, ...(typeof r.reason === "string" ? { reason: r.reason } : {}) });
  }
  return out;
}
