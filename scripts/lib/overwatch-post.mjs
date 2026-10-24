// Overwatch Step 7: claims-block events go into a local outbox and a detached sender posts them to overwatch-ingest.
//
// Nothing here runs on the network inside the claims lock or the guard hook. queueEvents appends a line per event
// (local file I/O, under the claims lock the caller holds) and kickSender starts `scripts/overwatch-post.mjs` as a
// detached process, which drains the outbox and posts it. Every function a caller on the hook path uses swallows its
// own errors: a lost event is acceptable, a refused or slowed edit is not.
//
// Spec: docs/technical-spec-overwatch-q4n.md sections 4.5 and 5.1.

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const OUTBOX_FILE = "alfred-overwatch-outbox.jsonl";
export const SENDER_SCRIPT = path.join("scripts", "overwatch-post.mjs");
export const BATCH_SIZE = 200; // overwatch-ingest's MAX_EVENTS
export const OUTBOX_CAP = 5000; // lines kept when sends keep failing; the oldest go first
export const SENDER_STALE_MS = 120_000;
const LOG_CAP_BYTES = 256 * 1024;

// The sender's working files sit beside the outbox, in the shared git dir.
export const sendingFile = (outbox) => `${outbox}.sending`;
export const senderLock = (outbox) => `${outbox}.lock`;
export const senderLog = (outbox) => `${outbox}.log`;

// ---------------------------------------------------------------------------
// queueing (claims lock held by the caller)
// ---------------------------------------------------------------------------

export function readLines(file) {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
}

/** Append events as JSON lines. Throws; queueBlockEvents in claims-core catches. */
export function queueEvents(outbox, events) {
  if (!events.length) return;
  appendFileSync(outbox, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
}

/** Start the detached sender unless one is already running. Never throws. */
export function kickSender(ctx, { env = process.env, spawnImpl = spawn } = {}) {
  try {
    if (env.OVERWATCH_SENDER === "off" || !ctx.outboxFile) return false;
    if (lockIsFresh(senderLock(ctx.outboxFile))) return false;
    const child = spawnImpl(process.execPath, [path.join(ctx.root, SENDER_SCRIPT)], {
      cwd: ctx.root,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function lockIsFresh(lock, now = Date.now()) {
  try {
    return now - statSync(lock).mtimeMs < SENDER_STALE_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// the sender
// ---------------------------------------------------------------------------

/** One sender at a time: a lock file, taken over when stale. Returns a release function, or null. */
export function takeSenderLock(outbox, now = Date.now()) {
  const lock = senderLock(outbox);
  for (let i = 0; i < 2; i += 1) {
    try {
      writeFileSync(lock, `${process.pid} ${new Date(now).toISOString()}\n`, { flag: "wx" });
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST" || lockIsFresh(lock, now)) return null;
      rmSync(lock, { force: true });
    }
  }
  return null;
}

export function log(outbox, line, now = new Date()) {
  try {
    const file = senderLog(outbox);
    if (existsSync(file) && statSync(file).size > LOG_CAP_BYTES) renameSync(file, `${file}.old`);
    appendFileSync(file, `${now.toISOString()} ${line}\n`, "utf8");
  } catch {
    /* the log is a convenience */
  }
}

/**
 * Drain the outbox and post it in batches. `withLock(fn)` runs fn under the claims lock, so no event is appended
 * between the read and the rename. What could not be sent goes back into the outbox, capped at OUTBOX_CAP lines.
 * Returns a summary, also written to the log.
 */
export async function sendOutbox({ outbox, withLock, settings, fetchImpl = fetch }) {
  // A `.sending` file left by a sender that died is sent first.
  withLock(() => {
    const lines = [...readLines(sendingFile(outbox)), ...readLines(outbox)];
    writeFileSync(sendingFile(outbox), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    rmSync(outbox, { force: true });
  });
  const lines = readLines(sendingFile(outbox));
  const summary = { sent: 0, inserted: 0, updated: 0, unchanged: 0, dropped: 0, kept: 0 };
  if (!lines.length) {
    rmSync(sendingFile(outbox), { force: true });
    return summary;
  }

  const events = [];
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch {
      summary.dropped += 1;
    }
  }

  let unsent = [];
  if (!settings.url || !settings.secret) {
    unsent = events;
    log(outbox, `not sent: OVERWATCH_INGEST_URL unset, or OVERWATCH_INGEST_SECRET unset or under 32 characters (${events.length} kept)`);
  } else {
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      let status = 0;
      let body = null;
      try {
        const r = await fetchImpl(settings.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-overwatch-secret": settings.secret },
          body: JSON.stringify({ kind: "claim_block", events: batch }),
        });
        status = r.status;
        body = await r.json().catch(() => null);
      } catch (err) {
        log(outbox, `network error: ${err.message}`);
      }
      if (status === 200 && body?.ok) {
        summary.sent += batch.length;
        for (const k of ["inserted", "updated", "unchanged"]) summary[k] += body[k] ?? 0;
        for (const r of body.rejected ?? []) {
          summary.dropped += 1;
          log(outbox, `rejected ${JSON.stringify(batch[r.index])}: ${r.error}`);
        }
      } else if (status === 400) {
        // The whole batch was refused as malformed; sending it again cannot help.
        summary.dropped += batch.length;
        log(outbox, `batch of ${batch.length} refused (400): ${body?.error ?? "no body"}`);
      } else {
        // 401, 5xx or no answer: keep this batch and everything after it for the next run.
        if (status) log(outbox, `HTTP ${status}: ${body?.error ?? "no body"}; ${events.length - i} kept`);
        unsent = events.slice(i);
        break;
      }
    }
  }

  withLock(() => {
    const merged = [...unsent.map((e) => JSON.stringify(e)), ...readLines(outbox)];
    const kept = merged.slice(-OUTBOX_CAP);
    if (merged.length > kept.length) log(outbox, `outbox over ${OUTBOX_CAP} lines; ${merged.length - kept.length} oldest dropped`);
    summary.dropped += merged.length - kept.length;
    if (kept.length) writeFileSync(outbox, `${kept.join("\n")}\n`, "utf8");
    else rmSync(outbox, { force: true });
    rmSync(sendingFile(outbox), { force: true });
  });
  summary.kept = unsent.length;
  log(outbox, `sent ${summary.sent} (inserted ${summary.inserted}, updated ${summary.updated}, unchanged ${summary.unchanged}), dropped ${summary.dropped}, kept ${summary.kept}`);
  return summary;
}

// ---------------------------------------------------------------------------
// settings, as clip.mjs reads them
// ---------------------------------------------------------------------------

/** A Windows USER environment variable from the registry, for a shell that predates setx. Null on any failure. */
function fromWindowsUserEnv(name) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** URL and secret from the environment, else the registry. The secret is never logged or printed. */
export function readSettings(env = process.env, fromRegistry = fromWindowsUserEnv) {
  const get = (name) => (env[name] || "").trim() || fromRegistry(name) || "";
  const secret = get("OVERWATCH_INGEST_SECRET");
  return { url: get("OVERWATCH_INGEST_URL"), secret: secret.length >= 32 ? secret : "" };
}
