#!/usr/bin/env node
// ConfigChange hook. In an orchestrated agent session (HARNESS_ROLE is set), block every settings
// change during the session, so a session cannot loosen its own rules. In a human session, only log.

import { readStdinJson, appendJsonl, emit } from "./lib/io.mjs";

const role = process.env.HARNESS_ROLE || "";
let input = {};
try {
  input = await readStdinJson();
} catch {
  input = {};
}
appendJsonl(process.env.HARNESS_GUARD_LOG || "", { hook: "ConfigChange", role: role || "human", source: input.source, file: input.file_path, decision: role ? "block" : "none" });
if (role) {
  emit({ decision: "block", reason: `harness: settings cannot change during a "${role}" session.` });
}
