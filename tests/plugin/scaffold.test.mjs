// Tests of the scaffold: create-only, idempotent, proposals for existing files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quickCheck, scaffold } from "../../plugins/harness/scripts/scaffold.mjs";
import { detectStack } from "../../plugins/harness/scripts/detect-stack.mjs";
import { hashDir } from "../../plugins/harness/scripts/checksum.mjs";
import { optedIn } from "../../plugins/harness/scripts/session-start.mjs";
import { spawnSync } from "node:child_process";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-scaffold-"));
}

test("first run creates the files, second run changes nothing", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", typecheck: "tsc --noEmit", lint: "eslint .", test: "jest" } }));
  fs.writeFileSync(path.join(dir, "yarn.lock"), "");
  const first = scaffold({ projectDir: dir });
  assert.ok(first.created.includes("harness/pinned-config.yaml"));
  assert.ok(first.created.includes("harness/pinned-harness.lock"));
  assert.ok(first.created.includes("CLAUDE.md"));
  assert.ok(first.created.includes(".github/harness/ci-path-guard.mjs"));
  assert.ok(first.created.includes(".github/harness/lib/ownership.mjs"));
  assert.deepEqual(first.todo, []);
  const config = fs.readFileSync(path.join(dir, "harness/pinned-config.yaml"), "utf8");
  assert.match(config, /build: "yarn build"/);
  assert.match(config, /test: "yarn test --no-watchman"/);
  const before = hashDir(dir);
  const second = scaffold({ projectDir: dir });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.proposed, []);
  assert.equal(hashDir(dir), before);
  assert.deepEqual(quickCheck({ projectDir: dir }), []);
});

test("existing CLAUDE.md and settings get proposals, not overwrites", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Mine\n");
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.writeFileSync(path.join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }));
  const r = scaffold({ projectDir: dir });
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "# Mine\n");
  assert.ok(r.proposed.includes("CLAUDE.md.harness-proposed"));
  assert.ok(r.proposed.includes(".claude/settings.json.harness-proposed"));
  const merged = JSON.parse(fs.readFileSync(path.join(dir, ".claude/settings.json.harness-proposed"), "utf8"));
  assert.deepEqual(merged.permissions.allow, ["Bash(npm test)"]);
  assert.ok(merged.enabledPlugins["harness@harness-template"]);
  const again = scaffold({ projectDir: dir });
  assert.deepEqual(again.proposed, []);
});

test("missing scripts stay TODO and the quick check reports them", () => {
  const dir = tmp();
  const r = scaffold({ projectDir: dir });
  assert.deepEqual(r.todo.sort(), ["build", "lint", "test", "typecheck"]);
  assert.ok(quickCheck({ projectDir: dir }).some((p) => /TODO/.test(p)));
});

test("stack detection", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { "type-check": "tsc" }, dependencies: { "react-native": "0.80.0" }, workspaces: ["apps/*"] }));
  const s = detectStack(dir);
  assert.equal(s.gate.typecheck, "npm run type-check");
  assert.equal(s.reactNative, true);
  assert.equal(s.workspaces, true);
});

test("opt-in reads enabledPlugins in .claude/settings.json", () => {
  const dir = tmp();
  assert.equal(optedIn(dir), false);
  scaffold({ projectDir: dir });
  assert.equal(optedIn(dir), true);
});

test("run records are ignored, run summaries are not", () => {
  const dir = tmp();
  spawnSync("git", ["init", "-q"], { cwd: dir });
  scaffold({ projectDir: dir });
  const ignored = (p) => spawnSync("git", ["check-ignore", "-q", p], { cwd: dir }).status === 0;
  assert.equal(ignored("harness/runs/r1/record.json"), true);
  assert.equal(ignored("harness/reports/runs/r1.json"), false);
});

test("a GitLab project gets the guard in .gitlab/harness and no .github folder", async () => {
  const { ciHost } = await import("../../plugins/harness/scripts/lib/ci-host.mjs");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "next build", lint: "eslint ." } }));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), '[remote "origin"]\n\turl = https://gitlab.example.com/team/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  assert.equal(ciHost(dir), "gitlab");
  const r = scaffold({ projectDir: dir });
  assert.equal(r.ci, "gitlab");
  for (const f of [".gitlab/harness/ci-path-guard.mjs", ".gitlab/harness/lib/ownership.mjs", ".gitlab/harness/harness-guard.gitlab-ci.yml"]) assert.ok(r.created.includes(f), f);
  assert.equal(fs.existsSync(path.join(dir, ".github")), false);
  assert.deepEqual(scaffold({ projectDir: dir }).created, []);

  // Files of the project win over the remote. The default is GitHub.
  const gh = tmp();
  assert.equal(ciHost(gh), "github");
  fs.writeFileSync(path.join(gh, ".gitlab-ci.yml"), "stages: [test]\n");
  assert.equal(ciHost(gh), "gitlab");
});

