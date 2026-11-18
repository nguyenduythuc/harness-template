// Small I/O helpers for hook scripts. No dependencies.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Read all of stdin and parse it as JSON. Returns {} when stdin is empty. */
export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

/** Append one JSON line to `file`. Make the directory when it is missing. Never throws. */
export function appendJsonl(file, obj) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {
    // Logging must not change the decision of a hook.
  }
}

/** Read a JSON file. Returns `fallback` when the file is missing or not valid JSON. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** SHA-256 of a file, as hex. Returns null when the file cannot be read. */
export function sha256File(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Write a hook result as JSON on stdout. */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
