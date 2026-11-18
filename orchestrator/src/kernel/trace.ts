// Traces: the raw SDK message stream of a session (JSONL), and a normalized view of its tool calls.

import fs from "node:fs";
import { readJsonl } from "../util/fs.js";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: string;
  /** Set for calls inside a subagent. */
  parent: string | null;
}

export interface NormalTrace {
  toolCalls: ToolCall[];
  texts: string[];
  finalText: string;
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
type Msg = { type?: string; subtype?: string; parent_tool_use_id?: string | null; message?: { content?: unknown }; result?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Build the normalized view from raw SDK messages. */
export function normalizeTrace(messages: unknown[]): NormalTrace {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  const texts: string[] = [];
  let finalText = "";
  for (const raw of messages) {
    const m = raw as Msg;
    if (m.type === "assistant" && Array.isArray(m.message?.content)) {
      for (const b of m.message!.content as Block[]) {
        if (b.type === "tool_use" && b.id && b.name) {
          calls.set(b.id, { id: b.id, name: b.name, input: (b.input as Record<string, unknown>) ?? {}, isError: false, output: "", parent: m.parent_tool_use_id ?? null });
          order.push(b.id);
        } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          if (!m.parent_tool_use_id) texts.push(b.text);
        }
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message!.content as Block[]) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const c = calls.get(b.tool_use_id);
          if (c) {
            c.isError = b.is_error === true;
            c.output = textOf(b.content);
          }
        }
      }
    } else if (m.type === "result" && typeof m.result === "string") {
      finalText = m.result;
    }
  }
  return { toolCalls: order.map((id) => calls.get(id) as ToolCall), texts, finalText: finalText || texts[texts.length - 1] || "" };
}

/** The H components that a session used. */
export interface ComponentUse {
  skills: string[];
  agents: string[];
  scripts: string[];
}

/**
 * Which skills, subagents and scripts of H a trace used. A skill counts when the Skill tool loads it
 * or when a Read opens its SKILL.md. A subagent counts when the Agent tool starts it. A script counts
 * when a Bash command names its project path. Calls inside a subagent count too.
 */
export function componentsUsed(t: NormalTrace, inv: { skills: string[]; agents: string[]; scripts: string[] }): ComponentUse {
  const skills = new Set<string>();
  const agents = new Set<string>();
  const scripts = new Set<string>();
  for (const c of t.toolCalls) {
    const str = (k: string): string => (typeof c.input[k] === "string" ? (c.input[k] as string) : "");
    if (c.name === "Skill") {
      const name = str("skill").replace(/^\//, "");
      if (inv.skills.includes(name)) skills.add(name);
    } else if (c.name === "Read") {
      const m = str("file_path").match(/(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/);
      if (m && m[1] && inv.skills.includes(m[1])) skills.add(m[1]);
    } else if (c.name === "Agent" || c.name === "Task") {
      const type = str("subagent_type");
      if (inv.agents.includes(type)) agents.add(type);
    } else if (c.name === "Bash") {
      const cmd = str("command");
      for (const s of inv.scripts) if (cmd.includes(s)) scripts.add(s);
    }
  }
  const sorted = (x: Set<string>): string[] => [...x].sort();
  return { skills: sorted(skills), agents: sorted(agents), scripts: sorted(scripts) };
}

export function readTrace(file: string): NormalTrace {
  return normalizeTrace(fs.existsSync(file) ? readJsonl(file) : []);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s;
}

/**
 * Markdown view of a trajectory for R roles. Each step has a number, so an editor can name
 * "the moment" (step N) that motivates an edit.
 */
export function renderTrajectory(t: NormalTrace, title: string, maxOutput = 4000): string {
  const out: string[] = [`# ${title}`, "", `Tool calls: ${t.toolCalls.length}. Errors: ${t.toolCalls.filter((c) => c.isError).length}.`, ""];
  t.toolCalls.forEach((c, i) => {
    out.push(`## step ${i + 1} · ${c.name}${c.parent ? " (subagent)" : ""}${c.isError ? " · ERROR" : ""}`);
    out.push("```json", clip(JSON.stringify(c.input, null, 2), 2000), "```");
    if (c.output) out.push("```text", clip(c.output, maxOutput), "```");
    out.push("");
  });
  if (t.finalText) out.push("## final message", "", clip(t.finalText, 8000), "");
  return out.join("\n");
}
