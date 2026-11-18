// One task through the template (docs/plan.md, "Kiến trúc" and "Bộ rule quyết định"):
//   reference run -> decision 1 -> propose (2 editors) -> probe (1 run per candidate) -> compose -> composed run -> gate -> output
// The loop stops on budget, never on a score. H′ stays in the run record: H0 changes only through decision 5.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../kernel/ctx.js";
import { composerContext, editorContext, extractBlock } from "./contexts.js";
import type { HTree } from "../kernel/htree.js";
import { diffH, isPromptFile, promptSize, readHFromDir, treeHash, validateH } from "../kernel/htree.js";
import { sessionDirs } from "../kernel/paths.js";
import type { Role } from "../kernel/roles.js";
import { readRunRecords } from "../kernel/runs.js";
import type { SessionRunner } from "../kernel/runner.js";
import type { CandidateView, Deps, TaskInput, TaskResult } from "../kernel/run.js";
import { TaskRun } from "../kernel/run.js";
import { p75, signals } from "./trigger.js";
import { ensureDir, writeJson } from "../util/fs.js";
import { reuseMatches } from "./reuse.js";

export type { Deps, TaskInput, TaskResult } from "../kernel/run.js";
export { claudeBlock, pinnedGuardrails } from "../kernel/run.js";

function p75ForType(ctx: Ctx, taskType: string | null): { steps: number; tokens: number } | null {
  if (!taskType) return null;
  const prior = readRunRecords(ctx.pp.runsDir).filter((r) => r.task_type === taskType && r.reference);
  if (prior.length < ctx.config.trigger.p75_min_runs) return null;
  return { steps: p75(prior.map((r) => r.reference!.steps)), tokens: p75(prior.map((r) => r.reference!.tokens)) };
}

export async function runTask(ctx: Ctx, task: TaskInput, deps: Deps = {}): Promise<TaskResult> {
  const r = new TaskRun(ctx, task, deps);
  const { runner, rp, rec, notes, h0, hRun, overlay, result } = r;
  const libraryDir = task.noLibrary ? ensureDir(path.join(rp.workDir, "scratch", "no-library")) : ctx.pp.libraryDir;

  // 1. Reference run.
  const ref = await r.runReference();
  const refView = ref.view;
  if (r.referenceBroken() || !ref.out) return r.finish(false, null);

  // 2. Decision 1.
  let improve: boolean;
  if (task.frozen) improve = false;
  else if (task.mode === "eval") improve = true;
  else {
    const sig = signals(refView.trace, rec.reference?.tokens ?? 0, { toolErrorsMin: ctx.config.trigger.tool_errors_min, p75: p75ForType(ctx, task.taskType) });
    improve = task.force === "improve" || (task.force !== "no-improve" && sig.weak);
    rec.decision1 = { ran: improve, forced: task.force, signals: sig.signals };
  }
  if (improve && ctx.config.phase < 2) {
    notes.push(`Phase lock: the improvement loop starts in Phase 2. The project is in Phase ${ctx.config.phase}.`);
    improve = false;
  }
  if (!improve || runner.budgetStop || ref.out.status !== "ok") return r.finish(true, null);

  // 3. Propose: two editors in parallel, each on its own copy of H.
  const pg = overlay.pinnedGuardrails;
  // Growth limit: the always-on text and the skills of a candidate stay within growth_limit_pct of H0.
  const sizeLimit = Math.floor(promptSize(h0) * (1 + ctx.config.growth_limit_pct / 100));
  const validate = (t: HTree): string[] => {
    const p = validateH(t);
    const size = promptSize(t);
    if (size > sizeLimit) {
      // Editors have no shell to count bytes, so the message names the size of each file.
      const files = [...t].filter(([rel]) => isPromptFile(rel)).map(([rel, data]) => `${rel} ${data.length}`);
      p.push(`The harness text is ${size} bytes. The growth limit is ${sizeLimit} bytes (${ctx.config.growth_limit_pct}% above H0). Remove at least ${size - sizeLimit} bytes, or fold rules together. Bytes per file: ${files.join(", ")}.`);
    }
    return p;
  };
  // Give the limit before the first try. Found on the trial monorepo: 3 of 3 proposals went over the
  // limit and each needed a fix session (21% of the cost of the run). Editors have no shell to count bytes.
  const sizeNote = (t: HTree): string => {
    const files = [...t].filter(([rel]) => isPromptFile(rel)).map(([rel, data]) => `${rel} ${data.length}`);
    return `Size limit: the harness text in H/ (the always-on files and the skills) can have at most ${sizeLimit} bytes. It has ${promptSize(t)} bytes now, so you can add at most ${Math.max(0, sizeLimit - promptSize(t))} bytes. Bytes per file: ${files.join(", ")}. A proposal over the limit is discarded. Fold or remove text when you add text.`;
  };
  const editors: { id: string; role: Role }[] = [
    { id: "A", role: "invariant-editor" },
    { id: "B", role: "domain-editor" },
  ];
  const proposals = await Promise.all(
    editors.map(async (e) => {
      const staging = sessionDirs(rp, `edit-${e.id}`).staging;
      editorContext({ staging, taskMd: task.taskMd, base: hRun, reference: refView, pinnedGuardrails: pg, libraryDir });
      return proposeOne(runner, e.role, `edit-${e.id}`, staging, editors.length, validate, sizeNote(hRun));
    }),
  );
  const candidates: CandidateView[] = [];
  for (let i = 0; i < editors.length; i++) {
    const e = editors[i] as { id: string; role: Role };
    const p = proposals[i] as Awaited<ReturnType<typeof proposeOne>>;
    const diff = p.tree ? await diffH(hRun, p.tree, path.join(rp.workDir, "scratch", `diff-${e.id}`)) : "";
    rec.candidates.push({ label: e.id, valid: Boolean(p.tree), problems: p.problems, firstProblems: p.firstProblems, treeHash: p.tree ? treeHash(p.tree) : null });
    if (p.tree) candidates.push({ id: e.id, h: p.tree, diff, notes: p.notes, run: null });
  }

  // 4. Probe: one run per changed candidate, in parallel.
  const changed = candidates.filter((c) => treeHash(c.h) !== treeHash(hRun));
  await Promise.all(
    changed.map(async (c) => {
      const probe = await r.execRun(`probe-${c.id}`, c.h, changed.length);
      c.run = probe.view;
    }),
  );
  result.candidates = candidates;
  if (!changed.length || runner.budgetStop) {
    notes.push(changed.length ? "The budget stopped the loop after the probes." : "Both editors kept the base (KEEP_BASE). No probe ran.");
    return r.finish(true, null);
  }

  // 5. Compose.
  const composeStaging = sessionDirs(rp, "compose").staging;
  composerContext({ staging: composeStaging, taskMd: task.taskMd, base: hRun, reference: refView, candidates, pinnedGuardrails: pg });
  const composed = await proposeOne(runner, "composer", "compose", composeStaging, 1, validate, sizeNote(hRun));
  const hPrime = composed.tree ?? hRun;
  result.composed = hPrime;
  result.xi = composed.notes;
  rec.composed_tree_hash = treeHash(hPrime);
  writeJson(path.join(rp.recordDir, "xi.json"), { notes: composed.notes, problems: composed.problems, first_problems: composed.firstProblems, kept_base: !composed.tree || treeHash(hPrime) === treeHash(hRun) });
  rec.reuse_entries = reuseMatches(hRun, hPrime, libraryDir, [...candidates.map((c) => c.notes), composed.notes]);
  rec.reuse_event = rec.reuse_entries.length > 0;
  if (treeHash(hPrime) === treeHash(hRun) || runner.budgetStop) {
    notes.push(treeHash(hPrime) === treeHash(hRun) ? "The composer kept the base harness (KEEP_BASE)." : "The budget stopped the loop before the composed run.");
    return r.finish(true, null);
  }

  // 6. Composed run, then the gate (composed first, reference as the fallback).
  const comp = await r.execRun("composed", hPrime);
  return r.finish(true, comp.out && comp.out.status !== "aborted_spec" ? comp.ws : null);
}

