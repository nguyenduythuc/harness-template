# harness-template

Instructions for agents that work on this repo.

## Commands

- Build and test the orchestrator: `cd orchestrator && npm ci && npm test`.
- Typecheck only: `cd orchestrator && npm run typecheck`.
- Test the plugin scripts: `node --test "tests/plugin/*.test.mjs"` from the repo root.

## Rules

- Write code comments, README text, commit messages and PR descriptions in ASD-STE100 Simplified Technical English.
- Keep the layer rule of `ARCHITECTURE.md`: imports go util <- kernel <- loop <- extras <- cli.ts. `npm test` checks it. A lower layer that must call a higher one takes a hook, and `cli.ts` passes it.
- No new feature in `orchestrator/src/loop/` or `orchestrator/src/extras/` until an E2 round passes. Fixes that make a measurement possible are allowed.
- Never add a `Co-Authored-By` trailer to a commit message.
- The ownership rules exist two times: `plugins/harness/scripts/lib/ownership.mjs` (no dependencies, for hooks and CI) and `orchestrator/src/kernel/ownership.ts`. Change both in the same commit. The parity test in `orchestrator/test/unit.test.ts` must pass.
- The directory hash exists two times: `plugins/harness/scripts/checksum.mjs` and `hashDir` in `orchestrator/src/util/fs.ts`. Keep them equal.
- Tool packs are in `packs/`. A pack has no skill for the code of one project, no company name and no secret. `harness pack install` never writes a file that exists: it writes a `.harness-proposed` file.
- The CI host rule exists two times: `plugins/harness/scripts/lib/ci-host.mjs` and `ciHost` in `orchestrator/src/kernel/admin.ts`. Keep them equal.
- Keep tests of the plugin outside `plugins/harness/`. Each file in that folder changes the plugin hash in the lock of every project.
- No score, rubric or eval-store path goes into a project file, a run record or a printed line of a production command.
- The lesson store (`orchestrator/src/extras/lessonstore.ts`) never gets task text, deliverable code, rubrics, scores or holdout data. Every text goes through `redact()`. No agent session reads the store.
- The benchmark page (`orchestrator/src/extras/bench.ts`) is one file: `<eval_store>/benchmarks.html`. It holds scores. Every text from data goes through `esc()`, and the page has no JavaScript.
- Tests must give the lesson store a temporary path. A test must never write to the real home folder.
- A command that changes a `pinned-` file writes a `.harness-proposed` file. It never writes the pinned file.
- The orchestrator never pushes, merges or opens a PR.
- Each step of a later phase checks `phase` with `requirePhase` in `orchestrator/src/kernel/config.ts`.
- SDK options change fast. Before you change `orchestrator/src/kernel/roles.ts`, read the type definitions in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

## Where to read more

- `docs/plan.md`: the plan (Vietnamese).
- `ARCHITECTURE.md`: the layers, the layer rule and the hooks.
- `DECISIONS.md`: the default of each decision in the code.
- `STATE.md`: what is tested and what is not.
