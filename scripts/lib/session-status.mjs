// Per-checkout session state for the Switchboard panel: .clip/session-status.json.
// Written by the Claude Code hooks, read by tools/claude-sessions. Reads files
// only, never runs git, and never throws: a failed write must not touch a prompt.

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_FILE } from "./project-code.mjs";

export const STATUS_RELATIVE = ".clip/session-status.json";
export const STATES = ["processing", "approval", "waiting", "blocked"];

export const APPROVAL_TYPES = [
  "permission_prompt",
  "worker_permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
];

/** Notification hook input to a state, or null for "write nothing". The message is a fallback only. */
export function stateForNotification({ notification_type: type, message } = {}) {
  if (type) {
    if (APPROVAL_TYPES.includes(type)) return "approval";
    return type === "idle_prompt" ? "waiting" : null;
  }
  const text = String(message ?? "").toLowerCase();
  if (text.includes("permission")) return "approval";
  if (text.includes("waiting for your input")) return "waiting";
  return null;
}

/** The status file for a checkout; SESSION_STATUS_FILE redirects it for tests. */
export function statusFile(root) {
  return process.env.SESSION_STATUS_FILE
    ? path.resolve(process.env.SESSION_STATUS_FILE)
    : path.join(root, STATUS_RELATIVE);
}

export function readStatus(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Worktree: its folder name. Main: the binding file, then the last write, then "main". */
export function projectFor(root, prev) {
  const dotGit = path.join(root, ".git");
  try {
    if (statSync(dotGit).isFile()) return path.basename(root);
  } catch {
    /* no .git: treat as main */
  }
  const binding = process.env.CLAIMS_PROJECT_FILE
    ? path.resolve(process.env.CLAIMS_PROJECT_FILE)
    : path.join(dotGit, PROJECT_FILE);
  try {
    const { code } = JSON.parse(readFileSync(binding, "utf8"));
    if (typeof code === "string" && code) return code;
  } catch {
    /* unbound */
  }
  return (typeof prev?.project === "string" && prev.project) || "main";
}

/** The next record: red latches on approval/blocked and clears only on processing. */
export function nextStatus(prev, state, { root, sessionId, transcriptPath, event, now = new Date() }) {
  const red = state === "approval" || state === "blocked" ? true : state === "processing" ? false : !!prev?.red;
  return {
    state,
    since: prev?.state === state && prev?.since ? prev.since : now.toISOString(),
    project: projectFor(root, prev),
    session_id: sessionId || prev?.session_id || null,
    // The panel tails it for the interrupt line, which no hook reports.
    transcript_path: transcriptPath || prev?.transcript_path || null,
    red,
    event: event ?? null,
  };
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Atomic write: tmp then rename, retried briefly if a reader holds the file. */
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(tmp, text, "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 3) {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone */
        }
        throw err;
      }
      pause(10);
    }
  }
}

/**
 * Record `state` for the checkout at `root`. Returns the record written, or
 * null if nothing was written. Never throws.
 */
export function writeSessionStatus(root, state, { sessionId, transcriptPath, event, file, onlyIf } = {}) {
  try {
    if (!STATES.includes(state)) return null;
    const target = file ?? statusFile(root);
    const prev = readStatus(target);
    if (onlyIf && !onlyIf(prev)) return null;
    const record = nextStatus(prev, state, { root, sessionId, transcriptPath, event });
    writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch {
    return null;
  }
}
