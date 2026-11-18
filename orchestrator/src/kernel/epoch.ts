// Versions and epochs. σ and absolute scores compare only inside one epoch (docs/plan.md, "Epoch").

import crypto from "node:crypto";
import type { Ctx } from "./ctx.js";

export interface Epoch {
  h0_sha: string | null;
  models: { executor: string; editor: string; judge: string } | null;
  claude_code_version: string | null;
  plugin_version: string | null;
  plugin_sha: string | null;
  orchestrator_sha: string | null;
}

export function epochOf(ctx: Ctx): Epoch {
  return {
    h0_sha: ctx.h0Sha,
    models: ctx.config.models,
    claude_code_version: ctx.runtime.claude_code_version,
    plugin_version: ctx.runtime.plugin.version,
    plugin_sha: ctx.runtime.plugin.git_sha,
    orchestrator_sha: ctx.runtime.orchestrator.git_sha,
  };
}

/** The epoch ID: σ and absolute scores compare only inside one epoch (docs/plan.md, "Epoch"). */
export function epochId(e: Partial<Epoch> | null | undefined): string {
  const key = JSON.stringify({ h0: e?.h0_sha ?? null, models: e?.models ?? null, cc: e?.claude_code_version ?? null, plugin: e?.plugin_sha ?? null });
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** The template version: plugin version and the git SHA of the template checkout. */
export function templateLabel(e: Partial<Epoch> | null | undefined): string {
  return `${e?.plugin_version ?? "?"}@${(e?.plugin_sha ?? "unknown").slice(0, 8)}`;
}
