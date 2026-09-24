/**
 * What a capture's enrichment proposes, and how to file it untouched.
 *
 * Pure — no React, no Supabase — in its own module because TWO screens act on the
 * same suggestions and they must not interpret them differently:
 *
 *   the INBOX DETAIL PAGE seeds its form from `computeBaseline` and files whatever the
 *     user then has on screen;
 *   the INBOX LIST's one-tap Process files the suggestions AS THEY STAND, with no form
 *     in between.
 *
 * "One tap" has to mean exactly "open it and press Process without changing anything",
 * or the fast path quietly files something different from the careful path. That is
 * what `triageDataForOneTap` is, and `inboxSuggestions.test.js` asserts it against what
 * the detail page actually emits rather than against a copy of the intention.
 */

import { normaliseSuggestedElements } from "./suggestedElements";

/**
 * What a capture proposes, read off the row once.
 *
 * `capturedText` is in here alongside the suggestions because two fields are seeded
 * FROM it — an item's name and an intention's name, when the enrichment proposed
 * neither — and the only way to tell later whether one of those is still showing the
 * capture verbatim is to remember what the capture said at the time.
 */
export function computeBaseline(inboxItem) {
  const capturedText = inboxItem.capturedText || "";
  return {
    capturedText,
    contextId: inboxItem.suggestedContextId || "",
    tags: inboxItem.suggestedTags || [],
    itemOn: !!inboxItem.suggestItem,
    intentionOn: !!inboxItem.suggestIntent,
    itemName: inboxItem.suggestedItemText || capturedText,
    itemDescription: inboxItem.suggestedItemDescription || "",
    elements: normaliseSuggestedElements(inboxItem.suggestedItemElements),
    intentText: inboxItem.suggestedIntentText || capturedText,
    // Nothing suggests an intention's Details: the column arrived with migration
    // 069 and no enrichment writes it. Always starts empty.
    intentDescription: "",
    linkedItemId: inboxItem.suggestedItemId || "",
    eventDate: inboxItem.suggestedEventDate || "",
  };
}

/** Has this capture been through an enrichment? */
export function isEnriched(inboxItem) {
  return inboxItem?.aiStatus === "enriched" || inboxItem?.aiStatus === "re_enriched";
}

/**
 * Can this row be filed in one tap from the list?
 *
 * Both halves are required and neither is redundant:
 *
 *   ENRICHED, because Process files the SUGGESTIONS — on an unenriched row there are
 *     none, and a button that files a capture's own text as an item's name is a trap
 *     rather than a shortcut.
 *   SUGGESTS AN ITEM OR AN INTENTION, because those are the only two things triage
 *     creates. A row that suggests only a context or a tag has nothing for them to
 *     land on, and Process would archive it having created nothing at all.
 *
 * A name is not checked here: the baseline falls back to the captured text, so the only
 * way to have no name is to have no text, which the capture path already forbids.
 */
export function canProcessInOneTap(inboxItem) {
  if (!isEnriched(inboxItem)) return false;
  return Boolean(inboxItem.suggestItem) || Boolean(inboxItem.suggestIntent);
}

/**
 * The triage data for filing a capture exactly as it was suggested.
 *
 * ⚠️ THIS MUST MATCH WHAT THE DETAIL PAGE SENDS when nothing has been edited. The
 * shape is `handleInboxSave`'s, so the list and the page go through one save path — the
 * same one that archives with reason 'processed' and sets `source_inbox_id`.
 *
 * Three fields deserve their reasons, because they look like omissions:
 *
 *   `itemItemLinks: []` — "Attach this Item" was dropped in Step 17b and no longer
 *     exists on either surface.
 *   `recurrenceConfig` / `endDate` null — nothing suggests a recurrence. The column
 *     `suggested_intent_recurrence` exists and holds a WORD ('daily'), not the
 *     `recurrenceConfig` object the app stores, so filing it would mean inventing a
 *     translation here that the detail page does not make either. Left for the user.
 *   `itemId: itemOn ? null : …` — an explicitly suggested EXISTING item must lose to
 *     the item this triage is about to create, because `handleInboxSave` resolves
 *     `intentionData.itemId || createdItemId` and a value sent here would WIN.
 */
export function triageDataForOneTap(inboxItem) {
  const b = computeBaseline(inboxItem);
  return {
    createItem: b.itemOn,
    itemData: b.itemOn
      ? {
          name: b.itemName.trim(),
          description: b.itemDescription,
          contextId: b.contextId || null,
          elements: b.elements,
          tags: b.tags,
        }
      : null,
    itemItemLinks: [],
    createIntention: b.intentionOn,
    intentionData: b.intentionOn
      ? {
          text: b.intentText.trim(),
          description: b.intentDescription,
          contextId: b.contextId || null,
          tags: b.tags,
          recurrenceConfig: null,
          endDate: null,
          targetStartDate: null,
          itemId: b.itemOn ? null : b.linkedItemId || null,
          createEvent: Boolean(b.eventDate),
          eventDate: b.eventDate || null,
        }
      : null,
    // Collections are hidden on the detail page for now, so they are not filed from
    // the list either — one tap must not do something the careful path cannot.
    addToCollection: false,
    collectionData: null,
  };
}

/**
 * What a capture is CALLED in the list — Clipboard Step 21b.
 *
 * For an enriched row, Claude's suggested name: the item's, else the intention's. For
 * anything else, the captured text.
 *
 * ── Why the suggestion wins ──────────────────────────────────────────────────
 *
 * The captured text is what was said; the suggested name is what it will BECOME. Once a
 * row is enriched the second is the more useful title, because it is what you will be
 * looking for afterwards — "Duck mole tacos" rather than three sentences about wanting
 * to try a recipe. It is also what the card's Process button is about to create, so the
 * title and the action agree.
 *
 * ⚠️ NOT applied to unenriched rows or tasks, and the captured text is the FALLBACK
 * rather than the alternative. An unenriched row has no suggestion to show, and a task's
 * is not written yet — showing its raw text is the only honest thing either can do.
 * `computeBaseline` falls back the same way for the same reason, so a row with a blank
 * suggestion does not end up with a blank title.
 */
export function listTitleFor(inboxItem) {
  const capturedText = inboxItem?.capturedText || "";
  if (!isEnriched(inboxItem)) return capturedText;
  const suggested =
    (inboxItem.suggestedItemText || "").trim() || (inboxItem.suggestedIntentText || "").trim();
  return suggested || capturedText;
}

/**
 * The text a task item's Copy button puts on the clipboard.
 *
 * The trailing line is the point: a task capture is something a Claude session has to
 * pick up, and pasting the text alone leaves that session with no way to archive the
 * row afterwards. The id travels with it.
 */
export function copyTextForTask(inboxItem) {
  const text = (inboxItem?.capturedText || "").trim();
  return `${text}\n\nAlfred inbox item: ${inboxItem?.id ?? ""}`;
}
