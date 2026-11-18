# Architecture

The orchestrator has three layers. Each layer has a different level of evidence, so each layer has
its own rules for change.

| Layer | Folder | Job | Evidence (docs/verification.md) | Lines |
| --- | --- | --- | --- | --- |
| kernel | `orchestrator/src/kernel/` | Run a fixed harness in a safe session, and measure the result | Measured: guard 13/13 live, eval-check on 12 tasks, real runs on the trial monorepo | about 4 400 |
| loop | `orchestrator/src/loop/` | The improvement loop: editors, probes, composer, the E1 round | Runs on a real repo; no gain shown yet | about 700 |
| extras | `orchestrator/src/extras/` | Parts that wait for a gain: lesson store, dashboard, library | None | about 1 500 |

`orchestrator/src/util/` holds process and file helpers. `orchestrator/src/cli.ts` is the composition
root: it is the only file that connects the layers.

## The layer rule

Imports go one way only:

```
util  <-  kernel  <-  loop  <-  extras  <-  cli.ts
```

- kernel imports only kernel and util.
- loop imports kernel, loop and util.
- extras import kernel, loop, extras and util.
- cli.ts imports every layer.

`npm test` runs `scripts/check-layers.mjs` first, so a bad import fails CI. A unit test builds kernel and
loop without extras and without the CLI.

When a lower layer must call a higher one, the lower layer takes a hook. The CLI passes the hook:

| Hook | Declared in | The CLI passes |
| --- | --- | --- |
| `Deps.onRunEnd` | `kernel/run.ts` | `captureEpisode` from `extras/episode.ts` (the lesson store episode) |
| `RoundDeps.reflect` | `loop/round.ts` | `reflect` from `extras/library.ts` (Phase 3+), called before the score exists |
| `MeasureReport.dashboardPath`, `RoundReport.dashboardPath` | `kernel/measure.ts`, `loop/round.ts` | `refreshDashboard` from `extras/bench.ts`, after the command |

## Main parts of the kernel

- `run.ts`: `TaskRun` (workspace, setup, executor session, gate, run record) and `runFrozen`.
- `measure.ts`: `runAndScore`, `measure`, the measurement warnings. A round gives `runAndScore` its own
  run function.
- `evalcheck.ts`: the gate and the hidden tests at base and on `tasks/<id>/solution/` (a correct deliverable), without sessions.
- `runner.ts`, `session.ts`, `roles.ts`: one agent session with the guard, the sandbox and the budget.
- `workspace.ts`: production and eval workspaces, the workspace setup.
- `evalstore.ts`, `scoring.ts`, `judge.ts`, `score.ts`, `stats.ts`, `calibrate.ts`: the ruler.
- `doctor.ts`: static checks, the guard self-test and the live probes.

## What each measurement shows

- `measure` (kernel): sigma_run of frozen H0.
- E1 (loop, `evalRound`): the loop against frozen H0 on the same task. The loop reads the trace of that
  task and runs it again, so E1 shows the value of running the loop on one task. It does not show that the
  harness got better.
- E2 (loop, `evalRound --h0-prime`): a frozen H0′ against H0 on holdout tasks that H0′ never saw. This is
  the measurement of a better harness.

## Change rules

- A change to extras or to the loop does not change the kernel.
- No new feature in the loop or in extras until an E2 round passes. Fixes that make a measurement possible
  are allowed.
- A new layer, or a new hook, needs a line in this file.
