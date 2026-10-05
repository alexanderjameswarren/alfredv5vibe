import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { startOfPacificDay } from "../utils/localDay";
import {
  loadMembers,
  loadRemovals,
  addMembers,
  addOrMergeMembers,
  removeMember,
  removeMembers,
  reAddRemoval,
  updateMemberQuantity,
  updateMemberTags,
  loadCollectionTagPool,
  reorderMembers,
  REMOVAL_MANUAL,
  REMOVAL_COMPLETED,
} from "../utils/collectionMembers";

// Collection membership writers and collection CRUD, moved out of Alfred.jsx
// unchanged. Holds no state and no refs: everything it reads or sets is Alfred's,
// passed in — `memberWriteInFlight` included, which the poll in Alfred reads.
export function useCollections({
  user,
  collections,
  setCollections,
  contexts,
  setItems,
  collectionMembers,
  setCollectionMembers,
  setCollectionMembersError,
  setCollectionRemovals,
  setCollectionRemovalsError,
  reAddingRemovalId,
  setReAddingRemovalId,
  setCollectionHistory,
  setCollectionHistoryError,
  setCollectionTagPool,
  editingTagsItemId,
  setEditingTagsItemId,
  memberWriteInFlight,
  refreshData,
  withLoading,
  offerUndoFor,
}) {
  /**
   * Load membership rows for the given collections from collection_items.
   *
   * loadMembers reports failure by returning an error rather than throwing,
   * because withLoading swallows exceptions. A read failure must not look like
   * an empty collection, so it is surfaced in the UI rather than logged only.
   */
  async function loadCollectionMembers(collectionIds, options = {}) {
    const ids = (collectionIds || []).filter(Boolean);
    if (ids.length === 0) return;

    const results = await Promise.all(
      ids.map(async (id) => ({ id, ...(await loadMembers(id)) })),
    );

    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      console.error("[collections] failed to load members:", failed[0].error);
      // `quiet` is for the five-second poll. A failed tick means what is on
      // screen is five seconds old, not that it is wrong, and a banner that
      // flickers every five seconds would be worse than the staleness. A
      // foreground load still raises it, and a later success still clears it.
      if (!options.quiet) {
        setCollectionMembersError(`Could not load collection contents: ${failed[0].error}`);
      }
    } else {
      setCollectionMembersError(null);
    }

    setCollectionMembers((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (!r.error) next[r.id] = r.data;
      }
      return next;
    });
  }

  function membersOf(collectionId) {
    return collectionMembers[collectionId] || [];
  }

  function setMembersFor(collectionId, updater) {
    setCollectionMembers((prev) => ({
      ...prev,
      [collectionId]: updater(prev[collectionId] || []),
    }));
  }

  // ─── Collection membership writes ──────────────────────────────────────────
  //
  // These target collection_items. The item_collections.items jsonb is no longer
  // written by any of them and is now a frozen rollback snapshot.
  //
  // The data layer reports failure by returning { data, error } rather than
  // throwing, because withLoading catches and never rethrows — a thrown error
  // would be swallowed and the person would believe their edit had saved. Every
  // helper below inspects error and puts it in front of the user.

  function reportMembershipError(action, message) {
    console.error(`[collections] failed to ${action}:`, message);
    window.alert(`Could not ${action}: ${message}`);
  }

  async function addItemsToCollection(collectionId, entries) {
    const result = await addMembers(collectionId, entries, { userId: user.id });
    if (result.error) {
      reportMembershipError("add to this collection", result.error);
      return false;
    }
    await loadCollectionMembers([collectionId]);
    if (result.skipped.length > 0) {
      window.alert(
        result.skipped.length === 1
          ? "That item is already in this collection."
          : `${result.skipped.length} of those items were already in this collection.`,
      );
    }
    return true;
  }

  /**
   * Step 7 write path for Add to Collection.
   *
   * Three things happen, in this order:
   *   1. create any items the user chose to create
   *   2. ONE save of the source item's elements, stamping collectable and
   *      collectableItemId onto every row that was added
   *   3. add-or-merge the membership rows
   *
   * Returns true only if all three succeeded. The caller stays on the page on
   * false so the selection is not lost.
   *
   * Deliberately does NOT call updateItem: that helper ends with
   * `setItems(items.map(...))` over a closed-over snapshot, which would drop
   * the items created moments earlier in this same handler. State is updated
   * once here, functionally.
   */
  async function addElementsToCollection(collectionId, sourceItem, picks) {
    if (!collectionId || !sourceItem || !picks || picks.length === 0) return false;
    const coll = collections.find((c) => c.id === collectionId);
    if (!coll) return false;

    return withLoading("Adding...", async () => {
      const targetContext = contexts.find((c) => c.id === coll.contextId);
      const targetShared = targetContext?.shared || false;

      const created = [];
      const entries = [];
      const stamp = new Map();
      // One recipe can yield two create-new rows for the same product —
      // "Salt for the bean water" and "1/4 tsp salt" both reduce to salt.
      // Creating two items would be the catalogue pollution this feature
      // exists to prevent, so the first creation wins and the second reuses it.
      const createdByName = new Map();

      try {
        for (const pick of picks) {
          let itemId = pick.targetItemId;
          const nameKey = (pick.productName || "").trim().toLowerCase();
          if (!itemId && createdByName.has(nameKey)) {
            itemId = createdByName.get(nameKey);
          }
          if (!itemId) {
            // Same on-the-fly shape as CollectionAddItems.
            const newItem = {
              id: uid(),
              user_id: user.id,
              name: pick.productName,
              description: "",
              contextId: coll.contextId,
              elements: [],
              tags: [],
              isCaptureTarget: false,
              createdAt: new Date().toISOString(),
            };
            await storage.set(`item:${newItem.id}`, newItem, targetShared);
            created.push(newItem);
            itemId = newItem.id;
            createdByName.set(nameKey, itemId);
          }
          entries.push({ itemId, quantity: pick.quantity });
          if (Number.isInteger(pick.elementIndex)) stamp.set(pick.elementIndex, itemId);
        }

        // One save of the elements array, not one per row.
        const nextElements = (sourceItem.elements || []).map((el, idx) =>
          stamp.has(idx)
            ? { ...el, collectable: true, collectableItemId: stamp.get(idx) }
            : el,
        );
        const updatedSource = { ...sourceItem, elements: nextElements };
        const sourceContext = contexts.find((c) => c.id === updatedSource.contextId);
        await storage.set(
          `item:${updatedSource.id}`,
          updatedSource,
          sourceContext?.shared || false,
        );

        // One functional update covering both writes above.
        setItems((prev) => [
          ...prev.map((i) => (i.id === updatedSource.id ? updatedSource : i)),
          ...created,
        ]);
      } catch (error) {
        // storage.set throws; the module contract does not apply to it.
        console.error("[addElementsToCollection]", error);
        window.alert(
          "Could not save: " + (error?.message || "Unknown error") +
            ". Nothing was added to the collection.",
        );
        return false;
      }

      const result = await addOrMergeMembers(collectionId, entries, {
        userId: user.id,
      });
      await loadCollectionMembers([collectionId]);
      if (result.error) {
        reportMembershipError("add to this collection", result.error);
        return false;
      }
      return true;
    });
  }

  // OPTIMISTIC as of Step 12.4b — the row leaves the list on the tap, not on the
  // round trip. Same shape as toggleExecutionElement, which is why ticking items
  // off in an execution always felt instant and this did not.
  //
  // Step 12.4 removed the overlay but the wait stayed, because the row was still
  // gated on a write plus three reloads. Taking a spinner off a slow action makes
  // it feel broken rather than fast; the two halves only work together.
  //
  // ORDER MATTERS, and it is the whole correctness argument:
  //
  //   1. `memberWriteInFlight` is raised FIRST, before the optimistic update, not
  //      around the write. The five-second poll refetches membership; a tick
  //      landing between "row dropped from state" and "row deleted in Postgres"
  //      would read the pre-delete rows and put the row back under the user's
  //      thumb. That window is precisely what going optimistic creates.
  //   2. It is a COUNTER, not a flag, which is what makes three quick taps safe:
  //      they raise it to 3 and it returns to 0 only when the last settles. A
  //      boolean would let the second removal's completion clear the first's
  //      guard while the first was still in flight.
  //   3. The state update is FUNCTIONAL, so overlapping removals compose rather
  //      than clobber. Each filter runs against what the previous one left, not
  //      against a snapshot captured when this handler was created.
  //
  // On failure the row comes back by RELOADING rather than by re-inserting a
  // snapshot. The server owns the order; a partial failure (row deleted, removal
  // log not written) is real; and a reload is correct in every case where a
  // spliced snapshot would be correct in most. One round trip on a rare path, in
  // exchange for never showing a removal that did not happen.
  async function removeItemFromCollection(collectionId, itemId) {
    memberWriteInFlight.current += 1;
    setMembersFor(collectionId, (prev) => prev.filter((m) => m.itemId !== itemId));

    try {
      const result = await removeMember(collectionId, itemId, {
        reason: REMOVAL_MANUAL,
        userId: user.id,
      });

      if (result.error) {
        reportMembershipError("remove that item", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }

      // Membership is deliberately NOT reloaded on success: state already holds
      // the right answer, and a refetch would be a round trip whose only visible
      // effect is confirming what the user can already see. These two feed the
      // "Recently removed" panel and the history view, neither of which anyone is
      // waiting on.
      await loadCollectionRemovals(collectionId);
      await loadCollectionHistory(collectionId);
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  /**
   * Load manual removal history for the recently-removed panel.
   *
   * Only reason='manual'. A single execution completion can clear a dozen items
   * at once, and mixing those in would bury the accidental removal this panel
   * exists to catch; they show up in the full history view instead.
   *
   * Fetches a wider window than the panel displays, because entries whose item
   * is back in the collection are filtered out at render — fetching exactly five
   * could leave the panel showing fewer than it could.
   */
  async function loadCollectionRemovals(collectionId, options = {}) {
    const result = await loadRemovals(collectionId, {
      reason: REMOVAL_MANUAL,
      // Everything removed since midnight, uncapped. It used to be the most
      // recent 25, trimmed to 5 on render — which meant a shopping trip that
      // took more than five things off the list could not show you the sixth,
      // and one that took off more than 25 had already lost them before the
      // render ever saw them.
      //
      // PACIFIC midnight, not the browser's. `removed_at` is a server
      // timestamp and the boundary comes from an IANA rule, so the device's
      // TIMEZONE is consulted for nothing: a phone in Tokyo and a phone at home
      // show the same list, at the same moment, for the same collection.
      //
      // The device clock is not entirely out of it, and the comment here used
      // to overclaim that. `startOfPacificDay()` reads `new Date()` to decide
      // WHICH Pacific day is current — unavoidable for a window meaning
      // "today". A clock wrong by minutes or hours lands on the same day and
      // changes nothing; only one wrong enough to cross a Pacific day boundary
      // would pick the wrong day. That is also what makes this testable without
      // waiting: set the phone a day forward and the panel should empty.
      since: startOfPacificDay(),
      limit: null,
    });
    if (result.error) {
      // Surfaced in the panel rather than as an alert: this is a background read
      // on view open, and an alert on every visit would be intolerable. Poll
      // ticks pass `quiet` and do not raise the banner at all — see
      // loadCollectionMembers.
      console.error("[collections] failed to load removal history:", result.error);
      if (!options.quiet) {
        setCollectionRemovalsError(`Could not load removal history: ${result.error}`);
      }
      return false;
    }
    setCollectionRemovalsError(null);
    setCollectionRemovals((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Load the full removal history for the history view: both kinds, nothing
   * filtered out, newest first, capped at 50.
   *
   * Kept as a separate fetch from loadCollectionRemovals rather than deriving
   * both from one query. The panel wants the most recent *manual* removals, and
   * a collection with heavy completion churn could push every manual row out of
   * a mixed 50-row window while manual removals still exist.
   */
  async function loadCollectionHistory(collectionId) {
    const result = await loadRemovals(collectionId, { limit: 50 });
    if (result.error) {
      console.error("[collections] failed to load full history:", result.error);
      setCollectionHistoryError(`Could not load removal history: ${result.error}`);
      return false;
    }
    setCollectionHistoryError(null);
    setCollectionHistory((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Put a removed item back. The removal record is left in place — the table is
   * append-only and the item genuinely was removed at that time. The entry drops
   * out of the panel because the item is a member again, not because the history
   * was rewritten.
   */
  // Optimistic too, for consistency as much as speed: this sits a few inches
  // below the remove button on the same screen, in the same aisle. One instant
  // and one laggy would read as a bug in whichever felt slower.
  //
  // The provisional row carries only what the member list renders — `id`,
  // `itemId`, `quantity` — and is swapped for the real row the insert returns.
  // Its `id` is namespaced so it can never collide with a database id if
  // something goes wrong before the swap.
  //
  // Adding the member row is all that is needed to clear the entry from the
  // "Recently removed" panel: `recentRemovals` filters out removals whose item is
  // back in the collection, so the panel row disappears as a consequence rather
  // than needing its own optimistic update. One write, both halves of the
  // feedback.
  async function putBackRemoval(removal) {
    if (reAddingRemovalId) return false;
    setReAddingRemovalId(removal.id);
    memberWriteInFlight.current += 1;

    const provisional = {
      id: `pending:${removal.id}`,
      itemId: removal.itemId,
      quantity: removal.quantity,
    };
    setMembersFor(removal.collectionId, (prev) =>
      prev.some((m) => m.itemId === removal.itemId) ? prev : [...prev, provisional],
    );

    try {
      const result = await reAddRemoval(removal, { userId: user.id });

      if (result.error) {
        reportMembershipError("put that item back", result.error);
        setMembersFor(removal.collectionId, (prev) =>
          prev.filter((m) => m.id !== provisional.id),
        );
        return false;
      }

      // alreadyPresent means a double tap, or the other person restored it first.
      // That is the desired end state, so it is a quiet success, not a warning —
      // but it also means `result.data` is null, so the provisional row has no
      // real row to become and a reload is the only way to learn the true one.
      if (result.data) {
        setMembersFor(removal.collectionId, (prev) =>
          prev.map((m) => (m.id === provisional.id ? result.data : m)),
        );
      } else {
        await loadCollectionMembers([removal.collectionId]);
      }

      await loadCollectionRemovals(removal.collectionId);
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
      setReAddingRemovalId(null);
    }
  }

  // saveMemberQuantity and saveMemberOrder are not wrapped in withLoading, so
  // nothing else stops a poll tick landing in the middle of one and reverting the
  // change until the next tick. They hold the poll off for their own duration.
  //
  // As of Step 12.4 removeItemFromCollection and putBackRemoval are in this set
  // too — every write on the shopping path now holds the poll off explicitly
  // rather than as a side effect of raising a full-screen overlay.
  /**
   * Load the tag vocabulary for one collection's picker.
   *
   * Non-fatal by design: a picker with no suggestions still lets you create a
   * tag, so a failure here logs and leaves the pool empty rather than blocking
   * the control or raising an alert mid-shop.
   */
  /**
   * Close whichever collection tag editor is open.
   *
   * THE single close path. Tapping Done, tapping the open row's own Tag button,
   * switching to a different row, and leaving the view all route through here,
   * so none of them can drift from the others as this grows. Right now the
   * cleanup is one state write; the point is that when it stops being one, it
   * stops being one everywhere at once.
   *
   * Uncommitted text in the picker is discarded rather than committed, which is
   * the Phase 4 rule holding: a tag is created only by an explicit act. The
   * picker unmounts with the row, taking its query state with it.
   *
   * Clearing this also un-pauses the collection poll, via the effect that reads
   * `editingTagsItemId`.
   */
  function closeTagEditor() {
    setEditingTagsItemId(null);
  }

  /**
   * Open the tag editor on one member row, closing any other first.
   *
   * The close goes through `closeTagEditor` rather than being implied by
   * overwriting the id, so switching rows and closing a row share a path. React
   * batches the two writes, so the outgoing picker unmounts and the incoming
   * one mounts in a single commit — no flicker, and no window where the poll
   * sees "nothing open" and resumes mid-switch.
   */
  function openTagEditor(itemId) {
    closeTagEditor();
    setEditingTagsItemId(itemId);
  }

  /** Tapping a row's Tag button: close it if it is the open one, else switch. */
  function toggleTagEditor(itemId) {
    if (editingTagsItemId === itemId) closeTagEditor();
    else openTagEditor(itemId);
  }

  async function loadCollectionTags(collectionId) {
    const result = await loadCollectionTagPool(collectionId);
    if (result.error) {
      console.error("[collections] failed to load the tag pool:", result.error);
      return;
    }
    setCollectionTagPool((prev) => ({ ...prev, [collectionId]: result.data }));
  }

  /**
   * Write a member row's tags.
   *
   * Optimistic, like the quantity save: the chips change on the tap and the
   * write follows. A failure reloads membership so the row snaps back to what
   * the database actually holds rather than lying about it.
   *
   * The new tag is folded into the pool immediately so it is offered on the
   * next row without waiting for a refetch — tagging three items for the same
   * store in a row is the normal case, and only the first should cost a
   * "Create".
   */
  async function saveMemberTags(collectionId, itemId, tags) {
    memberWriteInFlight.current += 1;
    try {
      setCollectionTagPool((prev) => {
        const pool = prev[collectionId] || [];
        const added = tags.filter((tag) => !pool.includes(tag));
        return added.length === 0
          ? prev
          : { ...prev, [collectionId]: [...pool, ...added] };
      });

      const result = await updateMemberTags(collectionId, itemId, tags);
      if (result.error) {
        reportMembershipError("save those tags", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      setMembersFor(collectionId, (prev) =>
        prev.map((m) => (m.itemId === itemId ? result.data : m)),
      );
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  async function saveMemberQuantity(collectionId, itemId, quantity) {
    memberWriteInFlight.current += 1;
    try {
      const result = await updateMemberQuantity(collectionId, itemId, quantity);
      if (result.error) {
        reportMembershipError("save that quantity", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      setMembersFor(collectionId, (prev) =>
        prev.map((m) => (m.itemId === itemId ? result.data : m)),
      );
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  /**
   * Clear the items checked off during an execution, recording each as a
   * 'completed' removal.
   *
   * One removeMembers call rather than a loop over singular removals: every row
   * must land in a single INSERT so they share the server's transaction
   * timestamp exactly, which is what lets the history view group a bulk
   * clear-out under one heading.
   */
  async function clearCompletedFromCollection(collectionId, itemIds) {
    const result = await removeMembers(collectionId, itemIds, {
      reason: REMOVAL_COMPLETED,
      userId: user.id,
    });
    await loadCollectionMembers([collectionId]);
    if (result.error) {
      reportMembershipError("clear the completed items", result.error);
      return false;
    }
    return true;
  }

  async function saveMemberOrder(collectionId, orderedMembers) {
    memberWriteInFlight.current += 1;
    try {
      const result = await reorderMembers(collectionId, orderedMembers);
      if (result.error) {
        reportMembershipError("save the new order", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  async function refreshCollection(collectionId) {
    const coll = await storage.get(`item_collections:${collectionId}`);
    if (coll) {
      setCollections((prev) =>
        prev.map((c) => (c.id === collectionId ? coll : c))
      );
    }
    await loadCollectionMembers([collectionId]);
  }

  // Collection CRUD
  async function addCollection(name, contextId = null) {
    return withLoading('Creating collection...', async () => {
      const newColl = {
        id: uid(),
        userId: user.id,
        name: name || "New Collection",
        contextId: contextId || null,
        shared: false,
        isCaptureTarget: false,
        // Explicit rather than leaning on the column default, so the object in
        // local state has the same shape as one read back from the database —
        // `updateCollection` spreads the whole row, and `activeCollections`
        // filters on this field.
        archived: false,
        // No items seed: membership lives in collection_items now. The jsonb
        // column keeps its own '[]' default and is never written again.
        createdAt: new Date().toISOString(),
      };
      const savedColl = await storage.set(`item_collections:${newColl.id}`, newColl);
      // Collections have NO realtime channel, so this is the only chance to
      // learn the database's `updated_at` short of a manual refresh.
      setCollections((prev) => [...prev, savedColl || newColl]);
      return newColl.id;
    });
  }

  // Collection metadata only — name, context, shared, pinned. Membership goes
  // through the collection_items helpers above.
  //
  // The `silent` flag STAYS. Step 12.4 briefly removed it and made every field
  // here quiet; that was the wrong target. These four settings — Context,
  // Shared, Pinned, Capture-target — are configuration, changed rarely and at a
  // desk, not the per-item taps done one-handed in a supermarket aisle. The
  // overlay was never the complaint here, so it goes back rather than leaving an
  // unrequested change behind. The shopping-path writes are the ones that lost
  // it: see removeItemFromCollection and putBackRemoval.
  //
  // What 12.4 DID leave behind is the error handling, and that was a real bug
  // independent of any screen. `storage.set` returns false rather than throwing,
  // so the silent branch's `catch` never fired for the failure that actually
  // happens: a failed save left the control showing a value the database did not
  // have, with nothing on screen and nothing in the console. Both branches now
  // report it and re-read the truth.
  async function updateCollection(collId, updates, silent = false) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;

    const reportFailure = async () => {
      window.alert("That change could not be saved. Reloading this collection.");
      await refreshData();
    };

    const doSave = async () => {
      const savedColl = await storage.set(`item_collections:${coll.id}`, { ...coll, ...updates });

      if (savedColl === false) {
        await reportFailure();
        return;
      }

      // Functional updater: apply the patch to the freshest state rather than
      // replacing the row with a snapshot captured at render time, which is an
      // independent cause of lost concurrent edits.
      //
      // `savedColl` sits in the MIDDLE of the spread as of Step 12.3, not at the
      // end: it carries the columns the database assigns — `updated_at` above
      // all — while `updates` stays the winner for the fields the user just
      // edited. Replacing the row with `savedColl` outright would take the
      // server's copy of every field and reintroduce exactly the clobber this
      // functional updater exists to prevent.
      setCollections((prev) =>
        prev.map((c) => (c.id === collId ? { ...c, ...savedColl, ...updates } : c)),
      );
    };

    if (silent) {
      try {
        await doSave();
      } catch (e) {
        console.error("Collection save error:", e);
        await reportFailure();
      }
    } else {
      return withLoading("Saving...", doSave);
    }
  }

  // Archive, not delete. Hard-deleting a collection cascades to
  // `collection_items` AND `collection_item_removals` — and the latter is an
  // append-only log of what was taken out of the collection and when, which is
  // the recovery path for accidental removals during shopping. Destroying that
  // behind a 5-second Undo was not acceptable, so collections became
  // soft-deletable like every other Alfred entity. See the spec's Undo section,
  // exception 2. The only hard delete left is the Recycle Bin's terminal one.
  //
  // Membership is deliberately left in `collectionMembers`: a soft delete does
  // not touch `collection_items`, so the cached rows stay correct and Undo has
  // nothing to rebuild.
  async function archiveCollection(collId) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;
    return withLoading('Archiving...', async () => {
      const archived = { ...coll, archived: true };
      await storage.set(`item_collections:${collId}`, archived);
      setCollections((prev) => prev.map((c) => (c.id === collId ? archived : c)));

      offerUndoFor(`Archived "${coll.name}".`, async () => {
        await storage.set(`item_collections:${collId}`, coll);
        setCollections((prev) => prev.map((c) => (c.id === collId ? coll : c)));
      });
    });
  }

  return {
    loadCollectionMembers,
    membersOf,
    setMembersFor,
    addItemsToCollection,
    addElementsToCollection,
    removeItemFromCollection,
    loadCollectionRemovals,
    loadCollectionHistory,
    putBackRemoval,
    closeTagEditor,
    toggleTagEditor,
    loadCollectionTags,
    saveMemberTags,
    saveMemberQuantity,
    clearCompletedFromCollection,
    saveMemberOrder,
    refreshCollection,
    addCollection,
    updateCollection,
    archiveCollection,
  };
}
