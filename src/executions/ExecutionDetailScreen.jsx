import React from "react";
import ExecutionDetailView from "./ExecutionDetailView";
import { isMenuRun, isRecipeRun, orderedRecipes } from "../groups/menuRun";
import { useCookRecipes } from "./menuHistory";

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
  closeExecution,
  changeCompletionDate,
  deleteClosedExecution,
  pauseExecution,
  makeExecutionActive,
  onViewContext,
  onViewIntention,
  onViewItem,
  onOpenExecution,
  // Restructure P5 step 14: { groups, groupTypes, members }, the live recipe runs, and Skip.
  menuLists = null,
  recipeRuns = [],
  setRecipeSkipped,
  // The shown open runs, to find a recipe run's menu run.
  liveExecutions = [],
}) {
  const menuRunFor = (run) => liveExecutions.find((x) => x.id === run.parentExecutionId) || null;
  const isMenu = Boolean(executionForRoute && menuLists && isMenuRun(executionForRoute, menuLists));
  // Open: the live recipe runs; finished: that cook's, read once (step 14b).
  const cookRuns = useCookRecipes(isMenu ? executionForRoute : null, recipeRuns);
  const menu = isMenu
    ? {
        recipes: orderedRecipes(cookRuns || [], {
          members: menuLists.members,
          items,
          groupId: executionForRoute.groupId,
        }),
        loading: cookRuns === null,
        onToggleElement: (run, index) => toggleExecutionElement(index, run),
        onUpdateElement: (run, index, fields) => updateExecutionElement(index, fields, run),
        onSkip: setRecipeSkipped,
      }
    : null;
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
          the new address would show the wrong execution. Keyed by id so each
          execution's note loads and saves on its own. */}
      {/* An open recipe run is only ever cooked inside its menu (step 14): a note's
          link to one opens the menu's run, never the recipe alone. */}
      {executionForRoute && isRecipeRun(executionForRoute) && executionForRoute.status !== "closed" && (
        <div className="p-6 text-center">
          <p className="text-muted-foreground mb-3">This recipe is being cooked as part of a menu.</p>
          {menuRunFor(executionForRoute) && (
            <button
              type="button"
              onClick={() => onOpenExecution(menuRunFor(executionForRoute))}
              className="px-4 py-2.5 min-h-[44px] bg-success hover:bg-success-hover text-white rounded-lg"
            >
              Open the menu
            </button>
          )}
        </div>
      )}

      {executionForRoute && !(isRecipeRun(executionForRoute) && executionForRoute.status !== "closed") && (
        <ExecutionDetailView
          key={executionForRoute.id}
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
          onComplete={(nextDate, completedOn) => closeExecution("done", { nextDate, completedOn })}
          onChangeCompletionDate={changeCompletionDate}
          onDeleteClosed={deleteClosedExecution}
          onPause={pauseExecution}
          onMakeActive={makeExecutionActive}
          onCancel={() => closeExecution("cancelled")}
          onBack={() => setView(previousView)}
          getIntentDisplay={getIntentDisplay}
          onViewContext={onViewContext}
          onViewIntention={onViewIntention}
          onViewItem={onViewItem}
          onOpenExecution={onOpenExecution}
          menu={menu}
        />
      )}
    </>
  );
}
