import React from "react";
import { storage } from "../utils/storage";
import { uid } from "../utils/flattenElements";
import CollectionAddItems from "./CollectionAddItems";

// The collection's add-items route, moved out of Alfred.jsx unchanged. It was an
// inline `(() => { ... })()` under `view === "collection-add-items"`; that test
// stays in Alfred and the function body is this component's body.
export default function CollectionAddItemsScreen({
  user,
  collections,
  selectedCollectionId,
  items,
  setItems,
  contexts,
  membersOf,
  addItemsToCollection,
  withLoading,
  setView,
}) {
  const coll = collections.find((c) => c.id === selectedCollectionId);
  if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
  const members = membersOf(coll.id);
  const existingItemIds = new Set(members.map((m) => m.itemId));
  const availableItems = items.filter((i) => !i.archived && !existingItemIds.has(i.id) && (!coll.contextId || i.contextId === coll.contextId));

  return (
    <CollectionAddItems
      availableItems={availableItems}
      contexts={contexts}
      collection={coll}
      onAdd={async (selectedItems) => {
        const added = await withLoading('Saving...', () =>
          addItemsToCollection(
            coll.id,
            selectedItems.map((s) => ({ itemId: s.itemId, quantity: s.quantity })),
          ),
        );
        // Stay on this screen if it failed, so the selection is not lost.
        if (added) setView("collection-detail");
      }}
      onCreateItem={async (itemName) => {
        // Create new item
        const newItem = {
          id: uid(),
          user_id: user.id,
          name: itemName,
          description: '',
          contextId: coll.contextId,
          elements: [],
          tags: [],
          isCaptureTarget: false,
          createdAt: new Date().toISOString(),
        };

        // Save to database
        const context = contexts.find((c) => c.id === newItem.contextId);
        const isShared = context?.shared || false;
        const savedItem = await storage.set(`item:${newItem.id}`, newItem, isShared);

        // Add to local items state
        setItems((prev) => [...prev, savedItem || newItem]);

        // Add to collection
        const added = await addItemsToCollection(coll.id, [
          { itemId: newItem.id, quantity: '' },
        ]);

        // Close dialog
        if (added) setView("collection-detail");
      }}
      onCancel={() => setView("collection-detail")}
      maxItems={200 - members.length}
    />
  );
}