test("the GitLab guard job takes the script from the target branch", () => {
  // Run the script lines of the job in a real repo, with the variables that GitLab sets.
  const dir = tmp();
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, ".gitlab-ci.yml"), "include:\n  - local: .gitlab/harness/harness-guard.gitlab-ci.yml\n");
  scaffold({ projectDir: dir });
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "mr");
  fs.appendFileSync(path.join(dir, "harness/pinned-guardrails.md"), "99. An agent wrote this rule.\n");
  // The merge request also tries to make its own copy of the guard pass everything.
  fs.writeFileSync(path.join(dir, ".gitlab/harness/ci-path-guard.mjs"), "process.exit(0);\n");
  git("commit", "-qam", "bad");
  const head = git("rev-parse", "HEAD");

  const job = fs.readFileSync(path.join(dir, ".gitlab/harness/harness-guard.gitlab-ci.yml"), "utf8");
  const script = job.slice(job.indexOf("  script:\n") + "  script:\n".length);
  const lines = [];
  for (const raw of script.split("\n")) {
    if (raw.startsWith("    - |")) continue;
    if (raw.startsWith("    - ")) lines.push(raw.slice(6));
    else if (raw.startsWith("      ")) lines.push(raw.slice(6));
  }
  const body = lines.filter((l) => !l.startsWith("apk ")).join("\n");
  const run = (labels) => spawnSync("sh", ["-c", body], { cwd: dir, encoding: "utf8", env: { ...process.env, CI_MERGE_REQUEST_DIFF_BASE_SHA: base, CI_COMMIT_SHA: head, CI_MERGE_REQUEST_LABELS: labels, GITLAB_USER_LOGIN: "dev" } });
  const bad = run("");
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /violation: .*pinned-guardrails\.md/);
  const ok = run("owner-change");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("AGENTS.md: the root CLAUDE.md imports it, and each nested AGENTS.md gets a CLAUDE.md that imports it", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\n");
  fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(dir, "apps", "web", "AGENTS.md"), "# Web rules\n");
  fs.mkdirSync(path.join(dir, "apps", "docs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "apps", "docs", "AGENTS.md"), "# Docs rules\n");
  fs.writeFileSync(path.join(dir, "apps", "docs", "CLAUDE.md"), "# Own file\n");
  fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "x", "AGENTS.md"), "no\n");
  const r = scaffold({ projectDir: dir });
  assert.ok(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").startsWith("@AGENTS.md\n\n<!-- harness:begin"));
  assert.equal(fs.readFileSync(path.join(dir, "apps", "web", "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(fs.readFileSync(path.join(dir, "apps", "docs", "CLAUDE.md"), "utf8"), "# Own file\n");
  assert.ok(r.created.includes("apps/web/CLAUDE.md"));
  assert.equal(fs.existsSync(path.join(dir, "node_modules", "x", "CLAUDE.md")), false);
});

test("detect-stack: a build script that fails on purpose is not the gate, and pnpm-workspace.yaml means workspaces", async () => {
  const { detectStack } = await import("../../plugins/harness/scripts/detect-stack.mjs");
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
  fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: 'echo "pick: build:dev | build:pro" && exit 1', "build:dev": "turbo run build:dev", "build:pro": "turbo run build:pro", typecheck: "turbo run typecheck" } }));
  const s = detectStack(dir);
  assert.equal(s.workspaces, true);
  assert.equal(s.gate.build, "pnpm build:dev");
  assert.equal(s.gate.typecheck, "pnpm typecheck");
  assert.ok(s.notes.some((n) => n.includes("fails on purpose")));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "exit 1" } }));
  assert.equal(detectStack(dir).gate.build, "TODO");
});

test("a project with Prettier gets the guard folder in .prettierignore", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "prettier.config.mjs"), "export default {};\n");
  fs.writeFileSync(path.join(dir, ".prettierignore"), "node_modules\n");
  const r = scaffold({ projectDir: dir });
  assert.ok(r.proposed.includes(".prettierignore.harness-proposed"));
  assert.equal(fs.readFileSync(path.join(dir, ".prettierignore.harness-proposed"), "utf8"), "node_modules\n.github/harness/\n");
  const none = tmp();
  fs.writeFileSync(path.join(none, "package.json"), "{}");
  scaffold({ projectDir: none });
  assert.equal(fs.existsSync(path.join(none, ".prettierignore")), false);
});
