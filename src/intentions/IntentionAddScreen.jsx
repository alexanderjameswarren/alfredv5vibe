import React from "react";
import AddPageChrome from "../shared/AddPageChrome";
import IntentionCard from "./IntentionCard";

// The New Intention page, moved out of Alfred.jsx unchanged. Everything it reads
// comes in as props from Alfred.
export default function IntentionAddScreen({
  addTargetItem,
  addTargetContext,
  tagPool,
  contexts,
  items,
  activeCollections,
  getIntentDisplay,
  closeAddPage,
  saveNewIntentionFromAddPage,
  moveToPlanner,
  setUnsavedChanges,
}) {
  return (
    <AddPageChrome
      title="New Intention"
      subtitle={
        addTargetItem
          ? `for ${addTargetItem.name}`
          : addTargetContext
            ? `in ${addTargetContext.name}`
            : null
      }
      onBack={closeAddPage}
    >
      <IntentionCard
        tagPool={tagPool}
        intent={{
          id: null,
          // Seeded from the item's name when adding against an item, which
          // is what the inline form on item detail did. Kept: it is the
          // common case and the text is usually right as-is.
          text: addTargetItem?.name || "",
          contextId: addTargetItem
            ? addTargetItem.contextId || null
            : addTargetContext?.id || null,
          isIntention: true,
          isItem: false,
          archived: false,
          itemId: addTargetItem?.id || null,
        }}
        contexts={contexts}
        items={items}
        collections={activeCollections}
        onUpdate={saveNewIntentionFromAddPage}
        onSchedule={moveToPlanner}
        getIntentDisplay={getIntentDisplay}
        showScheduling={true}
        isEditing={true}
        onCancel={closeAddPage}
        onDirtyChange={setUnsavedChanges}
        stickyFooter
      />
    </AddPageChrome>
  );
}
