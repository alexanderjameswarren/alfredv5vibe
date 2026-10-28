import { supabase } from "../supabaseClient";
import { storage } from "../utils/storage";
import { toCamelCase } from "../utils/caseConvert";
import { uid } from "../utils/flattenElements";
import {
  cancelRemindersForDiscard,
  restoreRemindersAfterDiscard,
} from "../utils/remindersApi";
import { undoNeedsConfirming, undoWarning } from "../utils/inboxArchive";
import { copyTextForTask, triageDataForOneTap } from "../utils/inboxSuggestions";
import { intentionRowFromTriage } from "../utils/intentionRows";
import { carriedItems } from "../utils/status";

// Inbox writers, moved out of Alfred.jsx unchanged. Holds no state: everything it
// reads or sets is Alfred's, passed in — including `refreshReminderIndex`, which
// belongs to another feature.
export function useInboxActions({
  user,
  inboxItems,
  allInboxItems,
  setAllInboxItems,
  captureText,
  setCaptureText,
  captureRef,
  setView,
  items,
  setItems,
  intents,
  setIntents,
  events,
  setEvents,
  refreshReminderIndex,
  withLoading,
  offerUndoFor,
  watchStatus,
}) {
  // The card's one-tap status toggle: someday or active only. Shown at once,
  // put back if the write fails.
  async function setInboxSuggestedStatus(inboxItemId, status) {
    const before = allInboxItems.find((i) => i.id === inboxItemId);
    if (!before) return;
    const apply = (value) =>
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? { ...i, suggestedStatus: value } : i)),
      );
    apply(status);
    const saved = await storage.patch(`inbox:${inboxItemId}`, { suggestedStatus: status });
    if (!saved) {
      apply(before.suggestedStatus);
      window.alert("Status was not saved.");
    }
  }

  async function handleCapture() {
    if (!captureText.trim()) return;
    return withLoading('Saving...', async () => {
      const inboxItem = {
        id: uid(),
        user_id: user.id,
        capturedText: captureText.trim(),
        createdAt: new Date().toISOString(),
        archived: false,
        triagedAt: null,
        suggestedContextId: null,
        suggestItem: false,
        suggestedItemText: null,
        suggestedItemDescription: null,
        suggestedItemElements: null,
        suggestIntent: false,
        suggestedIntentText: null,
        suggestedIntentDescription: null,
        suggestedIntentRecurrence: null,
        suggestEvent: false,
        suggestedEventDate: null,
        // NEW fields from Phase 7.2.1
        aiStatus: 'not_started',
        sourceType: 'manual',
        sourceMetadata: {},
        aiConfidence: null,
        aiReasoning: null,
        suggestedTags: [],
        suggestedItemId: null,
        suggestedCollectionId: null,
      };

      const savedCapture = await storage.set(`inbox:${inboxItem.id}`, inboxItem);
      // The saved row, not the one we built — see storage.set. Ours has no
      // `updatedAt`, which sorts a brand-new capture last under "Last modified"
      // and renders it with no timestamp line at all.
      setAllInboxItems((prev) => [...prev, savedCapture || inboxItem]); // Add to end (oldest first)
      setCaptureText("");
      if (captureRef.current) {
        captureRef.current.style.height = "auto";
      }
      setView("inbox");
    });
  }

  /**
   * Discard a capture from the inbox screen — Clipboard Step 5b.
   *
   * ⚠️ THIS ARCHIVES. IT USED TO HARD-DELETE, AND THE CHANGE FIXED A BUG RATHER
   * THAN EXPRESSING A PREFERENCE.
   *
   * The old rule was "a capture that does not make it through the inbox never
   * happened", so the row was deleted and `platform.audit_log` was the surviving
   * copy. That worked while an inbox row was the whole capture.
   *
   * A clip is TWO rows. `public.clips` holds the page text and the screenshot
   * slices; the inbox row is a lightweight pointer at it. Deleting the pointer
   * left the clip, and `get_recent_clips` decides "already handled" by reading
   * the paired inbox row — so a clip whose inbox row had been deleted looked
   * LIVE and came back to every new conversation, permanently. Binning a clip
   * was the one action that could not make it go away.
   *
   * So the row now stays, flagged: archived, stamped, and carrying WHY
   * ('discarded' — as against 'processed', which is what archive_inbox_item
   * writes when Claude has dealt with something). See spec decision 14 and
   * migration 066.
   *
   * Processing (`handleInboxSave`) archives too, with 'processed'. Discard leaves
   * `sourceApp` as it is and writes no outcome.
   */
  async function discardInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Discarding...', async () => {
      const discarded = {
        ...inboxItem,
        archived: true,
        triagedAt: new Date().toISOString(),
        archiveReason: 'discarded',
      };
      const saved = await storage.set(`inbox:${inboxItem.id}`, discarded);
      // storage.set swallows its own errors and returns false. Dropping the row
      // from the list after a failed write would hide a capture that is still
      // sitting in the inbox, and it would come back on the next refresh.
      if (!saved) {
        window.alert("Could not discard that capture. It is still in your inbox.");
        return;
      }
      // The row STAYS in state and its `archived` flag flips — Step 22. It used to be
      // filtered out of the array, which was the same thing while state held the live
      // inbox only; now the live list is derived, so removing the row here would drop it
      // from "Recently archived" too and the discard would look like a delete.
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || discarded : i)),
      );

      // A binned capture's reminders would fire for something no longer on screen.
      try {
        await cancelRemindersForDiscard(inboxItem.id);
      } catch (err) {
        console.error("[Reminders] cancel on discard failed:", err);
        window.alert("Discarded, but its reminder could not be cancelled and may still fire.");
      }
      refreshReminderIndex();

      // The undo writes the ORIGINAL row back, which restores archived,
      // triagedAt and archiveReason to whatever they were — all three together,
      // as inbox_archive_reason_needs_archived requires. `storage.set` UPDATEs
      // by id, so this is a plain field reversal now rather than the
      // re-insert-a-deleted-row trick it used to be.
      offerUndoFor("Capture discarded.", async () => {
        const restored = await storage.set(`inbox:${inboxItem.id}`, inboxItem);
        setAllInboxItems((prev) =>
          prev.map((i) => (i.id === inboxItemId ? restored || inboxItem : i)),
        );
        await restoreDiscardedReminders(inboxItem.id);
      });
    });
  }

  // Undo and Put back of a discard: re-arm the reminders it cancelled that are still ahead.
  async function restoreDiscardedReminders(inboxId) {
    try {
      await restoreRemindersAfterDiscard(inboxId);
    } catch (err) {
      console.error("[Reminders] restore after discard failed:", err);
      window.alert("The capture is back, but its reminder could not be restored.");
    }
    refreshReminderIndex();
  }

  /**
   * Edit a capture's text without triaging it — Step 12.7.
   *
   * NOT triage. Triage archives a capture; this one stays in the inbox, with
   * `triagedAt` still null. The row is spread rather than
   * rebuilt so every other column, that one included, is carried through
   * untouched.
   *
   * No MCP schema is involved: `update_inbox_item` writes the `ai_*` and
   * `suggested_*` fields, and this writes `captured_text`, a different column.
   * The tool schemas are frozen and stay frozen.
   *
   * ── The enrichment decision ──────────────────────────────────────────────
   *
   * Editing the text INVALIDATES any existing enrichment, so this clears
   * `aiStatus` back to `not_started` **and nulls the suggested_* fields with
   * it**. Clearing the status alone would not be enough, and that is the whole
   * argument: the inbox detail page seeds its triage fields
   * `suggestedIntentText || capturedText`, so a stale suggestion is not merely a
   * stale column — it is what the triage form PROPOSES. Leaving it would mean a
   * user who corrected a capture still gets offered the text they corrected.
   *
   * The cost is a good enrichment lost to a typo fix. It used to be mitigated by
   * a re-enrich button one tap away in this card; Clipboard Step 14 removed
   * that, so re-enriching now means asking in claude.ai. The clear still only
   * happens when the text ACTUALLY changed, which keeps it rare, and offering
   * the text a user just corrected would be worse than making them ask again.
   *
   * If this decision is overturned, this function is the only place to change.
   */
  async function updateInboxCaptureText(inboxItemId, capturedText) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return false;

    const text = (capturedText || "").trim();
    if (!text) {
      window.alert("A capture needs some text.");
      return false;
    }

    const textChanged = text !== inboxItem.capturedText;

    return withLoading("Saving...", async () => {
      const updated = {
        ...inboxItem,
        capturedText: text,
        ...(textChanged ? CLEARED_ENRICHMENT : {}),
      };

      const saved = await storage.set(`inbox:${inboxItem.id}`, updated);
      if (saved === false) {
        window.alert("Could not save that edit. The capture is unchanged.");
        return false;
      }

      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || updated : i)),
      );
      return true;
    });
  }

  /**
   * File an enriched capture in one tap, from the list — Clipboard Step 21.
   *
   * ⚠️ IT GOES THROUGH `handleInboxSave`, and that is the whole design. The detail
   * page's Process calls the same function with the same shape, so one tap archives
   * with reason 'processed' and stamps `source_inbox_id` exactly as the careful path
   * does. `triageDataForOneTap` is tested against what the page actually emits, so
   * "one tap" cannot quietly come to mean something else.
   *
   * No confirmation. It is reversible in the sense that matters — the capture is
   * archived rather than deleted, and what it created is an ordinary item or
   * intention — and the button only appears where Claude has already proposed
   * something, which is the judgement a confirm would be asking about.
   */
  async function processInboxItemFromList(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    // The suggested group goes with it, as the detail page's untouched Process would send it.
    return handleInboxSave(inboxItemId, triageDataForOneTap(inboxItem), { groupId: inboxItem.suggestedGroupId || null });
  }

  /**
   * Copy a task capture's text, with its id, for a Claude session — Step 21.
   *
   * The trailing `Alfred inbox item: <id>` line is the point: pasting the text alone
   * would leave that session with no way to archive the row afterwards.
   *
   * `navigator.clipboard` needs a secure context and can be refused, so the failure is
   * reported rather than swallowed — a Copy button that silently did nothing would be
   * indistinguishable from one that worked.
   */
  async function copyTaskInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    const text = copyTextForTask(inboxItem);
    try {
      await navigator.clipboard.writeText(text);
      offerUndoFor("Copied, with this item's id.", null);
    } catch (e) {
      window.alert(
        "Could not reach the clipboard, so nothing was copied. This usually means the " +
          "browser refused permission or the page is not on https.",
      );
    }
  }

  /**
   * Process a capture: one call to `process_inbox_item`, which writes the item, the
   * intention (taking the capture's reminders), the event and any collection member,
   * then archives the capture — all or nothing. `options.sourceApp` is the detail
   * page's App picker ("" or null = no app); left out (one tap), the capture keeps
   * its current app. Nothing on screen changes until the call succeeds.
   *
   * Still no Undo: un-archiving could not remove the records the capture became.
   */
  async function handleInboxSave(inboxItemId, triageData, options = {}) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Saving...', async () => {
      const { data, error } = await supabase.rpc("process_inbox_item", {
        p_inbox_id: inboxItem.id,
        p_payload: processInboxPayload(triageData, options),
      });
      if (error) {
        console.error("[Inbox] process failed:", error);
        window.alert(processFailedMessage(error));
        return;
      }

      const saved = toCamelCase(data);
      if (saved.item) setItems((prev) => [...prev, saved.item]);
      if (saved.intent) setIntents((prev) => [...prev, saved.intent]);
      if (saved.event) setEvents((prev) => [...prev, saved.event]);
      // Flipped, not dropped: "Recently archived" is where it goes next (Step 22).
      setAllInboxItems((prev) => prev.map((i) => (i.id === inboxItemId ? saved.inbox : i)));
      refreshReminderIndex();

      // The returned rows predate the 088 trigger the event fires, so they are the
      // before-state; the watch re-reads them and says "Moved to Active".
      if (saved.event && saved.intent) {
        await watchStatus({
          intents: [saved.intent],
          items: carriedItems(saved.intent, [], [saved.item, ...items]),
        })();
      }
    });
  }

  /**
   * Put an archived capture back in the inbox — Clipboard Step 22.
   *
   * All three archive fields move TOGETHER, because the database requires it:
   * `inbox_archive_reason_needs_archived` (migration 066) forbids a reason on a row that
   * is not archived, so clearing `archived` without clearing `archive_reason` is a
   * constraint violation rather than a partial success.
   *
   * ⚠️ IT CANNOT UNDO A PROCESSING, only the archiving. `handleInboxSave` says why it
   * offers no Undo of its own: the capture became an item, an intention or an event, and
   * putting the capture back does not remove any of them. That has not changed — what
   * changed is that the button is now asked for on every row, so instead of pretending,
   * it WARNS: `undoNeedsConfirming` is true for a processed row and `undoWarning` names
   * what is already out there. A discarded capture created nothing, so it just goes back
   * with no question.
   */
  async function unarchiveInboxItem(inboxItemId) {
    const inboxItem = allInboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;

    const records = { items, intents, events };
    if (
      undoNeedsConfirming(inboxItem, records) &&
      !window.confirm(undoWarning(inboxItem, records))
    ) {
      return;
    }

    return withLoading("Putting it back...", async () => {
      const restored = {
        ...inboxItem,
        archived: false,
        triagedAt: null,
        archiveReason: null,
      };
      const saved = await storage.set(`inbox:${inboxItem.id}`, restored);
      // `storage.set` swallows its own errors and returns false. Showing the row back in
      // the inbox after a failed write would be a lie that survives until the next
      // refresh — which is exactly when it would disappear again, with no explanation.
      if (saved === false) {
        window.alert("Could not put that capture back. It is still archived.");
        return;
      }
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || restored : i)),
      );
      // Only a discard cancelled anything; a processed capture's reminders never stopped.
      if (inboxItem.archiveReason === "discarded") {
        await restoreDiscardedReminders(inboxItem.id);
      }
    });
  }

  return {
    handleCapture,
    discardInboxItem,
    updateInboxCaptureText,
    processInboxItemFromList,
    copyTaskInboxItem,
    handleInboxSave,
    unarchiveInboxItem,
    setInboxSuggestedStatus,
  };
}

