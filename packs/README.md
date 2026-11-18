# Tool packs

A pack is a set of project files that a team uses each day with Claude Code: hooks, agents, MCP servers, a CI job and a test preset. The scaffold gives a project the harness (rules, gate, guard). A pack gives it the tools.

| Pack | For | Contents |
|---|---|---|
| `base` | Each JavaScript or TypeScript project | A hook that denies `.env` access, a hook that formats a changed file and reports a new `console.log`, the `mr-reviewer` agent, a CI job that runs the gate (GitHub or GitLab), human rules, a team page |
| `web-next` | A Next.js or React web project | A Vitest and Testing Library preset, `tools/i18n-check.mjs`, `tools/ensure-next-env.mjs`, rules for Next.js |
| `mcp-work` | A team with Jira, Confluence or Figma | `.mcp.json` with a read-only Atlassian server and the Figma server |

## Install

```bash
harness init --project <repo>            # scaffold: harness/, CLAUDE.md block, CI guard
harness pack install base --project <repo>
harness pack install web-next --project <repo>   # if it applies
harness doctor --project <repo>
harness gate-check --project <repo>
```

The installer follows three rules:

1. It creates a file that the project does not have.
2. For a file that the project has, it writes `<file>.harness-proposed`. Compare the two files, then move the proposal over the original.
3. It never changes `package.json`. It prints the scripts and the packages to add.

`harness pack install <name> --dry-run` shows the result and writes nothing.

## What a pack does not have

A pack has no skill for the code of one project. A skill that helps is specific: it names the files, the hooks and the rules of one repo. Such a skill comes from the project, not from the template.

## Write a skill from evidence

1. Run `harness evidence --project <repo>`. The command reads the git history. It uses 0 tokens.
2. Find the folders with the most file changes. Example: `src/components/Checkout` with 500 changes in 6 months.
3. For each folder, name the type of work. Example: "change the checkout form: fields, validation, payment types". If you cannot name one type of work, do not write a skill.
4. Read 2 or 3 merged changes of that type. Write down the files that each change touches and the order of the steps.
5. Write `.claude/skills/<name>/SKILL.md`: a map of the files, the steps, the rules, and one example from the repo. Use an English kebab-case name. Put the words of the team in the description.
6. Add a trigger line to `harness/instructions.md`. Example: "The checkout form or its validation: use the checkout-form skill." The doctor fails when a skill has no trigger line.
7. Give each skill an owner in the team. The owner reads the skill before the merge.
8. Start with 6 skills at most. Each skill adds its description to each session.

The numbers also show rules and hooks. Example: 25 commits in 6 months name "build" or "lint" in the subject, so the project needs a CI job that runs the gate.

## Make a new pack

```
packs/<name>/
  pack.json          name, description, packageJson { scripts, devDependencies }, manual [steps]
  files/**           for each project
  files.github/**    only for a GitHub project
  files.gitlab/**    only for a GitLab project
  append/**          lines to add to a file that the scaffold made
```

Text in `files.github/` and `files.gitlab/` can use `{{install}}`, `{{gate.build}}`, `{{gate.typecheck}}`, `{{gate.lint}}` and `{{gate.test}}`. The installer takes the values from `harness/pinned-config.yaml`.

Do not put a secret, a host name of a company or the code knowledge of one project in a pack.
