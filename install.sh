#!/bin/sh
# Install the harness CLI on this machine. No agent session, 0 tokens.
#
#   git clone https://github.com/nguyenduythuc/harness-template.git
#   sh harness-template/install.sh
#
# The script builds the orchestrator, puts the command `harness` on PATH, and writes the user
# config if it is missing. It does not change a project. For a project, see the last lines.
set -eu

T="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HARNESS_CONFIG:-$HOME/.config/harness/config.yaml}"
WORK="${HARNESS_WORK_ROOT:-$HOME/.local/share/harness/work}"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null || {
  echo "Node 22 or later is necessary. This shell has: $(node -v 2>/dev/null || echo 'no node')."
  exit 1
}

cd "$T/orchestrator"
npm ci --no-audit --no-fund
npm run build
if npm link >/dev/null 2>&1; then
  echo "OK: the command harness is on PATH."
else
  echo "npm link failed. Add this line to your shell profile, then open a new terminal:"
  echo "  alias harness='node $T/orchestrator/dist/src/cli.js'"
fi

if [ -f "$CONFIG" ]; then
  echo "Kept the existing user config: $CONFIG"
else
  mkdir -p "$(dirname "$CONFIG")" "$WORK"
  cat > "$CONFIG" <<CFG
# User config of the harness on this machine.
# work_root must be outside each project. No folder above it can have a CLAUDE.md.
work_root: $WORK
template_dir: $T
dev: true            # the plugin loads from the template checkout
# eval_store: /abs/path/harness-eval-<project>   # add in Phase 0, with \`harness eval-init\`
CFG
  echo "Wrote the user config: $CONFIG"
fi

echo "Claude Code: $(claude --version 2>/dev/null || echo 'not found. Install Claude Code before you run agent sessions.')"
cat <<'NEXT'

Next, in a project:
  harness init                      scaffold the harness files
  harness evidence                  numbers from the git history, to choose skills and rules
  harness pack list                 the tool packs of the template
  harness pack install base         hooks, the mr-reviewer agent, the CI gate job
  harness doctor                    check the guard layers
  harness gate-check                run the gate in a new worktree
NEXT
