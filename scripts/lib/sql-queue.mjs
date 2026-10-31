// Queue a SQL file with switchboard-runner, for Claude to review and Alex to approve by a link.
// The secret is sent in a header and never printed, logged or put in an error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const MIN_SECRET = 32;

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

/** Returns the function's answer, or { ok: false, error } without sending anything. */
export async function queueFile({ file, project }, settings, fetchFn = fetch) {
  if (!project || project === "main") return refuse("no project code here: pass --project <code>.");
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
      body: JSON.stringify({ project_code: project, sql }),
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
