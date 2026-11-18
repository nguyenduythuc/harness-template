// PreToolUse hook: deny each tool call that names a .env file.
// The .env files hold secrets. A human owns this file: the harness guard denies agent writes to
// .claude/hooks/.
//
// Limit: the hook reads the text of the tool call. A shell pattern such as `cat .e*` does not
// name the file, so the hook does not see it. Use the sandbox for a hard limit.
import fs from 'node:fs';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const ti = input.tool_input ?? {};
const text = [ti.file_path, ti.path, ti.pattern, ti.glob, ti.command].filter(v => typeof v === 'string').join('\n');

// ".env", ".env.local", ".env.production" as a path or a word. "process.env.X" does not match.
const envFile = /(^|[\s/'"=(:])\.env(\.[\w-]+)*(?![\w.-])/m;
const example = /\.env\.(example|sample|template)\b/;

if (envFile.test(text) && !example.test(text)) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'The .env files hold secrets. Do not read or change them. Find the names of the env values in the code or in .env.example. Ask a human for a value.',
      },
    }),
  );
}
process.exit(0);
