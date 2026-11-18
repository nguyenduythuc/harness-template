---
name: doctor
description: Check the harness configuration of this project, and try each known bypass of the owner rules. Use it after /harness:init, after a change to a pinned file, and before the first measurement. Only a human starts it, because it tries bypasses on purpose.
disable-model-invocation: true
argument-hint: "[--live]"
---

# /harness:doctor

The doctor checks the configuration. It does not prove containment. It passes only when each bypass is blocked or detected.

## Steps

1. Make sure that `harness` is on PATH: `command -v harness`. If it is missing, tell the human how to build it (see `/harness:run`) and stop.
2. Run the static checks: `harness doctor --project "${CLAUDE_PROJECT_DIR}"`.
3. If the human asked for `--live`, run `harness doctor --project "${CLAUDE_PROJECT_DIR}" --live`. The live probes open real sessions with the settings of each role, so they use API tokens. Tell the human this before you start.
4. Show each result line. A line with `[FAIL]`, `[BYPASSED]` or `[CRASH]` needs a human fix. `[WARN]` needs a human decision.

## Rules

- Do not fix a failed check by editing a `pinned-` file, an exception file or a role settings file. Report the failure. A human makes the fix.
