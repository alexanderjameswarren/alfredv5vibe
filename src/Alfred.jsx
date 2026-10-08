import React, { useState, useEffect, useRef } from "react";
import {
  viewToPath,
  isKnownPath,
  parentPath,
  DEFAULT_PATH,
  addRouteFromPath,
  inboxIdFromPath,
  intentionIdFromPath,
  intentionDetailPath,
  recordIdFromPath,
  RECORD_VIEW,
} from "./viewPaths";
import RecordLinkScreen from "./records/RecordLinkScreen";
import { archivedCaptureTarget } from "./utils/remindersApi";
import { useReminderIndex, useReminderListRefresh } from "./reminders/useReminderIndex";
import { useNotificationEffects } from "./reminders/useNotificationEffects";
import SettingsScreen from "./reminders/SettingsScreen";
import { useExecutionRoute } from "./useExecutionRoute";
import { useInboxActions } from "./inbox/useInboxActions";
import InboxScreen from "./inbox/InboxScreen";
import InboxDetailScreen from "./inbox/InboxDetailScreen";
import {
  olderArchivedCount,
  recentlyArchived,
} from "./utils/inboxArchive";
import {
  ALL_SOURCES,
  effectiveSource,
  matchesSource,
  sourceTabsFor,
} from "./utils/inboxSourceTabs";
import { sourceLabel } from "./inbox/CaptureMeta";
import { useUndo } from "./shared/UndoMessage";
import { useListPreferences } from "./alfred/useListPreferences";
import { useAlfredNavigation, useDetailNavigation } from "./alfred/useAlfredNavigation";
import { useAlfredData, useCollectionPoll } from "./alfred/useAlfredData";
import { useRealtime } from "./alfred/useRealtime";
import AppChrome from "./shared/AppChrome";
import BottomDock from "./shared/BottomDock";
import { useNotice } from "./shared/Notice";
import { useStatusSync } from "./alfred/useStatusSync";
import {
  statusCounts,
  filterByStatus,
  rankByActivity,
  withTag,
} from "./utils/status";
import GamesPage from "./games/GamesPage";
import MoneyPage from "./money/MoneyPage";
import { sortRows } from "./utils/sortOrders";
import { matchesQuery } from "./utils/search";
// `supabaseUrl` used to be imported alongside this: it built the ai-enrich
// endpoint by hand. Step 14 removed the only two callers and left the import
// behind as a lint warning; dropped here.
import { supabase } from "./supabaseClient";
import { storage } from "./utils/storage";
import { getTodayDate } from "./utils/eventDates";
import {
  NAMED_RECORD_ACCESSORS,
  itemSearchFields,
  INTENTION_ACCESSORS,
  INBOX_ACCESSORS,
} from "./utils/listSortOptions";
import { TAG_TOGGLE_ATTR } from "./utils/tagFilterViews";
import LoginScreen from "./shared/LoginScreen";
import LoadingOverlay from "./shared/LoadingOverlay";
import { useRecycleBin } from "./recycle/useRecycleBin";
import RecycleScreen from "./recycle/RecycleScreen";
import { useContextActions } from "./contexts/useContextActions";
import ContextsScreen from "./contexts/ContextsScreen";
import { useCollections } from "./collections/useCollections";
import CollectionsScreen from "./collections/CollectionsScreen";
import CollectionDetailScreen from "./collections/CollectionDetailScreen";
import CollectionHistoryScreen from "./collections/CollectionHistoryScreen";
import ItemAddToCollectionScreen from "./collections/ItemAddToCollectionScreen";
import CollectionAddItemsScreen from "./collections/CollectionAddItemsScreen";
import ContextDetailView from "./contexts/ContextDetailView";
import IntentionDetailView from "./intentions/IntentionDetailView";
import ItemDetailView from "./items/ItemDetailView";
import { useEventActions } from "./schedule/useEventActions";
import HomeScreen from "./schedule/HomeScreen";
import ScheduleScreen from "./schedule/ScheduleScreen";
import { useIntentionActions } from "./intentions/useIntentionActions";
import IntentionsScreen from "./intentions/IntentionsScreen";
import IntentionAddScreen from "./intentions/IntentionAddScreen";
import { useItemActions } from "./items/useItemActions";
import MemoriesScreen from "./items/MemoriesScreen";
import ItemAddScreen from "./items/ItemAddScreen";
import { useExecutionActions } from "./executions/useExecutionActions";
import ExecutionDetailScreen from "./executions/ExecutionDetailScreen";
import SamPlayer from "./sam/SamPlayer";
import TimerPage from "./timer/TimerPage";

