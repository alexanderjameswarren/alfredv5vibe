import { archiveCutoff, isRecentlyArchived } from "../utils/inboxArchive";

// The inbox is read in slices, never whole: past 1000 rows PostgREST silently returns an
// arbitrary 1000 (inbox_rowcap-x7k). Live and recently archived load with the app;
// older archived rows load by page or by id.

/** PostgREST's max-rows. A select("*") that returns exactly this many was cut off. */
export const POSTGREST_ROW_CAP = 1000;
export const ARCHIVE_PAGE_SIZE = 50;

/** The live inbox. `archived` is nullable, and a NULL row is live. */
export function liveInboxQuery(db) {
  return db.from("inbox").select("*").not("archived", "is", true);
}

/** Archived inside the window, dated by triaged_at (see recentlyArchived). */
export function recentArchivedQuery(db, now = new Date()) {
  return db.from("inbox").select("*").eq("archived", true).gte("triaged_at", archiveCutoff(now));
}

// Older than the window: stamped before the cutoff, or never stamped (pre-066).
function olderArchived(query, now) {
  return query.eq("archived", true).or(`triaged_at.lt.${archiveCutoff(now)},triaged_at.is.null`);
}

/** One page of older archived rows: newest triaged_at first, unstamped last by updated_at. */
export function olderArchivedPageQuery(db, offset = 0, now = new Date()) {
  return olderArchived(db.from("inbox").select("*"), now)
    .order("triaged_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + ARCHIVE_PAGE_SIZE - 1);
}

/** How many rows "Show all" can reveal. A count only: no rows on the wire. */
export function olderArchivedCountQuery(db, now = new Date()) {
  return olderArchived(db.from("inbox").select("id", { count: "exact", head: true }), now);
}

export function inboxRowsByIdQuery(db, ids) {
  return db.from("inbox").select("*").in("id", ids);
}

/** Logs when a whole-table read hit the cap, so the next silent truncation is not silent. */
export function warnIfCapped(table, rows) {
  if (Array.isArray(rows) && rows.length === POSTGREST_ROW_CAP) {
    console.warn(
      `[Alfred] ${table} returned exactly ${POSTGREST_ROW_CAP} rows, PostgREST's cap: some rows are missing.`,
    );
  }
  return rows;
}

const byCreatedAt = (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "");

/** Rows merged into the inbox list by id, later ones winning, in the list's createdAt order. */
export function mergeInboxRows(prev, rows) {
  const byId = new Map((prev || []).map((r) => [r.id, r]));
  for (const r of rows || []) byId.set(r.id, r);
  return [...byId.values()].sort(byCreatedAt);
}

/**
 * A refresh's live and recent rows replace those slices; older archived rows already
 * loaded (Show all pages, rows fetched by id) are kept unless the refresh has them.
 */
export function mergeInboxRefresh(fresh, prev, now = new Date()) {
  const freshIds = new Set((fresh || []).map((r) => r.id));
  const keep = (prev || []).filter(
    (r) => !freshIds.has(r.id) && r.archived && !isRecentlyArchived(r, now),
  );
  return mergeInboxRows(keep, fresh);
}

/** The capture a /<id> result needs from the inbox list, or null. */
export function inboxIdOfRecord(result) {
  const row = result?.row;
  if (!row) return null;
  if (result.table === "inbox") return row.id || null;
  if (result.table === "clips" || result.table === "reminders") return row.inbox_id || null;
  return null;
}
