import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";

// Context writers and the archive guard, moved out of Alfred.jsx unchanged. Holds no
// state of its own: everything it reads or sets is Alfred's, passed in.
export function useContextActions({
  user,
  contexts,
  setContexts,
  items,
  setItems,
  intents,
  setIntents,
  events,
  collections,
  editingContext,
  setEditingContext,
  setShowContextForm,
  withLoading,
  offerUndoFor,
}) {
  // The core save, with the target passed in rather than read from
  // `editingContext`. Context detail edits in place now (Step 5) and has its own
  // notion of what it is editing; making it set Alfred's modal state first would
  // have meant two sources of truth for the same question.
  async function saveContextRecord(
    existing,
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
    defaultCollectionId = null,
  ) {
    return withLoading('Saving context...', async () => {
      // The <select> uses "" for "none", but default_collection_id is a FK to
      // item_collections.id — an empty string would violate it. Normalise here,
      // at the single point every caller funnels through.
      const defaultCollection = defaultCollectionId || null;

      // `tags` is stripped, deliberately. Contexts carried a jsonb tags column
      // with a GIN index and no user interface; the tags project's Migration A
      // drops it.
      //
      // This matters because `existing` comes from `select("*")` and
      // `storage.set` UPSERTS THE WHOLE OBJECT — so a spread would send a
      // `tags` key to a table that no longer has that column, and PostgREST
      // rejects the write outright (PGRST204). The window is narrow but real:
      // a tab that loaded contexts before the migration and saves one after it.
      // Costs nothing to be safe, and a context edit failing is not a failure
      // anyone would connect back to a dropped column.
      const { tags: _droppedContextTags, ...existingWithoutTags } =
        existing || {};

      const context = existing
        ? {
            ...existingWithoutTags,
            name,
            shared,
            keywords,
            description,
            pinned,
            defaultCollectionId: defaultCollection,
          }
        : {
            id: uid(),
            user_id: user.id,
            name,
            shared,
            keywords,
            description,
            pinned,
            defaultCollectionId: defaultCollection,
            createdAt: new Date().toISOString(),
          };

      const savedContext = (await storage.set(`context:${context.id}`, context, shared)) || context;

      // Both branches take the saved row. On the edit branch that matters as
      // much as on the create branch: the `set_updated_at` trigger stamps a new
      // `updated_at` that the object we sent does not have, so without this an
      // edited context kept its old "Last modified" until a reload.
      if (existing) {
        setContexts((prev) =>
          prev.map((c) => (c.id === context.id ? savedContext : c)),
        );
      } else {
        setContexts((prev) => [...prev, savedContext]);
      }
    });
  }

  // The Contexts page's form, which is driven by the `editingContext` modal
  // slot. Clearing that slot is a page concern, so it stays here rather than in
  // the shared core.
  async function saveContext(
    name,
    shared = false,
    keywords = "",
    description = "",
    pinned = false,
    defaultCollectionId = null,
  ) {
    await saveContextRecord(
      editingContext,
      name,
      shared,
      keywords,
      description,
      pinned,
      defaultCollectionId,
    );
    setShowContextForm(false);
    setEditingContext(null);
  }

  async function handleAddItemToContext(
    name,
    elements,
    contextId,
    description = "",
    isCaptureTarget = false,
  ) {
    return withLoading('Saving...', async () => {
      const newItem = {
        id: uid(),
        user_id: user.id,
        name: name || "New Item",
        description: description || "",
        contextId: contextId,
        elements: elements || [],
        isCaptureTarget: isCaptureTarget || false,
        createdAt: new Date().toISOString(),
      };

      const context = contexts.find((c) => c.id === contextId);
      const isShared = context?.shared || false;

      const savedItem = await storage.set(`item:${newItem.id}`, newItem, isShared);
      setItems([...items, savedItem || newItem]);
    });
  }

  async function handleAddIntentionToContext(
    text,
    contextId,
    itemId = null,
    collectionId = null,
    recurrenceConfig = null,
  ) {
    return withLoading('Saving...', async () => {
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: text || "New Intention",
        createdAt: new Date().toISOString(),
        isIntention: true,
        isItem: false,
        archived: false,
        itemId: itemId,
        contextId: contextId,
        recurrenceConfig: recurrenceConfig,
        collectionId: collectionId,
      };

      const savedIntent = await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents([...intents, savedIntent || newIntent]);
      return newIntent.id; // Return the ID so it can be scheduled
    });
  }

  // Contexts are taxonomy, not content, so archiving one is only safe while it
  // holds nothing — nothing cascades, and nothing is left pointing at a parent
  // the UI has stopped showing.
  //
  // ARCHIVED CHILDREN COUNT. An archived item still belongs to its context, and
  // there is a concrete reason beyond principle: the Recycle Bin labels each
  // archived row with its context name, and restoring an item whose context is
  // archived would put it somewhere with no page to reach. Emptiness means "no
  // children at all", not "no live children".
  //
  // All four counts come from state already loaded — `loadData` selects every
  // row of each table without a filter — so this needs no query.
  function contextChildCounts(contextId) {
    return {
      items: items.filter((i) => i.contextId === contextId).length,
      intentions: intents.filter((i) => i.contextId === contextId).length,
      events: events.filter((e) => e.contextId === contextId).length,
      collections: collections.filter((c) => c.contextId === contextId).length,
    };
  }

  /** Human list of what is stopping a context being archived; empty when clear. */
  function contextArchiveBlockers(contextId) {
    const counts = contextChildCounts(contextId);
    const label = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
    const parts = [];
    if (counts.items) parts.push(label(counts.items, "item", "items"));
    if (counts.intentions)
      parts.push(label(counts.intentions, "intention", "intentions"));
    if (counts.events) parts.push(label(counts.events, "event", "events"));
    if (counts.collections)
      parts.push(label(counts.collections, "collection", "collections"));
    return parts;
  }

  async function archiveContext(contextId) {
    const context = contexts.find((c) => c.id === contextId);
    if (!context) return;
    // Belt and braces: the button is disabled when this is non-empty, but the
    // counts come from state that a realtime insert can change between render
    // and click.
    const blockers = contextArchiveBlockers(contextId);
    if (blockers.length > 0) {
      window.alert(
        `Cannot archive "${context.name}": it still holds ${blockers.join(", ")}.`,
      );
      return;
    }
    return withLoading("Archiving...", async () => {
      const archived = { ...context, archived: true };
      await storage.set(`context:${contextId}`, archived, context.shared);
      setContexts((prev) => prev.map((c) => (c.id === contextId ? archived : c)));

      offerUndoFor(`Archived "${context.name}".`, async () => {
        await storage.set(`context:${contextId}`, context, context.shared);
        setContexts((prev) => prev.map((c) => (c.id === contextId ? context : c)));
      });
    });
  }

  return {
    saveContextRecord,
    saveContext,
    handleAddItemToContext,
    handleAddIntentionToContext,
    contextChildCounts,
    contextArchiveBlockers,
    archiveContext,
  };
}
