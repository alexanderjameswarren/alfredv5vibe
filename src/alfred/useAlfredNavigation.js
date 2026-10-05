import { useState, useRef, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  pathToView,
  viewToPath,
  normalizePath,
  parentPath,
  executionPath,
  addPath,
  inboxDetailPath,
} from "../viewPaths";
import { TAG_FILTERED_VIEWS } from "../utils/tagFilterViews";

// Alfred's navigation, moved out of Alfred.jsx unchanged. Neither hook runs an
// effect. They are two calls because the action hooks need `setView` before they
// run, and the detail and add-page helpers need those hooks' writers after.

// The routing primitives, the navigation state and the unsaved-changes guard.
// Called first in Alfred, where `setView` was.
export function useAlfredNavigation({ setFilterTag }) {
  // --- Navigation bridge (Step 4, docs/technical-spec-navigation-urls.md) ---
  // `view` used to be `useState("home")`. It is now derived from the URL, and
  // `setView` is a thin wrapper around the router's navigate(). The point of
  // doing it this way round is that all 39 existing call sites keep working
  // with no edits — the URL simply becomes the thing that backs them.
  // See src/viewPaths.js for the 18-entry map.
  //
  // (Deliberately no literal call syntax in this comment: the call sites get
  // counted by grep at every step, and a comment would inflate the count.)
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = normalizePath(location.pathname);
  const view = pathToView(location.pathname);
  const setView = useCallback(
    (nextView) => {
      const path = viewToPath(nextView);
      // §A5. Arriving at one of the three tag-filtered screens from a DIFFERENT
      // screen drops the filter, so it cannot follow you across. See
      // TAG_FILTERED_VIEWS for what it was costing.
      //
      // Two conditions, and both earn their place:
      //
      //   `nextView !== view` — otherwise re-selecting the screen you are on
      //   would clear a filter you just set on it.
      //
      //   the target is filtered — otherwise opening a record from a filtered
      //   list would clear it, and browser Back would return you to a list that
      //   had silently forgotten. Opening a record and coming back keeps the
      //   filter, exactly as it keeps the search text: Back never comes through
      //   here at all, because `view` is derived from the URL.
      if (TAG_FILTERED_VIEWS.includes(nextView) && nextView !== view) {
        setFilterTag(null);
      }
      // Re-selecting the screen you are already on used to be an inert
      // re-render. Pushing an identical entry would make the next Back press
      // look broken, so same-path navigations replace instead of push.
      navigate(path, { replace: path === currentPath });
    },
    // setFilterTag is Alfred's state setter, passed in: stable, as when it was local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, currentPath, view]
  );
  // Opening an execution goes through here rather than setView, because
  // setView can only reach the id-less /schedule/execution — it is handed a
  // view name and has no way to know which execution is meant. Every
  // navigation to an execution carries its id so the address stays meaningful
  // after a refresh, a paste, or a notification tap.
  const goToExecution = useCallback(
    (exec) => {
      if (!exec || !exec.id) return;
      const path = executionPath(exec.id);
      navigate(path, { replace: path === currentPath });
    },
    [navigate, currentPath]
  );
  // Opening a capture for triage, for the same reason as the line above: setView
  // is handed a view name and has no way to know WHICH capture. Not guarded by
  // confirmDiscardIfDirty — the only route in is a tap on an inbox row, and a
  // list has nothing unsaved on it.
  const openInboxDetail = useCallback(
    (inboxItemId) => {
      if (!inboxItemId) return;
      const path = inboxDetailPath(inboxItemId);
      navigate(path, { replace: path === currentPath });
    },
    [navigate, currentPath]
  );

  const [selectedCollectionId, setSelectedCollectionId] = useState(null);

  const [selectedContextId, setSelectedContextId] = useState(null);
  const [selectedIntentionId, setSelectedIntentionId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [previousView, setPreviousView] = useState("home");

  // Step 12.2: the execution -> item-edit round trip.
  //
  // A DEDICATED slot, not `previousView`. That one is shared by every detail
  // view and any intervening navigation clobbers it — the same reason
  // `viewIntentionDetail` grew `intentionReturnView`. This one is written on the
  // way out and read once on the way back.
  //
  // Holds { executionId, itemId } — an ID, never the execution object. The URL
  // carries the id and `useExecutionRoute` can refetch from it, so an id is
  // sufficient, cannot go stale, and cannot resurrect an execution that has since
  // been closed elsewhere. `itemId` is what makes the return fire on the right
  // item when the user has tapped through several.
  const [executionEditReturn, setExecutionEditReturn] = useState(null);
  const [intentionReturnView, setIntentionReturnView] = useState("home");
  const [itemHistoryStack, setItemHistoryStack] = useState([]);

  // Unsaved changes guard
  const unsavedChangesRef = useRef(false);
  const unsavedChangesLabelRef = useRef("");

  function setUnsavedChanges(dirty, label = "") {
    unsavedChangesRef.current = dirty;
    unsavedChangesLabelRef.current = label;
  }

  // The single unsaved-changes guard (Step 5, docs/technical-spec-navigation-urls.md).
  //
  // This block used to be written out four times: here, plus hand-inlined
  // copies in the Sam tab, the Timer tab, and the mobile drawer. Those three
  // could not call `guardedSetView` because each needs to run its own side
  // effects (setPreviousView, setMenuOpen) *after* the confirm passes but
  // *before* navigating — so the reusable part is the question, not the
  // navigation.
  //
  // Returns true if it is safe to navigate. Clears the dirty flag as a side
  // effect when the user chooses to discard, exactly as the inline copies did.
  function confirmDiscardIfDirty() {
    if (!unsavedChangesRef.current) return true;
    const label = unsavedChangesLabelRef.current || "this form";
    if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) {
      return false;
    }
    unsavedChangesRef.current = false;
    unsavedChangesLabelRef.current = "";
    return true;
  }

  function guardedSetView(newView) {
    if (!confirmDiscardIfDirty()) return;
    setView(newView);
  }

  return {
    location,
    navigate,
    currentPath,
    view,
    setView,
    goToExecution,
    openInboxDetail,
    selectedCollectionId,
    setSelectedCollectionId,
    selectedContextId,
    setSelectedContextId,
    selectedIntentionId,
    setSelectedIntentionId,
    selectedItemId,
    setSelectedItemId,
    previousView,
    setPreviousView,
    executionEditReturn,
    setExecutionEditReturn,
    intentionReturnView,
    setIntentionReturnView,
    itemHistoryStack,
    setItemHistoryStack,
    unsavedChangesRef,
    unsavedChangesLabelRef,
    setUnsavedChanges,
    confirmDiscardIfDirty,
    guardedSetView,
  };
}

