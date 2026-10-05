import React from "react";
import ItemAddToCollection from "./ItemAddToCollection";

// The item's add-to-collection route, moved out of Alfred.jsx unchanged. It was
// an inline `(() => { ... })()` under `view === "item-add-to-collection"`; that
// test stays in Alfred and the function body is this component's body.
export default function ItemAddToCollectionScreen({
  items,
  selectedItemId,
  collections,
  contexts,
  setView,
  addElementsToCollection,
}) {
  const target = items.find((i) => i.id === selectedItemId);
  if (!target) return <p className="text-muted-foreground">Item not found</p>;
  return (
    <ItemAddToCollection
      item={target}
      items={items}
      collections={collections}
      contexts={contexts}
      onBack={() => setView("item-detail")}
      onAdd={(collectionId, picks) =>
        addElementsToCollection(collectionId, target, picks)
      }
    />
  );
}
