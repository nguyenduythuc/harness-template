// Find the CI host of a project: "gitlab" or "github". No dependencies.
// The scaffold and the doctor use the answer to put the CI guard (layer 5) in the correct folder.

import fs from "node:fs";
import path from "node:path";

/** The folder of the CI guard copies for each host. */
export const CI_GUARD_DIR = { github: ".github/harness", gitlab: ".gitlab/harness" };

/** The URL of the remote "origin" from .git/config, or "". A worktree has a .git file, so the answer is "" there. */
export function originUrl(projectDir) {
  try {
    const text = fs.readFileSync(path.join(projectDir, ".git", "config"), "utf8");
    const m = text.match(/\[remote "origin"\][^[]*?\n\s*url\s*=\s*(\S+)/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/**
 * Order of the checks: files of the project first, then the remote. The default is "github".
 * @returns {"github" | "gitlab"}
 */
export function ciHost(projectDir) {
  const has = (rel) => fs.existsSync(path.join(projectDir, rel));
  if (has(".gitlab/harness") || has(".gitlab-ci.yml")) return "gitlab";
  if (has(".github/harness") || has(".github/workflows")) return "github";
  return /gitlab/i.test(originUrl(projectDir)) ? "gitlab" : "github";
}
