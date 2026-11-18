// Context folders for R roles. Each R session starts in its own staging folder:
//   <staging>/context/  objects to inspect (task, trajectories, deliverables, library, candidates)
//   <staging>/H/        the harness copy that an editing role edits (flat H layout, see htree.ts)
// The orchestrator writes these folders. R roles cannot read anything outside their staging folder.

import fs from "node:fs";
import path from "node:path";
import type { HTree } from "../kernel/htree.js";
import { writeHToDir } from "../kernel/htree.js";
import type { CandidateView, RunView } from "../kernel/run.js";
import { renderTrajectory } from "../kernel/trace.js";

export type { CandidateView, RunView };
import { copyDir, ensureDir } from "../util/fs.js";

function writeRun(dir: string, run: RunView): void {
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, "trajectory.md"), renderTrajectory(run.trace, run.title));
  fs.writeFileSync(path.join(dir, "deliverable.diff"), run.diff || "(no change)\n");
}

function writeLibrary(contextDir: string, libraryDir: string | null): void {
  const dst = path.join(contextDir, "library");
  if (libraryDir && fs.existsSync(libraryDir)) copyDir(libraryDir, dst);
  else {
    ensureDir(dst);
    fs.writeFileSync(path.join(dst, "index.md"), "# Library index\n\n(empty)\n");
  }
}

export interface EditorContextArgs {
  staging: string;
  taskMd: string;
  base: HTree;
  reference: RunView;
  pinnedGuardrails: string;
  libraryDir: string | null;
}

/** Context for the invariant editor and the domain editor. */
export function editorContext(a: EditorContextArgs): void {
  const ctx = ensureDir(path.join(a.staging, "context"));
  fs.writeFileSync(path.join(ctx, "task.md"), a.taskMd);
  fs.writeFileSync(path.join(ctx, "pinned-guardrails.md"), a.pinnedGuardrails);
  writeRun(path.join(ctx, "reference"), a.reference);
  writeLibrary(ctx, a.libraryDir);
  writeHToDir(a.base, path.join(a.staging, "H"));
}

export interface ComposerContextArgs {
  staging: string;
  taskMd: string;
  base: HTree;
  reference: RunView;
  candidates: CandidateView[];
  pinnedGuardrails: string;
}

/** Context for the composer. */
export function composerContext(a: ComposerContextArgs): void {
  const ctx = ensureDir(path.join(a.staging, "context"));
  fs.writeFileSync(path.join(ctx, "task.md"), a.taskMd);
  fs.writeFileSync(path.join(ctx, "pinned-guardrails.md"), a.pinnedGuardrails);
  writeRun(path.join(ctx, "reference"), a.reference);
  for (const c of a.candidates) {
    const cdir = path.join(ctx, "candidates", c.id);
    writeHToDir(c.h, path.join(cdir, "H"));
    fs.writeFileSync(path.join(cdir, "diff.patch"), c.diff || "(no change: KEEP_BASE)\n");
    fs.writeFileSync(path.join(cdir, "notes.md"), c.notes || "(no notes)\n");
    if (c.run) writeRun(path.join(cdir, "run"), c.run);
    else fs.writeFileSync(path.join(cdir, "no-run.md"), "This candidate made no change, so it had no probe run.\n");
  }
  writeHToDir(a.base, path.join(a.staging, "H"));
}

export interface ReflectorContextArgs {
  staging: string;
  base: HTree;
  candidates: CandidateView[];
  composed: { h: HTree; diff: string; xi: string; run: RunView | null };
  review: string | null;
}

/** Context for the reflector. It never holds a score. */
export function reflectorContext(a: ReflectorContextArgs): void {
  const ctx = ensureDir(path.join(a.staging, "context"));
  writeHToDir(a.base, path.join(ctx, "base", "H"));
  for (const c of a.candidates) {
    const cdir = path.join(ctx, "candidates", c.id);
    writeHToDir(c.h, path.join(cdir, "H"));
    fs.writeFileSync(path.join(cdir, "diff.patch"), c.diff || "(no change)\n");
    fs.writeFileSync(path.join(cdir, "notes.md"), c.notes || "(no notes)\n");
    if (c.run) writeRun(path.join(cdir, "run"), c.run);
  }
  const comp = path.join(ctx, "composed");
  writeHToDir(a.composed.h, path.join(comp, "H"));
  fs.writeFileSync(path.join(comp, "diff.patch"), a.composed.diff || "(no change: KEEP_BASE)\n");
  fs.writeFileSync(path.join(comp, "xi.md"), a.composed.xi || "(no step record)\n");
  if (a.composed.run) writeRun(path.join(comp, "run"), a.composed.run);
  if (a.review) {
    ensureDir(path.join(ctx, "review"));
    fs.writeFileSync(path.join(ctx, "review", "comments.md"), a.review);
  }
}

/** The text inside the first <tag>...</tag> block of a reply, or "". */
export function extractBlock(text: string, tag: string): string {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m && m[1] ? m[1].trim() : "";
}
