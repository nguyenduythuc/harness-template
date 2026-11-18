#!/usr/bin/env node
// InstructionsLoaded hook. Record each instruction file that the session loads, with its hash.
// The orchestrator sets HARNESS_INSTRUCTIONS_LOG and copies the hashes into the run fingerprint.
// The hook has no decision control, so it only writes the log.

import { readStdinJson, appendJsonl, sha256File } from "./lib/io.mjs";

const logFile = process.env.HARNESS_INSTRUCTIONS_LOG || "";
if (logFile) {
  try {
    const input = await readStdinJson();
    appendJsonl(logFile, {
      file: input.file_path,
      memory_type: input.memory_type,
      load_reason: input.load_reason,
      parent: input.parent_file_path,
      sha256: input.file_path ? sha256File(input.file_path) : null,
    });
  } catch {
    // The log is for observability only.
  }
}