export default function Alfred() {
  // Declared before navigation because `setView` clears it.
  const [filterTag, setFilterTag] = useState(null);
  // Routing, navigation state and the unsaved-changes guard. No effects.
  const {
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
  } = useAlfredNavigation({ setFilterTag });
  const [menuOpen, setMenuOpen] = useState(false);
  // Record state and its loaders. No effects. `loadCollectionMembers` comes from
  // useCollections below, which needs `refreshData` from here, so it is deferred.
  const {
    contexts,
    setContexts,
    items,
    setItems,
    intents,
    setIntents,
    tagPool,
    events,
    setEvents,
    activeExecution,
    setActiveExecution,
    activeExecutions,
    setActiveExecutions,
    pausedExecutions,
    setPausedExecutions,
    allInboxItems,
    setAllInboxItems,
    inboxItems,
    collections,
    setCollections,
    collectionMembers,
    setCollectionMembers,
    collectionMembersError,
    setCollectionMembersError,
    editingQuantityItemId,
    setEditingQuantityItemId,
    pollPausedRef,
    memberWriteInFlight,
    user,
    setUser,
    authLoading,
    setAuthLoading,
    dataLoaded,
    setDataLoaded,
    isLoading,
    setIsLoading,
    loadingMessage,
    setLoadingMessage,
    realtimeStatus,
    setRealtimeStatus,
    loadData,
    refreshData,
    manualRefresh,
  } = useAlfredData({
    withLoading,
    loadCollectionMembers: (...args) => loadCollectionMembers(...args),
  });
  // Realtime subscriptions and change handlers. No effects; the auth effect calls it.
  const { setupRealtimeSubscriptions } = useRealtime({
    setRealtimeStatus,
    setAllInboxItems,
    setContexts,
    setItems,
    setIntents,
    setEvents,
    setActiveExecutions,
    setPausedExecutions,
  });
  const { reminderIndex, refreshReminderIndex } = useReminderIndex();
  // Manual removal history, keyed by collection id — feeds the recently-removed
  // panel on the collection detail view.
  const [collectionRemovals, setCollectionRemovals] = useState({});
  const [collectionRemovalsError, setCollectionRemovalsError] = useState(null);
  const [reAddingRemovalId, setReAddingRemovalId] = useState(null);
  // Full removal history — both kinds, unfiltered — for the history view.
  const [collectionHistory, setCollectionHistory] = useState({});
  const [collectionHistoryError, setCollectionHistoryError] = useState(null);
  // Which source tab the user last chose — Clipboard Step 21b.
  //
  // What is STORED is the choice; what is USED is `effectiveSource` below, which falls
  // back to All whenever the chosen source has no items left. Processing the last Claude
  // item must not leave the list filtered to a source with no tab to unset it.
  const [inboxSourceTab, setInboxSourceTab] = useState(ALL_SOURCES);
  // "Recently archived" — Clipboard Step 22.
  //
  // Collapsed by default: the inbox's job is the live list, and a history opened every
  // time you arrive pushes the capture bar off a phone screen. "Items (26)" on the
  // context detail page starts OPEN because it is the point of that page; this is not
  // the point of this one.
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // The seven-day window, off. Not persisted — it is a "let me look further back"
  // gesture, not a preference, and a stored one would quietly turn the section into an
  // unbounded list months later.
  const [archivedShowAll, setArchivedShowAll] = useState(false);
  // Separate from `filterTag` on purpose. That one is shared across Intentions,
  // Memories and Context Detail, all of which draw from the item/intent tag
  // pool. Collection tags are a different vocabulary entirely — per-shopping-
  // trip store labels — so filtering a list to "tjs" must not leave that filter
  // set when you open a context, where no such tag exists and the list would
  // silently come back empty.
  const [collectionFilterTag, setCollectionFilterTag] = useState(null);
  // Suggestions for the tag control on a collection member row, keyed by
  // collection id. Drawn from that collection's members AND its removal
  // history, so the vocabulary survives the list being emptied.
  const [collectionTagPool, setCollectionTagPool] = useState({});
  // Which member row has its tag editor open, or null. One at a time — the
  // picker is too tall to have several expanded on a phone.
  const [editingTagsItemId, setEditingTagsItemId] = useState(null);
  // The row currently holding an open tag editor. Attached to whichever row
  // that is, so the dismissal effect below can ask whether a tap landed inside
  // it. One ref rather than one per row: only ever one is open.
  const editingTagsRowRef = useRef(null);
  const [collDragIdx, setCollDragIdx] = useState(null);
  const [collectionContextFilter, setCollectionContextFilter] = useState("");

  const captureRef = useRef(null);
  const [executionTab, setExecutionTab] = useState("active");
  const [captureText, setCaptureText] = useState("");
  const [showContextForm, setShowContextForm] = useState(false);
  const [editingContext, setEditingContext] = useState(null);
  // "Moved to active" after a write the 088 triggers may answer. Before the
  // action hooks, which take `watchStatus`.
  const { notice, showNotice } = useNotice();
  const { watchStatus } = useStatusSync({ setIntents, setItems, showNotice });
  // Called here, after `user` and every state it reads. `withLoading` and
  // `offerUndoFor` are function declarations below, hoisted.
  const {
    saveContextRecord,
    saveContext,
    handleAddItemToContext,
    handleAddIntentionToContext,
    contextArchiveBlockers,
    archiveContext,
  } = useContextActions({
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
  });
  const { updateEvent, triggerRecurrence } = useEventActions({
    user,
    events,
    setEvents,
    intents,
    withLoading,
    offerUndoFor,
  });
  const { moveToPlanner, scheduleFromItem, updateIntent, archiveIntention, setIntentionStatus } = useIntentionActions({
    user,
    intents,
    setIntents,
    items,
    events,
    setEvents,
    view,
    setView,
    setSelectedIntentionId,
    intentionReturnView,
    withLoading,
    offerUndoFor,
    watchStatus,
  });
  const { updateItem, deepCloneItem, setItemStatus } = useItemActions({
    user,
    items,
    setItems,
    contexts,
    withLoading,
    offerUndoFor,
  });
  // Before useExecutionActions and useInboxActions, which take two of its
  // writers. The poll refs stay owned here; the poll effect below reads them.
  const {
    loadCollectionMembers,
    membersOf,
    setMembersFor,
    addItemsToCollection,
    addElementsToCollection,
    removeItemFromCollection,
    loadCollectionRemovals,
    loadCollectionHistory,
    putBackRemoval,
    closeTagEditor,
    toggleTagEditor,
    loadCollectionTags,
    saveMemberTags,
    saveMemberQuantity,
    clearCompletedFromCollection,
    saveMemberOrder,
    refreshCollection,
    addCollection,
    updateCollection,
    archiveCollection,
  } = useCollections({
    user,
    collections,
    setCollections,
    contexts,
    setItems,
    collectionMembers,
    setCollectionMembers,
    setCollectionMembersError,
    setCollectionRemovals,
    setCollectionRemovalsError,
    reAddingRemovalId,
    setReAddingRemovalId,
    setCollectionHistory,
    setCollectionHistoryError,
    setCollectionTagPool,
    editingTagsItemId,
    setEditingTagsItemId,
    memberWriteInFlight,
    refreshData,
    withLoading,
    offerUndoFor,
  });
  const {
    activate,
    closeExecution,
    cancelExecutionForEvent,
    pauseExecution,
    makeExecutionActive,
    toggleExecutionElement,
    updateExecutionElement,
    updateExecutionNotes,
    toggleCollectionItem,
    startNowFromItem,
    startNowFromIntention,
  } = useExecutionActions({
    user,
    view,
    setView,
    items,
    intents,
    setIntents,
    events,
    setEvents,
    activeExecution,
    setActiveExecution,
    activeExecutions,
    setActiveExecutions,
    pausedExecutions,
    setPausedExecutions,
    previousView,
    setPreviousView,
    goToExecution,
    triggerRecurrence,
    clearCompletedFromCollection,
    withLoading,
    watchStatus,
  });
  const {
    handleCapture,
    discardInboxItem,
    updateInboxCaptureText,
    processInboxItemFromList,
    copyTaskInboxItem,
    handleInboxSave,
    unarchiveInboxItem,
    setInboxSuggestedStatus,
  } = useInboxActions({
    user,
    inboxItems,
    allInboxItems,
    setAllInboxItems,
    captureText,
    setCaptureText,
    captureRef,
    setView,
    contexts,
    items,
    setItems,
    intents,
    setIntents,
    events,
    setEvents,
    refreshReminderIndex,
    addItemsToCollection,
    withLoading,
    offerUndoFor,
    watchStatus,
  });
  // `refreshData` is a function declaration below, hoisted.
  const recycleBin = useRecycleBin({ view, refreshData, contextArchiveBlockers });

  // Notification landing and push self-healing. Same place in the effect order.
  useNotificationEffects({ navigate, user });

  // --- Execution deep link (notification chains, Phase 1) -------------------
  //
  // The URL is the source of truth for which execution is open. This owns the
  // cold-load fetch, the guard suppression that keeps a deep link from being
  // redirected away before it has been looked up, and the clearing of an
  // execution the URL no longer names. It lives in its own module so the test
  // exercises it rather than a copy of it.
  const { awaitingExecutionLoad, executionForRoute } =
    useExecutionRoute({
      pathname: location.pathname,
      user,
      activeExecution,
      setActiveExecution,
      fetchExecution: (id) => storage.get(`execution:${id}`),
    });

  // --- Inbox detail route (Alfred Clipboard, Step 17) -----------------------
  //
  // `/inbox/detail/:id`. No fetch-by-id hook like `useExecutionRoute` is needed
  // and would be the wrong shape here: `loadData` already selects every live
  // inbox row into state, so the capture the URL names is a plain lookup. Same
  // reasoning as the add pages below, and the same one thing to be careful
  // about — not judging it missing before that load has happened, which is what
  // `dataLoaded` is for.
  const routeInboxId = inboxIdFromPath(currentPath);
  const routeInboxItem = routeInboxId
    ? inboxItems.find((i) => i.id === routeInboxId) || null
    : null;

  // Covers three cases with one condition, and all three want the same answer —
  // back to the list:
  //
  //   the bare /inbox/detail, which carries no id and so has nothing to triage
  //   an id that never existed, or belongs to someone else (RLS hides it)
  //   an id that existed a moment ago and has just been filed or discarded,
  //     which is the ORDINARY exit from this page: Process archives the row, the
  //     row leaves `inboxItems`, and this carries us back. That is deliberate —
  //     see the note on handleProcess in InboxDetailView.
  const inboxDetailMissing = view === "inbox-detail" && dataLoaded && !routeInboxItem;

  // An ARCHIVED capture — typically a reminder tap after the capture was filed —
  // opens what it became instead. "kind:id", or "" to fall back to the list.
  const archivedInboxTarget = (() => {
    if (!inboxDetailMissing || !routeInboxId) return "";
    const row = allInboxItems.find((i) => i.id === routeInboxId);
    if (!row?.archived) return "";
    const t = archivedCaptureTarget(routeInboxId, { items, intents, events });
    return t ? `${t.kind}:${t.id}` : "";
  })();

  // --- Intention detail route (Reminders) -----------------------------------
  // `/intentions/detail/:id`, which is where an intention-linked reminder's tap
  // lands. The URL's id wins over state; intents are fully loaded by `loadData`,
  // so it is a plain lookup once `dataLoaded`, exactly like the inbox route.
  const routeIntentionId = intentionIdFromPath(currentPath);
  const effectiveIntentionId = routeIntentionId || selectedIntentionId;
  const intentionDetailMissing =
    view === "intention-detail" &&
    dataLoaded &&
    Boolean(routeIntentionId) &&
    !intents.some((i) => i.id === routeIntentionId);

  useReminderListRefresh({ dataLoaded, view, refreshReminderIndex });

  // --- Cold-load redirects (Step 9, docs/technical-spec-navigation-urls.md) --
  //
  // Two things can put Alfred on a path it cannot actually render:
  //
  //   1. An unknown path (/testing). It used to render home while the address
  //      bar went on claiming otherwise. Now the address is corrected too.
  //   2. A detail view opened cold. The seven detail views carry no id in the
  //      URL this slice — their id is set by a separate React state call that
  //      has not flushed when setView runs, so threading it into the URL would
  //      mean editing the 39 call sites. Pasting /collections/detail into a
  //      fresh tab therefore arrives with no id and would render "not found".
  //      Falling back to the parent list is the honest answer.
  //
  // These fire only when the required state is genuinely absent. In normal
  // navigation the id and the view are set in the same batch, so by the render
  // where `view` becomes a detail view its id is already there and nothing
  // redirects.
  const DETAIL_VIEW_STATE = {
    "context-detail": selectedContextId,
    "intention-detail": effectiveIntentionId,
    "item-detail": selectedItemId,
    "item-add-to-collection": selectedItemId,
    // Not `activeExecution`: the route decides which execution counts as
    // present. See useExecutionRoute — an execution left in state from a
    // previous visit must not satisfy this guard for a different URL.
    "execution-detail": executionForRoute,
    "collection-detail": selectedCollectionId,
    "collection-history": selectedCollectionId,
    "collection-add-items": selectedCollectionId,
  };

  const detailStateMissing =
    view in DETAIL_VIEW_STATE &&
    !DETAIL_VIEW_STATE[view] &&
    // Execution-detail is the exception to point 2 above: since Phase 1 of the
    // notification-chain work it carries its id in the URL, so a cold load can
    // fetch the execution instead of giving up. The guard holds its fire until
    // that lookup has actually completed and found nothing.
    !awaitingExecutionLoad;

  // --- Add pages (Step 12.6) ------------------------------------------------
  //
  // `/memories/new/context/:id` and `/intentions/new/(context|item)/:id`, plus
  // the bare forms. Resolved from the URL rather than held in state, which is
  // what makes these cold-loadable and makes browser Back work on them.
  //
  // No fetch-by-id hook like `useExecutionRoute` is needed: contexts and items
  // are ALREADY fully loaded into state by `loadData`, which selects every row
  // of both. So the target is a plain lookup, and the only thing to be careful
  // about is not judging it missing before that load has happened.
  const addRoute = addRouteFromPath(currentPath);
  const addTargetContext =
    addRoute?.target?.kind === "context"
      ? contexts.find((c) => c.id === addRoute.target.id) || null
      : null;
  const addTargetItem =
    addRoute?.target?.kind === "item"
      ? items.find((i) => i.id === addRoute.target.id) || null
      : null;

  // `dataLoaded` is the whole guard, and it is not optional. The redirect effect
  // below runs on every render — hooks run before this component's `!dataLoaded`
  // early return — so without it, every cold load would find an empty `contexts`
  // array, decide the target was gone, and bounce to the list before the data
  // arrived. Same failure `useExecutionRoute` documents at length; the fix here
  // is cheaper only because the data is already on its way.
  const addTargetMissing =
    dataLoaded &&
    Boolean(addRoute?.target) &&
    !addTargetContext &&
    !addTargetItem;

  useEffect(() => {
    if (!isKnownPath(currentPath)) {
      navigate(DEFAULT_PATH, { replace: true });
      return;
    }
    // A target that no longer exists — a stale link, or a context deleted since
    // the URL was shared. `parentPath` sends both add pages to their LIST, not
    // to their own bare form: opening an add form with the target silently
    // dropped would be worse than saying the address is no good.
    if (addTargetMissing) {
      navigate(parentPath(currentPath), { replace: true });
      return;
    }
    // Not folded into DETAIL_VIEW_STATE: that table is consulted before
    // `dataLoaded` is true, so an inbox-detail entry there would bounce every
    // cold load to the list before the row it names had arrived.
    if (archivedInboxTarget) {
      const [kind, ...rest] = archivedInboxTarget.split(":");
      const id = rest.join(":");
      // `replace`, not viewItemDetail's push: Back must not land on this redirect again.
      if (kind === "item") {
        setPreviousView("inbox");
        setItemHistoryStack([]);
        setExecutionEditReturn(null);
        setSelectedItemId(id);
        navigate(viewToPath("item-detail"), { replace: true });
      } else {
        navigate(intentionDetailPath(id), { replace: true });
      }
      return;
    }
    if (inboxDetailMissing || intentionDetailMissing) {
      navigate(parentPath(currentPath), { replace: true });
      return;
    }
    if (detailStateMissing) {
      // parentPath() consults its override table first — the last-segment rule
      // is a tiebreaker for naming, not a law.
      navigate(parentPath(currentPath), { replace: true });
    }
    // `replace` in every case: a path the app cannot render should not become
    // a history entry the Back button can return the user to.
  }, [currentPath, detailStateMissing, addTargetMissing, inboxDetailMissing, intentionDetailMissing, archivedInboxTarget, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Record links (/<id>) -------------------------------------------------
  // `replace` throughout, so Back skips the /<id> address. State-opened detail
  // views mirror the archived-inbox redirect above. The lookup lets the map
  // pick only screens whose row is loaded; see records/recordRoutes.js.
  const recordLookup = {
    inbox: (id) => allInboxItems.find((i) => i.id === id) || null,
    item: (id) => items.some((i) => i.id === id),
    intention: (id) => intents.some((i) => i.id === id),
    context: (id) => contexts.some((c) => c.id === id),
    collection: (id) => collections.some((c) => c.id === id),
    archivedTarget: (id) => archivedCaptureTarget(id, { items, intents, events }),
  };

  function openRecordDestination(dest) {
    if (dest.kind === "path") {
      navigate(dest.path, { replace: true });
      return;
    }
    setPreviousView("home");
    if (dest.kind === "item") {
      setItemHistoryStack([]);
      setExecutionEditReturn(null);
      setSelectedItemId(dest.id);
      navigate(viewToPath("item-detail"), { replace: true });
    } else if (dest.kind === "context") {
      setSelectedContextId(dest.id);
      navigate(viewToPath("context-detail"), { replace: true });
    } else if (dest.kind === "collection") {
      setSelectedCollectionId(dest.id);
      navigate(viewToPath("collection-detail"), { replace: true });
    }
  }

  // Sort, search and tag-bar state per list page. Same place in the effect order.
  const {
    homeSort,
    scheduleSort,
    inboxSort,
    contextsSort,
    collectionsSort,
    intentionsSort,
    memoriesSort,
    contextDetailSort,
    intentionsStatus,
    contextDetailStatus,
    searchFor,
    setSearchFor,
    tagsCollapsedFor,
    toggleTagsFor,
  } = useListPreferences();
  // Detail-page openers, add-page helpers and Back handlers. No effects.
  const {
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
  } = useDetailNavigation({
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
  });

  // --- Undo (Step 2, docs/technical-spec-ui-standardization.md) -------------
  //
  // Governing rule 3: destructive actions get no confirmation dialog, so this
  // message is the safety net. Every handler that archives or deletes ends by
  // offering an undo whose restore closure puts back exactly what it took.
  //
  // Restores go through `storage.set`, which UPDATEs by id and INSERTs only if
  // that matched nothing — so the same call re-flags an archived row and
  // re-inserts a deleted one with its original id. See UndoMessage.jsx.
  const { pendingUndo, offerUndo, runUndo, dismissUndo } = useUndo();

  // Undo restores are written where the state setters live, and they need the
  // same "Saving…" overlay and error handling as the action they reverse.
  function offerUndoFor(message, restore) {
    offerUndo(message, () => withLoading("Restoring...", restore));
  }

  useEffect(() => {
    function handleBeforeUnload(e) {
      if (unsavedChangesRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    // unsavedChangesRef is a ref from useAlfredNavigation: stable, as when it was local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function withLoading(message, operation) {
    setIsLoading(true);
    setLoadingMessage(message);
    try {
      return await operation();
    } catch (error) {
      console.error('Operation failed:', error);
      alert('Operation failed: ' + error.message);
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  }

  useEffect(() => {
    let realtimeCleanup = null;
    let isInitialized = false;

    async function handleAuthChange(event, session) {
      try {
        console.log('[Auth] State changed:', event, 'User:', session?.user?.email || 'none');

        // Skip SIGNED_IN event - wait for INITIAL_SESSION when session is fully ready
        if (event === 'SIGNED_IN') {
          console.log('[Auth] Skipping SIGNED_IN - waiting for INITIAL_SESSION');
          return;
        }

        // Check allowlist if user exists
        if (session?.user) {
          console.log('[Auth] Checking allowlist for:', session.user.email);

          // Add timeout to prevent hanging forever
          const queryPromise = supabase
            .from('allowed_emails')
            .select('email')
            .eq('email', session.user.email)
            .maybeSingle();

          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Allowlist query timeout after 5 seconds')), 5000)
          );

          const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

          console.log('[Auth] Allowlist query completed:', { data, error });

          if (error) {
            console.error('[Auth] Allowlist query error:', error);
            alert(`Allowlist check failed: ${error.message}\n\nPlease check:\n1. RLS policy on allowed_emails table\n2. Your email is in the allowed_emails table\n3. Supabase console for errors`);
            setAuthLoading(false);
            setIsLoading(false);
            return;
          }

          if (!data) {
            console.log('[Auth] Email not in allowlist, signing out');
            await supabase.auth.signOut();
            alert('Access denied. Your email is not authorized to access this app.');
            setUser(null);
            setAuthLoading(false);
            return;
          }

          console.log('[Auth] Email allowed');
        }

        setUser(session?.user ?? null);
        setAuthLoading(false);

        // Only initialize once on first auth event with user
        if (session?.user && !isInitialized) {
          isInitialized = true;
          console.log('[Auth] First-time init - loading data...');
          await loadData();
          setDataLoaded(true);
          console.log('[Auth] Data loaded');

          console.log('[Auth] Setting up realtime...');
          realtimeCleanup = await setupRealtimeSubscriptions(session.user);
          console.log('[Auth] Realtime setup complete');
        } else if (session?.user && isInitialized) {
          // Subsequent auth changes - just reload data
          console.log('[Auth] Reloading data...');
          loadData();
        }
      } catch (error) {
        console.error('[Auth] handleAuthChange error:', error);
        setAuthLoading(false);
        setIsLoading(false);
      }
    }

    // Listen for auth state changes (fires immediately with current session)
    console.log('[Init] Setting up auth listener');
    const { data: { subscription } } = supabase.auth.onAuthStateChange(handleAuthChange);
    console.log('[Init] Auth listener ready');

    // Cleanup function
    return () => {
      console.log('[Init] Cleanup: unsubscribing');
      subscription.unsubscribe();
      if (realtimeCleanup) {
        realtimeCleanup();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let lastRefresh = Date.now();

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && user) {
        const elapsed = Date.now() - lastRefresh;
        if (elapsed > 30000) { // 30 second debounce
          lastRefresh = Date.now();
          refreshData();
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    // refreshData is intentionally omitted: it is recreated every render, so
    // depending on it would tear down and re-attach this listener constantly.
    // It closes over nothing render-scoped — only stable setters and module
    // imports — so there is no staleness to guard against. Same reasoning as the
    // suppression on the init effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    setFilterTag(null);
    setCollectionFilterTag(null);
    // Through the same close path as Done and the Tag button, so leaving the
    // view cannot drift from the other ways of closing. Hoisted, so calling it
    // from an effect declared above it is fine.
    closeTagEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Load removal history when a collection view is opened. One-shot fetches on
  // open — deliberately not a poll or a realtime channel.
  useEffect(() => {
    if (!selectedCollectionId) return;
    if (view === "collection-detail") {
      // The detail view needs all three: membership, manual removals for the
      // panel, and the full history so it knows whether the "view all" entry
      // point should exist.
      loadCollectionMembers([selectedCollectionId]);
      loadCollectionRemovals(selectedCollectionId);
      loadCollectionHistory(selectedCollectionId);
      loadCollectionTags(selectedCollectionId);
    } else if (view === "collection-history") {
      loadCollectionHistory(selectedCollectionId);
    }
    // These loaders are recreated every render; depending on them would refetch
    // in a loop. They close over nothing render-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCollectionId]);

  /**
   * Tapping outside an open tag editor closes it — the whole thing, input and
   * all, not just the dropdown.
   *
   * `mousedown` and NOT `touchstart`, deliberately. A tap fires both; a scroll
   * fires only touchstart. Listening to touchstart would close the editor the
   * moment a finger landed to scroll the list, which is not a dismissal.
   *
   * "Outside" means outside the whole row, not just the editor. Same for the
   * row's chips — removing a tag mid-edit should not throw you out.
   *
   * ANY row's tag button is exempt, including other rows'. That button owns the
   * switch itself, on the press (see `TAG_TOGGLE_ATTR`). Without this exemption
   * the two would race: React's handlers run at the root container and this one
   * runs at the document, so the button would open its editor and this listener
   * would immediately close it again.
   *
   * Routed through `closeTagEditor` like every other way of closing, so the
   * poll resumes and uncommitted text is discarded rather than committed —
   * a tag is created only by an explicit act.
   */
  useEffect(() => {
    if (!editingTagsItemId) return undefined;
    function handlePointerDown(e) {
      if (e.target.closest?.(`[${TAG_TOGGLE_ATTR}]`)) return;
      const row = editingTagsRowRef.current;
      if (row && !row.contains(e.target)) closeTagEditor();
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
    // closeTagEditor is recreated every render but only calls a stable setter,
    // so a stale closure cannot go wrong here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTagsItemId]);

  // The collection detail poll and its pause guard. Same place in the effect order.
  useCollectionPoll({
    view,
    selectedCollectionId,
    pollPausedRef,
    memberWriteInFlight,
    collDragIdx,
    editingQuantityItemId,
    editingTagsItemId,
    isLoading,
    loadCollectionMembers,
    loadCollectionRemovals,
  });

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
  }

  function getIntentDisplay(intent) {
    if (intent.text) return intent.text;
    if (intent.itemId) {
      const item = items.find((i) => i.id === intent.itemId);
      return item?.name || "Untitled";
    }
    return intent.text || "Untitled";
  }

  // Filter events to only show those with valid, non-archived intents
  const validEvents = events.filter((e) => {
    if (e.archived) return false;
    const intent = intents.find((i) => i.id === e.intentId);
    return intent && !intent.archived;
  });

  const todayEvents = validEvents.filter((e) => {
    const today = getTodayDate();
    // Include all events that are today or in the past (validEvents already excludes archived)
    return e.time <= today;
  });
  const allNonArchivedEvents = validEvents;
  // Contexts are soft-deletable from Step 11. Same split as activeCollections:
  // `activeContexts` for anything that offers a CHOICE, raw `contexts` for
  // anything that resolves an ID — an archived context's name must still render
  // on a Recycle Bin row, an execution badge, and every item that was in it.
  const activeContexts = contexts.filter((c) => !c.archived);
  const pinnedContexts = activeContexts.filter((c) => c.pinned);

  // Collections are soft-deleted from Step 4b, so `collections` now holds
  // archived rows too — the Recycle Bin reads them from there. Everything else
  // wants the live ones, and "everything else" is about fifteen places: three
  // lists plus a collection picker on IntentionCard and three
  // detail views. Filtering once here rather than at each use is the same move
  // `validEvents` above makes, for the same reason — fifteen filter sites is
  // fifteen places to forget one.
  //
  // Pass `activeCollections` to anything that offers a choice; keep raw
  // `collections` for lookups by id, which must still resolve for a row that is
  // archived (the detail view during an archive, and Undo restoring it).
  // Needs `intents` and `getIntentDisplay` in scope, so unlike the other three
  // accessor bags this one cannot be module-level. The name shown on an event
  // row is its own text when it has one, and the intention's otherwise —
  // exactly what the row renders, so sorting by Name matches what you can read.
  // Search on Home's Today tab and Schedule matches the same value.
  const eventTitle = (e) =>
    e.text || getIntentDisplay(intents.find((i) => i.id === e.intentId) || {});
  const eventSortAccessors = {
    title: eventTitle,
    time: (e) => e.time,
    created: (e) => e.createdAt,
    updated: (e) => e.updatedAt,
  };

  // Home's Today tab used to end with `.sort((a, b) => a.time.localeCompare(b.time))`
  // and a "Sort by oldest date first" comment. That order is now the control's
  // DEFAULT rather than a fixture, so day one looks identical and every other
  // order becomes reachable.
  //
  // Schedule had no sort at all — `allNonArchivedEvents` is a bare alias, so its
  // order was whatever Postgres returned from an unordered SELECT, further
  // mutated by local appends and realtime inserts. That is why it could reshuffle
  // between sessions. Sorting here fixes it by construction: the order is now a
  // function of the rows and the preference, neither of which depends on the
  // order they arrived in.
  const sortedTodayEvents = sortRows(
    todayEvents, homeSort.sortKey, eventSortAccessors, homeSort.sortDir,
  );
  const sortedScheduleEvents = sortRows(
    allNonArchivedEvents, scheduleSort.sortKey, eventSortAccessors, scheduleSort.sortDir,
  );

  const activeCollections = collections.filter((c) => !c.archived);
  const pinnedCollections = activeCollections.filter((c) => c.pinned);
  const allLiveExecutions = [...activeExecutions, ...pausedExecutions];

  // Intentions: every live intention. Which of them show is the status chips'
  // call (088), not a hidden "no live event" rule, which this used to be.
  const liveIntentions = intents.filter((i) => i.isIntention && !i.archived);
  // Counted before tags and search, like the inbox source tabs, so a chip's
  // number does not move as you type.
  // Counts only rows passing the tag filter, as the tag chips count only rows
  // passing the status chips. Every chip still shows, zero included.
  const intentionStatusCounts = statusCounts(withTag(liveIntentions, filterTag));

  const memoriesWithoutContext = items.filter((i) => !i.contextId && !i.archived);

  // What each list page shows: sorted, through its own filters (tags on
  // Intentions and Memories), then searched. Search is applied last and the
  // toolbar's presence is decided by the UNSEARCHED list, so typing can empty a
  // list but never removes the box you are typing in.
  const visibleTodayEvents = sortedTodayEvents.filter((e) =>
    matchesQuery(searchFor("home"), eventTitle(e)),
  );
  const visibleScheduleEvents = sortedScheduleEvents.filter((e) =>
    matchesQuery(searchFor("schedule"), eventTitle(e)),
  );
  // The inbox's source tabs — Clipboard Step 21b. Counted from every live capture, so
  // the counts do not move as the search box narrows the list below them.
  const inboxSourceTabs = sourceTabsFor(inboxItems, sourceLabel);
  const activeInboxSource = effectiveSource(inboxSourceTab, inboxSourceTabs);

  const visibleInboxItems = sortRows(
    inboxItems, inboxSort.sortKey, INBOX_ACCESSORS, inboxSort.sortDir,
  )
    .filter((i) => matchesSource(i, activeInboxSource))
    .filter((i) => matchesQuery(searchFor("inbox"), i.capturedText));
  // "Recently archived" — Clipboard Step 22. Deliberately NOT filtered by the source tab
  // or the search box above it: those two controls belong to the live list, and a history
  // that silently hid the row you were looking for because a tab was still selected is
  // the trap `effectiveSource` exists to avoid. The window and "Show all" are its own
  // controls.
  // The capture a filed record came from, for the two detail views' Original capture
  // section. Reads `allInboxItems` rather than `inboxItems`: triage ARCHIVES the row, so
  // by the time anything links to it, it is out of the live list by definition.
  const capturedTextFor = (record) =>
    record?.sourceInboxId
      ? allInboxItems.find((i) => i.id === record.sourceInboxId)?.capturedText || null
      : null;

  const archivedInboxItems = recentlyArchived(allInboxItems, { showAll: archivedShowAll });
  const olderArchived = olderArchivedCount(allInboxItems);
  // Keywords are not on the card, so a keyword hit shows a row whose visible
  // text does not contain the query. Accepted deliberately.
  const visibleContexts = sortRows(
    activeContexts, contextsSort.sortKey, NAMED_RECORD_ACCESSORS, contextsSort.sortDir,
  ).filter((c) =>
    matchesQuery(searchFor("contexts"), c.name, c.description, c.keywords),
  );
  // What is happening now first (rankByActivity); the chosen sort orders within each group.
  const visibleIntentions = rankByActivity(
    sortRows(
      filterByStatus(liveIntentions, intentionsStatus.selected).filter(
        (intent) => !filterTag || (intent.tags && intent.tags.includes(filterTag)),
      ),
      intentionsSort.sortKey,
      INTENTION_ACCESSORS,
      intentionsSort.sortDir,
    ),
    validEvents,
    allLiveExecutions,
  ).filter((intent) => matchesQuery(searchFor("intentions"), getIntentDisplay(intent)));
  const visibleMemories = sortRows(
    memoriesWithoutContext.filter(
      (item) => !filterTag || (item.tags && item.tags.includes(filterTag)),
    ),
    memoriesSort.sortKey,
    NAMED_RECORD_ACCESSORS,
    memoriesSort.sortDir,
  ).filter((item) => matchesQuery(searchFor("memories"), ...itemSearchFields(item)));

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  if (!dataLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          <p className="text-foreground font-medium">Loading your data...</p>
        </div>
      </div>
    );
  }

  if (view === "sam") {
    return (
      <SamPlayer
        onBack={() => setView(previousView || "home")}
      />
    );
  }

  if (view === "timer") {
    return (
      <TimerPage
        onBack={() => setView(previousView || "home")}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {isLoading && <LoadingOverlay message={loadingMessage} />}

      <AppChrome
        view={view}
        setView={setView}
        setPreviousView={setPreviousView}
        guardedSetView={guardedSetView}
        confirmDiscardIfDirty={confirmDiscardIfDirty}
        menuOpen={menuOpen}
        setMenuOpen={setMenuOpen}
        manualRefresh={manualRefresh}
        realtimeStatus={realtimeStatus}
        handleSignOut={handleSignOut}
        inboxItems={inboxItems}
        allNonArchivedEvents={allNonArchivedEvents}
      />

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-28 sm:pb-32">
        {/* Home View */}
        {view === "home" && (
          <HomeScreen
            executionTab={executionTab}
            setExecutionTab={setExecutionTab}
            activeExecutions={activeExecutions}
            pausedExecutions={pausedExecutions}
            allLiveExecutions={allLiveExecutions}
            todayEvents={todayEvents}
            visibleTodayEvents={visibleTodayEvents}
            pinnedCollections={pinnedCollections}
            pinnedContexts={pinnedContexts}
            intents={intents}
            contexts={contexts}
            items={items}
            getIntentDisplay={getIntentDisplay}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            homeSort={homeSort}
            updateEvent={updateEvent}
            activate={activate}
            openExecution={openExecution}
            cancelExecutionForEvent={cancelExecutionForEvent}
            viewIntentionDetail={viewIntentionDetail}
            viewItemDetail={viewItemDetail}
            viewContextDetail={viewContextDetail}
            membersOf={membersOf}
            setPreviousView={setPreviousView}
            setSelectedCollectionId={setSelectedCollectionId}
            setView={setView}
            archiveCollection={archiveCollection}
          />
        )}

        {/* Inbox View */}
        {view === "inbox" && (
          <InboxScreen
            inboxItems={inboxItems}
            visibleInboxItems={visibleInboxItems}
            inboxSourceTabs={inboxSourceTabs}
            activeInboxSource={activeInboxSource}
            setInboxSourceTab={setInboxSourceTab}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            inboxSort={inboxSort}
            contexts={contexts}
            items={items}
            intents={intents}
            events={events}
            reminderIndex={reminderIndex}
            openInboxDetail={openInboxDetail}
            processInboxItemFromList={processInboxItemFromList}
            copyTaskInboxItem={copyTaskInboxItem}
            discardInboxItem={discardInboxItem}
            setInboxSuggestedStatus={setInboxSuggestedStatus}
            archivedInboxItems={archivedInboxItems}
            olderArchived={olderArchived}
            archivedShowAll={archivedShowAll}
            setArchivedShowAll={setArchivedShowAll}
            archivedExpanded={archivedExpanded}
            setArchivedExpanded={setArchivedExpanded}
            unarchiveInboxItem={unarchiveInboxItem}
          />
        )}

        {/* Inbox Detail View — Alfred Clipboard, Step 17.

            Rendered from `routeInboxItem`, which is resolved from the URL rather
            than from state, so a refresh or a pasted link opens the same capture.
            `key` is the capture id: moving from one capture to another remounts
            the page rather than re-seeding it, which is what keeps a half-typed
            triage from bleeding into the next one. */}
        {view === "inbox-detail" && routeInboxItem && (
          <InboxDetailScreen
            routeInboxItem={routeInboxItem}
            contexts={contexts}
            items={items}
            tagPool={tagPool}
            handleInboxSave={handleInboxSave}
            discardInboxItem={discardInboxItem}
            guardedSetView={guardedSetView}
            setUnsavedChanges={setUnsavedChanges}
            updateInboxCaptureText={updateInboxCaptureText}
          />
        )}

        {/* Contexts View */}
        {view === "contexts" && (
          <ContextsScreen
            activeContexts={activeContexts}
            visibleContexts={visibleContexts}
            collections={collections}
            showContextForm={showContextForm}
            setShowContextForm={setShowContextForm}
            editingContext={editingContext}
            setEditingContext={setEditingContext}
            saveContext={saveContext}
            setUnsavedChanges={setUnsavedChanges}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            contextsSort={contextsSort}
            viewContextDetail={viewContextDetail}
          />
        )}

        {/* Context Detail View */}
        {view === "context-detail" && selectedContextId && (
          <ContextDetailView
            tagPool={tagPool}
            onOpenAddItem={() =>
              openAddPage("item-add", { kind: "context", id: selectedContextId })
            }
            onOpenAddIntention={() =>
              openAddPage("intention-add", { kind: "context", id: selectedContextId })
            }
            contextId={selectedContextId}
            context={contexts.find((c) => c.id === selectedContextId)}
            // Unsorted on purpose: the page sorts all three of its lists with
            // its own control, whose default (Last modified, newest first) is
            // the fixed order Items used to get here.
            items={items.filter((i) => i.contextId === selectedContextId && !i.archived)}
            sort={contextDetailSort}
            search={searchFor("context-detail")}
            onSearchChange={setSearchFor("context-detail")}
            intents={intents.filter((i) => i.contextId === selectedContextId && !(i.isIntention && i.archived))}
            allIntents={intents}
            statusFilter={contextDetailStatus}
            archivedItems={items.filter((i) => i.contextId === selectedContextId && i.archived)}
            archivedIntents={intents.filter(
              (i) => i.contextId === selectedContextId && i.isIntention && i.archived,
            )}
            contexts={contexts}
            onBack={() => {
              setSelectedContextId(null);
              setView("contexts");
            }}
            getIntentDisplay={getIntentDisplay}
            onUpdateItem={updateItem}
            onUpdateIntent={updateIntent}
            onSchedule={moveToPlanner}
            onSaveContext={saveContextRecord}
            onArchiveContext={archiveContext}
            archiveBlockers={contextArchiveBlockers(selectedContextId)}
            onAddItem={handleAddItemToContext}
            onAddIntention={handleAddIntentionToContext}
            onViewIntentionDetail={(id) =>
              viewIntentionDetail(id, "context-detail")
            }
            onViewItemDetail={(id) => viewItemDetail(id, "context-detail")}
            executions={allLiveExecutions}
            onOpenExecution={openExecution}
            events={events}
            onUpdateEvent={updateEvent}
            onActivate={activate}
            onCancelExecution={cancelExecutionForEvent}
            onStartNow={startNowFromIntention}
            onArchiveIntention={archiveIntention}
            filterTag={filterTag}
            onFilterTag={setFilterTag}
            tagsCollapsed={tagsCollapsedFor("context-detail")}
            onToggleTags={toggleTagsFor("context-detail")}
            allItems={items}
            collections={activeCollections}
            collectionMembers={collectionMembers}
            onViewCollection={(id) => {
              setPreviousView("context-detail");
              setSelectedCollectionId(id);
              setView("collection-detail");
            }}
            onArchiveCollection={archiveCollection}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Intention Detail View */}
        {view === "intention-detail" && effectiveIntentionId && (
          <IntentionDetailView
            tagPool={tagPool}
            intention={intents.find((i) => i.id === effectiveIntentionId)}
            capturedText={capturedTextFor(intents.find((i) => i.id === effectiveIntentionId))}
            intents={intents}
            events={events}
            contexts={contexts}
            items={items}
            onBack={handleBackFromIntentionDetail}
            onUpdateIntention={updateIntent}
            onEditIntention={() => {
              // For now, the user can see all events scheduled for this intention
              // Could add inline editing in the future
            }}
            onUpdateEvent={updateEvent}
            onUpdateItem={updateItem}
            onActivate={activate}
            getIntentDisplay={getIntentDisplay}
            onViewItemDetail={(id) => viewItemDetail(id, "intention-detail")}
            onViewContextDetail={viewContextDetail}
            executions={allLiveExecutions}
            onOpenExecution={openExecution}
            onCancelExecution={cancelExecutionForEvent}
            onArchiveIntention={archiveIntention}
            onSetStatus={setIntentionStatus}
            onSchedule={moveToPlanner}
            onStartNow={startNowFromIntention}
            collections={activeCollections}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {/* Item Detail View */}
        {/* Add pages — Step 12.6. Two pages, four entry points; which entry
            point sent you is a target in the URL, not a separate screen. */}
        {view === "item-add" && (
          <ItemAddScreen
            addTargetContext={addTargetContext}
            tagPool={tagPool}
            contexts={contexts}
            items={items}
            closeAddPage={closeAddPage}
            saveNewItemFromAddPage={saveNewItemFromAddPage}
            setUnsavedChanges={setUnsavedChanges}
          />
        )}

        {view === "intention-add" && (
          <IntentionAddScreen
            addTargetItem={addTargetItem}
            addTargetContext={addTargetContext}
            tagPool={tagPool}
            contexts={contexts}
            items={items}
            activeCollections={activeCollections}
            getIntentDisplay={getIntentDisplay}
            closeAddPage={closeAddPage}
            saveNewIntentionFromAddPage={saveNewIntentionFromAddPage}
            moveToPlanner={moveToPlanner}
            setUnsavedChanges={setUnsavedChanges}
          />
        )}

        {view === "item-detail" && selectedItemId && (
          <ItemDetailView
            tagPool={tagPool}
            capturedText={capturedTextFor(items.find((i) => i.id === selectedItemId))}
            onOpenAddIntention={(itemId) =>
              openAddPage("intention-add", { kind: "item", id: itemId })
            }
            item={items.find((i) => i.id === selectedItemId)}
            intents={intents}
            events={events}
            contexts={contexts}
            items={items}
            onBack={handleBackFromItemDetail}
            onAddToCollection={() => setView("item-add-to-collection")}
            onUpdateItem={updateItem}
            onSetStatus={setItemStatus}
            onEditItem={() => {
              // User can click item to edit inline
            }}
            onUpdateIntent={updateIntent}
            onSchedule={moveToPlanner}
            getIntentDisplay={getIntentDisplay}
            executions={allLiveExecutions.filter((ex) => ex.itemIds?.includes(selectedItemId))}
            onOpenExecution={openExecution}
            onStartNow={startNowFromItem}
            onScheduleItem={scheduleFromItem}
            onUpdateEvent={updateEvent}
            onActivate={activate}
            onAddIntention={handleAddIntentionToContext}
            onCancelExecution={cancelExecutionForEvent}
            onStartNowIntention={startNowFromIntention}
            onArchiveIntention={archiveIntention}
            onViewItem={viewItemDetail}
            onViewIntentionDetail={(id) => viewIntentionDetail(id, "item-detail")}
            // Step 12.2: arrive already editing when the execution screen sent
            // us. Keyed on the item id so tapping through to a DIFFERENT item
            // from here does not also open that one in edit mode.
            startInEditMode={executionEditReturn?.itemId === selectedItemId}
            onClone={async (itemId, newName) => {
              const cloned = await deepCloneItem(itemId, newName);
              if (cloned) {
                viewItemDetail(cloned.id, "item-detail");
              }
            }}
            collections={activeCollections}
            onDirtyChange={setUnsavedChanges}
          />
        )}

        {view === "execution-detail" && (
          <ExecutionDetailScreen
            executionForRoute={executionForRoute}
            awaitingExecutionLoad={awaitingExecutionLoad}
            intents={intents}
            events={events}
            items={items}
            contexts={contexts}
            collections={collections}
            collectionMembers={collectionMembers}
            previousView={previousView}
            setView={setView}
            getIntentDisplay={getIntentDisplay}
            toggleExecutionElement={toggleExecutionElement}
            updateExecutionElement={updateExecutionElement}
            editItemFromExecution={editItemFromExecution}
            toggleCollectionItem={toggleCollectionItem}
            saveMemberQuantity={saveMemberQuantity}
            refreshCollection={refreshCollection}
            updateExecutionNotes={updateExecutionNotes}
            closeExecution={closeExecution}
            pauseExecution={pauseExecution}
            makeExecutionActive={makeExecutionActive}
            // Back from these lands on Home (Active/Paused/Today), one tap from
            // the run: "execution-detail" as a return view has no id in its path.
            onViewIntention={(id) => viewIntentionDetail(id, "home")}
            onViewItem={(id) => viewItemDetail(id, "home")}
            onViewContext={(id) => {
              viewContextDetail(id);
              setPreviousView("home");
            }}
          />
        )}

        {/* Schedule View */}
        {view === "schedule" && (
          <ScheduleScreen
            allNonArchivedEvents={allNonArchivedEvents}
            visibleScheduleEvents={visibleScheduleEvents}
            allLiveExecutions={allLiveExecutions}
            intents={intents}
            contexts={contexts}
            items={items}
            getIntentDisplay={getIntentDisplay}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            scheduleSort={scheduleSort}
            updateEvent={updateEvent}
            activate={activate}
            openExecution={openExecution}
            cancelExecutionForEvent={cancelExecutionForEvent}
            viewIntentionDetail={viewIntentionDetail}
            viewItemDetail={viewItemDetail}
            viewContextDetail={viewContextDetail}
          />
        )}

        {/* Intentions View */}
        {view === "intentions" && (
          <IntentionsScreen
            liveIntentions={liveIntentions}
            intentionStatusCounts={intentionStatusCounts}
            intentionsStatus={intentionsStatus}
            visibleIntentions={visibleIntentions}
            validEvents={validEvents}
            allLiveExecutions={allLiveExecutions}
            reminderIndex={reminderIndex}
            tagPool={tagPool}
            contexts={contexts}
            items={items}
            activeCollections={activeCollections}
            filterTag={filterTag}
            setFilterTag={setFilterTag}
            tagsCollapsedFor={tagsCollapsedFor}
            toggleTagsFor={toggleTagsFor}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            intentionsSort={intentionsSort}
            getIntentDisplay={getIntentDisplay}
            openAddPage={openAddPage}
            updateIntent={updateIntent}
            moveToPlanner={moveToPlanner}
            startNowFromIntention={startNowFromIntention}
            viewIntentionDetail={viewIntentionDetail}
            updateEvent={updateEvent}
            activate={activate}
            openExecution={openExecution}
            cancelExecutionForEvent={cancelExecutionForEvent}
            archiveIntention={archiveIntention}
          />
        )}

        {/* Memories View */}
        {view === "memories" && (
          <MemoriesScreen
            memoriesWithoutContext={memoriesWithoutContext}
            visibleMemories={visibleMemories}
            allLiveExecutions={allLiveExecutions}
            reminderIndex={reminderIndex}
            tagPool={tagPool}
            contexts={contexts}
            intents={intents}
            filterTag={filterTag}
            setFilterTag={setFilterTag}
            tagsCollapsedFor={tagsCollapsedFor}
            toggleTagsFor={toggleTagsFor}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            memoriesSort={memoriesSort}
            getIntentDisplay={getIntentDisplay}
            updateItem={updateItem}
            viewItemDetail={viewItemDetail}
            openExecution={openExecution}
          />
        )}

        {/* Collections View */}
        {view === "collections" && (
          <CollectionsScreen
            activeCollections={activeCollections}
            contexts={contexts}
            collectionContextFilter={collectionContextFilter}
            setCollectionContextFilter={setCollectionContextFilter}
            collectionsSort={collectionsSort}
            searchFor={searchFor}
            setSearchFor={setSearchFor}
            membersOf={membersOf}
            addCollection={addCollection}
            archiveCollection={archiveCollection}
            setPreviousView={setPreviousView}
            setSelectedCollectionId={setSelectedCollectionId}
            setView={setView}
          />
        )}

        {/* Collection Detail View */}
        {view === "collection-detail" && (
          <CollectionDetailScreen
            collections={collections}
            setCollections={setCollections}
            selectedCollectionId={selectedCollectionId}
            setSelectedCollectionId={setSelectedCollectionId}
            items={items}
            contexts={contexts}
            previousView={previousView}
            setView={setView}
            membersOf={membersOf}
            setMembersFor={setMembersFor}
            collectionMembersError={collectionMembersError}
            collectionFilterTag={collectionFilterTag}
            setCollectionFilterTag={setCollectionFilterTag}
            collectionTagPool={collectionTagPool}
            collectionRemovals={collectionRemovals}
            collectionRemovalsError={collectionRemovalsError}
            collectionHistory={collectionHistory}
            collectionHistoryError={collectionHistoryError}
            reAddingRemovalId={reAddingRemovalId}
            editingTagsItemId={editingTagsItemId}
            editingTagsRowRef={editingTagsRowRef}
            collDragIdx={collDragIdx}
            setCollDragIdx={setCollDragIdx}
            setEditingQuantityItemId={setEditingQuantityItemId}
            tagsCollapsedFor={tagsCollapsedFor}
            toggleTagsFor={toggleTagsFor}
            updateCollection={updateCollection}
            archiveCollection={archiveCollection}
            saveMemberOrder={saveMemberOrder}
            saveMemberTags={saveMemberTags}
            saveMemberQuantity={saveMemberQuantity}
            toggleTagEditor={toggleTagEditor}
            removeItemFromCollection={removeItemFromCollection}
            putBackRemoval={putBackRemoval}
          />
        )}

        {/* Collection Removal History View */}
        {view === "collection-history" && (
          <CollectionHistoryScreen
            collections={collections}
            selectedCollectionId={selectedCollectionId}
            collectionHistory={collectionHistory}
            collectionHistoryError={collectionHistoryError}
            setView={setView}
          />
        )}

        {/* Collection Add Items View */}
        {/* The picker. Back is a bare setView("item-detail"): it touches
            neither previousView (the shared slot holding where item detail
            itself came from) nor itemHistoryStack (a stack of item ids for
            item-to-item navigation). selectedItemId is untouched by this
            navigation and this view is keyed on it in DETAIL_VIEW_STATE, so
            no return address is needed. Same as collection-add-items. */}
        {view === "item-add-to-collection" && (
          <ItemAddToCollectionScreen
            items={items}
            selectedItemId={selectedItemId}
            collections={collections}
            contexts={contexts}
            setView={setView}
            addElementsToCollection={addElementsToCollection}
          />
        )}

        {view === "collection-add-items" && (
          <CollectionAddItemsScreen
            user={user}
            collections={collections}
            selectedCollectionId={selectedCollectionId}
            items={items}
            setItems={setItems}
            contexts={contexts}
            membersOf={membersOf}
            addItemsToCollection={addItemsToCollection}
            withLoading={withLoading}
            setView={setView}
          />
        )}

        {/* Record link: /<id> */}
        {view === RECORD_VIEW && (
          <RecordLinkScreen
            recordId={recordIdFromPath(currentPath)}
            onOpen={openRecordDestination}
            lookup={recordLookup}
          />
        )}

        {/* Games View */}
        {view === "games" && <GamesPage />}

        {/* Money View (Warren Buffet) */}
        {view === "money" && <MoneyPage />}

        {/* Settings View */}
        {view === "settings" && <SettingsScreen />}

        {/* Recycle Bin View */}
        {view === "recycle" && (
          <RecycleScreen contexts={contexts} intents={intents} {...recycleBin} />
        )}
      </div>

      {/* Bottom dock: the Undo message stacked directly on top of the Capture
          bar. One bottom-anchored container rather than two, so the message is
          above the bar by document order instead of by a hard-coded offset —
          the bar's height changes as its textarea grows, and any offset would
          be wrong the moment somebody types a long capture. */}
      <BottomDock
        notice={notice}
        pendingUndo={pendingUndo}
        runUndo={runUndo}
        dismissUndo={dismissUndo}
        captureRef={captureRef}
        captureText={captureText}
        setCaptureText={setCaptureText}
        handleCapture={handleCapture}
      />
    </div>
  );
}
