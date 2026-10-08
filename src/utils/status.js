// Status on items and intentions (migration 088): the pure rules the UI needs.

export const STATUSES = ["someday", "active", "background", "closed"];

export const STATUS_LABELS = {
  someday: "Someday",
  active: "Active",
  background: "Background",
  closed: "Closed",
};

export const DEFAULT_STATUS_FILTER = ["someday", "active"];

// A row made in the browser before the database answered has no status yet;
// the column default is someday, so that is what it is.
export function statusOf(row) {
  return STATUSES.includes(row?.status) ? row.status : "someday";
}

// Nothing pulls a row out of closed (status_guard), so Start Now, Schedule and
// Create Intention are disabled until it is set back to Active by hand.
export function closedBlockTitle(row, kind) {
  return statusOf(row) === "closed" ? `This ${kind} is closed. Set it to Active to use it.` : null;
}

export function statusCounts(rows) {
  const counts = { someday: 0, active: 0, background: 0, closed: 0 };
  for (const row of rows) counts[statusOf(row)] += 1;
  return counts;
}

/** Rows carrying `tag`, or all of them when no tag is selected. */
export function withTag(rows, tag) {
  return tag ? rows.filter((row) => row.tags && row.tags.includes(tag)) : rows;
}

export function filterByStatus(rows, selected) {
  return rows.filter((row) => selected.includes(statusOf(row)));
}

// Background and closed sink below the rest; order within each group is kept.
export function rankByStatus(rows) {
  const low = (row) => (statusOf(row) === "background" || statusOf(row) === "closed" ? 1 : 0);
  return rows
    .map((row, i) => [row, i])
    .sort((a, b) => low(a[0]) - low(b[0]) || a[1] - b[1])
    .map(([row]) => row);
}

/**
 * Intentions in order of what is happening now: an open run (active, then
 * paused), then scheduled (soonest date first), unscheduled, background, closed.
 * Stable within a group, so a list's own sort still orders each group.
 * `openExecutions` are the active and paused ones.
 */
export function rankByActivity(intents, events, openExecutions) {
  const tier = (intent) => {
    const open = openExecutions.find((x) => x.intentId === intent.id);
    if (open) return open.status === "paused" ? 1 : 0;
    const status = statusOf(intent);
    if (status === "closed") return 5;
    if (status === "background") return 4;
    return liveEventsFor(events, intent.id).length ? 2 : 3;
  };
  return intents
    .map((row, i) => ({ row, i, t: tier(row), d: String(liveEventsFor(events, row.id)[0]?.time || "") }))
    .sort((a, b) => a.t - b.t || (a.t === 2 ? a.d.localeCompare(b.d) : 0) || a.i - b.i)
    .map(({ row }) => row);
}

// The database refuses a move back to someday (status_guard), so the picker
// offers someday only while the row is still someday.
export function statusOptionsFor(current) {
  return current === "someday" ? STATUSES : STATUSES.filter((s) => s !== "someday");
}

export function toggleStatusFilter(selected, status) {
  return selected.includes(status)
    ? selected.filter((s) => s !== status)
    : STATUSES.filter((s) => s === status || selected.includes(s));
}

/** Rows whose status went from someday or background to active. */
export function flippedToActive(before, fresh) {
  const was = new Map(before.map((r) => [r.id, statusOf(r)]));
  return fresh.filter(
    (r) => r.status === "active" && ["someday", "background"].includes(was.get(r.id)),
  );
}

/** Items an event or execution insert can flip (088): the intention's item and every id carried. */
export function carriedItems(intent, itemIds, items) {
  const ids = new Set([...(itemIds || []), intent?.itemId].filter(Boolean));
  return items.filter((i) => i && ids.has(i.id));
}

/** Copy status and status_changed_at from fresh rows onto state rows. */
export function mergeStatuses(rows, fresh) {
  if (!fresh.length) return rows;
  const byId = new Map(fresh.map((r) => [r.id, r]));
  return rows.map((row) => {
    const f = byId.get(row.id);
    if (!f || (f.status === row.status && f.statusChangedAt === row.statusChangedAt)) return row;
    return { ...row, status: f.status, statusChangedAt: f.statusChangedAt };
  });
}

/** Live (unarchived) events of an intention, earliest first. */
export function liveEventsFor(events, intentId) {
  return events
    .filter((e) => e.intentId === intentId && !e.archived)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

// A date is the plan for a day; once its run is ACTIVE, moving it is
// incoherent. A paused run may be moved ("I'll finish it Friday").
export const RUN_ACTIVE_MOVE_REASON = "An execution is in progress. Pause or cancel it before moving the date.";

/**
 * The one rule behind Start Now / Schedule on intention detail, item detail and
 * the cards. An intention has one live event and at most one open execution.
 * `executions` are the open ones (active and paused).
 */
export function recordActions(intent, events, executions) {
  const open = intent ? executions.find((e) => e.intentId === intent.id) || null : null;
  const live = intent ? liveEventsFor(events, intent.id)[0] || null : null;
  return {
    open,
    live,
    primaryLabel: open ? "Continue" : "Start Now",
    scheduleLabel: live ? "Reschedule" : "Schedule",
    // Why the date cannot move now, or null.
    moveBlocked: open?.status === "active" ? RUN_ACTIVE_MOVE_REASON : null,
    // The picker opens on the date being moved, else today (set by the caller).
    liveDate: live ? String(live.time).slice(0, 10) : null,
  };
}

const STORE_PREFIX = "alfred.status.";

export function readStoredStatusFilter(page) {
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + page);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return STATUSES.filter((s) => parsed.includes(s));
  } catch {
    // Unreadable storage falls back to the default.
  }
  return DEFAULT_STATUS_FILTER;
}

export function writeStoredStatusFilter(page, selected) {
  try {
    window.localStorage.setItem(STORE_PREFIX + page, JSON.stringify(selected));
  } catch {
    // Not persisting is acceptable; the filter still works for this sitting.
  }
}
