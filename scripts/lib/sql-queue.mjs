// Queue a SQL file with switchboard-runner, for Claude to review and Alex to approve by a link.
// The secret is sent in a header and never printed, logged or put in an error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIN_SECRET = 32;
const MAX_DESCRIPTION = 300;

/** A Windows USER environment variable from the registry, for a shell that predates setx. Null on any failure. */
function fromWindowsUserEnv(name) {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** The key, and the queue's address: its own setting, else beside the clipboard's function. */
export function readQueueSettings(env = process.env, fromRegistry = fromWindowsUserEnv) {
  const get = (name) => (env[name] || "").trim() || fromRegistry(name) || "";
  const secret = get("SWITCHBOARD_QUEUE_SECRET");
  const clipboard = get("CLIPBOARD_URL");
  const beside = clipboard ? clipboard.replace(/\/clip-capture\/?$/, "/switchboard-runner/queue") : "";
  return { url: get("SWITCHBOARD_QUEUE_URL") || beside, secret: secret.length >= MIN_SECRET ? secret : "" };
}

const refuse = (error) => ({ ok: false, error });

/** "2, unknown,0" as [2, "unknown", 0], or null if any value is neither a row count nor "unknown". */
function parseExpect(text) {
  const values = text.split(",").map((v) => v.trim());
  if (!values.every((v) => v === "unknown" || /^\d+$/.test(v))) return null;
  return values.map((v) => (v === "unknown" ? v : Number(v)));
}

/** Returns the function's answer, or { ok: false, error } without sending anything. */
export async function queueFile({ file, project, description, expect, test }, settings, fetchFn = fetch) {
  if (!project || project === "main") return refuse("no project code here: pass --project <code>.");
  const said = (description ?? "").trim();
  if (!said || said.length > MAX_DESCRIPTION || /[\r\n]/.test(said)) {
    return refuse(`--describe needs one sentence, on one line of at most ${MAX_DESCRIPTION} characters, saying what the SQL does: what it inserts, updates, deletes or creates, in which table, and roughly how many rows or what values.`);
  }
  if (test && expect !== undefined) return refuse("--expect doesn't go with --test: a test action is undone.");
  const expected = expect === undefined ? undefined : parseExpect(expect);
  if (expected === null) return refuse('--expect needs comma-separated values, one for each insert, update and delete in order: a row count, or "unknown" if it can\'t be known.');
  if (!settings.secret) return refuse("SWITCHBOARD_QUEUE_SECRET is not set, or is too short.");
  if (!settings.url) return refuse("no queue URL: set SWITCHBOARD_QUEUE_URL or CLIPBOARD_URL.");
  if (path.extname(file ?? "").toLowerCase() !== ".sql") return refuse("the file must be a .sql file.");
  let sql;
  try {
    sql = readFileSync(file, "utf8");
  } catch {
    return refuse(`cannot read ${file}.`);
  }
  if (!sql.trim()) return refuse(`${file} is empty.`);

  try {
    const res = await fetchFn(settings.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-switchboard-queue-secret": settings.secret },
      body: JSON.stringify({ project_code: project, sql, description: said, expected, ...(test ? { test: true } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    return body.ok ? body : { ok: false, error: body.error ?? `the queue answered ${res.status}.`, reasons: body.reasons };
  } catch {
    // The error's own text is not repeated: a failed request can echo what it carried.
    return refuse("could not reach the queue.");
  }
}

export function describeResult(out) {
  if (out.ok) return `Queued.\n  action id: ${out.action_id}\n  headline:  ${out.headline}`;
  const reasons = (out.reasons ?? []).map((r) => `\n  - ${r}`).join("");
  return `Not queued: ${out.error}${reasons}`;
}
