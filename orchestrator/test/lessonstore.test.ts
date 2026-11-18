// Tests of the lesson store (D10): redaction, IDs, the lesson life cycle across the staging branch,
// the weekly library branch and main, episodes, the holdout rule, the project switch, and the export.

import { test } from "node:test";
import { withEpisodes } from "../src/extras/episode.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadCtx } from "../src/kernel/ctx.js";
import { evalRound } from "../src/loop/round.js";
import { libraryPrBranch, reflect } from "../src/extras/library.js";
import {
  cleanRemote,
  exportDataset,
  lessonId,
  lessonStatuses,
  listEpisodes,
  listLessons,
  projectIdentity,
  readEvents,
  redact,
  storeStats,
  syncProject,
  templateStats,
} from "../src/extras/lessonstore.js";
import type { StoreEvent } from "../src/extras/lessonstore.js";
import { runTask } from "../src/loop/pipeline.js";
import { fakeQuery, fixture, sh } from "./helpers.js";

// --- unit ------------------------------------------------------------------------------------

test("redact removes secrets and counts them", () => {
  const r = redact(
    [
      "key sk-ant-api03-abcdefghijklmnop",
      "gh token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "aws AKIAABCDEFGHIJKLMNOP",
      "password: hunter2hunter2",
      'API_KEY="abcdef123456"',
      "url https://bob:s3cret@git.example.com/x.git",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "plain text with no secret",
    ].join("\n"),
  );
  assert.equal(r.count, 7);
  for (const secret of ["sk-ant-api03", "ghp_abc", "AKIAABCD", "hunter2", "abcdef123456", "s3cret", "BEGIN RSA"]) assert.ok(!r.text.includes(secret), secret);
  assert.match(r.text, /plain text with no secret/);
  assert.match(r.text, /https:\/\/\[REDACTED:url-credentials\]@git\.example\.com/);
});

