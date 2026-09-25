/**
 * What happened to the captures that have left the inbox — Alfred Clipboard, Step 22.
 *
 * Design: docs/inbox-list-mockups/README.md §5, approved 2026-09-24.
 *
 * Pure — no React, no Supabase — because the window, the ordering and the wording of
 * "what happened" are the whole of this feature and all three are worth asserting
 * without rendering anything.
 *
 * ── Why archived rows are now in state at all ─────────────────────────────────
 *
 * They were always FETCHED. `loadData` and `refreshData` both did
 * `supabase.from("inbox").select("*")` — no filter — and then threw the archived ones
 * away in JavaScript, which is why this section costs nothing at the network: the rows
 * were already on the wire. Alfred.jsx now keeps them, holds ONE list, and derives the
 * live inbox and this section from it. Two lists kept in step by hand is what the
 * pinned-footer rounds were about.
 */

/** How far back the section reaches before "Show all" is needed. */
export const RECENT_ARCHIVE_DAYS = 7;

/**
 * When a capture left the inbox.
 *
 * `triagedAt` is the real answer and both writers set it — `discardInboxItem` and the
 * archive step of `handleInboxSave`. The fallbacks are for rows archived before
 * migration 066 gave the column a job, which have no stamp at all; ordering them by
 * `createdAt` puts them somewhere sensible rather than at the epoch.
 */
export function archivedAt(inboxItem) {
  return inboxItem?.triagedAt || inboxItem?.updatedAt || inboxItem?.createdAt || "";
}

/** Every archived capture, newest departure first. */
function allArchived(inboxItems) {
  return (Array.isArray(inboxItems) ? inboxItems : [])
    .filter((i) => i?.archived)
    .sort((a, b) => archivedAt(b).localeCompare(archivedAt(a)));
}

/**
 * The rows the section shows.
 *
 * ⚠️ NEWEST FIRST, which is the opposite of the live inbox's oldest-first order, and
 * deliberately so. The inbox is a queue and you work the front of it; this is a history
 * and the only row you are likely to want is the one you just archived by mistake.
 *
 * @param {Array}  inboxItems  Every capture, archived or not.
 * @param {object} [opts]
 * @param {Date}   [opts.now]      Injected so the seven-day boundary is testable.
 * @param {boolean} [opts.showAll] Past the window, everything.
 */
export function recentlyArchived(inboxItems, { now = new Date(), showAll = false } = {}) {
  const rows = allArchived(inboxItems);
  if (showAll) return rows;
  const cutoff = new Date(now.getTime() - RECENT_ARCHIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // A row with no stamp at all is OLDER than the window, not newer: `"" < cutoff` is
  // true, so it is hidden until "Show all". That is the right way round — an unstamped
  // row is a pre-066 relic, not something that just happened.
  return rows.filter((i) => archivedAt(i) >= cutoff);
}

/**
 * How many more rows "Show all" would reveal.
 *
 * Zero means the control is hidden. A "Show all" that shows exactly what is already on
 * screen is a control that does nothing — the same reasoning that keeps a source tab off
 * the row until its source has items.
 */
export function olderArchivedCount(inboxItems, { now = new Date() } = {}) {
  return allArchived(inboxItems).length - recentlyArchived(inboxItems, { now }).length;
}

/**
 * What happened to this capture, in words, and in what colour.
 *
 * `archive_reason` says whether it was processed or discarded (migration 066). WHAT it
 * was processed into is not on the row at all — it is on the records that came out of
 * it, each carrying `source_inbox_id` back here. So this reads them, which is the only
 * reason `items` / `intents` / `events` are parameters.
 *
 * ⚠️ It counts records REGARDLESS of their own `archived` flag. This is a history: an
 * item that was created from a capture and later binned still answers "what happened to
 * that capture".
 *
 * Nothing is inferred when nothing points back. A processed row with no descendants
 * reads as plain "Processed" rather than guessing — it can honestly happen, because
 * triage can add a capture to a collection, and because the FK is ON DELETE SET NULL, so
 * a deleted record takes its own link with it.
 *
 * @returns {{label: string, tone: string, reason: string}} `tone` is a Tailwind text
 *   colour class, so the caller states no colours of its own.
 */
export function archiveOutcome(inboxItem, { items = [], intents = [], events = [] } = {}) {
  const reason = inboxItem?.archiveReason || null;

  if (reason === "discarded") {
    return { label: "Discarded", tone: "text-destructive", reason: "discarded" };
  }

  // Archived with no reason: rows from before migration 066, when `archived` was a
  // column nothing wrote. Saying "Processed" about one would be an invention.
  if (reason !== "processed") {
    return { label: "Archived", tone: "text-muted-foreground", reason: reason || "unknown" };
  }

  const id = inboxItem?.id;
  const from = (rows) => rows.some((r) => r?.sourceInboxId === id);
  const made = [];
  // Creation order, which is also how the detail page's sections read top to bottom.
  if (from(items)) made.push("an item");
  if (from(intents)) made.push("an intention");
  if (from(events)) made.push("an event");

  const label = made.length === 0 ? "Processed" : `Processed into ${joinPhrase(made)}`;
  return { label, tone: "text-muted-foreground", reason: "processed" };
}

/** "an item", "an item and an intention", "an item, an intention and an event". */
function joinPhrase(parts) {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Does undoing this need a confirmation?
 *
 * ⚠️ THE ONE HONEST PROBLEM WITH THIS FEATURE, and it is not new. `handleInboxSave`
 * deliberately offers no Undo, and says why: un-archiving a processed capture puts the
 * capture back but CANNOT remove the item, intention or event it turned into. Process it
 * again and you get a second copy of everything.
 *
 * Step 22 asks for an Undo on every row, so the button exists. What it does not do is
 * pretend the problem away: on a row that created something, the Undo asks first and
 * names what is already out there. A discarded row created nothing, so it just goes back.
 */
export function undoNeedsConfirming(inboxItem, records) {
  return archiveOutcome(inboxItem, records).reason === "processed";
}

/** The sentence the confirmation asks. Here so it is testable and says one thing. */
export function undoWarning(inboxItem, records) {
  const { label } = archiveOutcome(inboxItem, records);
  const made = label.startsWith("Processed into ") ? label.slice("Processed into ".length) : null;
  return (
    `This capture was filed${made ? ` and became ${made}` : ""}.\n\n` +
    "Putting it back in your inbox does NOT remove what it created. If you process it " +
    "again you will have two copies.\n\nPut it back anyway?"
  );
}
