// Reflect and the library staging branch (docs/plan.md, decision 4 and D7 = C).
//   - The reflector reads the record of one round and writes edit rows plus at most one lesson.
//   - The orchestrator commits the lesson to the local branch harness/library-staging. No task ID or
//     run ID goes into the branch, so the human who reviews the weekly PR cannot tie a lesson to a score.
//   - `harness library-pr` builds the weekly branch from main plus the staged library.

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "../kernel/ctx.js";
import { extractBlock, reflectorContext } from "../loop/contexts.js";
import type { CandidateView } from "../loop/contexts.js";
import { diffH, readHFromDir, readHFromGit, treeHash } from "../kernel/htree.js";
import { runPaths, sessionDirs } from "../kernel/paths.js";
import type { RunRecord } from "../kernel/runs.js";
import { RunLog } from "../kernel/runs.js";
import { SessionRunner } from "../kernel/runner.js";
import type { QueryFn } from "../kernel/session.js";
import { readTrace } from "../kernel/trace.js";
import { git, gitOk } from "../util/exec.js";
import { ensureDir, readJson } from "../util/fs.js";
import { appendEvent, attachReflection, lessonId, redact, lessonStatuses, projectIdentity, readEvents, recordLesson, syncProject } from "./lessonstore.js";

export const STAGING_BRANCH = "harness/library-staging";

export interface Experience {
  domain: string;
  entry: string;
  cue: string;
  lesson: string;
  evidence: string;
}

/** Parse the <experience> block. Returns null for NO_ENTRY or a block without every field. */
export function parseExperience(reply: string): Experience | null {
  if (/^\s*NO_ENTRY\s*$/m.test(reply) && !/<experience>/.test(reply)) return null;
  const block = extractBlock(reply, "experience");
  if (!block) return null;
  const field = (k: string): string => (block.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1] ?? "").trim();
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  const e = { domain: slug(field("domain")), entry: slug(field("entry")), cue: field("cue"), lesson: field("lesson"), evidence: field("evidence") };
  return e.domain && e.entry && e.cue && e.lesson ? e : null;
}

function loadRecord(ctx: Ctx, runId: string): RunRecord {
  const rec = readJson<RunRecord | null>(path.join(ctx.pp.runsDir, runId, "record.json"), null);
  if (!rec) throw new Error(`run ${runId} has no record in ${ctx.pp.runsDir}`);
  return rec;
}

function readFileOr(file: string, fallback: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fallback;
}

export interface ReflectResult {
  edits: string;
  experience: Experience | null;
  stagedPath: string | null;
  lessonId: string | null;
}

/** Run the reflector on a finished run. Production: after the human review. Eval dev: before scoring. */
export async function reflect(ctx: Ctx, runId: string, review: string | null, queryFn?: QueryFn): Promise<ReflectResult> {
  const rec = loadRecord(ctx, runId);
  if (rec.split === "holdout") throw new Error("Reflect never runs on holdout tasks: the library must not learn from the test.");
  if (!rec.composed_tree_hash) return { edits: "", experience: null, stagedPath: null, lessonId: null };
  const rp = runPaths(ctx.pp, ctx.user.work_root, runId);
  const log = new RunLog(rp);
  const runner = new SessionRunner(ctx, rp, log, SessionRunner.budgetFor(ctx), rec.mode, queryFn);
  const base = readHFromGit(ctx.pp.projectDir, rec.fingerprint.h0_sha ?? ctx.h0Sha);

  const candidates: CandidateView[] = [];
  for (const c of rec.candidates.filter((x) => x.valid)) {
    const staging = sessionDirs(rp, `edit-${c.label}`).staging;
    const h = readHFromDir(path.join(staging, "H"));
    const trace = path.join(rp.tracesDir, `probe-${c.label}.jsonl`);
    candidates.push({
      id: c.label,
      h,
      diff: await diffH(base, h, path.join(rp.workDir, "scratch", `rdiff-${c.label}`)),
      notes: readFileOr(path.join(staging, "notes.md"), ""),
      run: fs.existsSync(trace) ? { trace: readTrace(trace), diff: readFileOr(path.join(rp.recordDir, `probe-${c.label}.diff`), ""), title: `probe-${c.label}` } : null,
    });
  }
  const composedH = readHFromDir(path.join(sessionDirs(rp, "compose").staging, "H"));
  const composedTrace = path.join(rp.tracesDir, "composed.jsonl");
  const xi = readJson<{ notes?: string }>(path.join(rp.recordDir, "xi.json"), {}).notes ?? "";
  const staging = sessionDirs(rp, "reflect").staging;
  reflectorContext({
    staging,
    base,
    candidates,
    composed: {
      h: composedH,
      diff: await diffH(base, composedH, path.join(rp.workDir, "scratch", "rdiff-composed")),
      xi,
      run: fs.existsSync(composedTrace) ? { trace: readTrace(composedTrace), diff: readFileOr(path.join(rp.recordDir, "composed.diff"), ""), title: "composed" } : null,
    },
    review,
  });
  const out = await runner.run({
    role: "reflector",
    label: "reflect",
    cwd: staging,
    prompt: "Start. The record of the round is in context/. Reply in the output format of your instructions.",
    writeRoots: [],
  });
  if (!out || out.status !== "ok") throw new Error(`the reflector session did not finish: ${out ? out.errors.join("; ") : "no budget"}`);
  const edits = extractBlock(out.resultText, "edits");
  const experience = parseExperience(out.resultText);
  let stagedPath: string | null = null;
  let id: string | null = null;
  if (experience) {
    const patch = await diffH(base, composedH, path.join(rp.workDir, "scratch", "lesson-patch"));
    const staged = stageLesson(ctx, experience, edits, patch, treeHash(base), rec);
    stagedPath = staged.rel;
    id = staged.lessonId;
  }
  if (ctx.lessonStore) {
    try {
      attachReflection(ctx.lessonStore.path, projectIdentity(ctx.pp.projectDir), runId, edits, id);
    } catch (err) {
      log.event("lesson_store_error", { step: "reflection", error: String(err) });
    }
  }
  log.event("reflect", { entry: experience ? `${experience.domain}/${experience.entry}` : "NO_ENTRY", lesson_id: id });
  return { edits, experience, stagedPath, lessonId: id };
}