// The detail-page openers, the add-page helpers and the Back handlers. Called in
// Alfred after the action hooks and the list preferences, which it takes from.
export function useDetailNavigation({
  view,
  setView,
  navigate,
  location,
  currentPath,
  goToExecution,
  selectedContextId,
  setSelectedContextId,
  setSelectedIntentionId,
  intentionReturnView,
  setIntentionReturnView,
  selectedItemId,
  setSelectedItemId,
  itemHistoryStack,
  setItemHistoryStack,
  previousView,
  setPreviousView,
  executionEditReturn,
  setExecutionEditReturn,
  unsavedChangesRef,
  unsavedChangesLabelRef,
  confirmDiscardIfDirty,
  setSearchFor,
  setFilterTag,
  activeExecution,
  setActiveExecution,
  addTargetContext,
  addTargetItem,
  handleAddItemToContext,
  handleAddIntentionToContext,
  moveToPlanner,
}) {
  function viewContextDetail(contextId) {
    // A different context starts with an empty search AND no tag filter. Coming
    // back to the same one — Back from a record opened on it — does not come
    // through here.
    //
    // The tag clear is belt and braces: reaching a context from anywhere but
    // another context already passes the `nextView !== view` test in setView.
    // This is the one route that does not — context to context, where the view
    // name never changes but the vocabulary underneath it does, which is
    // precisely the case the search clear beside it was added for.
    if (contextId !== selectedContextId) {
      setSearchFor("context-detail")("");
      setFilterTag(null);
    }
    setPreviousView(view);
    setSelectedContextId(contextId);
    setView("context-detail");
  }

  function viewIntentionDetail(intentionId, fromView) {
    setSelectedIntentionId(intentionId);
    setIntentionReturnView(fromView || view);
    setView("intention-detail");
  }

  function handleBackFromIntentionDetail() {
    if (unsavedChangesRef.current) {
      const label = unsavedChangesLabelRef.current || "this form";
      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
      unsavedChangesRef.current = false;
      unsavedChangesLabelRef.current = "";
    }
    setSelectedIntentionId(null);
    setView(intentionReturnView);
  }

  function viewItemDetail(itemId, fromView) {
    // If already on item-detail, push current item onto stack
    if (view === "item-detail" && selectedItemId) {
      setItemHistoryStack((prev) => [...prev, selectedItemId]);
    } else {
      setPreviousView(fromView || view);
      setItemHistoryStack([]);
      // A fresh visit from anywhere else drops any stale return address, so a
      // later Back off this item cannot bounce into an execution the user was
      // not in. `editItemFromExecution` writes the slot after calling this.
      setExecutionEditReturn(null);
    }
    setSelectedItemId(itemId);
    setView("item-detail");
  }

  // Step 12.2. The link on the execution screen: open the underlying item
  // already in edit mode, skipping the extra tap on "Edit Item".
  //
  // Order matters — `viewItemDetail` clears this slot when it starts a fresh
  // visit, so the slot is written after it. Both land in one batch, so the
  // render that mounts ItemDetailView already sees it.
  function editItemFromExecution(itemId) {
    const executionId = activeExecution?.id;
    if (!executionId || !itemId) return;
    viewItemDetail(itemId, "execution-detail");
    setExecutionEditReturn({ executionId, itemId });
  }

  // --- Add pages: open, leave, save (Step 12.6) -----------------------------
  //
  // NO return-address slot. The routing thread asked for exactly this: "if a new
  // screen needs a return address after slice 2 lands, it should use
  // `navigate(-1)`". These are new screens, so they use it now rather than
  // adding a fifth thing for slice 3 to unpick.
  //
  // `state.fromApp` is the one piece of bookkeeping, and it exists because
  // `navigate(-1)` steps OUT of the app when there is nothing to go back to —
  // the caveat the routing thread recorded for cold-loaded deep links and
  // middle-clicked tabs. An add page reached from inside Alfred carries the flag
  // and goes back; one reached by pasting a URL has no flag and goes to the
  // parent list instead. Router state, not app state: it lives on the history
  // entry, so it cannot go stale and there is nothing to clear.
  function openAddPage(view, target = null) {
    if (!confirmDiscardIfDirty()) return;
    navigate(addPath(view, target), { state: { fromApp: true } });
  }

  // Leave without asking. Used after a save, where the card has already cleared
  // the dirty flag — asking again would prompt about changes that were just
  // committed.
  //
  // Two paths, and the second one is cold-load only.
  //
  // IN-APP: `navigate(-1)`, which returns to the actual previous history entry
  // with its scroll position. Unchanged.
  //
  // COLD LOAD: there is no history to pop, so the destination is reconstructed —
  // and **the address already says where the link conceptually came from**. A
  // pasted `/intentions/new/context/:id` almost certainly arrived from someone
  // pointing at that context, so Back goes to the CONTEXT, not to the Intentions
  // list. Only the bare form, which names no target, falls back to the record
  // type's list.
  //
  // Deliberately NOT via `viewContextDetail` / `viewItemDetail`: both write
  // `previousView`, and from here they would write "intention-add" — so Back off
  // the context would try to return to a form the user has just left. Setting the
  // id and navigating directly avoids that, and avoids adding a `setPreviousView`
  // writer the routing thread has asked us not to add. The consequence is that
  // `previousView` keeps its cold-load default of "home", so Back off the target
  // page goes Home. That is correct for a session that started on a pasted link:
  // there is genuinely nowhere else it came from.
  //
  // `replace` throughout: the add page is being LEFT, not navigated from, so it
  // should not sit in history as somewhere Back returns to — it would render an
  // empty form, the draft having already been discarded or saved.
  function leaveAddPage() {
    if (location.state?.fromApp) {
      navigate(-1);
      return;
    }

    if (addTargetContext) {
      setSelectedContextId(addTargetContext.id);
      navigate(viewToPath("context-detail"), { replace: true });
      return;
    }

    if (addTargetItem) {
      setSelectedItemId(addTargetItem.id);
      navigate(viewToPath("item-detail"), { replace: true });
      return;
    }

    navigate(parentPath(currentPath), { replace: true });
  }

  function closeAddPage() {
    if (!confirmDiscardIfDirty()) return;
    leaveAddPage();
  }

  async function saveNewItemFromAddPage(_itemId, updates) {
    await handleAddItemToContext(
      updates.name,
      updates.elements,
      updates.contextId || null,
      updates.description,
      updates.isCaptureTarget,
    );
    leaveAddPage();
  }

  async function saveNewIntentionFromAddPage(_intentId, updates, scheduledDate) {
    const newIntentId = await handleAddIntentionToContext(
      updates.text,
      updates.contextId || null,
      updates.itemId || null,
      updates.collectionId || null,
      updates.recurrenceConfig || null,
    );
    if (scheduledDate && newIntentId) {
      await moveToPlanner(newIntentId, scheduledDate);
    }
    leaveAddPage();
  }

  function handleBackFromItemDetail() {
    if (unsavedChangesRef.current) {
      const label = unsavedChangesLabelRef.current || "this form";
      if (!window.confirm(`You have unsaved changes to ${label}. Discard and navigate away?`)) return;
      unsavedChangesRef.current = false;
      unsavedChangesLabelRef.current = "";
    }
    if (itemHistoryStack.length > 0) {
      // Pop back to previous item
      const stack = [...itemHistoryStack];
      const prevItemId = stack.pop();
      setItemHistoryStack(stack);
      setSelectedItemId(prevItemId);
      return;
    }

    // Step 12.2 return trip. Checked against `selectedItemId` so that tapping
    // through to other items and back only lands on the execution once the user
    // is actually back on the item they left it for.
    //
    // `goToExecution`, NOT `setView("execution-detail")`. The view map is a
    // bijection and `viewToPath("execution-detail")` is always the bare,
    // ID-LESS "/schedule/execution" — so setView would render the right screen
    // under an address that has silently lost the id, and a refresh from there
    // redirects to /schedule. goToExecution puts the id back in the URL.
    if (executionEditReturn && executionEditReturn.itemId === selectedItemId) {
      const { executionId } = executionEditReturn;
      setExecutionEditReturn(null);
      setSelectedItemId(null);
      goToExecution({ id: executionId });
      return;
    }

    setSelectedItemId(null);
    setView(previousView);
  }

  function openExecution(exec) {
    setPreviousView(view);
    setActiveExecution(exec);
    goToExecution(exec);
  }

  return {
    viewContextDetail,
    viewIntentionDetail,
    handleBackFromIntentionDetail,
    viewItemDetail,
    editItemFromExecution,
    openAddPage,
    closeAddPage,
    saveNewItemFromAddPage,
    saveNewIntentionFromAddPage,
    handleBackFromItemDetail,
    openExecution,
  };
}
