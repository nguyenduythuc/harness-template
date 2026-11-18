# harness-template

This repo gives each new project a measured execution harness, an improvement loop that follows Harness², and a lesson library.
A human merges each change that steers later tasks. No agent can merge, and no agent can see a score.

## Status

| Part | Status |
| --- | --- |
| Plan and verification | Done. See [docs/plan.md](docs/plan.md) and [docs/verification.md](docs/verification.md). |
| Plugin `harness` (Phase 0–1) | Code done. Tests pass on Linux. |
| Orchestrator CLI (Phase 0–3, part of Phase 5) | Code done. Tests pass with a fake Agent SDK. No real session has run yet. |
| Lesson store of the machine (D10) | Code done. It collects data for Phase 6 from Phase 2 of each project. |
| Phase 6 (make the template smarter and more efficient from the data of many projects; no model training) | In the plan. It starts when `harness lessons stats` shows READY. |
| Phase gates | Not started. The first real step is Phase 0: write eval tasks, then run `harness measure`. |

The decisions D1–D11 in the plan are proposals. [DECISIONS.md](DECISIONS.md) shows the default that the code uses for each one. [STATE.md](STATE.md) shows what is tested and what is not.

## Contents

| Path | Content |
| --- | --- |
| [docs/usage.md](docs/usage.md) | The user guide (Vietnamese): every manual step, in order, with the commands |
| [docs/plan.md](docs/plan.md) | The build plan (Vietnamese): architecture, measurement, decisions, rules, phases, risks |
| [docs/verification.md](docs/verification.md) | Four verification rounds of the plan: each error, its fix, and the lessons |
| [docs/flow-sheet.html](docs/flow-sheet.html) | Interactive flow sheet of one task, the run modes and an MDE80 calculator. Open it in a browser |
| `.claude-plugin/marketplace.json` | The plugin marketplace of this repo |
| `plugins/harness/` | The plugin: skills, hooks, the role guard, the scaffold, role prompts, role settings, project templates |
| `orchestrator/` | The `harness` CLI (TypeScript, Agent SDK). It opens every agent session, measures, and writes the run records |
| `tests/plugin/` | Tests of the plugin scripts. They are outside the plugin folder, so they do not change the plugin hash |

## How one task runs

1. The orchestrator runs the executor one time with H0. This is the reference run.
2. Decision 1 reads the reference trace. In production, weak signals start the loop. In eval, the loop always runs.
3. Two editors propose changes to a copy of H: one for invariant rules, one for domain facts.
4. The orchestrator runs the executor one time with each changed candidate (the probes).
5. The composer reads the evidence and writes H′. The orchestrator runs the executor with H′.
6. The gate (build, typecheck, lint, test) checks the composed deliverable first, then the reference deliverable.
7. The deliverable goes to a local branch. H′ stays in the run record. H0 does not change.
8. After the human review, the reflector writes at most one lesson to the branch `harness/library-staging`. A weekly PR brings the lessons into `main`.

The loop stops on the budget, never on a score. The flow sheet shows each step with its data.

## Lesson store (all projects on this machine)

Each project keeps its own library. The lesson store is one more folder on your machine. It collects data from every project for Phase 6, which changes the template itself.

- Default folder: `~/.local/share/harness/lessons`. To change it, set `lesson_store: { path: /abs/path }` in the user config. To turn it off, set `lesson_store: false`.
- What goes in: each staged lesson, each life-cycle event (`staged`, `proposed`, `merged`, `edited`, `not-merged`, `removed`, `reused`), and one episode for each improvement step (candidates, notes, the composer record, gate outcome, tokens for each role, the edit rows of the reflector).
- What never goes in: task text, deliverable code, rubrics, scores, holdout runs. Every text goes through a secret filter first.
- No agent session can read the store.
- A project can stay out: set `lesson_store: "off"` in its `harness/pinned-config.yaml`. Use this when the owner of the repo does not allow a copy of its facts outside the repo.
- Keep the `id:` line when you edit a lesson in a library PR. `harness lessons sync` uses it to find your edit.

```sh
harness lessons sync --project .   # after you merge a library PR: record merged, edited, not merged
harness lessons stats              # counts, merge and edit rates, efficiency by template version, the Phase 6 data gate
harness lessons list --status edited
harness lessons export             # lessons.jsonl and episodes.jsonl for Phase 6
```

## Install in 5 commands

```sh
git clone https://github.com/nguyenduythuc/harness-template.git
sh harness-template/install.sh          # build the CLI, put `harness` on PATH, write the user config
cd <your project>
harness init                            # scaffold: harness/, the CLAUDE.md block, the CI guard (GitHub or GitLab)
harness pack install base               # hooks, the mr-reviewer agent, a CI job that runs the gate
```

Then set the gate in `harness/pinned-config.yaml`, and run `harness doctor` and `harness gate-check`. These steps use 0 tokens. The tool packs are in [packs/README.md](packs/README.md): `base`, `web-next` and `mcp-work`. `harness evidence` gives numbers from the git history, to choose the skills that a project needs.

## Quick start

The full list of manual steps is in [docs/usage.md](docs/usage.md). The short version:

Requirements: Node 22 or later, git, Claude Code 2.1.295 or later, an Anthropic API key. On Linux and WSL2, the sandbox also needs `bwrap` and `socat`. Native Windows is not supported: use WSL2.

1. Build and link the CLI:

   ```sh
   cd orchestrator
   npm ci
   npm run build
   npm link
   ```

2. Write the user config `~/.config/harness/config.yaml`. Use absolute paths. Keep `work_root` and `eval_store` outside every project, and make sure that no `CLAUDE.md` is in a folder above `work_root`.

   ```yaml
   work_root: /home/you/harness-work
   template_dir: /home/you/src/harness-template
   eval_store: /home/you/harness-eval-myproject
   dev: true            # Phases 1-3: the plugin loads from the checkout
   ```