/** The worktree of the staging branch, under the work root. Creates the branch from HEAD when it is missing. */
export function stagingWorktree(ctx: Ctx): string {
  const dir = path.join(ctx.user.work_root, "library-staging");
  if (fs.existsSync(path.join(dir, ".git"))) return dir;
  if (gitOk(["rev-parse", "--verify", STAGING_BRANCH], ctx.pp.projectDir)) git(["worktree", "add", "-q", dir, STAGING_BRANCH], ctx.pp.projectDir);
  else git(["worktree", "add", "-q", "-b", STAGING_BRANCH, dir, "HEAD"], ctx.pp.projectDir);
  return dir;
}

/**
 * Write one lesson into the staging branch and commit it, then copy it to the lesson store of the
 * machine (D10). Returns the entry path and the lesson ID. The ID is not a run ID or a task ID (B4).
 */
export function stageLesson(ctx: Ctx, e: Experience, edits: string, patch: string, baseTree: string, rec: RunRecord): { rel: string; lessonId: string } {
  const wt = stagingWorktree(ctx);
  let entry = e.entry;
  let n = 2;
  while (fs.existsSync(path.join(wt, "harness", "library", e.domain, entry))) entry = `${e.entry}-${n++}`;
  const rel = path.join("harness", "library", e.domain, entry);
  const dir = ensureDir(path.join(wt, rel));
  const createdAt = new Date().toISOString();
  const today = createdAt.slice(0, 10);
  const ident = projectIdentity(ctx.pp.projectDir);
  const key = `${e.domain}/${entry}`;
  const id = lessonId(ident.project_id, key, createdAt, e.lesson);
  const raw = [
    `# ${e.domain}/${entry}`,
    "",
    "tag: {hypothesis}",
    `id: ${id}`,
    `created: ${today}`,
    `base_tree: ${baseTree}`,
    "",
    "## Cue",
    "",
    e.cue,
    "",
    "## Lesson",
    "",
    e.lesson,
    "",
    "## Evidence",
    "",
    e.evidence || "(see the edit rows)",
    "",
    "## Edit rows",
    "",
    edits || "(none)",
    "",
  ].join("\n");
  // The reflector reads traces, so a lesson can quote a secret. Remove secrets before the lesson goes into git.
  const experience = redact(raw).text;
  const hPatch = redact(`# base-tree: ${baseTree}\n${patch}`).text;
  fs.writeFileSync(path.join(dir, "EXPERIENCE.md"), experience);
  fs.writeFileSync(path.join(dir, "H.patch"), hPatch);
  const index = path.join(wt, "harness", "library", "index.md");
  ensureDir(path.dirname(index));
  if (!fs.existsSync(index)) fs.writeFileSync(index, "# Library index\n\n");
  fs.appendFileSync(index, `- [L:${e.domain}/${entry}] ${e.lesson} {hypothesis}\n`);
  git(["add", "-A", "harness/library"], wt);
  git(["-c", "user.name=harness", "-c", "user.email=harness@localhost", "commit", "-q", "--no-verify", "-m", `library staging: add ${e.domain}/${entry}`], wt);
  if (ctx.lessonStore) {
    try {
      recordLesson(ctx.lessonStore.path, ident, {
        lessonId: id,
        key,
        domain: e.domain,
        entry,
        cue: e.cue,
        lesson: e.lesson,
        evidence: e.evidence,
        edits,
        createdAt,
        baseTree,
        experience,
        patch: hPatch,
        rec,
      });
    } catch (err) {
      ctx.notes.push(`The lesson store did not get lesson ${id}: ${String(err)}`);
    }
  }
  return { rel, lessonId: id };
}

