// Per-checkout session state for the Switchboard panel: .clip/session-status.json.
// Written by the Claude Code hooks, read by tools/claude-sessions. Reads files
// only, never runs git, and never throws: a failed write must not touch a prompt.
//
// Interface: the file's format (the states, run_tag, prompt_at, event) and
// writeAtomic. Used by .claude/hooks/prompt-check.mjs and session-status.mjs, and
// by last-report.mjs. Read on the panel side by claude-sessions.ahk (ReadStatus).

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_FILE } from "./project-code.mjs";

export const STATUS_RELATIVE = ".clip/session-status.json";
// "wrong": prompt-check refused a prompt in this window (wrong window, bad or
// missing tag). Its own state, not a red latch, so Switchboard can clear it.
export const STATES = ["processing", "approval", "waiting", "blocked", "wrong"];

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

/**
 * The next record: red latches on approval/blocked and clears on processing or
 * wrong. `promptAt` is set by a prompt Alex typed, never by machine traffic:
 * Switchboard counts a report pushed after it as the answer to it.
 */
export function nextStatus(prev, state, { root, sessionId, transcriptPath, runTag, event, promptAt, now = new Date() }) {
  const red =
    state === "approval" || state === "blocked" ? true : state === "processing" || state === "wrong" ? false : !!prev?.red;
  return {
    state,
    since: prev?.state === state && prev?.since ? prev.since : now.toISOString(),
    project: projectFor(root, prev),
    session_id: sessionId || prev?.session_id || null,
    // The panel tails it for the interrupt line, which no hook reports.
    transcript_path: transcriptPath || prev?.transcript_path || null,
    // The CLI's current run: set by a tagged prompt, carried over by every other write.
    run_tag: runTag || prev?.run_tag || null,
    prompt_at: promptAt || prev?.prompt_at || null,
    red,
    event: event ?? null,
  };
}

// A background agent or shell this session started, and the notice that it ended.
const LAUNCH = [
  /Async agent launched successfully[\s\S]{0,400}?agentId: ([a-z0-9]+)/g,
  /running in background with ID: ([a-z0-9]+)/g,
];
const ENDED = /<task-id>([a-z0-9]+)<\/task-id>[\s\S]{0,400}?<status>(?!running)[a-z_]+<\/status>/g;
/** Launches older than this are assumed over, notice or not. */
export const BACKGROUND_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * The ids of background tasks this session's transcript (JSONL) shows started
 * and not yet ended. A turn that stops while one runs is not the session
 * waiting for Alex: the hand-back will start the next turn by itself.
 */
export function pendingBackground(transcript, now = Date.now()) {
  const started = new Set();
  const ended = new Set();
  for (const line of String(transcript ?? "").split("\n")) {
    if (line.includes("<task-id>")) for (const m of line.matchAll(ENDED)) ended.add(m[1]);
    if (!line.includes("agentId: ") && !line.includes("running in background with ID: ")) continue;
    let at = NaN;
    try {
      at = Date.parse(JSON.parse(line).timestamp);
    } catch {
      /* not a JSON line: no age, so it counts */
    }
    if (now - at > BACKGROUND_MAX_MS) continue;
    for (const re of LAUNCH) for (const m of line.matchAll(re)) started.add(m[1]);
  }
  return [...started].filter((id) => !ended.has(id));
}

/** pendingBackground for a transcript file; [] when it cannot be read. */
export function pendingBackgroundIn(file, now = Date.now()) {
  try {
    return file ? pendingBackground(readFileSync(file, "utf8"), now) : [];
  } catch {
    return [];
  }
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
export function writeSessionStatus(root, state, { sessionId, transcriptPath, runTag, event, promptAt, file, onlyIf } = {}) {
  try {
    if (!STATES.includes(state)) return null;
    const target = file ?? statusFile(root);
    const prev = readStatus(target);
    if (onlyIf && !onlyIf(prev)) return null;
    const record = nextStatus(prev, state, { root, sessionId, transcriptPath, runTag, event, promptAt });
    writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch {
    return null;
  }
}

/** Switchboard's tap on a "Wrong window" tile: back to waiting, only if it is still wrong. */
export function clearWrong(root) {
  return writeSessionStatus(root, "waiting", { event: "cleared on Switchboard", onlyIf: (prev) => prev?.state === "wrong" });
}

// `node scripts/lib/session-status.mjs clear-wrong <checkout>`, run by Switchboard.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "clear-wrong") {
  process.exitCode = process.argv[3] && clearWrong(path.resolve(process.argv[3])) ? 0 : 1;
}
