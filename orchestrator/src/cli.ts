#!/usr/bin/env node
// The harness CLI. A human runs it. Agents never run it: they have no GH_TOKEN, and the guard denies gh.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { evalInit, evalSplit, proposeFreezeH0, proposeUpgrade } from "./kernel/admin.js";
import { ConfigError, loadProjectConfig, loadUserConfig, requirePhase } from "./kernel/config.js";
import type { Ctx } from "./kernel/ctx.js";
import { loadCtx } from "./kernel/ctx.js";
import { withEpisodes } from "./extras/episode.js";
import { doctor, doctorText } from "./kernel/doctor.js";
import { evidence, evidenceText } from "./kernel/evidence.js";
import { gateCheck, gateCheckText } from "./kernel/gatecheck.js";
import { installPack, listPacks, packText } from "./kernel/pack.js";
import { measure } from "./kernel/measure.js";
import { evalRound, roundOutcomeLine } from "./loop/round.js";
import { evalCheck, evalCheckText, latestEvalCheck } from "./kernel/evalcheck.js";
import { readHFromGit } from "./kernel/htree.js";
import { libraryPrBranch, reflect } from "./extras/library.js";
import { deliverableBranch } from "./kernel/output.js";
import { runTask } from "./loop/pipeline.js";
import { projectReport, reportText } from "./kernel/report.js";
import { mde80, passProbability } from "./kernel/stats.js";
import { refreshDashboard, writeBenchmarks } from "./extras/bench.js";
import { loadWeights } from "./kernel/evalstore.js";
import { calibrationTemplate, CALIBRATION_GATE, checkCalibration } from "./kernel/calibrate.js";
import { commitStore, exportDataset, initLessonStore, listLessons, mainRef, PHASE6_GATE, resolveLessonStore, storeStats, syncProject, templateStats } from "./extras/lessonstore.js";

const USAGE = `harness <command> [options]        (global: --project <dir>, default: the current folder)

Set up a project (no agent session, 0 tokens)
  init [--dry-run]                     scaffold the harness files into the project (create-only)
  pack list                            list the tool packs of the template (packs/)
  pack install <name> [--dry-run]      copy a tool pack into the project (hooks, agents, MCP, CI gate)
  gate-check [--keep-work]             workspace_setup and the gate in a new worktree at HEAD
  evidence [--since "6 months ago"] [--depth 3]
                                       numbers from the git history, to choose skills and rules
Phase 0
  eval-init <dir>                      make an eval store skeleton (outside every project)
  eval-split                           put new eval tasks into dev or holdout (stratified, final)
  eval-check [--only a,b] [--keep-work]
                                       gate and hidden tests at base and on tasks/<id>/solution/,
                                       without agent sessions; run it before measure
  measure [--m N] [--only a,b]         frozen H0 runs on dev: sigma_run and the MDE80 table
  mde --n N --sd S [--delta-min D] [--gain G]
                                       MDE80 (and the pass probability at gain G) by simulation
  calibrate template [--runs N] [--pairs N]
                                       write label files for judge calibration (eval store)
  calibrate check --dir <dir>          compare the human labels with the judge (kappa, pair order)
  bench                                write the benchmark page <eval_store>/benchmarks.html
Every phase
  run --task <file> [--type T] [--force improve|no-improve] [--title T]
                                       one production task; prints the push and PR commands
  doctor [--live]                      check the guard layers (--live opens real sessions)
  report [--last N] [--mode production|eval]
                                       run summary without scores
  upgrade [--claude-code-min X]        propose a new lock (new epoch)
Phase 1+
  freeze-h0                            propose h0_sha = HEAD in the lock
Phase 2+
  eval --split dev|holdout --decision "<text>" [--m N] [--no-library-arm]
       [--h0-prime <git-ref>] [--allow-host] [--only a,b]
                                       one eval round; prints the outcome and the report path
Phase 3+
  reflect <run-id> [--review <file>]   reflect on a production run after your review
  library-pr [--main <ref>]            build the weekly library branch
Lesson store of this machine (every project, D10)
  lessons sync [--main <ref>]          record what the human merged, edited or did not merge
  lessons list [--status S] [--of P]   list the lessons of every project (no scores)
  lessons stats                        counts, merge rate, edit rate, the Phase 6 data gate
  lessons export [--out <dir>]         build lessons.jsonl and episodes.jsonl for Phase 6
`;

function syncQuietly(ctx: Ctx, ref?: string): void {
  if (!ctx.lessonStore) return;
  try {
    syncProject(ctx.lessonStore.path, ctx.pp.projectDir, ref);
  } catch (err) {
    process.stderr.write(`note: the lesson store sync failed: ${String(err)}\n`);
  }
}