/**
 * process_inbox_item's payload from the detail page's triage shape (and one tap's).
 * Ids are made here so the outcome and the screen agree; the database stamps
 * user_id and source_inbox_id. The collection branch is dormant: the page always
 * sends `addToCollection: false` for now (docs/inbox-detail-mockups/README.md).
 */
export function processInboxPayload(triageData, options = {}) {
  const payload = {};
  if ("sourceApp" in options) payload.source_app = options.sourceApp || null;

  let itemId = null;
  if (triageData.createItem && triageData.itemData) {
    const d = triageData.itemData;
    itemId = uid();
    payload.item = {
      id: itemId,
      name: d.name,
      description: d.description || "",
      context_id: d.contextId || null,
      elements: d.elements || [],
      tags: d.tags || [],
      status: d.status === "active" ? "active" : "someday",
    };
  }

  if (triageData.createIntention && triageData.intentionData) {
    const d = triageData.intentionData;
    const row = intentionRowFromTriage({ id: uid(), intentionData: d, createdItemId: itemId });
    payload.intent = {
      id: row.id,
      text: row.text,
      description: row.description,
      item_id: row.itemId || null,
      context_id: row.contextId || null,
      recurrence_config: row.recurrenceConfig,
      target_start_date: row.targetStartDate,
      end_date: row.endDate,
      tags: row.tags,
      status: row.status,
    };
    if (d.createEvent && d.eventDate) {
      payload.event = { id: uid(), time: d.eventDate, context_id: d.contextId || null, text: d.text };
    }
  }

  if (triageData.addToCollection && triageData.collectionData) {
    const c = triageData.collectionData;
    const target = c.itemId || itemId;
    if (target && c.collectionId) {
      payload.collection = { collection_id: c.collectionId, item_id: target, quantity: c.quantity || "1" };
    }
  }

  // Overwatch 8c: the new intention (or, with none, the item) joins this group, in the same call.
  if (options.groupId && (payload.item || payload.intent)) payload.group = { group_id: options.groupId };
  return payload;
}

