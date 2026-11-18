// `harness gate-check`: run workspace_setup and the gate in a new worktree at HEAD, the same way
// as `harness run`, without an agent session (0 tokens). The main checkout does not change.
// Use it after you set or change the gate in harness/pinned-config.yaml.

import path from "node:path";
import { git } from "../util/exec.js";
import type { ProjectConfig } from "./config.js";
import { runGate } from "./gate.js";
import type { GateResult } from "./gate.js";
import { productionWorkspace, removeWorkspace, runWorkspaceSetup } from "./workspace.js";

export interface GateCheck {
  sha: string;
  setup: { command: string; code: number; durationMs: number }[];
  setupError: string | null;
  gate: GateResult | null;
}

export async function gateCheck(projectDir: string, config: ProjectConfig, workRoot: string, keepWork = false): Promise<GateCheck> {
  const sha = git(["rev-parse", "HEAD"], projectDir).trim();
  const dest = path.join(workRoot, `gate-check-${Date.now()}`);
  productionWorkspace(projectDir, sha, dest, null);
  try {
    const s = await runWorkspaceSetup(config.workspace_setup.commands, dest, projectDir, config.workspace_setup.timeout_s);
    const setup = s.steps.map((st) => ({ command: st.command, code: st.code, durationMs: st.durationMs }));
    if (s.error) return { sha, setup, setupError: s.error, gate: null };
    return { sha, setup, setupError: null, gate: await runGate(dest, config.gate) };
  } finally {
    if (!keepWork) removeWorkspace(projectDir, dest);
  }
}

export function gateCheckText(r: GateCheck): string {
  const sec = (ms: number): string => (ms / 1000).toFixed(1) + " s";
  const lines = [`Worktree at ${r.sha.slice(0, 9)} (HEAD). Changes that are not in a commit are not in the check.`];
  for (const s of r.setup) lines.push(`setup     exit ${s.code}  ${sec(s.durationMs)}  ${s.command}`);
  if (r.setupError) lines.push(r.setupError);
  const g = r.gate;
  if (g) {
    for (const c of g.commands) lines.push(`${c.key.padEnd(9)} exit ${c.code}  ${sec(c.durationMs)}  ${c.command}`);
    for (const c of g.commands.filter((x) => x.code !== 0)) lines.push(`--- ${c.key}, last lines:\n${(g.tails[c.key as keyof typeof g.tails] ?? "").split("\n").slice(-15).join("\n")}`);
    if (g.skipped?.length) lines.push(`Not checked ("none"): ${g.skipped.join(", ")}`);
    if (g.todo.length) lines.push(`Not set (counts as a fail): ${g.todo.join(", ")}`);
    lines.push(`Gate: ${g.pass ? "PASS" : "FAIL"}`);
  }
  return lines.join("\n") + "\n";
}