function list(v: string | undefined): string[] | undefined {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`--${name} must be a number`);
  return n;
}

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
      m: { type: "string" },
      only: { type: "string" },
      "keep-work": { type: "boolean" },
      n: { type: "string" },
      sd: { type: "string" },
      "delta-min": { type: "string" },
      gain: { type: "string" },
      task: { type: "string" },
      type: { type: "string" },
      force: { type: "string" },
      title: { type: "string" },
      live: { type: "boolean" },
      last: { type: "string" },
      mode: { type: "string" },
      "claude-code-min": { type: "string" },
      split: { type: "string" },
      decision: { type: "string" },
      "no-library-arm": { type: "boolean" },
      "h0-prime": { type: "string" },
      "allow-host": { type: "boolean" },
      review: { type: "string" },
      main: { type: "string" },
      status: { type: "string" },
      of: { type: "string" },
      out: { type: "string" },
      runs: { type: "string" },
      pairs: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean" },
      since: { type: "string" },
      depth: { type: "string" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || o.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const project = path.resolve(o.project ?? process.cwd());
  const say = (s: string): void => void process.stdout.write(s + "\n");

  switch (cmd) {
    case "init": {
      const user = loadUserConfig();
      const script = path.join(user.template_dir, "plugins", "harness", "scripts", "scaffold.mjs");
      const r = spawnSync(process.execPath, [script, project, ...(o["dry-run"] ? ["--dry-run"] : [])], { stdio: "inherit" });
      if (r.status === 0) say("Next: set the gate in harness/pinned-config.yaml, then run `harness pack list`, `harness doctor` and `harness gate-check`.");
      return r.status ?? 1;
    }
    case "pack": {
      const user = loadUserConfig();
      if (rest[0] === "list" || !rest[0]) {
        const packs = listPacks(user.template_dir);
        say(packs.length ? packs.map((m) => `${m.name.padEnd(12)} ${m.description}`).join("\n") : `No packs in ${path.join(user.template_dir, "packs")}.`);
        return 0;
      }
      if (rest[0] !== "install" || !rest[1]) throw new ConfigError("usage: harness pack list | harness pack install <name> [--dry-run]");
      const packDir = path.join(user.template_dir, "packs", rest[1]);
      if (!fs.existsSync(path.join(packDir, "pack.json"))) throw new ConfigError(`No pack "${rest[1]}" in ${path.join(user.template_dir, "packs")}. Run \`harness pack list\`.`);
      process.stdout.write(packText(installPack(packDir, project, { dryRun: Boolean(o["dry-run"]) })));
      return 0;
    }
    case "gate-check": {
      const user = loadUserConfig();
      const r = await gateCheck(project, loadProjectConfig(project), user.work_root, Boolean(o["keep-work"]));
      process.stdout.write(gateCheckText(r));
      return r.gate?.pass ? 0 : 1;
    }
    case "evidence": {
      process.stdout.write(evidenceText(evidence(project, o.since ?? "6 months ago", num(o.depth, "depth") ?? 3)));
      return 0;
    }
    case "eval-init": {
      const dir = rest[0];
      if (!dir) throw new ConfigError("eval-init needs a folder");
      const r = evalInit(dir);
      say(`Eval store at ${path.resolve(dir)}${r.git ? " (new git repo)" : ""}. Created: ${r.created.join(", ") || "nothing (all files exist)"}.`);
      say(`Add this line to your user config (${process.env.HARNESS_CONFIG ?? "~/.config/harness/config.yaml"}):\n  eval_store: ${path.resolve(dir)}`);
      say("Write weights.yaml and the thresholds BEFORE the first measurement, and commit them.");
      return 0;
    }
    case "eval-split": {
      const ctx = loadCtx(project, { requireEvalStore: true });
      const r = evalSplit(ctx.user.eval_store as string);
      say(`Split: ${r.split.dev.length} dev, ${r.split.holdout.length} holdout. New tasks: ${r.added.join(", ") || "none"}.`);
      return 0;
    }
    case "eval-check": {
      const ctx = loadCtx(project, { requireEvalStore: true });
      const only = list(o.only);
      const r = await evalCheck(ctx, { ...(only ? { only } : {}), keepWork: Boolean(o["keep-work"]) });
      say(evalCheckText(r.report));
      say(`Report: ${r.reportPath}`);
      return r.report.ok ? 0 : 2;
    }
    case "measure": {
      const ctx = loadCtx(project, { requireEvalStore: true });
      const last = latestEvalCheck(ctx.user.eval_store as string);
      if (!last) say("WARNING: no eval-check report. Run `harness eval-check` first: it finds a wrong gate or hidden test command without tokens.");
      else if (!last.report.ok) say(`WARNING: the last eval-check has a FAIL (${last.file}). Fix it first, or sigma_run measures a wrong ruler.`);
      const m = num(o.m, "m");
      const only = list(o.only);
      const r = await measure(ctx, { ...(m !== undefined ? { m } : {}), ...(only ? { only } : {}), keepWork: Boolean(o["keep-work"]) });
      r.dashboardPath = refreshDashboard(ctx);
      say(`sigma_run = ${r.sigmaRun} (${r.scoredRuns} scored runs, ${r.unscoredRuns} unscored).`);
      say(`Phase 0 gate: MDE80 = ${r.gate.mde80} at n = ${r.gate.n}, sigma_int = 5; target ${r.gate.deltaTarget}: ${r.gate.pass ? "PASS" : "FAIL"}.`);
      if (r.warnings.length) say(`WARNING: ${r.warnings.length} warning(s) about the measurement itself. Read them in the report before you trust sigma_run.`);
      say(`Report: ${r.reportPath}`);
      if (r.dashboardPath) say(`Dashboard: ${r.dashboardPath}`);
      return r.gate.pass ? 0 : 2;
    }
    case "mde": {
      const n = num(o.n, "n");
      const sd = num(o.sd, "sd");
      if (n === undefined || sd === undefined) throw new ConfigError("mde needs --n and --sd");
      const dm = num(o["delta-min"], "delta-min") ?? 3;
      say(`MDE80(n=${n}, SD of d_t=${sd}, delta_min=${dm}) = ${Math.round(mde80(n, sd, dm) * 10) / 10}`);
      const g = num(o.gain, "gain");
      if (g !== undefined) say(`P(pass | gain ${g}) = ${Math.round(passProbability(n, sd, dm, g) * 100) / 100}`);
      return 0;
    }
    case "run": {
      if (!o.task) throw new ConfigError("run needs --task <file>");
      if (o.force && o.force !== "improve" && o.force !== "no-improve") throw new ConfigError("--force is improve or no-improve");
      const ctx = loadCtx(project);
      syncQuietly(ctx);
      const taskMd = fs.readFileSync(path.resolve(o.task), "utf8");
      const id = path.basename(o.task).replace(/\.[^.]+$/, "");
      const res = await runTask(ctx, { id, taskMd, taskType: o.type ?? null, mode: "production", split: null, baseSha: null, force: (o.force as "improve" | "no-improve" | undefined) ?? null }, withEpisodes({}));
      for (const n of res.record.notes) say(`note: ${n}`);
      say(`Run ${res.record.run_id}: outcome ${res.record.outcome}${res.record.budget_stop ? " (budget stop)" : ""}. Record: ${path.join(ctx.pp.runsDir, res.record.run_id)}`);
      const br = deliverableBranch(ctx, res, o.title ?? `harness: ${id}`);
      if (!br) {
        say("No deliverable passed the gate, so there is no branch.");
        return 2;
      }
      say(`Branch ${br.branch} (${br.commit.slice(0, 12)}). Review it, then run:\n  ${br.pushCommand}\n  ${br.prCommand}`);
      say(`After your review, run: harness reflect ${res.record.run_id} --review <file with your review>`);
      return 0;
    }
    case "reflect": {
      const runId = rest[0];
      if (!runId) throw new ConfigError("reflect needs a run ID");
      const ctx = loadCtx(project);
      requirePhase(ctx.config, 3, "Reflect");
      const review = o.review ? fs.readFileSync(path.resolve(o.review), "utf8") : null;
      syncQuietly(ctx);
      const r = await reflect(ctx, runId, review);
      say(r.experience ? `Lesson ${r.lessonId} staged: ${r.stagedPath} on the branch harness/library-staging.` : "The reflector found no lesson (NO_ENTRY).");
      if (r.experience) say(ctx.lessonStore ? `The lesson store has a copy: ${ctx.lessonStore.path}` : "The lesson store is off for this project, so it has no copy.");
      return 0;
    }
    case "library-pr": {
      const ctx = loadCtx(project);
      requirePhase(ctx.config, 3, "The library PR");
      const r = libraryPrBranch(ctx, mainRef(ctx.pp.projectDir, o.main));
      if (!r) {
        say("The staging branch has no new lessons.");
        return 0;
      }
      if (r.skipped.length) say(`Not in this PR, because you did not merge them before: ${r.skipped.join(", ")}`);
      const bodyFile = path.join(ctx.user.work_root, `${r.branch.replace(/\//g, "-")}.md`);
      fs.writeFileSync(bodyFile, r.body + "\n");
      say(`Branch ${r.branch}. Review each lesson BEFORE you open this week's eval reports. Then run:\n  git push -u origin ${r.branch}\n  gh pr create --head ${r.branch} --label library --title "library: lessons of this week" --body-file ${bodyFile}`);
      return 0;
    }
    case "eval": {
      if (o.split !== "dev" && o.split !== "holdout") throw new ConfigError("eval needs --split dev or --split holdout");
      if (!o.decision) throw new ConfigError('eval needs --decision "<what this round decides>"');
      const ctx = loadCtx(project, { requireEvalStore: true });
      const m = num(o.m, "m");
      const only = list(o.only);
      const r = await evalRound(ctx, {
        split: o.split,
        decision: o.decision,
        ...(m !== undefined ? { m } : {}),
        ...(only ? { only } : {}),
        noLibraryArm: Boolean(o["no-library-arm"]),
        ...(o["h0-prime"] ? { h0Prime: readHFromGit(ctx.pp.projectDir, o["h0-prime"]) } : {}),
        allowHost: Boolean(o["allow-host"]),
        keepWork: Boolean(o["keep-work"]),
      }, { ...withEpisodes({}), reflect: async (c, runId) => void (await reflect(c, runId, null)) });
      r.dashboardPath = refreshDashboard(ctx);
      for (const n of r.notes) say(`note: ${n}`);
      say(roundOutcomeLine(r));
      if (r.dashboardPath) say(`Dashboard: ${r.dashboardPath}`);
      return 0;
    }
    case "doctor": {
      const r = await doctor(project, { live: Boolean(o.live) });
      say(doctorText(r));
      return r.ok ? 0 : 2;
    }
    case "report": {
      const ctx = loadCtx(project);
      const last = num(o.last, "last");
      const mode = o.mode === "production" || o.mode === "eval" ? o.mode : undefined;
      say(reportText(projectReport(ctx.pp.runsDir, { ...(last !== undefined ? { last } : {}), ...(mode ? { mode } : {}) })));
      return 0;
    }
    case "upgrade": {
      const ctx = loadCtx(project, { allowLockMismatch: true });
      const r = proposeUpgrade(ctx, o["claude-code-min"]);
      say(r.changes.length ? `Changes:\n${r.changes.map((c) => "  " + c).join("\n")}` : "The lock matches this checkout.");
      say(`Proposal: ${r.file}. Review it, move it over harness/pinned-harness.lock, and open a PR with the label harness-upgrade. The merge starts a new epoch: measure sigma again.`);
      for (const c of r.copies) say(`Proposal: ${c}. It is the plugin version of a CI guard file.`);
      return 0;
    }
    case "freeze-h0": {
      const ctx = loadCtx(project);
      const r = proposeFreezeH0(ctx);
      say(`Proposal: ${r.file} with h0_sha ${r.sha}. Review it, move it over harness/pinned-harness.lock, and open a PR with the label owner-change. Then run measure again: that is epoch 1.`);
      return 0;
    }
    case "bench": {
      const store = loadUserConfig().eval_store;
      if (!store) throw new ConfigError("bench needs eval_store in the user config.");
      let ctx: Ctx | null = null;
      try {
        ctx = loadCtx(project, { requireEvalStore: true });
      } catch (err) {
        say(`note: no project context (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). The dashboard shows the eval store only.`);
      }
      const r = writeBenchmarks(store, ctx, loadWeights(store).delta_min);
      say(`Benchmarks: ${r.rounds} rounds. Dashboard: ${r.dashboard}`);
      say("The dashboard shows scores. Review the library PR of the week before you open it.");
      return 0;
    }
    case "calibrate": {
      const store = loadUserConfig().eval_store;
      if (!store) throw new ConfigError("calibrate needs eval_store in the user config.");
      if (rest[0] === "template") {
        const runs = num(o.runs, "runs");
        const pairs = num(o.pairs, "pairs");
        const r = calibrationTemplate(store, { ...(runs !== undefined ? { runs } : {}), ...(pairs !== undefined ? { pairs } : {}) });
        say(`Wrote ${r.labels} labels and ${r.pairs} pairs to ${r.dir}. Read its README.md, fill in the answers, then run: harness calibrate check --dir ${r.dir}`);
        if (r.labels < CALIBRATION_GATE.judgments) say(`Note: the gate needs ${CALIBRATION_GATE.judgments} judgments. Run more measurements first, or use --runs with a larger number.`);
        return 0;
      }
      if (rest[0] === "check") {
        if (!o.dir) throw new ConfigError("calibrate check needs --dir <calibration folder>");
        const r = checkCalibration(store, path.resolve(o.dir));
        say(`Judgments: ${r.judgments}, kappa: ${r.kappa ?? "n/a"}. Pairs: ${r.pairsAgree} of ${r.pairsUsed} in the right order (${r.pairsTie} ties dropped).`);
        for (const d of r.disagreements.slice(0, 20)) say(`  differs: run ${d.run_id} criterion ${d.criterion}: judge ${d.judge}, human ${d.human}`);
        for (const p of r.problems) say(`problem: ${p}`);
        say(r.pass ? "Judge calibration: PASS." : "Judge calibration: NOT YET. Scores do not count until it passes.");
        return r.pass ? 0 : 2;
      }
      throw new ConfigError("calibrate needs template or check");
    }
    case "lessons": {
      const sub = rest[0];
      const user = loadUserConfig();
      const store = resolveLessonStore(user);
      if (!store) throw new ConfigError("The lesson store is off (lesson_store: false in the user config).");
      initLessonStore(store.path);
      if (sub === "sync") {
        const ctx = loadCtx(project);
        if (!ctx.lessonStore) throw new ConfigError("This project has lesson_store: off in harness/pinned-config.yaml.");
        const r = syncProject(store.path, project, o.main);
        say(`Synced with ${r.ref}: ${r.merged.length} merged, ${r.edited.length} edited by a human, ${r.notMerged.length} not merged, ${r.removed.length} removed.`);
        if (commitStore(store.path, `sync ${path.basename(project)}`)) say(`Committed the lesson store: ${store.path}`);
        return 0;
      }
      if (sub === "list") {
        const rows = listLessons(store.path, { ...(o.status ? { status: o.status } : {}), ...(o.of ? { project: o.of } : {}) });
        for (const r of rows) say(`${r.lesson_id}  ${r.status.padEnd(10)}  reuse=${String(r.reuse_count).padEnd(3)}  ${r.project}  ${r.key}  ${r.lesson.slice(0, 80)}`);
        say(`${rows.length} lessons. Store: ${store.path}`);
        return 0;
      }
      if (sub === "stats") {
        const st = storeStats(store.path);
        const pct = (x: number | null): string => (x === null ? "n/a" : `${Math.round(x * 1000) / 10}%`);
        say(`Projects: ${st.projects}. Lessons: ${st.lessons} (${Object.entries(st.byStatus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}). Episodes: ${st.episodes}. Reuse events: ${st.reuseEvents}.`);
        say(`Merge rate: ${pct(st.mergeRate)} of decided lessons. Edit rate: ${pct(st.editRate)} of merged lessons.`);
        for (const p of st.perProject) say(`  ${p.project}: ${p.lessons} lessons, ${p.decided} decided, ${p.episodes} episodes`);
        const tpl = templateStats(store.path);
        if (tpl.length) {
          say("By template version (efficiency; lower tokens and budget stops are better, higher merge and gate pass are better):");
          for (const t of tpl) {
            say(
              `  ${t.template}: ${t.episodes} episodes, ${t.meanTokens ?? "n/a"} tokens/episode, budget stops ${pct(t.budgetStopRate)}, KEEP_BASE ${pct(t.keptBaseRate)}, composed gate pass ${pct(t.composedGatePassRate)}, ${t.lessons} lessons, merge ${pct(t.mergeRate)}, edit ${pct(t.editRate)}`,
            );
          }
        }
        say(`Phase 6 data gate (projects >= ${PHASE6_GATE.projects}, decided lessons >= ${PHASE6_GATE.decidedLessons}, episodes >= ${PHASE6_GATE.episodes}): ${st.phase6Ready ? "READY" : "NOT YET"}.`);
        return 0;
      }
      if (sub === "export") {
        const r = exportDataset(store.path, o.out ? path.resolve(o.out) : undefined);
        say(`Dataset: ${r.dir} (${r.lessons} lessons, ${r.episodes} episodes). It holds internal facts of your projects: keep it on this machine.`);
        return 0;
      }
      throw new ConfigError("lessons needs one of: sync, list, stats, export");
    }
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ConfigError) process.stderr.write(`harness: ${err.message}\n`);
    else process.stderr.write(`harness: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
