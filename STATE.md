# State

Last update: 2026-10-27. PRs #1–#9 are merged into `main`.

## Done

- The orchestrator has three layers (kernel, loop, extras) with a checked import rule (`ARCHITECTURE.md`, C38). New features in loop and extras wait for an E2 round.

- The plan, four verification rounds, and the flow sheet (`docs/`).
- The plugin `harness`: five skills, five hooks, the role guard, the config guard, the instruction log, the scaffold, stack detection, the CI path guard, role prompts (from Appendix H of the paper), role settings, project templates.
- The orchestrator CLI: config and lock checks, the session launcher with the `system/init` check, budget, traces, the full task pipeline, the gate, scoring, the judge, the eval store, the Phase 0 measurement, eval rounds with the paired rule, Reflect, the library staging branch, the doctor, the report, upgrade and freeze-h0 proposals.
- CI for this repo (`.github/workflows/ci.yml`).
- The user guide `docs/usage.md` (every manual step), the judge calibration helper (`harness calibrate`), and the benchmark page `<eval_store>/benchmarks.html` (`harness bench`).
- The lesson store of the machine (D10) and the `harness lessons` commands, with efficiency numbers for each template version. Phase 6 is in the plan: it makes the template smarter (E3 Pass) or more efficient (the same score with at most 85% of the tokens). It does not train a model. Its optimization step and the E3 round have no code yet, by design: they start after the data gate.

## Tested

| Test | What it shows |
| --- | --- |
| `tests/plugin/*.test.mjs` (38 tests) | Guard decisions for agents and humans, CI owner rules, scaffold create-only and idempotence, the ignore rule of run records, the plugin skills against the Agent Skills specification, the inline-shell switch in each role settings file, the scaffold for a GitLab project, the GitLab guard job in a real repo with the variables that GitLab sets (C40), the CLAUDE.md import of AGENTS.md and the build script that fails on purpose (C43) |
| `orchestrator/test/unit.test.ts` (38 tests) | The t quantiles, the paired rule, MDE80 against the table in the plan, scores, rubric, budget, decision 1 signals, H tree validation and diff, the name and length rules of the Agent Skills specification, the refusal of hooks, MCP servers and inline shell in H (C22), skill-local scripts and references, the H inventory and the component use of a trace, the component table of the report (C25), the per-task view of an estimate (C26), the warning when hidden tests and the judge disagree (R3), the error of a broken meta.yaml, reuse events, TS and plugin parity of the ownership rules and of the directory hash, config checks, the split, the eval store, pairing, the shell of config commands (not a login shell, R7), the warning for arms that the budget stopped (C34), the error lines of a failed command (R7), a build of kernel and loop without extras (C38), the `none` value of the gate (C39), pack install (create, propose, no change to package.json), the hooks and the i18n check of the packs, no token in a pack (C41), the CI host and the doctor line for GitLab (C40), `harness evidence` (C42) |
| `orchestrator/test/integration.test.ts` (17 tests) | The full loop in temporary git repos with a fake Agent SDK (it adds `StructuredOutput` like the real SDK); component use in the run record; one fix session over the growth limit with the first problems in the record; upgrade with a stale lock; a live doctor whose executor session cannot start; the phase lock; no session for an H with a skill hook; the per-task table of an eval round; the init check; Phase 0 measurement; an eval round; the canary stop; the doctor static checks and the guard self-test; workspace setup before each session (C31); `harness eval-check` with base and reference results, the report in the eval store only, and the doctor line (C33); one gate run per eval run (C35); upgrade proposals for stale CI guard copies (C37); reflect before the score in a round (B4, after the hook change of C38); `harness gate-check` (C42) |
| `orchestrator/test/bench.test.ts` (3 tests) | Version labels and epochs; escaping; the dashboard page after a measurement, an eval round and a production run; one file only, in the eval store, not in the project |
| `orchestrator/test/calibrate.test.ts` (2 tests) | Cohen's kappa; the label template; the judged diff in the eval store; the check against the judge |
| `orchestrator/test/lessonstore.test.ts` (8 tests) | Redaction (also before a lesson goes into git), IDs, the full lesson life cycle (staged, proposed, edited by a human, reused, not merged), the weekly branch that keeps human edits and skips rejected lessons, no holdout data, the project switch, the read-deny rule, the export |

## Tested live (2026-10-25)

These tests used real Claude Code sessions in a Linux container (Ubuntu 24.04, bubblewrap 0.9.0, Claude Code 2.1.295 in the Agent SDK). The evidence is in `docs/verification.md`, section "Kiểm chứng live ngày 2026-10-25" (L1–L20, R1–R6). The total cost was $0.71.

