import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import { STATUS_LABELS } from "../utils/status";

// Item writers, moved out of Alfred.jsx unchanged. Holds no state: everything it
// reads or sets is Alfred's, passed in.
export function useItemActions({
  user,
  items,
  setItems,
  contexts,
  withLoading,
  offerUndoFor,
}) {
  async function updateItem(itemId, updates) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading('Saving...', async () => {
      const updated = {
        id: item.id,
        userId: item.userId,
        name: updates.name !== undefined ? updates.name : item.name,
        description:
          updates.description !== undefined
            ? updates.description
            : item.description || "",
        contextId:
          updates.contextId !== undefined ? updates.contextId : item.contextId,
        elements:
          updates.elements !== undefined
            ? updates.elements
            : item.elements || item.components || [],
        tags:
          updates.tags !== undefined ? updates.tags : item.tags || [],
        isCaptureTarget:
          updates.isCaptureTarget !== undefined
            ? updates.isCaptureTarget
            : item.isCaptureTarget || false,
        archived:
          updates.archived !== undefined
            ? updates.archived
            : item.archived || false,
        createdAt: item.createdAt,
      };

      const context = contexts.find((c) => c.id === updated.contextId);
      const isShared = context?.shared || false;

      const savedItem = await storage.set(`item:${item.id}`, updated, isShared);
      setItems(items.map((i) => (i.id === itemId ? savedItem || updated : i)));

      // `item` is the pre-archive snapshot, so restoring is a straight rewrite
      // rather than a flag flip — it also puts back anything the archiving edit
      // happened to change alongside `archived`.
      if (updates.archived === true) {
        offerUndoFor(`Archived "${item.name}".`, async () => {
          await storage.set(`item:${item.id}`, item, isShared);
          setItems((prev) => prev.map((i) => (i.id === itemId ? item : i)));
        });
      }
    });
  }

  async function deepCloneItem(sourceItemId, newName) {
    const source = items.find((i) => i.id === sourceItemId);
    if (!source) return null;
    return withLoading('Cloning...', async () => {
      const clonedIds = new Map(); // sourceId -> cloneId
      const newItems = [];

      // Recursively clone item and its children
      async function cloneRecursive(itemId, visited = new Set()) {
        if (visited.has(itemId) || clonedIds.has(itemId)) return clonedIds.get(itemId);
        visited.add(itemId);

        const item = items.find((i) => i.id === itemId);
        if (!item) return null;

        const cloneId = uid();
        clonedIds.set(itemId, cloneId);

        // Clone child references first
        const clonedElements = [];
        for (const el of (item.elements || [])) {
          const elItemId = el.itemId || el.item_id;
          if (elItemId) {
            const childCloneId = await cloneRecursive(elItemId, new Set(visited));
            clonedElements.push({ ...el, itemId: childCloneId || elItemId });
          } else {
            clonedElements.push({ ...el });
          }
        }

        const cloned = {
          id: cloneId,
          userId: user.id,
          name: itemId === sourceItemId ? newName : item.name,
          description: item.description || "",
          contextId: item.contextId || null,
          elements: clonedElements,
          tags: [...(item.tags || [])],
          isCaptureTarget: false,
          archived: false,
          createdAt: new Date().toISOString(),
        };

        const savedClone = await storage.set(`item:${cloneId}`, cloned);
        newItems.push(savedClone || cloned);
        return cloneId;
      }

      await cloneRecursive(sourceItemId);
      setItems((prev) => [...prev, ...newItems]);
      return newItems.find((i) => i.id === clonedIds.get(sourceItemId));
    });
  }

  // The only way an item's status changes by hand: storage.set drops it on UPDATE.
  // Undo never restores someday, which the database would refuse.
  async function setItemStatus(itemId, status) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading("Saving...", async () => {
      const saved = await storage.patch(`item:${itemId}`, { status });
      if (!saved) throw new Error("Status was not saved.");
      setItems((prev) => prev.map((i) => (i.id === itemId ? saved : i)));
      const previous = item.status;
      if (!previous || previous === "someday") return;
      offerUndoFor(`Moved to ${STATUS_LABELS[status]}.`, async () => {
        const back = await storage.patch(`item:${itemId}`, { status: previous });
        if (back) setItems((prev) => prev.map((i) => (i.id === itemId ? back : i)));
      });
    });
  }

  return { updateItem, deepCloneItem, setItemStatus };
}
