#!/usr/bin/env node
// Stop, Notification and PostToolUse hook: record this session's state in
// .clip/session-status.json for the Switchboard panel. Always exits 0 and prints
// nothing, so it can never hold up or change a turn. The prompt-submit states
// are written by prompt-check.mjs.
//
// Owns: the Stop, Notification and PostToolUse states in .clip/session-status.json.
// Uses: scripts/lib/session-status.mjs (the file's format and writes).

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

  const { writeSessionStatus, stateForNotification, pendingBackgroundIn } = await import(
    "../../scripts/lib/session-status.mjs"
  );
  const opts = { sessionId: payload.session_id, transcriptPath: payload.transcript_path, event, file };
  // A turn that ends while this session's own subagents or background shells
  // still run is not waiting for Alex: their hand-back starts the next turn.
  // Recording "waiting" then showed red "Check CLI" mid-run (bug 11).
  const waiting = () =>
    pendingBackgroundIn(payload.transcript_path).length
      ? writeSessionStatus(root, "processing", { ...opts, event: `${event} (background running)` })
      : writeSessionStatus(root, "waiting", opts);

  if (event === "Stop") waiting();
  else if (event === "PostToolUse")
    writeSessionStatus(root, "processing", { ...opts, onlyIf: (prev) => prev?.state === "approval" });
  else if (event === "Notification") {
    const state = stateForNotification(payload);
    if (state === "waiting") waiting();
    else if (state) writeSessionStatus(root, state, opts);
  }
} catch {
  // A status write is never worth failing a hook over.
}
process.exit(0);
