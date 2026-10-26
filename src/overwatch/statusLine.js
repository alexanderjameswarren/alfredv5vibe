// The status line at the top of the Overwatch tab (spec section 9, item 0). Exactly three
// wordings: "everything scanned", "partially scanned: <what was not checked>", or a red
// "Scan failed · see Action Required" (a failed run always raises an Action Required item).

import { appDisplayName } from "./appNames";

// The run's flags keys (nightly prompt Step 7, weekly Step 10), in plain words.
const PART_LABELS = {
  quiet_apps: "quiet apps",
  stalled: "stalls",
  waiting_on_alex: "waits on you",
  overruns: "overruns",
  over_limit: "the project limit",
  scope_changes: "scope changes",
  empty_projects: "empty Projects",
  backlogs: "inbox backlogs",
  unrouted: "unrouted items",
  low_confidence_routing: "routing",
  stopped_schedules: "schedules",
  orphan_runs: "open runs",
  task_health: "scheduled tasks",
  claim_blocks: "claim blocks",
  fading: "fading items",
  overdue_intentions: "overdue intentions",
  deadline_no_date: "deadlines",
  watch_ended: "watch items",
  checks_due: "checks due",
  feature_watch: "release notes",
  friction: "friction",
  estimate_accuracy: "estimate accuracy",
  drift_audit: "the drift audit",
};


/**
 * One `details.skipped` entry in plain words: "Money not checked". New runs store
 * { part, error }; older runs stored a string, "<part> — <error>".
 */
export function skippedLabel(entry, appNames = {}) {
  const raw = typeof entry === "string" ? entry : entry?.part || "";
  const part = raw.split(" — ")[0].trim();
  const [kind, rest] = part.includes(":") ? [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1)] : ["count", part];
  if (kind === "pull") return `${appDisplayName(rest, appNames)} not checked`;
  if (kind === "inbox") return "an Action Required item not raised";
  if (kind === "nudge" || kind === "step8") return "a nudge not sent";
  const label = PART_LABELS[rest] || rest.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} not checked`;
}

/** "4:31 AM" today, "Oct 25, 4:31 AM" on another day. */
export function asOfLabel(iso, now = new Date()) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/**
 * { text, warning } from the latest nightly and weekly runs. A weekly run counts only when it
 * started in the last day, so it speaks on the weekly day and not all week.
 */
export function statusLine({ nightly, weekly }, now = new Date(), appNames = {}) {
  if (!nightly) return { text: "No report yet. The nightly run writes one at 4:20 am.", warning: false };
  const recentWeekly = weekly && now - new Date(weekly.started_at) < 24 * 3600 * 1000 ? weekly : null;
  const runs = [nightly, recentWeekly].filter(Boolean);
  if (runs.some((r) => r.status === "failed")) return { text: "Scan failed · see Action Required", warning: true };
  const asOf = `Report as of ${asOfLabel(nightly.finished_at || nightly.started_at, now)}`;
  const gaps = [...new Set(runs.flatMap((r) => r.details?.skipped || []).map((e) => skippedLabel(e, appNames)))];
  if (!gaps.length) return { text: `${asOf} · everything scanned`, warning: false };
  return { text: `${asOf} · partially scanned: ${gaps.join(", ")}`, warning: false };
}
