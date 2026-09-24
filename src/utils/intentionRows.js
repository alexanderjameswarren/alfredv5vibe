/**
 * How an `intents` row is built — both ways it can be.
 *
 * Pure — no React, no Supabase — in its own module so the tests exercise THESE
 * rather than a reproduction of their shape. One file, because "what columns does
 * an intention have, and who decides each one" is one question, and answering it in
 * two places is how the two writers came to disagree.
 *
 * ── Why this exists (Clipboard Steps 17b and 17c) ────────────────────────────
 *
 * `intents.description` — "Details" — is a column added late to a table two
 * different code paths write. Both paths had a problem, and only one of them was
 * the problem anyone suspected:
 *
 *   TRIAGE (`intentionRowFromTriage`) turned out to be correct all along. It was
 *   extracted in 17b anyway, because the mapping sat inside a 12,900-line component
 *   where no test could reach it — so "is Details being saved?" could only be
 *   answered by reading code and reasoning, which is not evidence.
 *
 *   EDITING (`intentionUpdateRow`) was NOT correct. `updateIntent` builds an
 *   explicit whitelist of columns — "be explicit about what we're storing" — and a
 *   field missing from that list is SILENTLY UNWRITABLE. The intention edit screen
 *   would have shown a Details box, accepted what you typed, reported a successful
 *   save, and changed nothing. No error, anywhere.
 *
 * That is the hazard a whitelist carries: it fails silently and invisibly, and it
 * fails once per new column. Keeping it here, tested, is the price of keeping it.
 *
 * ⚠️ AN OMITTED COLUMN IS NOT ERASED. `storage.set` issues an UPDATE, which only
 * touches the columns it names — which is why `source_inbox_id` survives an edit
 * despite being absent from the whitelist too. Worth knowing that the safety comes
 * from UPDATE's semantics and not from this list being complete: anything that ever
 * turned that path into a full replace would start nulling columns.
 */

/**
 * Details as the column wants it: the text, or null.
 *
 * NULL when nothing was written, which is the contract migration 069's comment
 * states. `not null default ''` was rejected precisely so that "no details" and
 * "details deliberately emptied" would not be the same value, and whitespace-only
 * counts as nothing.
 *
 * Deliberately unlike `items.description`, which has always stored `''` — that
 * column's history, not a rule to copy.
 */
export function detailsForStorage(value) {
  return (value || "").trim() || null;
}

/**
 * The `intents` row a triaged capture becomes.
 *
 * @param {object}   params
 * @param {string}   params.id             The new intention's id (uid()).
 * @param {string}   params.userId         Owner.
 * @param {object}   params.intentionData  `triageData.intentionData` from the form.
 * @param {string|null} [params.createdItemId]
 *   The item this same triage just created, if any.
 * @param {string}   params.sourceInboxId  The capture this came from.
 * @param {string}   params.createdAt      ISO timestamp. Passed in rather than read
 *   from the clock so a test can assert the row it produces.
 * @returns {object} The row, in camelCase — `storage.set` converts it.
 */
export function intentionRowFromTriage({
  id,
  userId,
  intentionData,
  createdItemId = null,
  sourceInboxId,
  createdAt,
}) {
  const data = intentionData || {};

  // An explicitly chosen EXISTING item wins over one this triage created, which is
  // the order the form relies on: the inbox detail page sends null here whenever its
  // New Item section is on, precisely so the new item is what gets linked.
  const itemId = data.itemId || createdItemId;

  return {
    id,
    user_id: userId,
    text: data.text,
    description: detailsForStorage(data.description),
    createdAt,
    isIntention: true,
    isItem: !!itemId,
    archived: false,
    itemId,
    contextId: data.contextId,
    recurrenceConfig: data.recurrenceConfig || null,
    targetStartDate: data.targetStartDate || null,
    endDate: data.endDate || null,
    tags: data.tags || [],
    sourceInboxId,
  };
}

/**
 * The `intents` row an edit produces: the existing row with a patch applied.
 *
 * Every field follows the same rule — take it from `updates` when that key is
 * PRESENT, otherwise keep what the row already had. `undefined` therefore means
 * "leave alone" and `null` means "clear it", which is what lets Details be emptied
 * on purpose.
 *
 * @param {object} intent  The intention as it currently stands, in camelCase.
 * @param {object} updates The fields being changed.
 * @returns {object} The row to write.
 */
export function intentionUpdateRow(intent, updates = {}) {
  const pick = (key, fallback) =>
    updates[key] !== undefined ? updates[key] : fallback;

  return {
    id: intent.id,
    userId: intent.userId,
    text: pick("text", intent.text),
    // Added by Step 17c. Absent from the whitelist before that, and therefore
    // unwritable — see this file's header.
    description: pick("description", intent.description ?? null),
    createdAt: intent.createdAt,
    isIntention: pick("isIntention", intent.isIntention || false),
    isItem: pick("isItem", intent.isItem || false),
    archived: pick("archived", intent.archived || false),
    itemId: pick("itemId", intent.itemId),
    contextId: pick("contextId", intent.contextId),
    recurrenceConfig: pick("recurrenceConfig", intent.recurrenceConfig || null),
    targetStartDate: pick("targetStartDate", intent.targetStartDate || null),
    endDate: pick("endDate", intent.endDate || null),
    tags: pick("tags", intent.tags || []),
    collectionId: pick("collectionId", intent.collectionId || null),
  };
}
