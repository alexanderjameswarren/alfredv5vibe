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
 * What a capture is CALLED in the list — Clipboard Step 21b, extended in Step 22.
 *
 * Three answers, in this order:
 *
 *   A TASK        → its task name and run date, from `source_metadata`. See
 *                   `taskTitleFor` for why a task is the one row not titled by its own
 *                   words. FIRST, because a task can also be enriched, and once it is
 *                   the suggestion below would win and the run would lose its identity.
 *   ENRICHED      → Claude's suggested name: the item's, else the intention's.
 *   ANYTHING ELSE → the captured text.
 *
 * ── Why the suggestion wins ──────────────────────────────────────────────────
 *
 * The captured text is what was said; the suggested name is what it will BECOME. Once a
 * row is enriched the second is the more useful title, because it is what you will be
 * looking for afterwards — "Duck mole tacos" rather than three sentences about wanting
 * to try a recipe. It is also what the card's Process button is about to create, so the
 * title and the action agree.
 *
 * ⚠️ NOT applied to unenriched rows, and the captured text is the FALLBACK rather than
 * the alternative. An unenriched row has no suggestion to show, so its raw text is the
 * only honest thing it can say. `computeBaseline` falls back the same way for the same
 * reason, so a row with a blank suggestion does not end up with a blank title.
 */
export function listTitleFor(inboxItem) {
  const capturedText = inboxItem?.capturedText || "";
  const task = taskTitleFor(inboxItem);
  if (task) return task;
  if (!isEnriched(inboxItem)) return capturedText;
  const suggested =
    (inboxItem.suggestedItemText || "").trim() || (inboxItem.suggestedIntentText || "").trim();
  return suggested || capturedText;
}

/**
 * What a TASK capture is called — Clipboard Step 22. `"Weekly DJ review · Sep 25"`.
 *
 * ── Why a task is titled differently from everything else ────────────────────
 *
 * Every other row in the list is titled by its own words, because its own words are all
 * there is. A task row is the exception: the text is the task's OUTPUT — a paragraph of
 * findings written for a Claude session to pick up — and the first fifty characters of
 * it are the least identifying part. Two runs of the same weekly task produce two rows
 * that are indistinguishable at a glance and are not the same row.
 *
 * `source_metadata.task_name` is the identity the writer was already required to supply
 * (`create_inbox_item` refuses a task without it), and the run date is what separates
 * this week's from last week's. So the title is the two facts that tell the rows apart,
 * and the text stays where it always was — one tap away, on the detail page.
 *
 * ⚠️ BOTH KEY CASES ARE READ. `storage.toCamelCase` recurses into jsonb, so a row that
 * came through React state carries `sourceMetadata.taskName` while the column itself
 * holds `task_name`. Nothing in the app should hand this an unconverted row, and reading
 * both costs one `||` — against a title that silently falls back to a paragraph of text
 * if one ever does.
 *
 * The date is written short and WITHOUT a year, matching the app's other short dates. It
 * is parsed field by field rather than through `new Date("2026-09-25")`, which is UTC
 * midnight and renders as the 24th in every negative-offset zone.
 *
 * Returns null — not a title — for anything that is not a task, and for a task with no
 * `task_name`, which falls back to the captured text through `listTitleFor`.
 */
export function taskTitleFor(inboxItem) {
  if (inboxItem?.sourceType !== "task") return null;
  const meta = inboxItem?.sourceMetadata || inboxItem?.source_metadata || {};
  const name = String(meta.taskName ?? meta.task_name ?? "").trim();
  if (!name) return null;
  const date = shortRunDate(meta.runDate ?? meta.run_date);
  return date ? `${name} · ${date}` : name;
}

/** A YYYY-MM-DD run date as "Sep 25", or null if it is missing or malformed. */
function shortRunDate(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!parts) return null;
  const [, y, m, d] = parts;
  const local = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(local.getTime())) return null;
  return local.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
