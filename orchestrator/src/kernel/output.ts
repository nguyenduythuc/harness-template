// Production output: a local branch with the deliverable only, plus the filtered run summary.
// The orchestrator does not push and does not open the PR by itself: it prints the commands, and the
// human runs them (agents have no GH_TOKEN; the human settles each PR one time).

import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./ctx.js";
import type { TaskResult } from "./run.js";
import { reportSummary } from "./runs.js";
import { git } from "../util/exec.js";
import { writeJson } from "../util/fs.js";
import { applyDiff } from "./workspace.js";

export interface DeliverableBranch {
  branch: string;
  commit: string;
  pushCommand: string;
  prCommand: string;
}

export function deliverableBranch(ctx: Ctx, res: TaskResult, title: string): DeliverableBranch | null {
  if (res.record.outcome === "none" || !res.diff.trim()) return null;
  const runId = res.record.run_id;
  const branch = `harness/run-${runId}`;
  const dir = path.join(ctx.user.work_root, runId, "pr");
  git(["worktree", "add", "-q", "-b", branch, dir, ctx.h0Sha], ctx.pp.projectDir);
  try {
    applyDiff(dir, res.diff);
    writeJson(path.join(dir, "harness", "reports", "runs", `${runId}.json`), reportSummary(res.record));
    git(["add", "-A"], dir);
    // -f: a project .gitignore must not drop the run summary from the PR without a sign.
    git(["add", "-f", path.join("harness", "reports", "runs", `${runId}.json`)], dir);
    const msg = `${title}\n\nDeliverable of harness run ${runId} (outcome: ${res.record.outcome}).\nThe PR holds the deliverable and the run summary only. H′ stays in the run record.`;
    git(["-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", msg], dir);
    const commit = git(["rev-parse", "HEAD"], dir).trim();
    return {
      branch,
      commit,
      pushCommand: `git push -u origin ${branch}`,
      prCommand: `gh pr create --head ${branch} --title ${JSON.stringify(title)} --body "Deliverable of a harness run. Settle it one time."`,
    };
  } finally {
    git(["worktree", "remove", "--force", dir], ctx.pp.projectDir);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
