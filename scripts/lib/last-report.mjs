// .clip/last-report.json: the run tag and time of the last report clip.mjs
// pushed from a checkout. Read by Switchboard (tools/claude-sessions).

import path from "node:path";
import { writeAtomic } from "./session-status.mjs";

export const LAST_REPORT_RELATIVE = ".clip/last-report.json";
export const REPORT_RELATIVE = ".clip/last-report.md";

/** True when `file` is the checkout's own .clip/last-report.md: only that push is "the report". */
export function isCheckoutReport(root, file) {
  if (!root || !file) return false;
  return path.resolve(file).toLowerCase() === path.resolve(root, REPORT_RELATIVE).toLowerCase();
}

/** Write the record; returns it, or null on any failure. Never throws. */
export function writeLastReport(root, { runTag, title, pushedAt = new Date() } = {}, file) {
  try {
    const record = {
      run_tag: runTag || null,
      title: title ?? null,
      pushed_at: pushedAt.toISOString(),
    };
    writeAtomic(file ?? path.join(root, LAST_REPORT_RELATIVE), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch {
    return null;
  }
}
