---
name: upgrade
description: Propose a new harness/pinned-harness.lock for a new plugin, orchestrator or Claude Code version. Use it when the doctor reports a lock or runtime failure, or after you update the template checkout. Only a human starts it.
disable-model-invocation: true
---

# /harness:upgrade

## Steps

1. Run `harness upgrade --project "${CLAUDE_PROJECT_DIR}"`. It writes `harness/pinned-harness.lock.harness-proposed` with the new versions, git SHAs and content hashes.
2. Show the human the diff between the lock and the proposal.
3. When the human says "apply", write the proposal content to `harness/pinned-harness.lock`. The guard asks again for this write. Then delete the proposal file.
4. Tell the human to open a PR with the `harness-upgrade` label. A new Claude Code or plugin version starts a new measurement epoch.
