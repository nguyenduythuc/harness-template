---
name: report
description: Show the token use, cost, outcomes and lesson reuse rate of recent harness runs in this project. Use this skill when the user asks how the harness runs went, what they cost, or how often the runs reused lessons. It never shows scores.
---

# /harness:report

## Steps

1. Run `harness report --project "${CLAUDE_PROJECT_DIR}"`.
2. Show the lines that it prints.

## Rules

- The report shows tokens, cost, outcomes and reuse. It never shows scores. Scores stay in the eval store, and only the human reads them there.
- Do not open files in the eval store.
