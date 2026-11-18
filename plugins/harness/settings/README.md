# Role settings

The orchestrator passes one of these files as flag settings (the `settings` option of the Agent SDK) to each session. Flag settings take precedence over project, local and user settings. The files carry no comments, because Claude Code reads them as settings.

| File | Roles | What it adds |
| --- | --- | --- |
| `executor.json` | executor (reference, probe, composed and baseline runs) | Deny rules for pinned-, exception, library and report paths; `Bash(gh *)` denied; strict sandbox; reads blocked outside the working directory |
| `editor.json` | invariant editor, domain editor, composer, consolidator | No shell, no web, no subagents; reads blocked outside the working directory |
| `reader.json` | selector, reflector | No writes, no shell, no web |
| `judge.json` | judge | No tools |

Each file sets `disableSkillShellExecution: true`. Claude Code then replaces the inline shell of a skill (`` !`command` `` and ` ```! ` blocks) with a placeholder, and does not run it. Inline shell runs when a skill loads, and the guard hook does not see it. The orchestrator also refuses an H tree with inline shell, hooks or MCP servers in a skill or a subagent (`unsafeH` in `orchestrator/src/kernel/htree.ts`). These settings cannot turn off skill hooks: `allowManagedHooksOnly` is read from managed settings only, and `disableAllHooks` also turns off the guard.

At launch the orchestrator adds concrete absolute paths to `sandbox.filesystem.denyWrite` and `denyRead`. The Linux and WSL2 sandbox skips entries that contain `*`, `?` or `[`, so globs do not work there.

The deny rules live here and not in the project settings. A deny rule wins over every approval, so a deny rule in `.claude/settings.json` would also stop the human who runs `/harness:init`.
