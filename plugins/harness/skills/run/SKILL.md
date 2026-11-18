---
name: run
description: Start the harness orchestrator for one task file in the background, then report the run ID and the commands for the branch. Use it when the human gives a task file to run through the harness. Only a human starts it.
disable-model-invocation: true
argument-hint: "<task-file> [improve | no-improve]"
---

# /harness:run

Start the orchestrator for one task. The orchestrator is a script, not an agent: it opens every session, measures tokens, and writes the run record.

## Steps

1. Make sure that `harness` is on PATH: `command -v harness`. If it is missing, tell the human to run `npm run build` and `npm link` in the `orchestrator/` folder of the harness-template checkout, and stop.
2. Read the task file `$0`. If the file is missing, ask the human for the task file and stop.
3. Start the run in the background with the Bash tool (`run_in_background: true`):
   `harness run --project "${CLAUDE_PROJECT_DIR}" --task "$0"`
   If the human gave a second argument (`improve` or `no-improve`), add `--force` and that argument to the command.
4. When the run ends, tell the human the run ID and the record path from the line that starts with `Run `.
5. Show the last 20 lines of the output, with the push and PR commands. Do not run them: the human reviews the branch first. Do not show scores. The orchestrator does not print scores.

## Rules

- Do not change any file of the run folder `harness/runs/`. Only the orchestrator writes there.
- Do not start a second run of the same task while the first run is still going.