/** Library entries of a ref: entry folder -> lesson ID (null for an entry without an `id:` line). */
function entriesAt(projectDir: string, ref: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (!gitOk(["rev-parse", "--verify", "-q", ref], projectDir)) return out;
  for (const f of git(["ls-tree", "-r", "--name-only", ref, "--", "harness/library"], projectDir).split("\n")) {
    if (!f.endsWith("/EXPERIENCE.md")) continue;
    const id = git(["show", `${ref}:${f}`], projectDir).match(/^id:\s*(L[0-9a-f]{12})\s*$/m)?.[1] ?? null;
    out.set(path.dirname(f), id);
  }
  return out;
}

/**
 * Build the weekly library branch: main plus the NEW lessons of the staging branch. Returns the
 * branch name and the PR body. The body lists cues and lessons only: no task ID, no run ID (B4).
 *
 * The branch takes only entries that main does not have, and adds their lines to the index of main.
 * So a lesson that a human edited in main keeps the edit, and a lesson that the human did not merge
 * (status "not-merged" in the lesson store) does not come back in the next PR.
 */
export function libraryPrBranch(ctx: Ctx, mainRef = "main"): { branch: string; body: string; skipped: string[] } | null {
  const projectDir = ctx.pp.projectDir;
  stagingWorktree(ctx);
  const rejected = new Set<string>();
  if (ctx.lessonStore) {
    syncProject(ctx.lessonStore.path, projectDir, mainRef);
    for (const s of lessonStatuses(readEvents(ctx.lessonStore.path)).values()) if (s.status === "not-merged") rejected.add(s.lesson_id);
  }
  const inMain = entriesAt(projectDir, mainRef);
  const mainIds = new Set([...inMain.values()].filter((x): x is string => Boolean(x)));
  const skipped: string[] = [];
  const fresh: { dir: string; id: string | null }[] = [];
  for (const [dir, id] of entriesAt(projectDir, STAGING_BRANCH)) {
    if (inMain.has(dir) || (id && mainIds.has(id))) continue;
    if (id && rejected.has(id)) {
      skipped.push(dir.replace("harness/library/", ""));
      continue;
    }
    fresh.push({ dir, id });
  }
  if (!fresh.length) return null;

  const day = `harness/library-${new Date().toISOString().slice(0, 10)}`;
  let branch = day;
  for (let n = 2; gitOk(["rev-parse", "--verify", "-q", branch], projectDir); n++) branch = `${day}-${n}`;
  const wtDir = path.join(ctx.user.work_root, branch.replace(/\//g, "-"));
  git(["worktree", "add", "-q", "-b", branch, wtDir, mainRef], projectDir);
  const ident = projectIdentity(projectDir);
  const lines: string[] = [];
  try {
    const stagingIndex = gitOk(["cat-file", "-e", `${STAGING_BRANCH}:harness/library/index.md`], projectDir) ? git(["show", `${STAGING_BRANCH}:harness/library/index.md`], projectDir) : "";
    const indexFile = path.join(wtDir, "harness", "library", "index.md");
    ensureDir(path.dirname(indexFile));
    let index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, "utf8") : "# Library index\n\n";
    for (const e of fresh) {
      git(["checkout", STAGING_BRANCH, "--", e.dir], wtDir);
      const key = e.dir.replace("harness/library/", "");
      const line = stagingIndex.split("\n").find((l) => l.includes(`[L:${key}]`));
      if (line && !index.includes(`[L:${key}]`)) index = index.replace(/\s*$/, "\n") + line + "\n";
      const text = fs.readFileSync(path.join(wtDir, e.dir, "EXPERIENCE.md"), "utf8");
      const cue = text.match(/## Cue\s*\n\s*\n([^\n]+)/)?.[1] ?? "";
      const lesson = text.match(/## Lesson\s*\n\s*\n([^\n]+)/)?.[1] ?? "";
      lines.push(`- \`${key}\`: ${lesson} (cue: ${cue})`);
      if (e.id && ctx.lessonStore) appendEvent(ctx.lessonStore.path, { type: "proposed", project_id: ident.project_id, lesson_id: e.id, branch });
    }
    fs.writeFileSync(indexFile, index);
    git(["add", "-A", "harness/library"], wtDir);
    git(["-c", "user.name=harness", "-c", "user.email=harness@localhost", "commit", "-q", "--no-verify", "-m", "library: add the lessons of this week"], wtDir);
  } finally {
    git(["worktree", "remove", "--force", wtDir], projectDir);
  }
  const body = [
    "Weekly library PR (D7). Review each lesson BEFORE you open the eval reports of this week.",
    "",
    "Each lesson starts with the tag {hypothesis}. The PR has no task IDs or run IDs on purpose.",
    "Keep the `id:` line of each lesson when you edit it: the lesson store of the machine uses it.",
    "",
    ...lines,
  ].join("\n");
  return { branch, body, skipped };
}
