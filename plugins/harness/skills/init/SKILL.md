---
name: init
description: Set up harness/ in this project, and apply the .harness-proposed files that the scaffold wrote next to existing files. Use it once in a new project, and again after an upgrade adds template files. Only a human starts it.
disable-model-invocation: true
---

# /harness:init

Set up the harness in this project. The scaffold is create-only: it never overwrites a file.

## Steps

1. Run the scaffold and read its output:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" "${CLAUDE_PROJECT_DIR}"`
2. Find the proposals: `find "${CLAUDE_PROJECT_DIR}" -name "*.harness-proposed" -not -path "*/node_modules/*"`.
3. For each proposal, show the human the diff between the file and its proposal.
4. Ask the human for each file: apply the proposal, or keep the file.
5. When the human says "apply", write the proposal content to the file. The guard asks again for this write, because the file is pinned. Then delete the proposal file.
6. Show the TODO lines in `harness/pinned-config.yaml`. Ask the human to fill in each gate command. Do not guess a command.
7. Tell the human the next step: run `/harness:doctor`.

## Rules

- Do not edit a `pinned-` file or an exception file without the explicit "apply" of the human for that file.
- Do not create the eval set. The eval store lives outside this repository. To make its skeleton, the human runs `harness eval-init <path>` in a terminal.