/** The alert for a failed Process. Nothing was written, so it is safe to try again. */
export function processFailedMessage(error) {
  if (error?.code === "55000") return "That capture has already been filed. Nothing was changed.";
  if (/not one of your open groups/.test(error?.message || "")) {
    return "That group is closed, archived or no longer yours, so nothing was filed and the capture is still in " +
      "your inbox. Pick another group, or No group, and Process again.";
  }
  return `Could not process that capture. Nothing was saved, and it is still in your inbox.\n\n${error?.message || ""}`.trim();
}

// Helper functions for the inbox screens
// Everything an enrichment produced, reset — Step 12.7.
//
// Applied when a capture's text is edited, because the suggestions describe text
// that no longer exists. `aiStatus` alone would not do it: the inbox detail page seeds its
// triage fields `suggestedIntentText || capturedText`, so a stale suggestion is
// what the form PROPOSES, not just a column nobody reads.
//
// Written out in full rather than derived, so adding a `suggested_*` column and
// forgetting it here shows up as a field this list does not mention. The columns
// are the ones enrichment writes — the alfred-enrich skill through
// `update_inbox_item` as of Clipboard Step 14, the ai-enrich function before
// that. Both write the same set; see the inbox table comment.
const CLEARED_ENRICHMENT = {
  aiStatus: "not_started",
  aiConfidence: null,
  aiReasoning: null,
  suggestedContextId: null,
  suggestItem: false,
  suggestedItemText: null,
  suggestedItemDescription: null,
  suggestedItemElements: null,
  suggestedItemId: null,
  suggestIntent: false,
  suggestedIntentText: null,
  suggestedIntentDescription: null,
  suggestedIntentRecurrence: null,
  suggestEvent: false,
  suggestedEventDate: null,
  suggestedTags: [],
  suggestedCollectionId: null,
  suggestedGroupId: null,
  suggestedStatus: "someday",
};
