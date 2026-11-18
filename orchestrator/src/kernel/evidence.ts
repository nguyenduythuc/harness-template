// `harness evidence`: numbers from the git history of a project, without an agent session.
// Use them to decide which skills and rules a project needs. A folder that many commits change
// is a candidate for a skill. A type of fix that comes again is a candidate for a rule or a hook.

import fs from "node:fs";
import path from "node:path";
import { git } from "../util/exec.js";

export interface Evidence {
  since: string;
  commits: number;
  merges: number;
  authors: number;
  activeAuthors: number;
  reverts: number;
  checkFixes: number;
  hotDirs: { dir: string; changes: number }[];
  testFiles: number;
  ciFiles: string[];
}

const CI_FILES = [".gitlab-ci.yml", ".github/workflows", "Jenkinsfile", "azure-pipelines.yml", ".circleci"];
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** @param depth number of path segments of a hot folder, for example 3 gives src/components/OrderForm */
export function evidence(projectDir: string, since = "6 months ago", depth = 3, top = 15): Evidence {
  const log = (args: string[]): string[] => git(["log", `--since=${since}`, ...args], projectDir).split("\n").filter(Boolean);
  const subjects = log(["--no-merges", "--format=%s"]);
  const authorCount = new Map<string, number>();
  for (const a of log(["--no-merges", "--format=%ae"])) authorCount.set(a, (authorCount.get(a) ?? 0) + 1);
  const dirs = new Map<string, number>();
  for (const f of log(["--no-merges", "--name-only", "--format="])) {
    const segs = f.split("/");
    if (segs.length <= 1) continue;
    const dir = segs.slice(0, Math.min(depth, segs.length - 1)).join("/");
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const tracked = git(["ls-files"], projectDir).split("\n");
  return {
    since,
    commits: subjects.length,
    merges: log(["--merges", "--format=%h"]).length,
    authors: authorCount.size,
    activeAuthors: [...authorCount.values()].filter((n) => n >= 10).length,
    reverts: subjects.filter((s) => /\brevert/i.test(s)).length,
    checkFixes: subjects.filter((s) => /\b(build|lint|type ?check|tsc|eslint)\b/i.test(s)).length,
    hotDirs: [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([dir, changes]) => ({ dir, changes })),
    testFiles: tracked.filter((f) => TEST_FILE.test(f)).length,
    ciFiles: CI_FILES.filter((f) => fs.existsSync(path.join(projectDir, f))),
  };
}

export function evidenceText(e: Evidence): string {
  const lines = [
    `Git history since "${e.since}"`,
    `  commits (no merges)        ${e.commits}`,
    `  merges                     ${e.merges}`,
    `  authors                    ${e.authors}  (${e.activeAuthors} with 10 or more commits)`,
    `  revert commits             ${e.reverts}`,
    `  commits that name a check  ${e.checkFixes}  (build, lint, typecheck in the subject)`,
    `  test files                 ${e.testFiles}`,
    `  CI files                   ${e.ciFiles.length ? e.ciFiles.join(", ") : "none"}`,
    "",
    "Folders with the most file changes (a candidate for a skill needs a clear type of work):",
    ...e.hotDirs.map((d) => `  ${String(d.changes).padStart(6)}  ${d.dir}`),
    "",
    "How to use the numbers: see packs/README.md in the template, section \"Write a skill from evidence\".",
  ];
  return lines.join("\n") + "\n";
}
