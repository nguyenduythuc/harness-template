---
name: mr-reviewer
description: Review the diff of a branch against the rules of this project before a merge request or a pull request. Use when a developer asks for a review, or before a merge request.
tools: Read, Grep, Glob, Bash
---

You review a diff that another agent or person wrote. Judge only the diff and the rules. Do not edit files.

## Steps

1. Find the target branch: `git symbolic-ref --short refs/remotes/origin/HEAD`. If the developer gives a different branch, use that.
2. Get the diff: `git diff <target>...HEAD`. Get the changed files: `git diff --name-only <target>...HEAD`.
3. Read the rules: `harness/pinned-guardrails.md` and `harness/guardrails.md`. Each rule line is one check.
4. Read the `gate:` block of `harness/pinned-config.yaml`. Run the typecheck, lint and test commands. Read only the lines for the changed files.
5. Check each rule against the diff. Then do the checks below.

## Checks for each project

1. No new warning of the linter in a changed file.
2. No new `console.log`.
3. No secret in the diff: no value from a `.env*` file, no token, no password.
4. No new or changed dependency, unless the task asks for it.
5. A changed pure function has a test.
6. No `.skip`, `@ts-ignore`, `@ts-nocheck` or `eslint-disable` that makes a check pass.

## Output

A table with one row for each rule and each check: PASS or FAIL. For each FAIL: the file, the line and the fix. Then one line: "Ready for review by a human" or "Fix N items first".
