#!/usr/bin/env node
// PreToolUse guard (enforcement layer 3 in docs/plan.md).
//
// Two kinds of session:
//   - An orchestrated agent session has HARNESS_ROLE and HARNESS_POLICY. The guard applies the role
//     policy and denies what the policy does not permit. When the policy is missing or the guard fails,
//     it denies (fail closed).
//   - A human session has no HARNESS_ROLE. The guard asks the human before each write to a pinned-,
//     exception or loop-owned file. It never denies a human.
//
// The guard prints a decision only for "deny" and "ask". It never prints "allow", so the normal
// permission flow and the sandbox still apply. Bash checks are best-effort: the sandbox (layer 4) is
// the real wall for shell commands.
//
// Role policy file (written by the orchestrator, outside every workspace):
// {
//   "role": "executor",
//   "writeRoots": ["/abs/workspace"],          // writes outside these roots are denied
//   "writeMode": "task" | "loop-owned" | "any", // what the role may write inside its roots
//   "allowFiles": ["notes.md"],                // extra relative files that "loop-owned" mode permits
//   "loopOwned": ["harness/instructions.md"],  // loop-owned globs, relative to each write root
//   "protectAbs": ["/abs/harness/runs"],       // absolute paths the role never writes
//   "readDeny": ["/abs/eval-store"],           // absolute paths the role never reads
//   "bash": true, "web": false, "subagents": false, "mcpAllow": []
// }

import path from "node:path";
import { pathToFileURL } from "node:url";
import { classify, isInside, relativeTo, readLoopOwned } from "./lib/ownership.mjs";
import { readStdinJson, readJson, appendJsonl, emit } from "./lib/io.mjs";

export const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
export const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LSP"]);
export const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Monitor"]);
export const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

const WRITE_WORDS = /(\s-i\b|>|\btee\b|\bmv\b|\brm\b|\bcp\b|\bchmod\b|\btruncate\b|\bpython3?\b|\bnode\b|\bperl\b|\bruby\b|\bsed\b|\bdd\b|\binstall\b)/;

function targetPath(input) {
  const ti = input.tool_input || {};
  const p = ti.file_path || ti.notebook_path || ti.path;
  if (!p) return null;
  return path.resolve(input.cwd || process.cwd(), String(p));
}

/**
 * Decide on one tool call. Pure function: no I/O.
 * @returns {{decision: "deny"|"ask"|"none", reason?: string, target?: string|null}}
 */
export function decide({ input, role, policy, projectDir, loopOwned }) {
  const tool = String(input.tool_name || "");
  const target = targetPath(input);

  if (!role) return decideHuman({ tool, target, projectDir, loopOwned });

  if (!policy) return { decision: "deny", reason: `harness guard: role "${role}" has no policy file. The guard denies every tool (fail closed).`, target };

  if (WRITE_TOOLS.has(tool)) {
    if (!target) return { decision: "deny", reason: "harness guard: the write has no file path.", target };
    const root = (policy.writeRoots || []).find((r) => isInside(r, target));
    if (!root) return { decision: "deny", reason: `harness guard: role "${role}" can write only inside its write roots.`, target };
    if ((policy.protectAbs || []).some((p) => isInside(p, target))) {
      return { decision: "deny", reason: `harness guard: role "${role}" cannot write to a protected path.`, target };
    }
    const rel = relativeTo(root, target);
    const cls = classify(rel, policy.loopOwned || []);
    const mode = policy.writeMode || "task";
    if (cls === "pinned" || cls === "exception") {
      return { decision: "deny", reason: `harness guard: ${rel} is ${cls === "pinned" ? "a pinned- file" : "an exception file"}. Only a human writes it.`, target };
    }
    if (mode === "task" && cls === "loop-owned") {
      return { decision: "deny", reason: `harness guard: ${rel} is loop-owned. It changes only through an h0-promotion PR.`, target };
    }
    if (mode === "loop-owned" && cls !== "loop-owned" && !(policy.allowFiles || []).includes(rel)) {
      return { decision: "deny", reason: `harness guard: role "${role}" can write only loop-owned files. ${rel} is not loop-owned.`, target };
    }
    return { decision: "none", target };
  }

  if (READ_TOOLS.has(tool)) {
    if (target && (policy.readDeny || []).some((p) => isInside(p, target))) {
      return { decision: "deny", reason: `harness guard: role "${role}" cannot read this path.`, target };
    }
    return { decision: "none", target };
  }

  if (SHELL_TOOLS.has(tool)) {
    if (policy.bash !== true) return { decision: "deny", reason: `harness guard: role "${role}" has no shell.`, target };
    const cmd = String((input.tool_input || {}).command || "");
    if (/(^|[\s;&|(`])gh(\s|$)/.test(cmd)) return { decision: "deny", reason: "harness guard: agent sessions cannot use the gh CLI.", target };
    const hit = (policy.readDeny || []).find((p) => p && cmd.includes(p));
    if (hit) return { decision: "deny", reason: `harness guard: the command names a path that role "${role}" cannot read.`, target };
    if (cmd.includes("pinned-") && WRITE_WORDS.test(cmd)) {
      return { decision: "deny", reason: "harness guard: the command can write to a pinned- file. Only a human writes pinned- files.", target };
    }
    return { decision: "none", target };
  }

  if (WEB_TOOLS.has(tool) && policy.web === false) return { decision: "deny", reason: `harness guard: role "${role}" has no web access.`, target };
  if (SUBAGENT_TOOLS.has(tool) && policy.subagents === false) return { decision: "deny", reason: `harness guard: role "${role}" cannot start subagents.`, target };
  if (tool.startsWith("mcp__") && !(policy.mcpAllow || []).includes(tool)) {
    return { decision: "deny", reason: `harness guard: role "${role}" cannot use MCP tool ${tool}.`, target };
  }
  return { decision: "none", target };
}

function decideHuman({ tool, target, projectDir, loopOwned }) {
  if (!WRITE_TOOLS.has(tool) || !target || !projectDir) return { decision: "none", target };
  const rel = relativeTo(projectDir, target);
  if (rel === null || rel === "") return { decision: "none", target };
  const cls = classify(rel, loopOwned || []);
  if (cls === "pinned") return { decision: "ask", reason: `harness: ${rel} is a pinned- file (human-owned). Confirm this write.`, target };
  if (cls === "exception") return { decision: "ask", reason: `harness: ${rel} is a tool-named file that the template protects. Confirm this write.`, target };
  if (cls === "loop-owned") return { decision: "ask", reason: `harness: ${rel} is loop-owned. A change outside an h0-promotion PR moves H0. Confirm this write.`, target };
  return { decision: "none", target };
}

function output(result, logFile, role, tool) {
  appendJsonl(logFile, { hook: "PreToolUse", role: role || "human", tool, decision: result.decision, reason: result.reason, target: result.target });
  if (result.decision === "none") return;
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: result.decision, permissionDecisionReason: result.reason } });
}

async function main() {
  const role = process.env.HARNESS_ROLE || "";
  const logFile = process.env.HARNESS_GUARD_LOG || "";
  let input = {};
  try {
    input = await readStdinJson();
    const policy = role ? readJson(process.env.HARNESS_POLICY || "", null) : null;
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const loopOwned = role ? (policy && policy.loopOwned) || [] : readLoopOwned(projectDir);
    output(decide({ input, role, policy, projectDir, loopOwned }), logFile, role, input.tool_name);
  } catch (err) {
    const reason = `harness guard failed: ${err && err.message ? err.message : String(err)}`;
    output({ decision: role ? "deny" : "ask", reason }, logFile, role, input.tool_name);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
