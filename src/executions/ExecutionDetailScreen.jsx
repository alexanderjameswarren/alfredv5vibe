import React from "react";
import ExecutionDetailView from "./ExecutionDetailView";

// The execution route, moved out of Alfred.jsx unchanged apart from the
// `view === "execution-detail"` test, which stays in Alfred around this component.
export default function ExecutionDetailScreen({
  executionForRoute,
  awaitingExecutionLoad,
  intents,
  events,
  items,
  contexts,
  collections,
  collectionMembers,
  previousView,
  setView,
  getIntentDisplay,
  toggleExecutionElement,
  updateExecutionElement,
  editItemFromExecution,
  toggleCollectionItem,
  saveMemberQuantity,
  refreshCollection,
  updateExecutionNotes,
  closeExecution,
  pauseExecution,
  makeExecutionActive,
  onViewContext,
  onViewIntention,
  onViewItem,
}) {
  return (
    <>
      {/* Opening an execution from a URL rather than from in-app state —
          a pasted link, a refresh, or a notification tap. Without this the
          pane is blank for the length of the fetch, which reads as a broken
          link on the one path where the user has no other context. */}
      {!executionForRoute && awaitingExecutionLoad && (
        <div className="p-6 text-center text-muted-foreground">
          Opening execution…
        </div>
      )}

      {/* Execution Detail View. Rendered from executionForRoute, not
          activeExecution: on the render after the URL changes to a different
          execution, state still holds the previous one, and drawing it under
          the new address would show the wrong execution. */}
      {executionForRoute && (
        <ExecutionDetailView
          execution={executionForRoute}
          intent={intents.find((i) => i.id === executionForRoute.intentId)}
          event={events.find((e) => e.id === executionForRoute.eventId)}
          items={items}
          contexts={contexts}
          collections={collections}
          collectionMembers={collectionMembers}
          onOpenSettings={() => setView("settings")}
          onToggleElement={toggleExecutionElement}
          onUpdateElement={updateExecutionElement}
          onEditItem={editItemFromExecution}
          onToggleCollectionItem={toggleCollectionItem}
          onUpdateCollectionItemQty={saveMemberQuantity}
          onRefreshCollection={refreshCollection}
          onUpdateNotes={updateExecutionNotes}
          onComplete={() => closeExecution("done")}
          onPause={pauseExecution}
          onMakeActive={makeExecutionActive}
          onCancel={() => closeExecution("cancelled")}
          onBack={() => setView(previousView)}
          getIntentDisplay={getIntentDisplay}
          onViewContext={onViewContext}
          onViewIntention={onViewIntention}
          onViewItem={onViewItem}
        />
      )}
    </>
  );
}
