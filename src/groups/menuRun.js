// Cooking a menu (Restructure P5 step 14). A menu run is one execution on the menu's
// own intention (group_id set, item_ids empty) plus one execution per recipe:
// group_id set, item_ids [recipe], intent_id and event_id null, parent_execution_id
// the menu run (migration 154). Pure.

/** A recipe's execution inside a menu: it has a group and no intention. */
export function isRecipeRun(execution) {
  return Boolean(execution?.groupId) && !execution?.intentId;
}

/** What running lists show: never a recipe run (the menu's card stands for them). */
export function shownRuns(executions = []) {
  return executions.filter((x) => !isRecipeRun(x));
}

/** The menu run's recipe executions, by parent_execution_id. */
export function recipeRunsOf(menuRun, executions = []) {
  if (!menuRun?.id) return [];
  return executions.filter((x) => x.parentExecutionId === menuRun.id);
}

/** "2 done · 1 skipped" for a cook's recipe runs; empty when it has none. */
export function cookSummary(runs = []) {
  const done = runs.filter((r) => r.outcome === "done").length;
  const skipped = runs.filter((r) => r.outcome === "skipped").length;
  return [done && `${done} done`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ");
}

/** Is this execution a menu's own run (its group is a together type)? */
export function isMenuRun(execution, { groups = [], groupTypes = [] }) {
  if (!execution?.groupId || !execution.intentId) return false;
  const group = groups.find((g) => g.id === execution.groupId);
  return groupTypes.find((t) => t.id === group?.groupTypeId)?.executionMode === "together";
}

/** How a recipe run closes when the menu completes: skipped stays skipped, else done. */
export function recipeOutcome(run) {
  return run.outcome === "skipped" ? "skipped" : "done";
}

/** The recipe runs in the menu's member order, each with its item: [{ run, item }]. */
export function orderedRecipes(runs, { members = [], items = [], groupId }) {
  const position = new Map(
    members.filter((m) => m.groupId === groupId && m.memberType === "item" && !m.removedAt).map((m) => [m.memberId, m.position]),
  );
  return runs
    .map((run) => ({ run, item: items.find((i) => i.id === run.itemIds?.[0]) || null }))
    .sort((a, b) => (position.get(a.run.itemIds?.[0]) ?? 1e9) - (position.get(b.run.itemIds?.[0]) ?? 1e9));
}