- A real executor session with the settings of `executor.json`: the sandbox starts, the guard hook loads from the plugin path, and `failIfUnavailable` stops a session without bwrap (L11, L17).
- Two of the three open points of D6: with `CLAUDE_CODE_RESTRICTED=1` and `settingSources: []`, the plugin loads and `CLAUDE.md` does not; `InstructionsLoaded` reports `CLAUDE.md` and each `@`-import (L18, L19).
- `harness doctor --live` on Linux: 13 of 13 attacks blocked (L11).
- The judge with `outputFormat` on claude-opus-5-5, after the fix R1.
- K52: inline shell, skill hooks and subagent hooks, with and without each layer (L1–L8).
- One full improvement step (`harness run --force improve`), and the Phase 0 measurement on two toy tasks (L12–L15).

## Tested on a real project (2026-10-26)

A private React Native monorepo on an iMac (macOS, APFS, Yarn 3.6.4, 3.2 GB of node_modules), with a new package `packages/ota-core` and 4 eval tasks with references. On 2026-10-26 no agent session ran, because Claude Code on that machine had no login. On 2026-10-27 real sessions ran on one task. The evidence is in `docs/verification.md`, section "Thử trên monorepo thật ngày 2026-10-26" (T1–T13, R7–R9).

- The eval workspace, `workspace_setup` with an APFS clone of node_modules, the gate and the hidden tests, at base and with the references.
- `harness doctor` on macOS: 0 FAIL, and the guard self-test blocks 14 of 14 attacks.
- `harness eval-check` on the 4 tasks.
- On 2026-10-27, with `CLAUDE_CODE_OAUTH_TOKEN` from a Claude subscription: one measurement run and one eval pair on c4 (T8–T13). `costUsd` has a value with a subscription token. The pipeline used 1.27 million tokens (64% of the default limit) and 9 minutes.
- On 2026-10-28, `harness measure` on 7 dev tasks (m = 3, T18): σ_run = 4.7, the Phase 0 gate passes (MDE80 6.9 ≤ 8), and the mean H0 score is 94.8. Hidden tests pass in 21 of 21 runs; the lost points come from the lint of the project and the `tests` criterion. The room above H0 (5.2 points) is less than MDE80, so no E1 or E2 round on this set can pass. The trial stops here, as the stop rule says.

## Not tested yet

0. The GitLab guard job and the gate job on a real GitLab runner. The tests run the script lines of the guard job in a local repo. No pipeline ran them. `install.sh` on macOS.
1. `harness doctor --live` on macOS and WSL2.
2. The third open point of D6: do plugins that claude.ai syncs load with an API key and a separate `CLAUDE_CONFIG_DIR`. The live test used a different login (a host proxy), so it does not answer this.
3. The CI path guard workflow on a real GitHub PR.
4. Judge calibration (Cohen's kappa ≥ 0.6, 8 of 10 pairs in the right order). It needs human labels.
5. Metro, xcodebuild and Gradle under the strict sandbox. On the trial monorepo (macOS, Seatbelt), executor sessions ran `npm run typecheck`, `npm test` (vitest) and `npx eslint` in a Yarn 3 workspace, and the gate passed (T8–T14).
6. Which Node the Bash tool of an executor session uses on macOS. Claude Code builds its shell from the zsh profile of the user, and on the trial iMac three shells gave three Node versions (R7). The gate now uses the PATH of the harness, but the executor can still test with another Node.

## Not built yet

- The clean eval container of D9 (a Dockerfile and the split between the executor step and the scoring step). Holdout rounds need `HARNESS_EVAL_IMAGE`, or `--allow-host` with a note.
- The Phase 6 optimization step and the E3 round.
- A judge stability check (the same 10 inputs scored two times). Do it by hand with `harness calibrate`.

## Next steps

1. Keep the kernel (guard, doctor, eval-check, measure) for the next project. Loop and extras stay frozen until an E2 round passes.
2. The next eval set comes from real merged PRs, with room above H0: tasks where H0 scores 30–85. Check the room before an E1 round: 100 minus the mean H0 score must be more than MDE80.
3. Open question for the next project: does a harness let a cheaper executor (for example Haiku) reach the score of Sonnet? That is a cost gain, and it needs room above a weaker H0.

Older steps:


1. Thức reads [docs/usage.md](docs/usage.md) and reviews [DECISIONS.md](DECISIONS.md), mainly C5 (growth limit), D10, C12 and C17.
2. Phase 0: write 10–15 eval tasks with rubrics in a private eval store, and write `weights.yaml` before any measurement.
3. Phase 0: run `harness eval-check` until it has no FAIL, then `harness doctor --live`, then `harness measure`. Check the Phase 0 gate (MDE80 ≤ delta_target at sigma_int = 5).
4. Phase 1: freeze H0 with `harness freeze-h0`, then measure again. That is epoch 1.
5. From Phase 2 in each project: run `harness lessons sync` after each merged library PR, and `harness lessons stats` to see the Phase 6 data gate.
