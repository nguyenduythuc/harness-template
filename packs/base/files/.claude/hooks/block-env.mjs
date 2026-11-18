// PreToolUse hook: deny each tool call that names a .env file that git does not track.
// Untracked .env files (.env, .env.local, .env.*.local) hold secrets. A tracked .env file is in the
// repo, so each reader of the repo can read it already: the hook allows it. Some projects keep
// public values in tracked files such as .env.development, and their rules tell agents to edit them.
// A human owns this file: the harness guard denies agent writes to .claude/hooks/.
//
// Limit: the hook reads the text of the tool call. A shell pattern such as `cat .e*` does not
// name the file, so the hook does not see it. Use the sandbox for a hard limit.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const ti = input.tool_input ?? {};
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const text = [ti.file_path, ti.path, ti.pattern, ti.glob, ti.command].filter(v => typeof v === 'string').join('\n');

// A path or a word that ends in ".env" or ".env.<suffix>". "process.env.X" does not match.
const envRef = /(?:^|[\s'"=(:])((?:~?\/)?(?:[\w@.+-]+\/)*\.env(?:\.[\w-]+)*)(?![\w.-])/gm;
const example = /\.env\.(example|sample|template)$/;

const tracked = ref => {
  if (/[*?[\]]/.test(ref)) return false; // a glob can match a secret file
  if (ref.startsWith('~')) return false;
  const abs = path.isAbsolute(ref) ? ref : path.join(input.cwd || root, ref);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) return false;
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'ignore' }).status === 0;
};

const refs = [...text.matchAll(envRef)].map(m => m[1]);
// A glob such as **/.env* names no file, but it can open each secret file.
if (/\.env\*/.test(text)) refs.push('.env*');
const secret = refs.filter(r => !example.test(r) && !tracked(r));

if (secret.length) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `${secret[0]} is a .env file that git does not track, so it can hold secrets. Do not read or change it. Ask a human for a value. Tracked .env files and .env.example are allowed.`,
      },
    }),
  );
}
process.exit(0);
