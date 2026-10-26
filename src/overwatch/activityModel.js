// The Activity section's logic (spec section 9, item 4), kept apart from the other sections so it
// can become its own tab later. Days are Pacific YYYY-MM-DD strings.

import { daysBefore } from "../money/moneyFormat";
import { groupDetailPath, recordPath } from "../viewPaths";
import { RECORD_LINK_BASE } from "../shared/copyRecord";

const SOURCE_LABELS = { trigger: "Alfred", claude: "Claude", cli: "CLI", manual: "Manual" };
const LINKED_TYPES = new Set(["item", "intention", "execution", "job_application"]);

export function capitalize(text) {
  const s = String(text || "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Today", "Yesterday", else "Fri, Oct 23". */
export function dayLabel(day, today) {
  if (day === today) return "Today";
  if (day === daysBefore(today, 1)) return "Yesterday";
  return fullDay(day);
}

/** The second line's time: "4:28 am", or "Logged overnight" for the nightly run's rows. */
export function rowTime(row) {
  return isOvernight(row) ? "Logged overnight" : timeLabel(row.occurred_at);
}

/**
 * The nightly run logs a whole day per app ("sam:2026-10-24"), stamped when it ran or with a
 * placeholder noon, never the real time. Its day is the one in source_ref.
 */
export function isOvernight(row) {
  return row.source === "nightly";
}

/** The Pacific day a row belongs to: source_ref's date for nightly rows, else occurred_at's. */
export function rowDay(row) {
  const ref = isOvernight(row) && /:(\d{4}-\d{2}-\d{2})$/.exec(row.source_ref || "");
  if (ref) return ref[1];
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(row.occurred_at));
}

/** "Sun, Oct 25", always the real date (copy text never says Today or Yesterday). */
export function fullDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "4:28 am", Pacific. */
export function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })
    .toLowerCase();
}

/** "Oct 23", Pacific. */
export function shortDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

/** The source as shown; null for the nightly run's rows. */
export function sourceLabel(source) {
  if (!source || source === "nightly") return null;
  return SOURCE_LABELS[source] || capitalize(source);
}

/** Where a row links: groups to their page, other records to /<id>; null when there is no page. */
export function rowPath(row) {
  if (!row.target_id) return null;
  if (row.target_type === "group") return groupDetailPath(row.target_id);
  if (LINKED_TYPES.has(row.target_type)) return recordPath(row.target_id);
  return null;
}

/** The app and kind filters; null means All. */
export function applyFilters(rows, { app = null, kind = null }) {
  return rows.filter((r) => (!app || r.app_id === app) && (!kind || r.kind === kind));
}

/** [value, count] pairs for one field, most first, then by name. */
export function facets(rows, field) {
  const counts = {};
  for (const r of rows) counts[r[field]] = (counts[r[field]] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Rows of the same app, kind and title become one entry with a count; order follows each
 * group's newest row. Entries: { key, rows } where rows are newest first.
 */
export function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.app_id}\u0000${r.kind}\u0000${r.title}`;
    if (!groups.has(key)) groups.set(key, { key, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}

/**
 * The day's entries: rows sharing a group_id (a project), 2 or more of them, become one project
 * entry; the rest group by app, kind and title as before. Entries are ordered by their newest row.
 * { type: "project", groupId, rows } | { type: "rows", key, rows }
 */
export function dayEntries(rows) {
  const byGroup = new Map();
  for (const r of rows) if (r.group_id) byGroup.set(r.group_id, [...(byGroup.get(r.group_id) || []), r]);
  const projectIds = new Set([...byGroup].filter(([, rs]) => rs.length >= 2).map(([id]) => id));
  const entries = [
    ...[...projectIds].map((id) => ({ type: "project", key: `project:${id}`, groupId: id, rows: byGroup.get(id) })),
    ...groupRows(rows.filter((r) => !projectIds.has(r.group_id))).map((g) => ({ type: "rows", ...g })),
  ];
  const newest = (e) => e.rows.reduce((m, r) => (r.occurred_at > m ? r.occurred_at : m), "");
  return entries.sort((a, b) => (newest(b) > newest(a) ? 1 : newest(b) < newest(a) ? -1 : 0));
}

/** ", Steps 11 to 14" when every title names "Step <n>", else "". */
export function stepRange(rows) {
  const nums = rows.map((r) => /\bStep\s+(\d+)/i.exec(r.title || "")?.[1]);
  if (!nums.length || nums.some((n) => n === undefined)) return "";
  const lo = Math.min(...nums.map(Number));
  const hi = Math.max(...nums.map(Number));
  return lo === hi ? `, Step ${lo}` : `, Steps ${lo} to ${hi}`;
}

/** "Overwatch: 30 progress reports, Steps 11 to 14" or "Overwatch: 5 updates". */
export function projectTitle(name, rows) {
  const kinds = new Set(rows.map((r) => r.kind));
  const what = kinds.size === 1 ? `${rows.length} ${[...kinds][0]} reports` : `${rows.length} updates`;
  return `${name}: ${what}${stepRange(rows)}`;
}

/** "2:32 pm to 3:55 pm" (or one time when they match); nightly rows have no real time. */
export function timeRange(rows) {
  const timed = rows.filter((r) => !isOvernight(r));
  if (!timed.length) return "Logged overnight";
  const times = timed.map((r) => r.occurred_at).sort();
  const first = timeLabel(times[0]);
  const last = timeLabel(times[times.length - 1]);
  return first === last ? first : `${first} to ${last}`;
}

export function projectCopy(name, rows, dayText) {
  return {
    what: "activity",
    name: `${name}, ${dayText}`,
    facts: [`${rows.length} ${rows.length === 1 ? "row" : "rows"}`, stepRange(rows).replace(/^, /, "")],
    link: `${RECORD_LINK_BASE}${groupDetailPath(rows[0].group_id).slice(1)}`,
    question: "Where does this project stand now?",
  };
}

/** The copy for rows grouped by app, kind and title: the group copies once, its rows do not. */
export function sameTitleCopy(rows, appName, dayText) {
  const first = rows[0];
  return {
    what: "activity",
    name: `${appName}: ${first.title} ×${rows.length}, ${dayText}`,
    facts: [`Kind: ${capitalize(first.kind)}`, `Times: ${timeRange(rows)}`, `Source: ${first.source}`],
    question: "What should come next from this?",
  };
}

/** "Nothing logged today.", "Nothing logged on Fri, Oct 23.", "Nothing for Sam, Progress yesterday." */
export function emptyText(dayText, filterNames) {
  const when = dayText === "Today" || dayText === "Yesterday" ? dayText.toLowerCase() : `on ${dayText}`;
  return filterNames.length ? `Nothing for ${filterNames.join(", ")} ${when}.` : `Nothing logged ${when}.`;
}

export function activityCopy(row, appName) {
  const path = rowPath(row);
  return {
    what: "activity",
    name: row.title,
    facts: [
      `App: ${appName}`,
      `Kind: ${capitalize(row.kind)}`,
      isOvernight(row)
        ? `When: ${fullDay(rowDay(row)).replace(/^\w+, /, "")}`
        : `When: ${shortDate(row.occurred_at)}, ${timeLabel(row.occurred_at)}`,
      `Source: ${row.source}${row.source_ref ? ` (${row.source_ref})` : ""}`,
    ],
    link: path ? `${RECORD_LINK_BASE}${path.slice(1)}` : null,
    question: "What should come next from this?",
  };
}
