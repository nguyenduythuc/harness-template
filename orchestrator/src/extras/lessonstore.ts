// The lesson store (docs/plan.md, D10 and Phase 6): one folder on this machine that collects the
// lessons and the improvement steps of every project that uses the template. Phase 6 uses this data
// to change the template: the R role prompts, the H0 defaults and the default thresholds.
//
// Rules:
//   - Only the orchestrator writes the store. Only a human runs the commands that read it.
//   - No agent session reads it: the store is in the read-deny list of every session (B1).
//   - It never holds task text, deliverable code, rubrics or scores. Eval scores stay in the eval
//     store; Phase 6 joins them by run ID, at export time only.
//   - Holdout runs never write to it, so that Phase 6 cannot learn from the test (B4).
//   - Every text goes through redact() first. The store stays on this machine.
//
// Layout:
//   README.md, schema_version
//   projects.jsonl                      one line for each project: project_id, name, remote
//   events.jsonl                        append-only: staged, proposed, merged, edited, not-merged, removed, reused
//   lessons/<lesson-id>/meta.json       the lesson, its provenance and its fingerprint
//   lessons/<lesson-id>/EXPERIENCE.md   the staged text;  merged/EXPERIENCE.md: the text in main, when a human changed it
//   lessons/<lesson-id>/H.patch         the H patch of the lesson
//   episodes/<project-id>/<run-id>.json one improvement step: candidates, notes, composer record, outcome
//   exports/<time>/                     datasets that `harness lessons export` builds

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserConfig } from "../kernel/config.js";
import type { RunRecord } from "../kernel/runs.js";
import { git, gitOk } from "../util/exec.js";
import { appendJsonl, ensureDir, readJson, readJsonl, sha256, writeIfMissing, writeJson } from "../util/fs.js";

export const SCHEMA_VERSION = 1;

export type { StoreConfig } from "../kernel/config.js";
export { resolveLessonStore } from "../kernel/config.js";

const README = `# Lesson store

The harness orchestrator writes this folder. It collects the lessons and the improvement steps of
every project on this machine. Phase 6 of the harness template uses it to change the template.

- Do not edit the files by hand. events.jsonl is append-only.
- No agent session reads this folder.
- The folder holds internal facts of your projects (harness text, lesson text). It never holds task
  text, deliverable code, rubrics or scores. Keep it on this machine. Before you copy it to another
  place, read the policy of each company whose project wrote to it.
- \`harness lessons sync\` updates the status of each lesson from the main branch of a project, and
  commits this folder when it is a git repo. \`harness lessons export\` builds a dataset in exports/.
`;

const ready = new Set<string>();

/** Make the store skeleton one time per process, before the first write. */
function ensureStore(dir: string): void {
  if (ready.has(dir)) return;
  initLessonStore(dir);
  ready.add(dir);
}

/** Make the store skeleton. Create-only. Returns the created paths. */
export function initLessonStore(dir: string): string[] {
  const created: string[] = [];
  ensureDir(path.join(dir, "lessons"));
  ensureDir(path.join(dir, "episodes"));
  for (const [rel, content] of [
    ["README.md", README],
    ["schema_version", `${SCHEMA_VERSION}\n`],
    [".gitignore", "exports/\n"],
  ] as const) {
    if (writeIfMissing(path.join(dir, rel), content)) created.push(rel);
  }
  if (!gitOk(["rev-parse", "--git-dir"], dir)) {
    git(["init", "-q"], dir);
    created.push(".git");
  }
  return created;
}

// ---------------------------------------------------------------------------------------------
// Redaction.

const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "url-credentials", re: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/gi },
];
const ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[:=]\s*)(["']?)([^\s"']{6,})\3/gi;

/** Replace secrets with [REDACTED:<kind>]. Returns the new text and the number of replacements. */
export function redact(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return `[REDACTED:${kind}]`;
    });
  }
  out = out.replace(ASSIGNMENT, (_m, key: string, sep: string, q: string) => {
    count++;
    return `${key}${sep}${q}[REDACTED:value]${q}`;
  });
  return { text: out, count };
}

/** Redact every string in a JSON value. */
function redactDeep<T>(value: T, counter: { n: number }): T {
  if (typeof value === "string") {
    const r = redact(value);
    counter.n += r.count;
    return r.text as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counter)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, counter);
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Projects.

export interface ProjectIdentity {
  project_id: string;
  name: string;
  remote: string | null;
}

