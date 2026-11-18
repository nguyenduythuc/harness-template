// PostToolUse hook for Edit, MultiEdit and Write:
// 1. Run Prettier on the file, if the project has Prettier.
// 2. Report each new console.log in the file. Exit code 2 sends the report to Claude.
// A human owns this file.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
const file = input.tool_input?.file_path;
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (typeof file !== 'string' || !fs.existsSync(file) || !/\.(tsx?|jsx?|mjs|cjs|s?css|json|md)$/.test(file)) process.exit(0);

const prettier = path.join(root, 'node_modules', '.bin', 'prettier');
if (fs.existsSync(prettier)) spawnSync(prettier, ['--write', '--log-level', 'warn', '--ignore-unknown', file], { cwd: root, stdio: 'ignore' });

if (/\.(tsx?|jsx?|mjs|cjs)$/.test(file) && !/\.(test|spec)\./.test(file)) {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const tracked = git(['ls-files', '--error-unmatch', '--', file]).status === 0;
  const added = tracked
    ? (git(['diff', '-U0', '--', file]).stdout ?? '').split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'))
    : fs.readFileSync(file, 'utf8').split('\n');
  const logs = added.filter(l => /\bconsole\.log\(/.test(l) && !/^\+?\s*\/\//.test(l));
  if (logs.length) {
    process.stderr.write(`${path.relative(root, file)}: ${logs.length} new console.log. Remove each one before you finish.\n`);
    process.exit(2);
  }
}
process.exit(0);
