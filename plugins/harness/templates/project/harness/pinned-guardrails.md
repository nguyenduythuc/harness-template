# Guardrails (human-owned)

A human writes these rules. The improvement loop reads them and never changes them.

1. Do not change files whose name starts with `pinned-`.
2. Do not change `CLAUDE.md`, `.claude/settings*.json`, `.mcp.json`, `.gitlab-ci.yml` or files in `.github/` or `.gitlab/`.
3. Do not add `.skip`, `@ts-ignore`, `@ts-nocheck` or `eslint-disable` to make a check pass.
4. Do not delete a test to make the gate pass.
5. Before you finish, run the checks of the project and read the result.

<!-- Add project rules below this line. Keep one rule per line. -->