/** Remove the user name and password from a git remote URL. */
export function cleanRemote(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1").replace(/\.git$/, "");
}

/** A stable ID for a project: from the origin remote when it has one, else from its absolute path. */
export function projectIdentity(projectDir: string): ProjectIdentity {
  const dir = path.resolve(projectDir);
  const remote = gitOk(["config", "--get", "remote.origin.url"], dir) ? cleanRemote(git(["config", "--get", "remote.origin.url"], dir)) : null;
  return { project_id: "P" + sha256(remote ?? `path:${dir}`).slice(0, 12), name: path.basename(dir), remote };
}

export function registerProject(store: string, ident: ProjectIdentity): void {
  ensureStore(store);
  const file = path.join(store, "projects.jsonl");
  if (readJsonl<ProjectIdentity>(file).some((p) => p.project_id === ident.project_id)) return;
  appendJsonl(file, { ...ident, first_seen: new Date().toISOString() });
}

export function readProjects(store: string): (ProjectIdentity & { first_seen: string })[] {
  return readJsonl(path.join(store, "projects.jsonl"));
}

// ---------------------------------------------------------------------------------------------
// Lessons and events.

export type EventType = "staged" | "proposed" | "merged" | "edited" | "not-merged" | "removed" | "reused";
const STATUS_EVENTS: EventType[] = ["staged", "proposed", "merged", "edited", "not-merged", "removed"];

export interface StoreEvent {
  ts: string;
  type: EventType;
  project_id: string;
  lesson_id?: string;
  [k: string]: unknown;
}

export function appendEvent(store: string, ev: Omit<StoreEvent, "ts"> & { ts?: string }): void {
  ensureStore(store);
  appendJsonl(path.join(store, "events.jsonl"), { ts: ev.ts ?? new Date().toISOString(), ...ev });
}

export function readEvents(store: string): StoreEvent[] {
  return readJsonl<StoreEvent>(path.join(store, "events.jsonl"));
}

/** A lesson ID: stable, and the same in the project library (the `id:` line) and in the store. */
export function lessonId(projectId: string, key: string, createdAt: string, lesson: string): string {
  return "L" + sha256(`${projectId}\0${key}\0${createdAt}\0${lesson}`).slice(0, 12);
}

export interface Fingerprint {
  claude_code_version: string | null;
  models: { executor: string; editor: string; judge: string };
  h0_tree_hash: string;
  plugin_version: string | null;
  plugin_sha: string | null;
  orchestrator_sha: string | null;
}

export function fingerprintOf(rec: RunRecord): Fingerprint {
  return {
    claude_code_version: rec.fingerprint.claude_code_version,
    models: rec.fingerprint.models,
    h0_tree_hash: rec.fingerprint.h0_tree_hash,
    plugin_version: rec.fingerprint.plugin.version,
    plugin_sha: rec.fingerprint.plugin.git_sha,
    orchestrator_sha: rec.fingerprint.orchestrator.git_sha,
  };
}

export interface LessonMeta {
  schema: number;
  lesson_id: string;
  project_id: string;
  key: string;
  domain: string;
  entry: string;
  cue: string;
  lesson: string;
  evidence: string;
  edits: string;
  created_at: string;
  base_tree: string;
  run_id: string;
  mode: "production" | "eval";
  task_type: string | null;
  phase: number;
  fingerprint: Fingerprint;
  /** SHA-256 of the staged EXPERIENCE.md before redaction. Sync compares it with the text in main. */
  experience_sha256: string;
  redactions: number;
}

export interface LessonInput {
  lessonId: string;
  key: string;
  domain: string;
  entry: string;
  cue: string;
  lesson: string;
  evidence: string;
  edits: string;
  createdAt: string;
  baseTree: string;
  experience: string;
  patch: string;
  rec: RunRecord;
}

