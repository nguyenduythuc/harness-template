// Test helpers: a temporary project with the harness scaffold, an eval store, a lesson store,
// and a fake Agent SDK that plays each role with fixed file edits and replies.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../src/kernel/session.js";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
export const pluginDir = path.join(repoRoot, "plugins", "harness");

for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" })) {
  process.env[k] = v;
}

export const sh = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" });

export interface Fixture {
  root: string;
  project: string;
  store: string;
  lessons: string;
  canary: string;
}

export async function fixture(phase: number, opts: { lessonStore?: "on" | "off" } = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-int-"));
  const project = path.join(root, "project");
  const store = path.join(root, "eval-store");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  sh(project, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", scripts: { build: "true", typecheck: "true", lint: "true", test: "true" } }, null, 2));
  fs.writeFileSync(path.join(project, "src", "index.ts"), "export const a = 1;\n");
  const { scaffold } = (await import(pathToFileURL(path.join(pluginDir, "scripts", "scaffold.mjs")).href)) as { scaffold: (a: { projectDir: string; pluginRoot: string }) => unknown };
  scaffold({ projectDir: project, pluginRoot: pluginDir });
  const cfgFile = path.join(project, "harness", "pinned-config.yaml");
  const cfg = fs
    .readFileSync(cfgFile, "utf8")
    .replace("phase: 0", `phase: ${phase}`)
    .replace(/^(\s+(build|typecheck|lint|test)): .*$/gm, '$1: "true"')
    .replace("m: 3", "m: 2")
    .replace('lesson_store: "on"', `lesson_store: "${opts.lessonStore ?? "on"}"`);
  fs.writeFileSync(cfgFile, cfg);
  sh(project, "add", "-A");
  sh(project, "commit", "-q", "-m", "init");

  const { initEvalStore } = await import("../src/kernel/evalstore.js");
  initEvalStore(store);
  const base = sh(project, "rev-parse", "HEAD").trim();
  for (const id of ["t1", "t2", "t3"]) {
    const d = path.join(store, "tasks", id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "task.md"), `Add a feature ${id}.\n`);
    fs.writeFileSync(path.join(d, "base_sha"), base + "\n");
    fs.writeFileSync(path.join(d, "rubric.md"), "- [spec] (2) Adds the feature\n- [tests] (1) Adds a test\n");
    fs.writeFileSync(path.join(d, "meta.yaml"), "task_type: feature\n");
  }
  fs.writeFileSync(path.join(store, "split.json"), JSON.stringify({ seed: 7, dev: ["t1", "t2"], holdout: ["t3"] }));
  const canary = fs.readFileSync(path.join(store, "canaries.txt"), "utf8").split("\n")[0] as string;

  const lessons = path.join(root, "lessons");
  const userCfg = path.join(root, "user-config.yaml");
  fs.writeFileSync(userCfg, `work_root: ${path.join(root, "work")}\ntemplate_dir: ${repoRoot}\neval_store: ${store}\ndev: false\nlesson_store:\n  path: ${lessons}\n`);
  process.env.HARNESS_CONFIG = userCfg;
  return { root, project, store, lessons, canary };
}

/** A fake Agent SDK. `leak` makes the executor print a string in a tool result (the canary test). */
export function fakeQuery(opts: { leak?: string; lesson?: string; bloat?: boolean } = {}): QueryFn & { calls: string[]; prompts: string[] } {
  const calls: string[] = [];
  const prompts: string[] = [];
  let judgeCount = 0;
  const fn = async function* ({ prompt, options }: { prompt: string; options: Options }): AsyncGenerator<SDKMessage> {
    const env = (options.env ?? {}) as Record<string, string>;
    const role = env.HARNESS_ROLE ?? "";
    const cwd = options.cwd as string;
    calls.push(role);
    prompts.push(prompt);
    // Like the real SDK: outputFormat adds the StructuredOutput tool.
    const base = role === "executor" ? ["Bash", "Read", "Edit", "Write", "Glob", "Grep"] : Array.isArray(options.tools) ? (options.tools as string[]) : [];
    const tools = options.outputFormat ? [...base, "StructuredOutput"] : base;
    const msgs: unknown[] = [
      { type: "system", subtype: "init", session_id: `s-${calls.length}`, model: options.model, tools, plugins: role === "judge" ? [] : [{ name: "harness", path: pluginDir }], claude_code_version: "2.1.295", mcp_servers: [] },
    ];
    let result = "done";
    let structured: unknown = undefined;
    const tool = (id: string, name: string, input: Record<string, unknown>, output: string): void => {
      msgs.push({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name, input }] } });
      msgs.push({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: output }] } });
    };
    const appendH = (line: string): void => {
      const f = path.join(cwd, "H", "instructions.md");
      fs.appendFileSync(f, `\n${line}\n`);
    };
    if (role === "executor") {
      fs.writeFileSync(path.join(cwd, "src", "feature.ts"), `export const feature = ${calls.length};\n`);
      tool("t1", "Write", { file_path: path.join(cwd, "src", "feature.ts") }, "ok");
      tool("t2", "Bash", { command: "npm test" }, opts.leak ? `output ${opts.leak}` : "ok");
      result = "Added the feature.";
    } else if (role === "invariant-editor" && opts.bloat) {
      // First try: break the growth limit. Fix session: remove the extra text.
      const mem = path.join(cwd, "H", "memory.md");
      if (String(prompt).includes("The orchestrator discarded your proposal")) fs.writeFileSync(mem, fs.readFileSync(mem, "utf8").split("\nBLOAT ")[0] as string);
      else fs.appendFileSync(mem, "\nBLOAT " + "x".repeat(3000) + "\n");
      appendH("Run the test command after each edit.");
      result = "<notes>\nadded -> instructions.md: run tests -> step 2\n</notes>";
    } else if (role === "invariant-editor") {
      appendH("Run the test command after each edit.");
      result = "<notes>\nadded -> instructions.md: run tests -> step 2\n</notes>";
    } else if (role === "domain-editor") {
      appendH("Features live in src/.");
      result = "<notes>\nadded -> instructions.md: src layout -> step 1\n</notes>";
    } else if (role === "composer") {
      appendH("Run the test command after each edit.");
      result = "<notes>\nkept -> A: run tests [L:testing/run-tests-after-edits] -> step 2\ndropped -> B: src layout -> step 1\n</notes>";
    } else if (role === "reflector") {
      result = `<edits>\n| A | run tests | helped |\n</edits>\n<experience>\ndomain: testing\nentry: Run tests after edits\ncue: a feature task with a test script\nlesson: ${opts.lesson ?? "Run the test command after each edit."}\nevidence: composed run, step 2\n</experience>`;
    } else if (role === "judge") {
      judgeCount++;
      structured = { criteria: [{ id: "spec", pass: true }, { id: "tests", pass: judgeCount % 2 === 0 }] };
      result = JSON.stringify(structured);
    }
    msgs.push({ type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.01, usage: { input_tokens: 1000, output_tokens: 100 }, result, structured_output: structured });
    for (const m of msgs) yield m as SDKMessage;
  };
  return Object.assign(fn, { calls, prompts });
}
