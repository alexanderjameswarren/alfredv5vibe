import React from "react";
import AddPageChrome from "../shared/AddPageChrome";
import ItemCard from "./ItemCard";

// The New Item page, moved out of Alfred.jsx unchanged. Everything it reads comes in
// as props from Alfred.
export default function ItemAddScreen({
  addTargetContext,
  tagPool,
  contexts,
  items,
  closeAddPage,
  saveNewItemFromAddPage,
  setUnsavedChanges,
}) {
  return (
    <AddPageChrome
      title="New Item"
      subtitle={addTargetContext ? `in ${addTargetContext.name}` : null}
      onBack={closeAddPage}
    >
      <ItemCard
        tagPool={tagPool}
        item={{
          id: null,
          name: "",
          description: "",
          contextId: addTargetContext?.id || null,
          elements: [],
          isCaptureTarget: false,
        }}
        contexts={contexts}
        allItems={items}
        isEditing={true}
        onUpdate={saveNewItemFromAddPage}
        onCancel={closeAddPage}
        onDirtyChange={setUnsavedChanges}
        stickyFooter
      />
    </AddPageChrome>
  );
}