/** Write one staged lesson and its "staged" event. */
export function recordLesson(store: string, ident: ProjectIdentity, a: LessonInput): LessonMeta {
  ensureStore(store);
  registerProject(store, ident);
  const dir = ensureDir(path.join(store, "lessons", a.lessonId));
  const counter = { n: 0 };
  const exp = redact(a.experience);
  const patch = redact(a.patch);
  counter.n += exp.count + patch.count;
  const meta = redactDeep<LessonMeta>(
    {
      schema: SCHEMA_VERSION,
      lesson_id: a.lessonId,
      project_id: ident.project_id,
      key: a.key,
      domain: a.domain,
      entry: a.entry,
      cue: a.cue,
      lesson: a.lesson,
      evidence: a.evidence,
      edits: a.edits,
      created_at: a.createdAt,
      base_tree: a.baseTree,
      run_id: a.rec.run_id,
      mode: a.rec.mode,
      task_type: a.rec.task_type,
      phase: a.rec.phase,
      fingerprint: fingerprintOf(a.rec),
      experience_sha256: sha256(a.experience),
      redactions: 0,
    },
    counter,
  );
  meta.redactions = counter.n;
  fs.writeFileSync(path.join(dir, "EXPERIENCE.md"), exp.text);
  fs.writeFileSync(path.join(dir, "H.patch"), patch.text);
  writeJson(path.join(dir, "meta.json"), meta);
  appendEvent(store, { type: "staged", project_id: ident.project_id, lesson_id: a.lessonId, key: a.key, run_id: a.rec.run_id });
  return meta;
}

export function readLessonMeta(store: string, id: string): LessonMeta | null {
  return readJson<LessonMeta | null>(path.join(store, "lessons", id, "meta.json"), null);
}

export interface LessonStatus {
  lesson_id: string;
  project_id: string;
  status: EventType;
  status_ts: string;
  proposed_ts: string | null;
  merged_sha256: string | null;
  reuse_count: number;
}

