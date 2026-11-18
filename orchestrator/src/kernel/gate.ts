// The deliverable gate (decision 3) and the score gate.
//   - Deliverable gate: every configured check of the project passes. A check set to "none" does not
//     exist in the project, so it does not run and does not fail (C39). TODO or empty makes the gate fail.
//   - Score gate: build and typecheck pass (1) or not (0). A score of 0 follows from a failed score gate.
//
// CAUTION: the gate runs code that an agent wrote. Run eval rounds in the clean container (D9.B).
// On a local machine the gate runs with the rights of the user, like a CI job on the user's machine.

import { GATE_NONE } from "./config.js";
import type { ProjectConfig } from "./config.js";
import type { GateSummary } from "./runs.js";
import { runShell } from "../util/exec.js";

export const GATE_KEYS = ["build", "typecheck", "lint", "test"] as const;
export type GateKey = (typeof GATE_KEYS)[number];

export interface GateResult extends GateSummary {
  tails: Record<string, string>;
  todo: GateKey[];
}

export type ShellRunner = typeof runShell;

/** Run the configured gate commands in `workspace`, in a fixed order. */
export async function runGate(workspace: string, cfg: ProjectConfig["gate"], runner: ShellRunner = runShell): Promise<GateResult> {
  const commands: GateResult["commands"] = [];
  const tails: Record<string, string> = {};
  const todo: GateKey[] = [];
  const skipped: GateKey[] = [];
  const ok: Partial<Record<GateKey, boolean>> = {};
  for (const key of GATE_KEYS) {
    const command = cfg[key].trim();
    if (command === GATE_NONE) {
      skipped.push(key);
      ok[key] = true;
      continue;
    }
    if (!command || command === "TODO") {
      todo.push(key);
      ok[key] = false;
      continue;
    }
    const r = await runner(command, { cwd: workspace, timeoutMs: cfg.timeout_s * 1000, tailChars: 4000 });
    commands.push({ key, command, code: r.timedOut ? 124 : r.code, durationMs: r.durationMs });
    tails[key] = (r.stdout + "\n" + r.stderr).trim();
    ok[key] = r.code === 0 && !r.timedOut;
  }
  const pass = todo.length === 0 && GATE_KEYS.every((k) => ok[k]);
  const scoreGate: 0 | 1 = ok.build && ok.typecheck ? 1 : 0;
  return { pass, scoreGate, commands, skipped, tails, todo };
}

export function summary(g: GateResult): GateSummary {
  return { pass: g.pass, scoreGate: g.scoreGate, commands: g.commands, ...(g.skipped?.length ? { skipped: g.skipped } : {}) };
}
