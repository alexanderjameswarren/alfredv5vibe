/**
 * The `intents` row a triaged capture becomes.
 *
 * Pure — no React, no Supabase — in its own module so the tests exercise THIS
 * rather than a reproduction of its shape.
 *
 * ── Why it was extracted (Clipboard Step 17b) ────────────────────────────────
 *
 * `intents.description` — "Details" on the inbox detail page — looked like it was
 * not being written. A check after processing a capture found it null on every row.
 *
 * Tracing it found no fault: the page emits `intentionData.description`, this
 * mapping copies it, `toSnakeCase` leaves an already-snake key alone, and
 * `storage.set` sends every key it is given with no column whitelist. The likeliest
 * explanation was simply that no Details text had been typed on the capture that
 * was tested — a null is the CORRECT result for that.
 *
 * "Probably fine, and here is my reasoning" is not the same as evidence, and the
 * reason it could not be evidence is that this mapping lived inside a 12,900-line
 * component with no test able to reach it. That is what changed. The mapping is
 * here, it is tested, and a value that stops arriving now fails a test instead of
 * being argued about.
 *
 * ── Why only the intention, and not the item and event rows too ──────────────
 *
 * Because this is the row with the new column and the doubt attached to it.
 * Extracting all three would be a bigger change to the one function that writes
 * everything a capture becomes, made at the same time as a bug hunt. The item and
 * event rows can follow when something needs them to.
 */

/**
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
  // the order the form relies on: the inbox detail page sends null here whenever
  // its New Item section is on, precisely so the new item is what gets linked.
  const itemId = data.itemId || createdItemId;

  return {
    id,
    user_id: userId,
    text: data.text,
    // `intents.description`, migration 069.
    //
    // NULL when nothing was written, which is the contract the column's comment
    // states: `not null default ''` was rejected so that "no details" and "details
    // deliberately emptied" would not be the same value. Whitespace-only counts as
    // nothing. Deliberately unlike `items.description`, which has always stored
    // "" — that column's history, not a rule to copy.
    //
    // The old inbox card sends no `description` at all; that arrives as undefined
    // and lands as null, which is right for it.
    description: (data.description || "").trim() || null,
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