/** The status of each lesson: the last status event. Reuse events count separately. */
export function lessonStatuses(events: StoreEvent[]): Map<string, LessonStatus> {
  const out = new Map<string, LessonStatus>();
  const reuse = new Map<string, number>();
  for (const ev of events) {
    if (!ev.lesson_id) continue;
    if (ev.type === "reused") {
      reuse.set(ev.lesson_id, (reuse.get(ev.lesson_id) ?? 0) + 1);
      continue;
    }
    if (!STATUS_EVENTS.includes(ev.type)) continue;
    let s = out.get(ev.lesson_id);
    if (!s) {
      // A lesson starts with its "staged" event. Status events of a lesson that the store does not know start it too.
      s = { lesson_id: ev.lesson_id, project_id: ev.project_id, status: "staged", status_ts: ev.ts, proposed_ts: null, merged_sha256: null, reuse_count: 0 };
      out.set(ev.lesson_id, s);
    }
    s.status = ev.type;
    s.status_ts = ev.ts;
    if (ev.type === "proposed") s.proposed_ts = ev.ts;
    if (ev.type === "merged" || ev.type === "edited") s.merged_sha256 = (ev.sha256 as string | undefined) ?? null;
  }
  for (const [id, n] of reuse) {
    const s = out.get(id);
    if (s) s.reuse_count = n;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Episodes: one improvement step, without task text or deliverable code.

export interface EpisodeCandidate {
  label: string;
  role: string;
  valid: boolean;
  problems: string[];
  tree_hash: string | null;
  h_patch: string;
  notes: string;
}

export interface EpisodeInput {
  rec: RunRecord;
  /** "off" for the eval arm that runs the loop with an empty library. */
  library: "on" | "off";
  candidates: EpisodeCandidate[];
  composer: { ran: boolean; kept_base: boolean; notes: string; h_patch: string; tree_hash: string | null };
}

export function recordEpisode(store: string, ident: ProjectIdentity, a: EpisodeInput): string {
  ensureStore(store);
  registerProject(store, ident);
  const rec = a.rec;
  const byRole: Record<string, { sessions: number; tokens: number; cost_usd: number }> = {};
  for (const s of rec.sessions) {
    const r = (byRole[s.role] ??= { sessions: 0, tokens: 0, cost_usd: 0 });
    r.sessions++;
    r.tokens += s.usage.inputTokens + s.usage.outputTokens + s.usage.cacheReadTokens + s.usage.cacheCreationTokens;
    r.cost_usd = Math.round((r.cost_usd + s.costUsd) * 10000) / 10000;
  }
  const counter = { n: 0 };
  const ep = redactDeep(
    {
      schema: SCHEMA_VERSION,
      episode_id: rec.run_id,
      project_id: ident.project_id,
      created_at: rec.ended_at,
      mode: rec.mode,
      split: rec.split,
      task_type: rec.task_type,
      phase: rec.phase,
      fingerprint: fingerprintOf(rec),
      library: a.library,
      decision1: rec.decision1,
      reference: rec.reference,
      candidates: a.candidates,
      composer: a.composer,
      outcome: rec.outcome,
      gate: { composed: rec.gate.composed?.pass ?? null, reference: rec.gate.reference?.pass ?? null },
      reuse_entries: rec.reuse_entries,
      budget_stop: rec.budget_stop,
      usage_by_role: byRole,
      totals: { tokens: rec.totals.tokens, cost_usd: Math.round(rec.totals.costUsd * 10000) / 10000 },
      redactions: 0,
    },
    counter,
  );
  ep.redactions = counter.n;
  const file = path.join(store, "episodes", ident.project_id, `${rec.run_id}.json`);
  writeJson(file, ep);
  for (const id of rec.reuse_entries) {
    appendEvent(store, { type: "reused", project_id: ident.project_id, lesson_id: /^L[0-9a-f]{12}$/.test(id) ? id : undefined, key: id, run_id: rec.run_id, outcome: rec.outcome });
  }
  return file;
}

/**
 * Add the reflector result to the episode of a run: the edit rows and the lesson ID. The edit rows
 * are data for Phase 6 also when the reflector writes no lesson (NO_ENTRY).
 */
export function attachReflection(store: string, ident: ProjectIdentity, runId: string, edits: string, lessonId: string | null): boolean {
  ensureStore(store);
  const file = path.join(store, "episodes", ident.project_id, `${runId}.json`);
  const ep = readJson<Record<string, unknown> | null>(file, null);
  if (!ep) return false;
  const r = redact(edits);
  ep.reflection = { edits: r.text, lesson_id: lessonId, at: new Date().toISOString() };
  ep.redactions = Number(ep.redactions ?? 0) + r.count;
  writeJson(file, ep);
  return true;
}

export function listEpisodes(store: string): string[] {
  const root = path.join(store, "episodes");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith(".json")).map((f) => path.join(root, d.name, f)))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Sync: read the library in the main branch of a project, and record what the human did.

export interface SyncResult {
  ref: string;
  merged: string[];
  edited: string[];
  notMerged: string[];
  removed: string[];
}

/** The main ref to read: origin/main when it exists (after a fetch), else main. */
export function mainRef(projectDir: string, wanted?: string): string {
  if (wanted) return wanted;
  return gitOk(["rev-parse", "--verify", "-q", "origin/main"], projectDir) ? "origin/main" : "main";
}

export function syncProject(store: string, projectDir: string, ref?: string): SyncResult {
  ensureStore(store);
  const ident = projectIdentity(projectDir);
  const r = mainRef(projectDir, ref);
  const out: SyncResult = { ref: r, merged: [], edited: [], notMerged: [], removed: [] };
  if (!gitOk(["rev-parse", "--verify", "-q", r], projectDir)) return out;
  const inMain = new Map<string, { file: string; text: string }>();
  for (const file of git(["ls-tree", "-r", "--name-only", r, "--", "harness/library"], projectDir).split("\n")) {
    if (!file.endsWith("/EXPERIENCE.md")) continue;
    const text = git(["show", `${r}:${file}`], projectDir);
    const id = text.match(/^id:\s*(L[0-9a-f]{12})\s*$/m)?.[1];
    if (id) inMain.set(id, { file, text });
  }
  const lastLibraryChange = git(["log", "-1", "--format=%cI", r, "--", "harness/library"], projectDir).trim();
  const statuses = lessonStatuses(readEvents(store));
  for (const s of statuses.values()) {
    if (s.project_id !== ident.project_id) continue;
    const meta = readLessonMeta(store, s.lesson_id);
    const main = inMain.get(s.lesson_id);
    if (main) {
      const h = sha256(main.text);
      if (s.merged_sha256 === h) continue;
      const edited = meta ? h !== meta.experience_sha256 : false;
      if (edited) {
        const dir = ensureDir(path.join(store, "lessons", s.lesson_id, "merged"));
        fs.writeFileSync(path.join(dir, "EXPERIENCE.md"), redact(main.text).text);
      }
      appendEvent(store, { type: edited ? "edited" : "merged", project_id: ident.project_id, lesson_id: s.lesson_id, sha256: h, ref: r, path: main.file });
      (edited ? out.edited : out.merged).push(s.lesson_id);
    } else if (s.status === "merged" || s.status === "edited") {
      appendEvent(store, { type: "removed", project_id: ident.project_id, lesson_id: s.lesson_id, ref: r });
      out.removed.push(s.lesson_id);
    } else if (s.status === "proposed" && s.proposed_ts && lastLibraryChange && new Date(lastLibraryChange) > new Date(s.proposed_ts)) {
      // The library in main changed after the proposal, and this lesson is not in it: the human did not merge it.
      appendEvent(store, { type: "not-merged", project_id: ident.project_id, lesson_id: s.lesson_id, ref: r });
      out.notMerged.push(s.lesson_id);
    }
  }
  return out;
}

/** Commit the store when it is a git repo. Best-effort: a failed commit loses no data. */
export function commitStore(store: string, message: string): boolean {
  ensureStore(store);
  if (!gitOk(["rev-parse", "--git-dir"], store)) return false;
  try {
    git(["add", "-A"], store);
    if (!git(["status", "--porcelain"], store).trim()) return false;
    git(["-c", "user.name=harness", "-c", "user.email=harness@localhost", "commit", "-q", "--no-verify", "-m", message], store);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Read side: list, stats, export. A human runs these commands. No score is in the store.

export interface LessonRow {
  lesson_id: string;
  project: string;
  key: string;
  status: EventType;
  reuse_count: number;
  lesson: string;
}

export function listLessons(store: string, filter: { status?: string; project?: string } = {}): LessonRow[] {
  const names = new Map(readProjects(store).map((p) => [p.project_id, p.name]));
  const rows: LessonRow[] = [];
  for (const s of lessonStatuses(readEvents(store)).values()) {
    const meta = readLessonMeta(store, s.lesson_id);
    if (!meta) continue;
    const project = names.get(s.project_id) ?? s.project_id;
    if (filter.status && s.status !== filter.status) continue;
    if (filter.project && filter.project !== project && filter.project !== s.project_id) continue;
    rows.push({ lesson_id: s.lesson_id, project, key: meta.key, status: s.status, reuse_count: s.reuse_count, lesson: meta.lesson });
  }
  return rows.sort((a, b) => a.project.localeCompare(b.project) || a.key.localeCompare(b.key));
}

/** The Phase 6 data gate (docs/plan.md, Phase 6). The values are proposals until Thức sets them. */
export const PHASE6_GATE = { projects: 3, decidedLessons: 30, episodes: 50 };

/** Efficiency numbers of one template version (plugin SHA). They are for reading, not for a gate. */
export interface TemplateStats {
  template: string;
  episodes: number;
  meanTokens: number | null;
  budgetStopRate: number | null;
  keptBaseRate: number | null;
  composedGatePassRate: number | null;
  lessons: number;
  mergeRate: number | null;
  editRate: number | null;
}

interface EpisodeView {
  fingerprint?: { plugin_sha?: string | null; plugin_version?: string | null };
  totals?: { tokens?: number };
  budget_stop?: boolean;
  composer?: { ran?: boolean; kept_base?: boolean };
  gate?: { composed?: boolean | null };
}

const rate = (n: number, d: number): number | null => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** Group episodes and lessons by template version, so that a new template can be compared with the old one. */
export function templateStats(store: string): TemplateStats[] {
  const name = (fp?: { plugin_sha?: string | null; plugin_version?: string | null }): string =>
    `${fp?.plugin_version ?? "?"}@${(fp?.plugin_sha ?? "unknown").slice(0, 8)}`;
  const groups = new Map<string, { eps: EpisodeView[]; lessons: LessonStatus[] }>();
  const slot = (k: string): { eps: EpisodeView[]; lessons: LessonStatus[] } => {
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { eps: [], lessons: [] }));
    return g;
  };
  for (const f of listEpisodes(store)) {
    const ep = readJson<EpisodeView>(f, {});
    slot(name(ep.fingerprint)).eps.push(ep);
  }
  for (const s of lessonStatuses(readEvents(store)).values()) {
    const meta = readLessonMeta(store, s.lesson_id);
    if (meta) slot(name(meta.fingerprint)).lessons.push(s);
  }
  return [...groups.entries()]
    .map(([template, g]) => {
      const composed = g.eps.filter((e) => e.composer?.ran);
      const gated = g.eps.filter((e) => typeof e.gate?.composed === "boolean");
      const accepted = g.lessons.filter((l) => ["merged", "edited", "removed"].includes(l.status)).length;
      const decided = accepted + g.lessons.filter((l) => l.status === "not-merged").length;
      const tokens = g.eps.map((e) => e.totals?.tokens ?? 0);
      return {
        template,
        episodes: g.eps.length,
        meanTokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
        budgetStopRate: rate(g.eps.filter((e) => e.budget_stop).length, g.eps.length),
        keptBaseRate: rate(composed.filter((e) => e.composer?.kept_base).length, composed.length),
        composedGatePassRate: rate(gated.filter((e) => e.gate?.composed === true).length, gated.length),
        lessons: g.lessons.length,
        mergeRate: rate(accepted, decided),
        editRate: rate(g.lessons.filter((l) => l.status === "edited").length, accepted),
      };
    })
    .sort((a, b) => a.template.localeCompare(b.template));
}

export interface StoreStats {
  projects: number;
  lessons: number;
  byStatus: Record<string, number>;
  decided: number;
  mergeRate: number | null;
  editRate: number | null;
  episodes: number;
  reuseEvents: number;
  perProject: { project: string; lessons: number; decided: number; episodes: number }[];
  phase6Ready: boolean;
}

export function storeStats(store: string): StoreStats {
  const projects = readProjects(store);
  const statuses = [...lessonStatuses(readEvents(store)).values()];
  const byStatus: Record<string, number> = {};
  for (const s of statuses) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  const accepted = (byStatus.merged ?? 0) + (byStatus.edited ?? 0) + (byStatus.removed ?? 0);
  const decided = accepted + (byStatus["not-merged"] ?? 0);
  const episodes = listEpisodes(store);
  const perProject = projects.map((p) => ({
    project: p.name,
    lessons: statuses.filter((s) => s.project_id === p.project_id).length,
    decided: statuses.filter((s) => s.project_id === p.project_id && ["merged", "edited", "removed", "not-merged"].includes(s.status)).length,
    episodes: episodes.filter((f) => path.basename(path.dirname(f)) === p.project_id).length,
  }));
  return {
    projects: projects.length,
    lessons: statuses.length,
    byStatus,
    decided,
    mergeRate: decided ? Math.round((accepted / decided) * 1000) / 1000 : null,
    editRate: accepted ? Math.round(((byStatus.edited ?? 0) / accepted) * 1000) / 1000 : null,
    episodes: episodes.length,
    reuseEvents: readEvents(store).filter((e) => e.type === "reused").length,
    perProject,
    phase6Ready: projects.length >= PHASE6_GATE.projects && decided >= PHASE6_GATE.decidedLessons && episodes.length >= PHASE6_GATE.episodes,
  };
}

/**
 * Build a dataset for Phase 6: lessons.jsonl (each lesson with its final status, the human edit and
 * the reuse count), episodes.jsonl, and manifest.json. Returns the output folder.
 */
export function exportDataset(store: string, outDir?: string): { dir: string; lessons: number; episodes: number } {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const dir = ensureDir(outDir ?? path.join(store, "exports", stamp));
  const names = new Map(readProjects(store).map((p) => [p.project_id, p.name]));
  const lessonsFile = path.join(dir, "lessons.jsonl");
  const episodesFile = path.join(dir, "episodes.jsonl");
  fs.writeFileSync(lessonsFile, "");
  fs.writeFileSync(episodesFile, "");
  let nL = 0;
  for (const s of lessonStatuses(readEvents(store)).values()) {
    const meta = readLessonMeta(store, s.lesson_id);
    if (!meta) continue;
    const ldir = path.join(store, "lessons", s.lesson_id);
    const mergedFile = path.join(ldir, "merged", "EXPERIENCE.md");
    appendJsonl(lessonsFile, {
      ...meta,
      project_name: names.get(meta.project_id) ?? null,
      status: s.status,
      status_ts: s.status_ts,
      reuse_count: s.reuse_count,
      staged_text: fs.readFileSync(path.join(ldir, "EXPERIENCE.md"), "utf8"),
      merged_text: fs.existsSync(mergedFile) ? fs.readFileSync(mergedFile, "utf8") : null,
      h_patch: fs.readFileSync(path.join(ldir, "H.patch"), "utf8"),
    });
    nL++;
  }
  const eps = listEpisodes(store);
  for (const f of eps) appendJsonl(episodesFile, readJson(f, {}));
  writeJson(path.join(dir, "manifest.json"), {
    schema: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    store_commit: gitOk(["rev-parse", "HEAD"], store) ? git(["rev-parse", "HEAD"], store).trim() : null,
    lessons: nL,
    episodes: eps.length,
    projects: readProjects(store).length,
    note: "No scores. To join eval scores, match episodes.episode_id with run IDs in the eval store (Phase 6 only, after the weekly library review).",
  });
  return { dir, lessons: nL, episodes: eps.length };
}
