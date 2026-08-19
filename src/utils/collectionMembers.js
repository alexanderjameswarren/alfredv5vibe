/**
 * Data access layer for collection membership and removal history.
 *
 * Backs `public.collection_items` (one row per member) and
 * `public.collection_item_removals` (append-only removal history), which replace
 * the `item_collections.items` jsonb array. Migration 005 created both.
 *
 * ─── Contract ────────────────────────────────────────────────────────────────
 *
 * Every exported function resolves to a result object and NEVER throws for an
 * expected failure:
 *
 *     { data, error }        error is null on success, a string on failure
 *
 * Some functions add fields (`alreadyPresent`, `skipped`, `removed`). Callers
 * MUST inspect `error` — Alfred's `withLoading` swallows exceptions and shows an
 * alert without rethrowing, so a thrown error inside a wrapped call site is
 * invisible to the caller and the user is left believing the write succeeded.
 * Returning the failure is the only way it can be surfaced.
 *
 * This module deliberately holds no React state and triggers no re-renders. The
 * caller owns state. Where a caller updates state from one of these results it
 * must use React's functional updater form — `setX((prev) => ...)` — because the
 * closed-over-snapshot pattern in the existing `updateCollection` is itself a
 * cause of lost concurrent edits, independent of the storage shape.
 *
 * ─── Key case ────────────────────────────────────────────────────────────────
 *
 * Postgres is snake_case, React state is camelCase, and `caseConvert` bridges
 * them. Arguments and returned rows are camelCase; conversion happens at the
 * boundary here, exactly as `storage` does in Alfred.jsx.
 */

import { supabase } from "../supabaseClient";
import { toCamelCase, toSnakeCase } from "./caseConvert";

// ─── Constants ───────────────────────────────────────────────────────────────

const MEMBERS_TABLE = "collection_items";
const REMOVALS_TABLE = "collection_item_removals";

/** The user pressed the X button on a single row. Shown in the panel. */
export const REMOVAL_MANUAL = "manual";

/** Cleared in bulk when an execution was completed. History view only. */
export const REMOVAL_COMPLETED = "completed";

const VALID_REASONS = [REMOVAL_MANUAL, REMOVAL_COMPLETED];

/** Postgres unique_violation. Raised by collection_items_unique_member. */
const UNIQUE_VIOLATION = "23505";

/** Ceiling on a removal-history read. The panel asks for 5, the history view 50. */
const MAX_REMOVALS = 200;
const DEFAULT_REMOVALS = 50;

// ─── Result helpers ──────────────────────────────────────────────────────────

function ok(data, extra) {
  return { data, error: null, ...extra };
}

