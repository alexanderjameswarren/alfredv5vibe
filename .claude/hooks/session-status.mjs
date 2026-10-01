#!/usr/bin/env node
// Stop, Notification and PostToolUse hook: record this session's state in
// .clip/session-status.json for the Switchboard panel. Always exits 0 and prints
// nothing, so it can never hold up or change a turn. The prompt-submit states
// are written by prompt-check.mjs.

import { readFileSync } from "node:fs";
import path from "node:path";

try {
  const payload = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  const event = payload.hook_event_name;
  const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
  const file = process.env.SESSION_STATUS_FILE
    ? path.resolve(process.env.SESSION_STATUS_FILE)
    : path.join(root, ".clip", "session-status.json");

  // PostToolUse runs after every tool call: leave before loading the writer
  // unless the file says approval.
  if (event === "PostToolUse") {
    let current;
    try {
      current = JSON.parse(readFileSync(file, "utf8")).state;
    } catch {
      /* no file: nothing to clear */
    }
    if (current !== "approval") process.exit(0);
  }

  const { writeSessionStatus, stateForNotification } = await import("../../scripts/lib/session-status.mjs");
  const opts = { sessionId: payload.session_id, transcriptPath: payload.transcript_path, event, file };

  if (event === "Stop") writeSessionStatus(root, "waiting", opts);
  else if (event === "PostToolUse")
    writeSessionStatus(root, "processing", { ...opts, onlyIf: (prev) => prev?.state === "approval" });
  else if (event === "Notification") {
    const state = stateForNotification(payload);
    if (state) writeSessionStatus(root, state, opts);
  }
} catch {
  // A status write is never worth failing a hook over.
}
process.exit(0);