3. Install the plugin in Claude Code, then open the project:

   ```text
   /plugin marketplace add nguyenduythuc/harness-template
   /plugin install harness@harness-template
   ```

   During development, you can load the plugin from the checkout: `claude --plugin-dir /home/you/src/harness-template/plugins/harness`.

4. In the project, run `/harness:init`. The scaffold creates `harness/`, the CI path guard and the import block in `CLAUDE.md`. It never overwrites a file: for a file that exists, it writes `<file>.harness-proposed`.
5. Fill in each `TODO` gate command in `harness/pinned-config.yaml`. Commit the harness files.
   In GitHub, create the six labels that the CI guard reads, and make the `owner-rules` check required on `main` ([docs/usage.md](docs/usage.md), section 2.3).
6. Make the eval store and add tasks. Each task folder has `task.md`, `base_sha`, `rubric.md`, `meta.yaml` and, optionally, `hidden-tests/` and `solution/` (a correct deliverable, with each file at its repo path).

   ```sh
   harness eval-init /home/you/harness-eval-myproject
   # write tasks/<task-id>/... and weights.yaml, then commit them in the eval store
   harness eval-split --project .
   harness eval-check --project .   # gate and hidden tests at base and on the reference, without agent sessions
   ```

7. Check the guard layers: `harness doctor --project .`. Then run `harness doctor --project . --live`. The live probes open real sessions and use API tokens.
8. Run Phase 0: `harness measure --project .`. It prints sigma_run, the Phase 0 gate result and the report path.

## Commands

| Command | Phase | What it does |
| --- | --- | --- |
| `harness eval-init <dir>` | 0 | Makes the eval store skeleton and a git repo in it |
| `harness eval-split` | 0 | Puts new tasks into dev or holdout, stratified by task type. A split is final |
| `harness eval-check [--only a,b]` | 0 | For each eval task, without agent sessions: runs the workspace setup, the gate and the hidden tests at base and on `solution/`. The solution must pass all. Writes the report to `<eval_store>/checks/` |
| `harness measure [--m N]` | 0 | Runs frozen H0 m times per dev task. Gives sigma_run and the MDE80 table |
| `harness mde --n N --sd S [--gain G]` | any | Calculates MDE80 and the pass probability by simulation |
| `harness bench` | any | Writes the benchmark dashboard `<eval_store>/benchmarks.html`: the current version and the history of every version. Measure and eval rounds also update it |
| `harness calibrate template` / `check --dir <dir>` | 0 | Writes label files for judge calibration, then compares the human labels with the judge (kappa, pair order) |
| `harness run --task <file>` | any | Runs one production task. Prints the push and PR commands. It does not push |
| `harness doctor [--live]` | any | Checks the configuration and tries each known bypass |
| `harness report` | any | Shows a summary of the runs, without scores |
| `harness upgrade` | any | Writes a lock proposal for a new plugin or orchestrator version |
| `harness freeze-h0` | 1 | Writes a lock proposal with `h0_sha` set to HEAD |
| `harness eval --split dev\|holdout --decision "<text>"` | 2 (dev), 3 (holdout) | Runs one eval round. Prints only the outcome and the report path |
| `harness reflect <run-id> [--review <file>]` | 3 | Runs the reflector on a finished production run |
| `harness library-pr` | 3 | Builds the weekly library branch from `main` and the new staged lessons |
| `harness lessons sync\|list\|stats\|export` | any | Reads and updates the lesson store of the machine |

The `phase` value in `harness/pinned-config.yaml` locks each command to its phase.

## Owner rules

Each file in a project has one owner class:

| Class | Files | Who changes it |
| --- | --- | --- |
| pinned | Each path with a segment that starts with `pinned-` | A human, through a PR with an owner label |
| exception | `CLAUDE*.md`, `AGENTS.md`, `.mcp.json`, `.github/**`, `.husky/**`, `.claude/settings*.json`, `.claude/{rules,hooks,commands}/**`, nested `.claude/` | A human, through a PR with an owner label |
| loop-owned | The `loop_owned` list in the config: H0 instructions, guardrails, skills, agents, scripts | Only an `h0-promotion` PR (decision 5, Phase 5) |
| library | `harness/library/**` | Only the weekly `library` PR |
| task code | Everything else | Deliverable PRs |

Five layers keep the rules:

1. The eval store is outside every project. Its path is only in the user config. Agent sessions cannot read it, and canary strings show a leak.
2. Every session starts from the orchestrator with explicit settings, tools, environment and config folder. No session gets a `GH_TOKEN`.
3. The `PreToolUse` guard applies the policy of the role. A role without a policy gets no tools.
4. The executor runs in the Claude Code sandbox. The orchestrator expands each protected path to a concrete path, because the Linux sandbox skips patterns.
5. CI runs the path guard on `pull_request_target` with the rules of the base commit.

## Tests

```sh
cd orchestrator && npm test          # unit and integration tests, with a fake Agent SDK
node --test "tests/plugin/*.test.mjs" # plugin script tests (from the repo root)
```

The integration tests run the full loop in temporary git repos: production with the composed outcome, the phase lock, the init check, Phase 0 measurement, an eval round, the canary stop, and the guard self-test.

## License

MIT. See [LICENSE](LICENSE).

## Limits

- The tests do not open real Claude Code sessions. The first real sessions are part of Phase 0 and Phase 1 (see [STATE.md](STATE.md)).
- The gate runs code that an agent wrote, on the machine of the orchestrator. Run eval rounds in the clean container of D9.
- The template does not merge, push or open PRs by itself. A human does each of these steps.
