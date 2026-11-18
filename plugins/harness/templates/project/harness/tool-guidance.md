# Tool guidance

How to use the tools in this project. The file is loop-owned.

- Use the package manager of the project for each dependency change. Do not edit lock files by hand.
- Run one check at a time, and read its output before you run the next check.
- Do not print an exit code with `$?`. In agent sessions, a Bash command with `$?` (for example `npm run build; echo "exit=$?"`) needs approval, and no one can approve it, so it does not run. The tool result already shows the exit code.