function fail(context, error, extra) {
  // Mirrors the logging the existing storage layer does on its own failures.
  console.error(`[collectionMembers] ${context}:`, error);
  const message =
    typeof error === "string" ? error : error?.message || "Unknown error";
  return { data: null, error: message, ...extra };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/**
 * Load every member of a collection, in display order.
 *
 * @param {string} collectionId
 * @returns {Promise<{data: Array<Object>|null, error: string|null}>}
 *   Members as `{ id, collectionId, itemId, quantity, position, addedAt, addedBy }`.
 */
export async function loadMembers(collectionId) {
  if (!collectionId) return fail("loadMembers", "collectionId is required");

  const { data, error } = await supabase
    .from(MEMBERS_TABLE)
    .select("*")
    .eq("collection_id", collectionId)
    .order("position", { ascending: true });

  if (error) return fail("loadMembers", error);
  return ok((data || []).map((row) => toCamelCase(row)));
}

/**
 * Load recent removals for a collection, most recent first.
 *
 * @param {string} collectionId
 * @param {Object} [options]
 * @param {string} [options.reason] - REMOVAL_MANUAL or REMOVAL_COMPLETED. Omit for both.
 * @param {number} [options.limit=50] - Clamped to 1..200.
 * @returns {Promise<{data: Array<Object>|null, error: string|null}>}
 *   Removals as `{ id, collectionId, itemId, itemName, quantity, position,
 *   reason, removedAt, removedBy }`. `itemName` may be null — see removeMembers.
 */
export async function loadRemovals(collectionId, options = {}) {
  if (!collectionId) return fail("loadRemovals", "collectionId is required");

  const { reason, limit } = options;
  if (reason && !VALID_REASONS.includes(reason)) {
    return fail("loadRemovals", `Unknown reason "${reason}"`);
  }

  const requested = Number.isFinite(limit) ? limit : DEFAULT_REMOVALS;
  const clamped = Math.max(1, Math.min(requested, MAX_REMOVALS));

  let query = supabase
    .from(REMOVALS_TABLE)
    .select("*")
    .eq("collection_id", collectionId)
    .order("removed_at", { ascending: false })
    .limit(clamped);

  if (reason) query = query.eq("reason", reason);

  const { data, error } = await query;
  if (error) return fail("loadRemovals", error);
  return ok((data || []).map((row) => toCamelCase(row)));
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * The position a newly appended member should take: one past the current last.
 * Returns 0 for an empty collection.
 *
 * Two people appending at the same moment can land on the same position. That
 * collides only in display order, which the spec accepts as unresolved.
 */
async function nextPosition(collectionId) {
  const { data, error } = await supabase
    .from(MEMBERS_TABLE)
    .select("position")
    .eq("collection_id", collectionId)
    .order("position", { ascending: false })
    .limit(1);

  if (error) return { position: null, error };
  const highest = data && data.length > 0 ? data[0].position : null;
  return { position: Number.isFinite(highest) ? highest + 1 : 0, error: null };
}

/**
 * Resolve item names for a set of ids, for snapshotting into a removal record.
 *
 * An id absent from the result maps to null. That happens for two reasons the
 * client cannot tell apart and does not need to: the item row was deleted, or
 * RLS on `items` hides it from this user (an item is readable via ownership or a
 * shared context — collection membership grants nothing). Either way the name is
 * unavailable and null is the honest value; the id alone is enough to re-add.
 */
async function fetchItemNames(itemIds) {
  const names = new Map();
  if (itemIds.length === 0) return names;

  const { data, error } = await supabase
    .from("items")
    .select("id, name")
    .in("id", itemIds);

  if (error) {
    // Non-fatal: a failed name lookup must not block the removal itself.
    console.error("[collectionMembers] fetchItemNames:", error);
    return names;
  }
  for (const row of data || []) names.set(row.id, row.name ?? null);
  return names;
}

/** Empty-string quantities were normalised to null on backfill. Stay consistent. */
function normaliseQuantity(quantity) {
  if (quantity === undefined || quantity === null) return null;
  const trimmed = String(quantity).trim();
  return trimmed === "" ? null : String(quantity);
}

// ─── Writes: membership ──────────────────────────────────────────────────────

/**
 * Add several items to a collection in one statement, appended in array order.
 *
 * Items already in the collection are skipped rather than erroring — the unique
 * index on (collection_id, item_id) is resolved with ON CONFLICT DO NOTHING.
 *
 * @param {string} collectionId
 * @param {Array<{itemId: string, quantity?: string}>} entries
 * @param {Object} [options]
 * @param {string} [options.userId] - Recorded as added_by. Null when absent.
 * @returns {Promise<{data: Array<Object>|null, error: string|null, skipped: Array<string>}>}
 *   `data` holds the rows actually inserted; `skipped` the itemIds already present.
 */
export async function addMembers(collectionId, entries, options = {}) {
  if (!collectionId)
    return fail("addMembers", "collectionId is required", { skipped: [] });
  if (!Array.isArray(entries) || entries.length === 0)
    return ok([], { skipped: [] });

  const { userId } = options;

  const { position, error: positionError } = await nextPosition(collectionId);
  if (positionError)
    return fail("addMembers", positionError, { skipped: [] });

  const rows = entries.map((entry, index) =>
    toSnakeCase({
      collectionId,
      itemId: entry.itemId,
      quantity: normaliseQuantity(entry.quantity),
      position: position + index,
      addedBy: userId || null,
    }),
  );

  const { data, error } = await supabase
    .from(MEMBERS_TABLE)
    .upsert(rows, {
      onConflict: "collection_id,item_id",
      ignoreDuplicates: true,
    })
    .select("*");

  if (error) {
    // Belt and braces. ON CONFLICT DO NOTHING should absorb a duplicate before
    // it ever reaches us, but a unique violation surfacing here still means
    // "already a member", which is a no-op success rather than a failure. The
    // re-add control can be double-tapped and must not produce an error.
    if (error.code === UNIQUE_VIOLATION) {
      return ok([], { skipped: entries.map((entry) => entry.itemId) });
    }
    return fail("addMembers", error, { skipped: [] });
  }

  const inserted = (data || []).map((row) => toCamelCase(row));
  const insertedIds = new Set(inserted.map((row) => row.itemId));
  const skipped = entries
    .map((entry) => entry.itemId)
    .filter((itemId) => !insertedIds.has(itemId));

  return ok(inserted, { skipped });
}

/**
 * Add a single item to a collection.
 *
 * @param {string} collectionId
 * @param {string} itemId
 * @param {Object} [options]
 * @param {string} [options.quantity]
 * @param {string} [options.userId]
 * @returns {Promise<{data: Object|null, error: string|null, alreadyPresent: boolean}>}
 *   `alreadyPresent` is true when the item was already a member; that is a
 *   no-op success, not a failure, and `data` is null.
 */
export async function addMember(collectionId, itemId, options = {}) {
  if (!itemId)
    return fail("addMember", "itemId is required", { alreadyPresent: false });

  const result = await addMembers(
    collectionId,
    [{ itemId, quantity: options.quantity }],
    { userId: options.userId },
  );

  if (result.error)
    return { data: null, error: result.error, alreadyPresent: false };

  const inserted = result.data[0] || null;
  return ok(inserted, { alreadyPresent: inserted === null });
}

/**
 * Update a member's free-text quantity. Empty string is stored as null.
 *
 * @param {string} collectionId
 * @param {string} itemId
 * @param {string} quantity
 * @returns {Promise<{data: Object|null, error: string|null}>}
 */
export async function updateMemberQuantity(collectionId, itemId, quantity) {
  if (!collectionId || !itemId)
    return fail("updateMemberQuantity", "collectionId and itemId are required");

  const { data, error } = await supabase
    .from(MEMBERS_TABLE)
    .update({ quantity: normaliseQuantity(quantity) })
    .eq("collection_id", collectionId)
    .eq("item_id", itemId)
    .select("*");

  if (error) return fail("updateMemberQuantity", error);
  if (!data || data.length === 0)
    return fail("updateMemberQuantity", "Item is no longer in this collection");

  return ok(toCamelCase(data[0]));
}

/**
 * Persist a new display order.
 *
 * Takes the members already in their intended order and writes each one's index
 * as its position. Rows whose position is unchanged are not written, so dragging
 * one row in a long list costs a handful of updates rather than one per member.
 *
 * Updates are scoped by collection_id as well as id, so a member deleted by
 * somebody else mid-drag simply matches nothing. A reorder cannot resurrect a
 * removed row. Two simultaneous reorders still resolve as last-write-wins, which
 * the spec accepts.
 *
 * @param {string} collectionId
 * @param {Array<Object>} orderedMembers - Member objects in their new order.
 * @returns {Promise<{data: {updated: number}|null, error: string|null}>}
 */
export async function reorderMembers(collectionId, orderedMembers) {
  if (!collectionId)
    return fail("reorderMembers", "collectionId is required");
  if (!Array.isArray(orderedMembers) || orderedMembers.length === 0)
    return ok({ updated: 0 });

  const moved = orderedMembers
    .map((member, index) => ({ member, index }))
    .filter(({ member, index }) => member.position !== index);

  if (moved.length === 0) return ok({ updated: 0 });

  const results = await Promise.all(
    moved.map(({ member, index }) =>
      supabase
        .from(MEMBERS_TABLE)
        .update({ position: index })
        .eq("id", member.id)
        .eq("collection_id", collectionId),
    ),
  );

  const failed = results.find((result) => result.error);
  if (failed) return fail("reorderMembers", failed.error);

  return ok({ updated: moved.length });
}

// ─── Writes: removal ─────────────────────────────────────────────────────────

/**
 * Remove items from a collection and record the removal.
 *
 * Two writes, deliberately ordered. supabase-js cannot open a transaction from
 * the browser, so these cannot be made atomic here. The history row is written
 * FIRST: if the second half then fails, the item is still in the collection and
 * carries a spurious history entry — visible and correctable. The other order
 * would lose the item with no record that it ever existed.
 *
 * The item's name is snapshotted at this moment rather than looked up later,
 * because the item may afterwards be deleted, or may be unreadable to whoever
 * views the history. An unresolvable name is stored as null; it never blocks the
 * removal.
 *
 * All rows go in one INSERT, so a bulk removal shares a single `removed_at` —
 * `now()` is transaction-stable — which is what lets the history view group them
 * under one heading. The timestamp is the server's, not the client's.
 *
 * @param {string} collectionId
 * @param {Array<string>} itemIds
 * @param {Object} [options]
 * @param {string} [options.reason=REMOVAL_MANUAL] - REMOVAL_MANUAL or REMOVAL_COMPLETED.
 * @param {string} [options.userId] - Recorded as removed_by.
 * @returns {Promise<{data: {removed: Array<Object>, removals: Array<Object>}|null, error: string|null}>}
 */
export async function removeMembers(collectionId, itemIds, options = {}) {
  if (!collectionId) return fail("removeMembers", "collectionId is required");
  if (!Array.isArray(itemIds) || itemIds.length === 0)
    return ok({ removed: [], removals: [] });

  const { reason = REMOVAL_MANUAL, userId } = options;
  if (!VALID_REASONS.includes(reason))
    return fail("removeMembers", `Unknown reason "${reason}"`);

  // Read the members first: the history record snapshots quantity and position
  // as they were, and we need the row ids to delete by.
  const { data: existing, error: loadError } = await supabase
    .from(MEMBERS_TABLE)
    .select("*")
    .eq("collection_id", collectionId)
    .in("item_id", itemIds);

  if (loadError) return fail("removeMembers", loadError);

  const members = (existing || []).map((row) => toCamelCase(row));
  if (members.length === 0) return ok({ removed: [], removals: [] });

  const names = await fetchItemNames(members.map((member) => member.itemId));

  // removed_at is left to the column default so every row in this one statement
  // shares the server's transaction timestamp exactly.
  const removalRows = members.map((member) =>
    toSnakeCase({
      collectionId,
      itemId: member.itemId,
      itemName: names.has(member.itemId) ? names.get(member.itemId) : null,
      quantity: member.quantity ?? null,
      position: member.position ?? null,
      reason,
      removedBy: userId || null,
    }),
  );

  const { data: removals, error: removalError } = await supabase
    .from(REMOVALS_TABLE)
    .insert(removalRows)
    .select("*");

  if (removalError) return fail("removeMembers", removalError);

  const { error: deleteError } = await supabase
    .from(MEMBERS_TABLE)
    .delete()
    .eq("collection_id", collectionId)
    .in(
      "id",
      members.map((member) => member.id),
    );

  if (deleteError) {
    // History exists, membership does not: the item is still on the list. Say so
    // plainly rather than reporting a success the user can see is wrong.
    return fail(
      "removeMembers",
      `${deleteError.message} — the removal was recorded but the item is still in the collection`,
    );
  }

  return ok({
    removed: members,
    removals: (removals || []).map((row) => toCamelCase(row)),
  });
}

/**
 * Remove a single item from a collection.
 *
 * @param {string} collectionId
 * @param {string} itemId
 * @param {Object} [options] - As removeMembers.
 * @returns {Promise<{data: {removed: Array<Object>, removals: Array<Object>}|null, error: string|null}>}
 */
export async function removeMember(collectionId, itemId, options = {}) {
  if (!itemId) return fail("removeMember", "itemId is required");
  return removeMembers(collectionId, [itemId], options);
}

/**
 * Put an item back from a removal record, restoring its original quantity.
 *
 * Appended at the end rather than reinserted at its old position: the list has
 * moved on since, and the stored position no longer means anything reliable.
 *
 * Pressing the control twice is safe. The second attempt hits the unique index,
 * is absorbed as a no-op, and comes back with `alreadyPresent: true` rather than
 * an error.
 *
 * The removal record is left in place. `collection_item_removals` is append-only
 * and re-adding is a plain insert, not an undo — so the history keeps saying the
 * item was removed at that time, which remains true. Deciding whether the panel
 * hides entries whose item is currently a member is a display question for
 * Step 5, not a data one.
 *
 * @param {Object} removal - A record from loadRemovals.
 * @param {Object} [options]
 * @param {string} [options.userId] - Recorded as added_by on the new membership row.
 * @returns {Promise<{data: Object|null, error: string|null, alreadyPresent: boolean}>}
 */
export async function reAddRemoval(removal, options = {}) {
  if (!removal || !removal.collectionId || !removal.itemId)
    return fail("reAddRemoval", "A removal record with ids is required", {
      alreadyPresent: false,
    });

  return addMember(removal.collectionId, removal.itemId, {
    quantity: removal.quantity,
    userId: options.userId,
  });
}
