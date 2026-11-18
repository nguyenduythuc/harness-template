# Claude Code in this project

This page is for each developer of the team. A tool that nobody uses after 2 weeks goes out.

## What you get

| Type | Name | Use it when |
|---|---|---|
| Agent | `mr-reviewer` | You want a review of your branch against the rules, before a merge request |
| Hook | no `.env` access | Claude cannot read or change a `.env` file |
| Hook | after an edit | Prettier runs on the file, and Claude gets a report of each new `console.log` |
| CI | gate | Each merge request runs the gate of `harness/pinned-config.yaml` |
| Skill | (add the skills of the project here) | |

The rules are in three places:

- `CLAUDE.md`: the architecture.
- `harness/guardrails.md` and `harness/instructions.md`: how to do the work.
- `harness/pinned-guardrails.md`: the rules of the humans. An agent cannot change them.

## Install (one time)

1. Install Claude Code, and log in with the account that the company gives you.
2. Install the packages of the project.
3. Open Claude Code in the project. Select **Trust** for the folder.

## Before each merge request

1. Run the checks in `harness/instructions.md`.
2. Ask Claude: "Review this branch before the merge request."

## When something is wrong

- Claude says that it cannot read `.env.local`: this is correct. Find the names of the values in the code, and ask a human for a value.
- A tool gives a wrong result: tell the owner of the harness. Give the text that you typed and the result.