test("remote URLs lose their credentials; IDs are stable", () => {
  assert.equal(cleanRemote("https://user:token@github.com/a/b.git\n"), "https://github.com/a/b");
  assert.equal(cleanRemote("git@github.com:a/b.git"), "git@github.com:a/b");
  const a = lessonId("P1", "testing/x", "2026-10-23T00:00:00.000Z", "Run tests.");
  assert.equal(a, lessonId("P1", "testing/x", "2026-10-23T00:00:00.000Z", "Run tests."));
  assert.notEqual(a, lessonId("P2", "testing/x", "2026-10-23T00:00:00.000Z", "Run tests."));
  assert.match(a, /^L[0-9a-f]{12}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-id-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const noRemote = projectIdentity(dir);
  execFileSync("git", ["remote", "add", "origin", "https://u:p@github.com/x/y.git"], { cwd: dir });
  const withRemote = projectIdentity(dir);
  assert.notEqual(noRemote.project_id, withRemote.project_id);
  assert.equal(withRemote.remote, "https://github.com/x/y");
});

test("status is the last status event; reuse counts apart; unknown reuse is ignored", () => {
  const ev = (type: StoreEvent["type"], lesson_id: string, ts: string): StoreEvent => ({ ts, type, project_id: "P", lesson_id });
  const s = lessonStatuses([
    ev("staged", "L1", "2026-01-01"),
    ev("proposed", "L1", "2026-01-02"),
    ev("reused", "L1", "2026-01-03"),
    ev("merged", "L1", "2026-01-04"),
    ev("reused", "L1", "2026-01-05"),
    ev("reused", "L9", "2026-01-05"),
  ]);
  assert.equal(s.get("L1")?.status, "merged");
  assert.equal(s.get("L1")?.reuse_count, 2);
  assert.equal(s.get("L1")?.proposed_ts, "2026-01-02");
  assert.equal(s.has("L9"), false);
});

// --- integration -----------------------------------------------------------------------------

/** Merge a branch into main of the project, with a commit date one minute in the future. */
function mergeLater(project: string, branch: string): void {
  const later = new Date(Date.now() + 60_000).toISOString();
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", `merge ${branch}`, branch], { cwd: project, env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } });
}

function commitLater(project: string, message: string, minutes: number): void {
  const later = new Date(Date.now() + minutes * 60_000).toISOString();
  execFileSync("git", ["commit", "-q", "-am", message], { cwd: project, env: { ...process.env, GIT_COMMITTER_DATE: later, GIT_AUTHOR_DATE: later } });
}

test("lesson life cycle: staged, proposed, edited by a human, reused, not merged, and the export", async () => {
  const f = await fixture(3);
  const ctx = loadCtx(f.project);
  assert.equal(ctx.lessonStore?.path, f.lessons);
  const q = fakeQuery();
  const task = { id: "add-feature", taskMd: "Add a feature SECRET-TASK-TEXT.", taskType: "feature", mode: "production" as const, split: null, baseSha: null, force: "improve" as const };

  // 1. A production run writes one episode, without task text or deliverable code.
  const run1 = await runTask(ctx, task, withEpisodes({ queryFn: q }));
  const eps = listEpisodes(f.lessons);
  assert.equal(eps.length, 1);
  const ep = fs.readFileSync(eps[0] as string, "utf8");
  assert.ok(!ep.includes("SECRET-TASK-TEXT"), "no task text in an episode");
  assert.ok(!ep.includes("export const feature"), "no deliverable code in an episode");
  const epj = JSON.parse(ep) as { candidates: { role: string; h_patch: string }[]; composer: { ran: boolean } };
  assert.deepEqual(epj.candidates.map((c) => c.role), ["invariant-editor", "domain-editor"]);
  assert.match(epj.candidates[0]?.h_patch ?? "", /Run the test command after each edit/);
  assert.equal(epj.composer.ran, true);

  // 2. Reflect stages a lesson with an ID in the project and a copy in the store.
  const r1 = await reflect(ctx, run1.record.run_id, null, q);
  assert.ok(r1.lessonId);
  const id1 = r1.lessonId as string;
  assert.ok(fs.existsSync(path.join(f.lessons, "lessons", id1, "meta.json")));
  assert.match(sh(f.project, "show", `harness/library-staging:harness/library/testing/run-tests-after-edits/EXPERIENCE.md`), new RegExp(`^id: ${id1}$`, "m"));
  assert.equal(lessonStatuses(readEvents(f.lessons)).get(id1)?.status, "staged");
  const withReflection = JSON.parse(fs.readFileSync(eps[0] as string, "utf8")) as { reflection?: { edits: string; lesson_id: string } };
  assert.equal(withReflection.reflection?.lesson_id, id1);
  assert.match(withReflection.reflection?.edits ?? "", /helped/);

  // 3. The weekly branch proposes it. The human edits the lesson and merges the PR.
  const pr1 = libraryPrBranch(ctx, "main");
  assert.ok(pr1);
  assert.equal(lessonStatuses(readEvents(f.lessons)).get(id1)?.status, "proposed");
  mergeLater(f.project, pr1.branch);
  const lessonFile = path.join(f.project, "harness", "library", "testing", "run-tests-after-edits", "EXPERIENCE.md");
  fs.writeFileSync(lessonFile, fs.readFileSync(lessonFile, "utf8").replace("Run the test command after each edit.", "Run `npm test` after each edit, before you reply."));
  commitLater(f.project, "library: make the lesson exact", 2);
  const s1 = syncProject(f.lessons, f.project, "main");
  assert.deepEqual(s1.edited, [id1]);
  assert.match(fs.readFileSync(path.join(f.lessons, "lessons", id1, "merged", "EXPERIENCE.md"), "utf8"), /npm test/);
  assert.deepEqual(syncProject(f.lessons, f.project, "main").edited, [], "a second sync records nothing new");

  // 4. A later run reuses the merged lesson; the store counts the reuse by lesson ID.
  const run2 = await runTask(ctx, task, withEpisodes({ queryFn: q }));
  assert.deepEqual(run2.record.reuse_entries, [id1]);
  assert.equal(lessonStatuses(readEvents(f.lessons)).get(id1)?.reuse_count, 1);

  // 5. A second lesson is proposed, the human does not merge it, and main changes the library later.
  const r2 = await reflect(ctx, run2.record.run_id, null, q);
  const id2 = r2.lessonId as string;
  const pr2 = libraryPrBranch(ctx, "main");
  assert.ok(pr2);
  assert.notEqual(pr2.branch, pr1.branch);
  fs.appendFileSync(lessonFile, "\nOne more line from the human.\n");
  commitLater(f.project, "library: one more line", 5);
  const s2 = syncProject(f.lessons, f.project, "main");
  assert.deepEqual(s2.notMerged, [id2]);
  // The rejected lesson does not come back, and the edit of the human stays.
  assert.equal(libraryPrBranch(ctx, "main"), null);

  // 6. Stats and export. No score anywhere in the store.
  const st = storeStats(f.lessons);
  assert.equal(st.projects, 1);
  assert.equal(st.decided, 2);
  assert.equal(st.byStatus.edited, 1);
  assert.equal(st.byStatus["not-merged"], 1);
  assert.equal(st.mergeRate, 0.5);
  assert.equal(st.editRate, 1);
  assert.equal(listLessons(f.lessons, { status: "edited" }).length, 1);
  const tpl = templateStats(f.lessons);
  assert.equal(tpl.length, 1, "one template version in this test");
  assert.equal(tpl[0]?.episodes, 2);
  assert.equal(tpl[0]?.composedGatePassRate, 1);
  assert.equal(tpl[0]?.budgetStopRate, 0);
  assert.equal(tpl[0]?.mergeRate, 0.5);
  assert.ok((tpl[0]?.meanTokens ?? 0) > 0);
  const ex = exportDataset(f.lessons, path.join(f.root, "export"));
  assert.equal(ex.lessons, 2);
  assert.equal(ex.episodes, 2);
  const rows = fs.readFileSync(path.join(ex.dir, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { lesson_id: string; status: string; merged_text: string | null; reuse_count: number });
  const edited = rows.find((r) => r.lesson_id === id1);
  assert.equal(edited?.status, "edited");
  assert.match(edited?.merged_text ?? "", /npm test/);
  assert.equal(edited?.reuse_count, 1);
  const all = fs.readdirSync(f.lessons, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !e.parentPath.includes(`${path.sep}.git`));
  for (const e of all) assert.doesNotMatch(fs.readFileSync(path.join(e.parentPath, e.name), "utf8"), /"s_rub"|"score":|SECRET-TASK-TEXT/, e.name);
});

test("holdout runs never write to the store; dev eval runs do", async () => {
  const f = await fixture(3);
  const ctx = loadCtx(f.project, { requireEvalStore: true });
  await evalRound(ctx, { split: "dev", decision: "dev smoke", m: 1 }, withEpisodes({ queryFn: fakeQuery() }));
  const afterDev = listEpisodes(f.lessons).length;
  assert.equal(afterDev, 2, "one episode for each dev task of the pipeline arm");
  await evalRound(ctx, { split: "holdout", decision: "holdout smoke", m: 1, allowHost: true }, withEpisodes({ queryFn: fakeQuery() }));
  assert.equal(listEpisodes(f.lessons).length, afterDev);
  const holdoutEvents = readEvents(f.lessons).filter((e) => e.run_id && String(e.run_id).includes("t3"));
  assert.deepEqual(holdoutEvents, []);
});

test("lesson_store: off in the project keeps every lesson and episode out of the store", async () => {
  const f = await fixture(3, { lessonStore: "off" });
  const ctx = loadCtx(f.project);
  assert.equal(ctx.lessonStore, null);
  const q = fakeQuery();
  const run = await runTask(ctx, { id: "x", taskMd: "Do x.", taskType: null, mode: "production", split: null, baseSha: null, force: "improve" }, withEpisodes({ queryFn: q }));
  const r = await reflect(ctx, run.record.run_id, null, q);
  assert.ok(r.lessonId, "the project library still gets the lesson");
  assert.equal(fs.existsSync(path.join(f.lessons, "events.jsonl")), false);
  assert.equal(listEpisodes(f.lessons).length, 0);
});

test("a secret in a lesson never reaches git or the store", async () => {
  const f = await fixture(3);
  const ctx = loadCtx(f.project);
  const q = fakeQuery({ lesson: "Log in with password: hunter2hunter2 and the key sk-ant-api03-abcdefghijklmnop." });
  const run = await runTask(ctx, { id: "x", taskMd: "Do x.", taskType: null, mode: "production", split: null, baseSha: null, force: "improve" }, withEpisodes({ queryFn: q }));
  const r = await reflect(ctx, run.record.run_id, null, q);
  const inGit = sh(f.project, "show", `harness/library-staging:harness/library/testing/run-tests-after-edits/EXPERIENCE.md`);
  assert.doesNotMatch(inGit, /hunter2|sk-ant-api03/);
  assert.match(inGit, /\[REDACTED:value\]/);
  const inStore = fs.readFileSync(path.join(f.lessons, "lessons", r.lessonId as string, "meta.json"), "utf8");
  assert.doesNotMatch(inStore, /hunter2|sk-ant-api03/);
});

test("agent sessions cannot read the lesson store", async () => {
  const f = await fixture(3);
  const ctx = loadCtx(f.project);
  const seen: string[][] = [];
  const q = fakeQuery();
  const spy: typeof q = Object.assign(
    async function* (args: Parameters<typeof q>[0]) {
      const policy = JSON.parse(fs.readFileSync((args.options.env as Record<string, string>).HARNESS_POLICY as string, "utf8")) as { readDeny: string[] };
      seen.push(policy.readDeny);
      yield* q(args);
    },
    { calls: q.calls, prompts: q.prompts },
  );
  await runTask(ctx, { id: "x", taskMd: "Do x.", taskType: null, mode: "production", split: null, baseSha: null, force: null }, withEpisodes({ queryFn: spy }));
  assert.ok(seen.length > 0);
  for (const deny of seen) assert.ok(deny.includes(f.lessons), "lesson store in readDeny");
});
