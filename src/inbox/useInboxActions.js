import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import {
  moveRemindersToIntention,
  cancelRemindersForDiscard,
  restoreRemindersAfterDiscard,
} from "../utils/remindersApi";
import { undoNeedsConfirming, undoWarning } from "../utils/inboxArchive";
import { copyTextForTask, triageDataForOneTap } from "../utils/inboxSuggestions";
import { intentionRowFromTriage } from "../utils/intentionRows";
import { carriedItems } from "../utils/status";

// Inbox writers, moved out of Alfred.jsx unchanged. Holds no state: everything it
// reads or sets is Alfred's, passed in — including `addItemsToCollection` and
// `refreshReminderIndex`, which belong to other features.
export function useInboxActions({
  user,
  inboxItems,
  allInboxItems,
  setAllInboxItems,
  captureText,
  setCaptureText,
  captureRef,
  setView,
  contexts,
  items,
  setItems,
  intents,
  setIntents,
  events,
  setEvents,
  refreshReminderIndex,
  addItemsToCollection,
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
   * Human triage through the process/save flow (`handleInboxSave`) is NOT
   * changed here and still deletes on success. Phase 3's one-tap process button
   * is where that becomes an archive with 'processed'.
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
   * NOT triage. Step 10's disposal rule deletes a capture on successful triage;
   * this one stays, with `triagedAt` still null. The row is spread rather than
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
    return handleInboxSave(inboxItemId, triageDataForOneTap(inboxItem));
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

  async function handleInboxSave(inboxItemId, triageData) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Saving...', async () => {
      let createdItemId = null;
      let createdItem = null;

      // "Delete only on success" needs an explicit check, because none of the
      // writers below throw. `storage.set` catches its own errors and returns
      // false; `addItemsToCollection` alerts and returns false. Nothing read
      // either until now, which was survivable while disposal merely set a
      // flag — the row stayed in the table and could be recovered. A hard
      // delete on a failed triage would destroy the capture AND leave nothing
      // downstream to show for it.
      let allWritesSucceeded = true;
      // Returns the result unchanged rather than a boolean, so a caller can
      // both record the failure and use the saved row — `storage.set` returns
      // the row it wrote as of Step 12.3. `false` is still the only falsy
      // result, which is what the check above and the `saved || local`
      // fallbacks below both rely on.
      const wrote = (result) => {
        if (result === false) allWritesSucceeded = false;
        return result;
      };

      // Create item if Item section was open
      if (triageData.createItem && triageData.itemData) {
        const newItem = {
          id: uid(),
          user_id: user.id,
          name: triageData.itemData.name,
          description: triageData.itemData.description || "",
          contextId: triageData.itemData.contextId,
          elements: triageData.itemData.elements || [],
          tags: triageData.itemData.tags || [],
          isCaptureTarget: false,
          // Chosen at triage (088); sent on INSERT, which storage.set keeps.
          status: triageData.itemData.status === "active" ? "active" : "someday",
          createdAt: new Date().toISOString(),
          // Where this came from — Clipboard Step 14. Only meaningful because
          // the inbox row below is now archived rather than deleted; the FK is
          // ON DELETE SET NULL, so a deleted capture would take the link with it.
          sourceInboxId: inboxItem.id,
        };

        const context = contexts.find((c) => c.id === newItem.contextId);
        const isShared = context?.shared || false;
        const savedItem = wrote(await storage.set(`item:${newItem.id}`, newItem, isShared));
        setItems((prev) => [...prev, savedItem || newItem]);
        createdItemId = newItem.id;
        createdItem = savedItem || newItem;

        // "Attach this Item" — appending the new item as a bullet element of an
        // existing one — used to happen here, driven by `triageData.itemItemLinks`.
        // Alex dropped the control in Step 17b and Step 18 deleted the form that
        // was its only source, so nothing could reach this branch again. Removed
        // rather than left looking live.
      }

      // Create intention if Intention section was open
      if (triageData.createIntention && triageData.intentionData) {
        // The row itself is built by a pure function in utils/intentionRows.js, so
        // that the mapping — `description` in particular — is reachable by a test.
        // It was not, which is why "is Details being saved?" could only be
        // answered by reading code. See that file's header.
        const newIntent = intentionRowFromTriage({
          id: uid(),
          userId: user.id,
          intentionData: triageData.intentionData,
          createdItemId,
          sourceInboxId: inboxItem.id,
          createdAt: new Date().toISOString(),
        });
        // Read back off the row rather than recomputed, so the event below and the
        // intention cannot disagree about which item this is.
        const intentionItemId = newIntent.itemId;
        const savedIntent = wrote(await storage.set(`intent:${newIntent.id}`, newIntent));
        setIntents((prev) => [...prev, savedIntent || newIntent]);

        // The capture's reminders follow it to the intention. Not a triage failure if
        // this fails: they stay on the archived capture and still fire.
        if (savedIntent) {
          try {
            await moveRemindersToIntention(inboxItem.id, newIntent.id);
          } catch (err) {
            console.error("[Reminders] move to intention failed:", err);
            window.alert("Saved, but this capture's reminder could not be moved to the new intention. It will still fire, and opens the capture.");
          }
          refreshReminderIndex();
        }

        // Create event if scheduled. A date makes a someday intention and its item
        // active (088 trigger); the watch re-reads them and says so.
        if (triageData.intentionData.createEvent && triageData.intentionData.eventDate) {
          const settle = watchStatus({
            intents: [savedIntent || newIntent],
            items: carriedItems(newIntent, [], [createdItem, ...items]),
          });
          const newEvent = {
            id: uid(),
            user_id: user.id,
            intentId: newIntent.id,
            contextId: triageData.intentionData.contextId,
            time: triageData.intentionData.eventDate,
            itemIds: intentionItemId ? [intentionItemId] : [],
            archived: false,
            createdAt: new Date().toISOString(),
            text: triageData.intentionData.text,
            // Redundant with the intention's, which carries the same value. Kept
            // so an event reached from the calendar answers "where did this come
            // from" without a join back through intents.
            sourceInboxId: inboxItem.id,
          };
          const savedEvent = wrote(await storage.set(`event:${newEvent.id}`, newEvent));
          setEvents((prev) => [...prev, savedEvent || newEvent]);
          await settle();
        }
      }

      // Add to collection if Collection section was open.
      //
      // ⚠️ DORMANT, NOT DEAD. The inbox detail page always sends
      // `addToCollection: false`, because the approved design hides collections
      // "for now" — docs/inbox-detail-mockups/README.md. This is kept, unlike the
      // itemItemLinks branch above, precisely because that "for now" is a plan and
      // not a removal: when the section comes back it sends the same shape and this
      // works unchanged.
      if (triageData.addToCollection && triageData.collectionData) {
        const targetItemId = triageData.collectionData.itemId || createdItemId;
        const targetCollectionId = triageData.collectionData.collectionId;
        if (targetItemId && targetCollectionId) {
          wrote(
            await addItemsToCollection(targetCollectionId, [
              {
                itemId: targetItemId,
                quantity: triageData.collectionData.quantity || '1',
              },
            ]),
          );
        }
      }

      // On failure the row stays put. Partial success is possible — the item
      // may have been created and the intention not — so this says "check what
      // was created" rather than "try again", which could duplicate the half
      // that worked.
      if (!allWritesSucceeded) {
        window.alert(
          "Some of that capture could not be saved, so it has been left in your inbox. Check what was created before filing it again.",
        );
        return;
      }

      // -------------------------------------------------------------------
      // TRIAGE ARCHIVES. IT USED TO DELETE — Clipboard Step 14.
      // -------------------------------------------------------------------
      //
      // The capture has become an item, an intention, an event or a collection
      // member, so it has no further job ON THE INBOX SCREEN. It does still have
      // a job: the records above now carry `sourceInboxId` pointing back here,
      // and the FK is ON DELETE SET NULL, so deleting this row would silently
      // cut every one of those links a moment after they were written.
      //
      // That is why the archive and the links are ONE change. Either half alone
      // is useless or actively misleading: links to a row that is about to
      // vanish, or an archived row nothing points at.
      //
      // This was the LAST hard delete on the inbox — Step 5b turned the trash
      // can into an archive with reason 'discarded' and deliberately left this
      // path alone until there was a reason to keep the row. Now there is.
      //
      // Still no Undo, and for the unchanged reason: undo would un-archive the
      // capture but could not remove the records it turned into, so it would
      // restore something already filed. A button labelled Undo that half-undoes
      // is worse than none. Discard has no such problem, which is why it offers
      // one.
      const processed = {
        ...inboxItem,
        archived: true,
        triagedAt: new Date().toISOString(),
        archiveReason: 'processed',
      };
      const disposed = await storage.set(`inbox:${inboxItem.id}`, processed);
      if (disposed === false) {
        window.alert(
          "Everything was saved, but the capture could not be filed away. It is still in your inbox — archive it by hand, and do not save it again or you will get a second copy of everything.",
        );
        return;
      }
      // Flips the flag rather than dropping the row — Step 22, same change as in
      // `discardInboxItem` and for the same reason: the live list is derived now, and
      // "Recently archived" is what this capture goes on to appear in.
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? disposed || processed : i)),
      );
      // An item filed from this capture shows the capture's reminder on its card.
      refreshReminderIndex();
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
  suggestedStatus: "someday",
};