/** Run one editing role. Validate its tree; on a problem, run it once more with the problems. */
async function proposeOne(
  runner: SessionRunner,
  role: Role,
  label: string,
  staging: string,
  concurrent: number,
  validate: (t: HTree) => string[] = validateH,
  sizeNote = "",
): Promise<{ tree: HTree | null; notes: string; problems: string[]; firstProblems: string[] }> {
  const hDir = path.join(staging, "H");
  const mission = "Start. The evidence is in context/. The harness to edit is in H/. Follow the mission in your instructions, then reply with one <notes> block." + (sizeNote ? `\n${sizeNote}` : "");
  let out = await runner.run({ role, label, cwd: staging, prompt: mission, writeRoots: [hDir], concurrent });
  if (!out || out.status !== "ok") return { tree: null, notes: "", problems: [`session ${out ? out.status : "skipped"}`], firstProblems: [] };
  let tree = readHFromDir(hDir);
  let problems = validate(tree);
  // Keep the problems of the first try: they explain the cost of the fix session (docs/plan.md, C5).
  const firstProblems = [...problems];
  if (problems.length) {
    out = await runner.run({
      role,
      label: `${label}-fix`,
      cwd: staging,
      prompt: `The orchestrator discarded your proposal. Fix these problems in H/, then reply with one <notes> block:\n${problems.map((p) => "- " + p).join("\n")}`,
      writeRoots: [hDir],
      retry: false,
    });
    if (!out || out.status !== "ok") return { tree: null, notes: "", problems, firstProblems };
    tree = readHFromDir(hDir);
    problems = validate(tree);
    if (problems.length) return { tree: null, notes: "", problems, firstProblems };
  }
  const notes = extractBlock(out.resultText, "notes") || out.resultText.trim();
  fs.writeFileSync(path.join(staging, "notes.md"), notes + "\n");
  return { tree, notes, problems: [], firstProblems };
}
