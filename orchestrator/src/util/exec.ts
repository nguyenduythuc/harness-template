// Process helpers. Every command runs without a shell unless the caller asks for one.

import { spawn, spawnSync } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Keep only the last N characters of stdout and stderr. */
  tailChars?: number;
}

function tail(s: string, n: number | undefined): string {
  return n && s.length > n ? s.slice(s.length - n) : s;
}

/** Run a program with arguments. Never throws for a non-zero exit code. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d: Buffer) => {
      stdout = tail(stdout + d.toString("utf8"), opts.tailChars ? opts.tailChars * 2 : undefined);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = tail(stderr + d.toString("utf8"), opts.tailChars ? opts.tailChars * 2 : undefined);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), durationMs: Date.now() - start, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout: tail(stdout, opts.tailChars), stderr: tail(stderr, opts.tailChars), durationMs: Date.now() - start, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Run a command string with bash. Use it only for commands that a human wrote in the config.
 * The shell is not a login shell, so the command gets the PATH of the harness process: the same
 * node and yarn as in the terminal of the human. A login shell on macOS runs path_helper, which
 * puts /usr/local/bin first. Found live: `bash -lc` ran Node 18 instead of the Node 22 of nvm, and
 * vitest 4 did not start, so the gate and the hidden tests failed for every deliverable (R7).
 */
export function runShell(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return run("bash", ["-c", command], opts);
}

/** Run git synchronously and return stdout. Throws on a non-zero exit code. */
export function git(args: string[], cwd: string, input?: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

/** Run git synchronously and return raw bytes of stdout. Throws on a non-zero exit code. */
export function gitBuffer(args: string[], cwd: string): Buffer {
  const r = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** True when `git` succeeds. */
export function gitOk(args: string[], cwd: string): boolean {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}
