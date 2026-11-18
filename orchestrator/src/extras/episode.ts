// The run-end hook that writes the improvement step of a run to the lesson store of the machine (D10).
// The CLI passes it to the kernel as `deps.onRunEnd`. The kernel and the loop do not import this file.

import type { Deps } from "../kernel/run.js";
import { diffH } from "../kernel/htree.js";
import { projectIdentity, recordEpisode } from "./lessonstore.js";

const CANDIDATE_ROLES: Record<string, string> = { A: "invariant-editor", B: "domain-editor" };

/**
 * Only runs where the loop ran write an episode. Holdout runs never write. Best-effort: an error here
 * never fails the run.
 */
export const captureEpisode: NonNullable<Deps["onRunEnd"]> = async ({ ctx, task, result: res, hRun, log, scratch }) => {
  const store = ctx.lessonStore;
  const rec = res.record;
  if (!store || !store.episodes || task.split === "holdout" || !rec.candidates.length) return;
  try {
    const byLabel = new Map(res.candidates.map((c) => [c.id, c]));
    const candidates = rec.candidates.map((c) => ({
      label: c.label,
      role: CANDIDATE_ROLES[c.label] ?? "editor",
      valid: c.valid,
      problems: c.problems,
      tree_hash: c.treeHash,
      h_patch: byLabel.get(c.label)?.diff ?? "",
      notes: byLabel.get(c.label)?.notes ?? "",
    }));
    const composedPatch = res.composed ? await diffH(hRun, res.composed, scratch) : "";
    const file = recordEpisode(store.path, projectIdentity(ctx.pp.projectDir), {
      rec,
      library: task.noLibrary ? "off" : "on",
      candidates,
      composer: { ran: Boolean(rec.composed_tree_hash), kept_base: Boolean(res.composed) && !composedPatch, notes: res.xi, h_patch: composedPatch, tree_hash: rec.composed_tree_hash },
    });
    log.event("lesson_store_episode", { file });
  } catch (err) {
    log.event("lesson_store_error", { step: "episode", error: String(err) });
  }
};

/** Deps with the lesson store hook added. */
export function withEpisodes<T extends Deps>(deps: T): T {
  return { ...deps, onRunEnd: captureEpisode };
}
