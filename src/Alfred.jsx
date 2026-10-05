import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  pathToView,
  viewToPath,
  normalizePath,
  isKnownPath,
  parentPath,
  DEFAULT_PATH,
  executionPath,
  addPath,
  addRouteFromPath,
  inboxDetailPath,
  inboxIdFromPath,
  intentionIdFromPath,
  intentionDetailPath,
} from "./viewPaths";
import {
  getListReminders,
  indexReminders,
  archivedCaptureTarget,
} from "./utils/remindersApi";
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
import { reconcilePushSubscription } from "./utils/pushSubscriptions";
import { takePendingNavigation } from "./utils/pushRotation";
import NotificationSettings from "./NotificationSettings";
import NotificationDiagnostics from "./NotificationDiagnostics";
import AppLink from "./shared/AppLink";
import UndoMessage, { useUndo } from "./shared/UndoMessage";
import { useSortPreference } from "./shared/SortControl";
import { collapseOnSearch } from "./shared/TagFilter";
import { tagPoolForRecords } from "./utils/tags";
import GamesPage from "./games/GamesPage";
import { sortRows } from "./utils/sortOrders";
import { matchesQuery } from "./utils/search";
import {
  X,
  Trash2,
  Menu,
  Settings,
  Wifi,
  WifiOff,
  RefreshCw,
  Send,
} from "lucide-react";
// `supabaseUrl` used to be imported alongside this: it built the ai-enrich
// endpoint by hand. Step 14 removed the only two callers and left the import
// behind as a lint warning; dropped here.
import { supabase } from "./supabaseClient";
import { storage } from "./utils/storage";
import { getTodayDate } from "./utils/eventDates";
import {
  EVENT_SORT_OPTIONS,
  INBOX_SORT_OPTIONS,
  NAMED_RECORD_SORT_OPTIONS,
  NAMED_RECORD_ACCESSORS,
  itemSearchFields,
  INTENTION_SORT_OPTIONS,
  INTENTION_ACCESSORS,
  INBOX_ACCESSORS,
} from "./utils/listSortOptions";
import { TAG_TOGGLE_ATTR, TAG_FILTERED_VIEWS } from "./utils/tagFilterViews";
import ObjectIcon from "./shared/ObjectIcon";
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

// The nav, as data. Rendered twice — a row of tabs on desktop, a list in the
// mobile drawer — from this one array, so the two cannot drift again.
//
// `count` names which counter decorates the label. `remembersReturn` marks the
// two destinations that record where you came from, so their own Back works;
// it was previously spelled as a `key === "sam" || key === "timer"` test in
// the drawer and as two hand-written onNavigate bodies on desktop.
const NAV_ITEMS = [
  { key: "home", label: "Home", icon: "home" },
  { key: "inbox", label: "Inbox", icon: "inbox", count: "inbox" },
  { key: "contexts", label: "Contexts", icon: "context" },
  { key: "schedule", label: "Schedule", icon: "schedule", count: "schedule" },
  { key: "intentions", label: "Intentions", icon: "intention" },
  { key: "memories", label: "Memories", icon: "item" },
  { key: "collections", label: "Collections", icon: "collection" },
  { key: "timer", label: "Timer", icon: "timer", remembersReturn: true },
  { key: "sam", label: "Sam", icon: "sam", remembersReturn: true },
  { key: "games", label: "Games", icon: "games" },
];

export default function Alfred() {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [contexts, setContexts] = useState([]);
  const [items, setItems] = useState([]);
  const [intents, setIntents] = useState([]);
  // Suggestions for every tag picker on an item or an intention. Recomputed
  // when either list changes, so a tag invented on one record is offered on the
  // next one without a reload.
  //
  // ARCHIVED ROWS ARE EXCLUDED (§A6, 2026-09-21), and the rule now lives in
  // `tagPoolForRecords` (src/utils/tags.js) rather than here — it used to be an
  // inline `.filter((i) => !i.archived)` on each argument, which nothing could
  // import and so nothing tested. Both it and the frequency-then-alphabetical
  // ordering are covered by src/utils/tags.pool.test.js.
  //
  // `tagPoolForRecords` is still a thin wrapper over `tagPoolFrom`, which stays
  // a pure "count the tags in these lists" helper with no opinion about what
  // belongs in them. Read both docblocks, and TagFilter's, before making this
  // list agree with the filter bar's — the difference is the point.
  const tagPool = useMemo(
    () => tagPoolForRecords(items, intents),
    [items, intents]
  );
  const [events, setEvents] = useState([]);
  const [activeExecution, setActiveExecution] = useState(null); // currently viewed
  const [activeExecutions, setActiveExecutions] = useState([]);
  const [pausedExecutions, setPausedExecutions] = useState([]);
  /**
   * EVERY capture, archived or not — Clipboard Step 22.
   *
   * ⚠️ ONE LIST, TWO VIEWS. This used to be `inboxItems`, holding the LIVE captures
   * only: both loaders dropped archived rows and the realtime handler had to drop them
   * again to agree. "Recently archived" needs them, and the alternative — a second
   * `archivedInboxItems` slice — would have meant every one of the eight writers below
   * keeping two lists in step by hand, with an archive moving a row from one to the
   * other. That is precisely the shape of bug the pinned footer took four rounds to fix:
   * a value two things depend on, stored twice.
   *
   * So the state is the whole table and the two views are DERIVED. `inboxItems` below is
   * the live inbox and every existing reader of it is unchanged; the writers now UPDATE
   * a row's `archived` flag where they used to remove the row from the array, which is
   * also what makes the archived section live rather than correct-until-you-refresh.
   *
   * It costs nothing at the network. Both loaders already fetched every row —
   * `select("*")`, no filter — and threw the archived ones away in JavaScript.
   */
  const [allInboxItems, setAllInboxItems] = useState([]);
  /** The live inbox: what the Inbox screen, the nav count and the detail route all mean. */
  const inboxItems = useMemo(() => allInboxItems.filter((i) => !i.archived), [allInboxItems]);
  // Per inbox row and per intention: the soonest scheduled reminder, else the latest
  // sent one, for the list cards. One query for the whole list; refreshed on list
  // views and after reminder-changing actions.
  const [reminderIndex, setReminderIndex] = useState({ byInbox: {}, byIntent: {} });
  const refreshReminderIndex = useCallback(async () => {
    try {
      setReminderIndex(indexReminders(await getListReminders()));
    } catch (err) {
      console.error("[Reminders] list read failed:", err);
    }
  }, []);
  const [collections, setCollections] = useState([]);
  // Step 3b: collection membership is READ from the collection_items table,
  // keyed by collection id. Writes still land in the item_collections.items
  // jsonb until Step 3c, so the two sources can diverge in between.
  const [collectionMembers, setCollectionMembers] = useState({});
  const [collectionMembersError, setCollectionMembersError] = useState(null);
  // Manual removal history, keyed by collection id — feeds the recently-removed
  // panel on the collection detail view.
  const [collectionRemovals, setCollectionRemovals] = useState({});
  const [collectionRemovalsError, setCollectionRemovalsError] = useState(null);
  const [reAddingRemovalId, setReAddingRemovalId] = useState(null);
  // Full removal history — both kinds, unfiltered — for the history view.
  const [collectionHistory, setCollectionHistory] = useState({});
  const [collectionHistoryError, setCollectionHistoryError] = useState(null);
  // Live-refresh support for the collection detail view. The poll must never
  // land on top of an edit in progress, so these track what is being touched.
  // Refs rather than state: the interval callback closes over the render that
  // created it, and reading stale values here would defeat the guard.
  const [editingQuantityItemId, setEditingQuantityItemId] = useState(null);
  const pollPausedRef = useRef(false);
  const memberWriteInFlight = useRef(0);
  const [filterTag, setFilterTag] = useState(null);
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
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [collDragIdx, setCollDragIdx] = useState(null);
  const [collectionContextFilter, setCollectionContextFilter] = useState("");

  const captureRef = useRef(null);
  const [executionTab, setExecutionTab] = useState("active");
  const [captureText, setCaptureText] = useState("");
  const [showContextForm, setShowContextForm] = useState(false);
  const [editingContext, setEditingContext] = useState(null);
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
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'
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
  const { moveToPlanner, updateIntent, archiveIntention } = useIntentionActions({
    user,
    intents,
    setIntents,
    events,
    setEvents,
    view,
    setView,
    setSelectedIntentionId,
    intentionReturnView,
    withLoading,
    offerUndoFor,
  });
  const { updateItem, deepCloneItem } = useItemActions({
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
  });
  const {
    handleCapture,
    discardInboxItem,
    updateInboxCaptureText,
    processInboxItemFromList,
    copyTaskInboxItem,
    handleInboxSave,
    unarchiveInboxItem,
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
  });
  // `refreshData` is a function declaration below, hoisted.
  const recycleBin = useRecycleBin({ view, refreshData, contextArchiveBlockers });

  // --- Notification landing (deep link, closed app) -------------------------
  //
  // Tapping a chain notification with Alfred CLOSED launched the installed PWA
  // on the home page. Everything upstream was correct — the payload carried the
  // URL, notification.data carried it into the click handler, and the same URL
  // pasted into a browser opened the right screen. It is lost inside
  // clients.openWindow(): on Android an installed PWA is launched by the OS at
  // the manifest's start_url, and the requested URL is advisory.
  //
  // So the worker records where it meant to go and this applies it on boot.
  // Runs BEFORE auth resolves on purpose: the Phase 1 guard already suppresses
  // its redirect while a session is being restored, so navigating early costs
  // nothing and gets the address right before anything can look at it.
  //
  // Deliberately not gated on `user` and deliberately not in the dependency
  // list of anything: it must run exactly once per launch.
  useEffect(() => {
    let cancelled = false;
    takePendingNavigation().then((path) => {
      if (cancelled || !path) return;
      // If openWindow DID land correctly — it does on some versions — the app
      // is already here and navigating again would push a pointless history
      // entry.
      if (normalizePath(path) === normalizePath(window.location.pathname)) return;
      console.log(`[Push] Notification asked for ${path}; applying it on launch.`);
      navigate(path, { replace: true });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Push subscription self-healing (Phase 5c) ----------------------------
  //
  // A push subscription can die while its stored row still looks healthy. In
  // the field an endpoint returned 201 from FCM and delivered nothing, for
  // three consecutive sends. There is no delivery receipt in Web Push, so a
  // 201 means "the push service accepted it" and never "the phone showed it" —
  // and a dead FCM registration can answer 201 forever rather than the 404/410
  // that would have pruned the row.
  //
  // So the table cannot be trusted to correct itself. The browser's own
  // getSubscription() is the authority, and this reconciles against it once per
  // load. It never registers a worker or creates a subscription: a user who has
  // not enabled push sees no change at all.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const outcome = await reconcilePushSubscription();
      if (cancelled || !outcome.ran) return;
      if (outcome.inserted || outcome.deleted > 0) {
        console.log(
          `[Push] Subscription reconciled — ${outcome.reason} ` +
            `(inserted: ${outcome.inserted}, removed: ${outcome.deleted})`
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // The worker postMessages a rotation when Alfred is open, so it is repaired
  // immediately rather than waiting for the next load.
  useEffect(() => {
    if (!user || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return undefined;
    }
    const onMessage = (event) => {
      if (!event.data || event.data.type !== "push-subscription-changed") return;
      console.log("[Push] Service worker reported a subscription rotation; repairing.");
      reconcilePushSubscription().then((outcome) => {
        console.log(`[Push] Rotation repair: ${outcome.reason}`);
      });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [user]);

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

  // Reminders are also created by Claude, outside this app, so a list view re-reads them.
  useEffect(() => {
    if (dataLoaded && (view === "inbox" || view === "intentions" || view === "memories")) {
      refreshReminderIndex();
    }
  }, [dataLoaded, view, refreshReminderIndex]);

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

  // --- List sort preferences (Step 9b) --------------------------------------
  //
  // One key per page, each persisting independently — changing the Inbox order
  // must not reorder Schedule. Called unconditionally at the top level: Alfred
  // renders every screen from one component, so these are not conditional even
  // though only one list is on screen at a time.
  //
  // Home's is named for the page but governs its **Today tab only**. Active and
  // Paused render ExecutionBadge, are ordered by `started_at` descending from
  // the database, and have none of these fields; the control is rendered inside
  // the Today panel rather than above the tab bar so it cannot imply otherwise.
  // Same reasoning that excluded those two tabs from the row strips in Step 8a.
  const homeSort = useSortPreference("alfred.sort.home", EVENT_SORT_OPTIONS, "time");
  const scheduleSort = useSortPreference("alfred.sort.schedule", EVENT_SORT_OPTIONS, "time");
  const inboxSort = useSortPreference("alfred.sort.inbox", INBOX_SORT_OPTIONS, "created");
  const contextsSort = useSortPreference("alfred.sort.contexts", NAMED_RECORD_SORT_OPTIONS, "title");
  const collectionsSort = useSortPreference("alfred.sort.collections", NAMED_RECORD_SORT_OPTIONS, "title");
  // Step 12.8. Own keys, independent of the other five — changing the Intentions
  // order must not reorder Memories.
  //
  // Both default to "Last modified, newest first". For Intentions that is Alex's
  // call. For Memories it is a judgement: it is a list of ITEMS, and the only
  // other list of items in the app — Context detail's Items — has always been
  // ordered that way. 12.3 also established that a newly touched record is
  // expected at the top, which is the same instinct. Name was the alternative,
  // for consistency with Contexts and Collections, which share this option set;
  // it lost because those two are things you look up and this is a holding pen
  // for what has not been filed yet.
  const intentionsSort = useSortPreference("alfred.sort.intentions", INTENTION_SORT_OPTIONS, "updated");
  const memoriesSort = useSortPreference("alfred.sort.memories", NAMED_RECORD_SORT_OPTIONS, "updated");
  // Context detail: ONE control for all three of its lists. Items and
  // Intentions offer identical choices — only what "Name" reads differs — so a
  // single row drives Items, Intentions and Collections alike. The default is
  // the order Items always had here; Intentions and Collections had none.
  const contextDetailSort = useSortPreference("alfred.sort.context-detail", NAMED_RECORD_SORT_OPTIONS, "updated");

  // Per-page search text, keyed by page. In memory only, unlike the sort
  // preference: it survives opening a record and pressing Back — the text is
  // still visible in the box, so nothing is filtered invisibly — and a reload
  // clears it.
  const [listSearch, setListSearch] = useState({});
  const searchFor = (page) => listSearch[page] || "";
  const setSearchFor = (page) => (value) => {
    setListSearch((prev) => ({ ...prev, [page]: value }));
    // Typing collapses that page's tag bar, so the results are visible while
    // you type — the whole point of the change. The rule itself lives in
    // TagFilter.jsx so the tests can import it rather than reproduce it; it is
    // the one that knows an empty value must change nothing.
    setListTagsCollapsed((prev) => collapseOnSearch(prev, page, value));
  };

  // Which pages have their tag bar collapsed. A sibling of `listSearch` in every
  // respect — same keys, same top-level owner, same lifetime: it survives
  // opening a record and pressing Back, and a reload clears it. Absent means
  // EXPANDED, so `{}` is the state a fresh load starts in.
  //
  // Matches search rather than sort on purpose. A collapsed tag bar is a fact
  // about the sitting you are in, like the text in the box above it — not a
  // preference about how you like Alfred to look, which is what the localStorage
  // sort keys are for. `/contexts/detail` also carries no context id in its URL,
  // so a reload does not land you back on the page anyway.
  //
  // `collection-detail` is a key here but NOT in `listSearch`: that view has no
  // search box, so its bar only ever collapses by hand.
  const [listTagsCollapsed, setListTagsCollapsed] = useState({});
  const tagsCollapsedFor = (page) => !!listTagsCollapsed[page];
  const toggleTagsFor = (page) => () =>
    setListTagsCollapsed((prev) => ({ ...prev, [page]: !prev[page] }));

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

  // The counter for one NAV_ITEMS entry — Step 12.11.
  //
  // Returns the NUMBER, not a formatted label, because the desktop tabs drop
  // their text below xl and the count has to survive that. A tab reading just
  // an inbox glyph tells you nothing about whether there is anything in it.
  //
  // Zero renders nothing rather than "0": an empty inbox is the goal, and the
  // tab should look calm when you get there.
  function navCount(item) {
    const counts = {
      inbox: inboxItems.length,
      schedule: allNonArchivedEvents.length,
    };
    return item.count ? counts[item.count] || 0 : 0;
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

  // Keep the poll's guard current. Read from a ref, not state, because the
  // interval callback below closes over the render that created it.
  useEffect(() => {
    pollPausedRef.current =
      collDragIdx !== null ||
      editingQuantityItemId !== null ||
      // An open tag editor is the same hazard as an open quantity field: a
      // five-second tick would replace `members` underneath the picker and
      // throw away chips added since the last write.
      editingTagsItemId !== null ||
      isLoading;
  }, [collDragIdx, editingQuantityItemId, editingTagsItemId, isLoading]);

  /**
   * Live refresh for the open collection: a five-second poll, the same cadence
   * and shape as the execution view's. Deliberately a poll and not a realtime
   * channel.
   *
   * Runs only while the collection detail view is open, and only for the
   * collection being viewed — the interval is torn down on navigate away, so no
   * other collection is ever polled.
   *
   * Membership and the manual-removal panel refresh; the full history does not.
   * Seeing the other person's removal land in "Recently removed" is the point of
   * that panel — without it an item would vanish from the list with no
   * explanation and no way to put it back. The history view is a record rather
   * than a live surface, costs a third query per tick, and reloads on entry
   * anyway.
   */
  useEffect(() => {
    if (view !== "collection-detail" || !selectedCollectionId) return;

    const interval = setInterval(() => {
      // Never land on top of an edit in progress. A skipped tick costs five
      // seconds; overwriting a half-typed quantity or a drag mid-flight costs
      // the user their work.
      if (pollPausedRef.current || memberWriteInFlight.current > 0) return;
      loadCollectionMembers([selectedCollectionId], { quiet: true });
      loadCollectionRemovals(selectedCollectionId, { quiet: true });
    }, 5000);

    return () => clearInterval(interval);
    // The loaders are recreated every render; depending on them would tear down
    // and restart the interval continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedCollectionId]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
  }

  async function loadData() {
    return withLoading('Loading your data...', async () => {
      const [
        { data: contextsData },
        { data: itemsData },
        { data: intentsData },
        { data: eventsData },
        { data: inboxData },
        { data: collectionsData },
        { data: activeExecData },
        { data: pausedExecData },
      ] = await Promise.all([
        supabase.from("contexts").select("*"),
        supabase.from("items").select("*"),
        supabase.from("intents").select("*"),
        supabase.from("events").select("*"),
        supabase.from("inbox").select("*"),
        supabase.from("item_collections").select("*"),
        supabase.from("executions").select("*").eq("status", "active").order("started_at", { ascending: false }),
        supabase.from("executions").select("*").eq("status", "paused").order("started_at", { ascending: false }),
      ]);

      setContexts((contextsData || []).map(d => storage.toCamelCase(d)));
      setItems((itemsData || []).map(d => storage.toCamelCase(d)));
      setIntents((intentsData || []).map(d => storage.toCamelCase(d)));
      setEvents((eventsData || []).map(d => storage.toCamelCase(d)));
      // ARCHIVED ROWS ARE KEPT — Step 22. The filter that used to drop them here has
      // moved into the `inboxItems` derivation, so the live inbox is unchanged and
      // "Recently archived" has something to read. The query never filtered them out
      // anyway; this only stops throwing away rows already on the wire.
      // (A guard in utils/inboxArchive.test.js fails if that filter comes back.)
      setAllInboxItems(
        (inboxData || [])
          .map(d => storage.toCamelCase(d))
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      );
      setCollections((collectionsData || []).map(d => storage.toCamelCase(d)));
      await loadCollectionMembers((collectionsData || []).map(d => d.id));
      setActiveExecutions((activeExecData || []).map(d => storage.toCamelCase(d)));
      setPausedExecutions((pausedExecData || []).map(d => storage.toCamelCase(d)));

      // Sync activeExecution if one is currently being viewed
      setActiveExecution(prev => {
        if (!prev) return prev;
        const allRefreshed = [
          ...(activeExecData || []).map(d => storage.toCamelCase(d)),
          ...(pausedExecData || []).map(d => storage.toCamelCase(d)),
        ];
        const refreshed = allRefreshed.find(e => e.id === prev.id);
        return refreshed || prev;
      });
    });
  }

  async function refreshData() {
    try {
      console.log('[Refresh] Silent background refresh...');
      const [
        { data: contextsData },
        { data: itemsData },
        { data: intentsData },
        { data: eventsData },
        { data: inboxData },
        { data: collectionsData },
        { data: activeExecData },
        { data: pausedExecData },
      ] = await Promise.all([
        supabase.from("contexts").select("*"),
        supabase.from("items").select("*"),
        supabase.from("intents").select("*"),
        supabase.from("events").select("*"),
        supabase.from("inbox").select("*"),
        supabase.from("item_collections").select("*"),
        supabase.from("executions").select("*").eq("status", "active").order("started_at", { ascending: false }),
        supabase.from("executions").select("*").eq("status", "paused").order("started_at", { ascending: false }),
      ]);

      setContexts((contextsData || []).map(d => storage.toCamelCase(d)));
      setItems((itemsData || []).map(d => storage.toCamelCase(d)));
      setIntents((intentsData || []).map(d => storage.toCamelCase(d)));
      setEvents((eventsData || []).map(d => storage.toCamelCase(d)));
      // ARCHIVED ROWS ARE KEPT — Step 22. The filter that used to drop them here has
      // moved into the `inboxItems` derivation, so the live inbox is unchanged and
      // "Recently archived" has something to read. The query never filtered them out
      // anyway; this only stops throwing away rows already on the wire.
      // (A guard in utils/inboxArchive.test.js fails if that filter comes back.)
      setAllInboxItems(
        (inboxData || [])
          .map(d => storage.toCamelCase(d))
          .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))
      );
      setCollections((collectionsData || []).map(d => storage.toCamelCase(d)));
      await loadCollectionMembers((collectionsData || []).map(d => d.id));
      setActiveExecutions((activeExecData || []).map(d => storage.toCamelCase(d)));
      setPausedExecutions((pausedExecData || []).map(d => storage.toCamelCase(d)));

      // Sync activeExecution if one is currently being viewed
      setActiveExecution(prev => {
        if (!prev) return prev;
        const allRefreshed = [
          ...(activeExecData || []).map(d => storage.toCamelCase(d)),
          ...(pausedExecData || []).map(d => storage.toCamelCase(d)),
        ];
        const refreshed = allRefreshed.find(e => e.id === prev.id);
        return refreshed || prev;
      });

      console.log('[Refresh] Done');
    } catch (e) {
      console.error('[Refresh] Failed:', e);
    }
  }

  async function manualRefresh() {
    return withLoading('Refreshing...', refreshData);
  }

  async function setupRealtimeSubscriptions(currentUser) {
    if (!currentUser) return null;

    console.log('[Realtime] Setting up subscriptions for user:', currentUser.id);
    setRealtimeStatus('connecting');

    // Use the recursive converter so JSONB columns (elements, tags, etc.) get camelCased too
    const toCamelCase = (obj) => storage.toCamelCase(obj);

    // Subscribe to inbox changes
    const inboxChannel = supabase
      .channel('inbox-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'inbox',
          filter: `user_id=eq.${currentUser.id}`
        },
        (payload) => {
          console.log('[Realtime] Inbox change:', payload.eventType, payload);
          handleInboxChange(payload, toCamelCase);
        }
      )
      .subscribe((status) => {
        console.log('[Realtime] Inbox subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected');
        }
      });

    // Subscribe to contexts changes
    const contextsChannel = supabase
      .channel('contexts-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'contexts'
        },
        (payload) => {
          console.log('[Realtime] Context change:', payload.eventType);
          handleContextChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to items changes
    const itemsChannel = supabase
      .channel('items-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        (payload) => {
          console.log('[Realtime] Item change:', payload.eventType);
          handleItemChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to intents changes
    const intentsChannel = supabase
      .channel('intents-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'intents'
        },
        (payload) => {
          console.log('[Realtime] Intent change:', payload.eventType);
          handleIntentChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to events changes
    const eventsChannel = supabase
      .channel('events-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'events'
        },
        (payload) => {
          console.log('[Realtime] Event change:', payload.eventType);
          handleEventChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Subscribe to executions changes
    const executionsChannel = supabase
      .channel('executions-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'executions'
        },
        (payload) => {
          console.log('[Realtime] Execution change:', payload.eventType);
          handleExecutionChange(payload, toCamelCase);
        }
      )
      .subscribe();

    // Return cleanup function
    return () => {
      console.log('[Realtime] Unsubscribing all channels');
      setRealtimeStatus('disconnected');
      inboxChannel.unsubscribe();
      contextsChannel.unsubscribe();
      itemsChannel.unsubscribe();
      intentsChannel.unsubscribe();
      eventsChannel.unsubscribe();
      executionsChannel.unsubscribe();
    };
  }

  /**
   * Keep `allInboxItems` in step with the table, live.
   *
   * ── This handler got SMALLER in Step 22, and that is the news ────────────────
   *
   * It used to know about `archived`: it dropped archived rows on INSERT, removed them
   * from the list on UPDATE, and put un-archived ones back — because the list it
   * maintained was the LIVE inbox and the loaders filtered the same way. Three copies of
   * one rule, in two loaders and here, which had to be changed together or the screen
   * disagreed with itself depending on when you last refreshed.
   *
   * Now the state is the whole table and `inboxItems` is derived from it, so this handler
   * mirrors the table and holds no opinion at all: a row arrives, a row changes, a row
   * goes. An archive is an ordinary UPDATE and both views follow from it — which is also
   * how the archived section became live for free.
   *
   * The one thing it still owns is the ORDER, `createdAt` ascending, matching both
   * loaders. Do not "add to top": the live inbox is a queue worked from the front, and
   * the sort is what enforces that rather than array order. ("Recently archived" sorts
   * itself, the other way round, in `recentlyArchived`.)
   */
  function handleInboxChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    const upsertSorted = (prev, record) =>
      [...prev.filter(item => item.id !== record.id), record]
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setAllInboxItems(prev => (
        prev.find(item => item.id === record.id) ? prev : upsertSorted(prev, record)
      ));
    } else if (eventType === 'UPDATE') {
      // Upsert rather than map: a row can arrive here without ever having been in `prev`
      // (another device captured and enriched it between refreshes), and a plain `map`
      // would silently do nothing.
      setAllInboxItems(prev => upsertSorted(prev, toCamelCase(newRecord)));
    } else if (eventType === 'DELETE') {
      setAllInboxItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleContextChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setContexts(prev => {
        if (prev.find(ctx => ctx.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setContexts(prev =>
        prev.map(ctx => ctx.id === record.id ? record : ctx)
      );
    } else if (eventType === 'DELETE') {
      setContexts(prev =>
        prev.filter(ctx => ctx.id !== oldRecord.id)
      );
    }
  }

  function handleItemChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setItems(prev => {
        if (prev.find(item => item.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setItems(prev =>
        prev.map(item => item.id === record.id ? record : item)
      );
    } else if (eventType === 'DELETE') {
      setItems(prev =>
        prev.filter(item => item.id !== oldRecord.id)
      );
    }
  }

  function handleIntentChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setIntents(prev => {
        if (prev.find(intent => intent.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setIntents(prev =>
        prev.map(intent => intent.id === record.id ? record : intent)
      );
    } else if (eventType === 'DELETE') {
      setIntents(prev =>
        prev.filter(intent => intent.id !== oldRecord.id)
      );
    }
  }

  function handleEventChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      setEvents(prev => {
        if (prev.find(event => event.id === record.id)) return prev;
        return [...prev, record];
      });
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      setEvents(prev =>
        prev.map(event => event.id === record.id ? record : event)
      );
    } else if (eventType === 'DELETE') {
      setEvents(prev =>
        prev.filter(event => event.id !== oldRecord.id)
      );
    }
  }

  function handleExecutionChange(payload, toCamelCase) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    if (eventType === 'INSERT') {
      const record = toCamelCase(newRecord);
      if (record.status === 'active') {
        setActiveExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => {
          if (prev.find(exec => exec.id === record.id)) return prev;
          return [...prev, record];
        });
      }
    } else if (eventType === 'UPDATE') {
      const record = toCamelCase(newRecord);
      // Remove from both lists first
      setActiveExecutions(prev => prev.filter(exec => exec.id !== record.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== record.id));
      // Add to appropriate list based on status
      if (record.status === 'active') {
        setActiveExecutions(prev => [...prev, record]);
      } else if (record.status === 'paused') {
        setPausedExecutions(prev => [...prev, record]);
      }
    } else if (eventType === 'DELETE') {
      setActiveExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
      setPausedExecutions(prev => prev.filter(exec => exec.id !== oldRecord.id));
    }
  }

  function getIntentDisplay(intent) {
    if (intent.text) return intent.text;
    if (intent.itemId) {
      const item = items.find((i) => i.id === intent.itemId);
      return item?.name || "Untitled";
    }
    return intent.text || "Untitled";
  }

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

  function openExecution(exec) {
    setPreviousView(view);
    setActiveExecution(exec);
    goToExecution(exec);
  }

  // Intentions: Marked as intentions, not archived, no active event
  const intentionsWithoutActiveEvent = intents.filter((i) => {
    if (!i.isIntention || i.archived) return false;
    const hasActiveEvent = validEvents.some((e) => e.intentId === i.id);
    return !hasActiveEvent;
  });

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
  const visibleIntentions = sortRows(
    intentionsWithoutActiveEvent.filter(
      (intent) => !filterTag || (intent.tags && intent.tags.includes(filterTag)),
    ),
    intentionsSort.sortKey,
    INTENTION_ACCESSORS,
    intentionsSort.sortDir,
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

      {/* Mobile header with hamburger */}
      <header className="sm:hidden sticky top-0 z-10 bg-white border-b border-border shadow-sm">
        <div className="px-3 py-3 flex items-center justify-between">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-foreground"
          >
            <Menu className="w-6 h-6" />
          </button>
          {/* Was a raw <a href="/">, so a plain click did a full page reload and
              never reached confirmDiscardIfDirty. AppLink keeps the same href
              and the same middle-click behaviour, and routes the plain click
              through the guard like the nav tabs. */}
          <AppLink
            view="home"
            onNavigate={() => guardedSetView("home")}
            className="text-lg font-bold text-foreground hover:text-foreground"
          >
            Alfred v5
          </AppLink>
          <div className="flex gap-1 items-center">
            <button
              onClick={manualRefresh}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            {/* Connection status indicator */}
            <div
              className="flex items-center gap-1"
              title={realtimeStatus === 'connected' ? 'Connected' : realtimeStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
            >
              {realtimeStatus === 'connected' ? (
                <Wifi className="w-4 h-4 text-success" />
              ) : realtimeStatus === 'connecting' ? (
                <Wifi className="w-4 h-4 text-warning animate-pulse" />
              ) : (
                <WifiOff className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
            <button
              onClick={() => guardedSetView("settings")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button
              onClick={() => guardedSetView("recycle")}
              className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
              title="Recycle Bin"
            >
              <Trash2 className="w-5 h-5" />
            </button>
            <button
              onClick={handleSignOut}
              className="text-sm px-3 py-1 text-muted-foreground hover:text-destructive transition-colors"
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Mobile slide-out menu */}
      {menuOpen && (
        <>
          <div
            className="sm:hidden fixed inset-0 bg-black bg-opacity-50 z-30"
            onClick={() => setMenuOpen(false)}
          />
          <nav className="sm:hidden fixed top-0 left-0 bottom-0 w-64 bg-white shadow-xl z-40">
            <div className="p-4 border-b border-border">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-foreground">Menu</h2>
                <button
                  onClick={() => setMenuOpen(false)}
                  className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="p-2">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  onClick={() => {
                    if (!confirmDiscardIfDirty()) return;
                    if (item.remembersReturn) setPreviousView(view);
                    setView(item.key);
                    setMenuOpen(false);
                  }}
                  className={`w-full text-left px-4 py-3 rounded-lg mb-1 ${
                    view === item.key
                      ? "bg-primary-light text-foreground font-medium"
                      : "text-foreground hover:bg-secondary/50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <ObjectIcon type={item.icon} />
                    {item.label}
                    {navCount(item) > 0 && (
                      <span className="text-xs tabular-nums opacity-75">
                        {navCount(item)}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </nav>
        </>
      )}

      {/* Desktop header with tabs */}
      <div className="hidden sm:block sticky top-0 z-10 bg-white border-b border-border shadow-sm">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              {/* See the mobile logo above — same reason. */}
              <AppLink
                view="home"
                onNavigate={() => guardedSetView("home")}
                className="text-2xl font-bold text-foreground hover:text-foreground"
              >
                Alfred v5
              </AppLink>
              <p className="text-sm text-muted-foreground mt-1">
                Capture decisions. Hold intent. Execute with focus.
              </p>
            </div>
            <div className="flex gap-2 items-center">
              <button
                onClick={manualRefresh}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Refresh data"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              {/* Connection status indicator */}
              <div
                className="flex items-center gap-1"
                title={realtimeStatus === 'connected' ? 'Connected' : realtimeStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
              >
                {realtimeStatus === 'connected' ? (
                  <Wifi className="w-4 h-4 text-success" />
                ) : realtimeStatus === 'connecting' ? (
                  <Wifi className="w-4 h-4 text-warning animate-pulse" />
                ) : (
                  <WifiOff className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <button
                onClick={() => guardedSetView("settings")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
              <button
                onClick={() => guardedSetView("recycle")}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
                title="Recycle Bin"
              >
                <Trash2 className="w-5 h-5" />
              </button>
              <button
                onClick={handleSignOut}
                className="text-sm px-3 py-1 text-muted-foreground hover:text-destructive transition-colors"
                title="Sign out"
              >
                Sign out
              </button>
            </div>
          </div>

          {/* Desktop navigation tabs — Step 12.10.

              Was ten hand-written AppLinks, each repeating the same class
              string and its own copy of the active-state ternary. They are now
              one map over NAV_ITEMS, which is the same array the mobile drawer
              renders.

              The icons are the reason for the merge, not a side effect of it:
              adding a glyph to each of two independent lists is precisely how
              the drawer's icons drifted from everything else in the first
              place. One array, one vocabulary, no way to update half of it. */}
          {/* Step 12.11. This bar has to hold ten destinations from 640px —
              where the mobile drawer stops — up to a wide desktop, and every
              one of them has to stay ONE tap away. That rules out an overflow
              menu: burying Sam behind a chevron is the one outcome worth
              avoiding.

              So the tabs compact instead of collapsing, in three tiers:

                640–1023   icon only, ~44px each — all ten fit in ~480px
                1024–1279  icon + label, tighter padding and text-sm
                1280+      icon + label, full padding

              `flex-wrap` is the safety net under all three. If a label ever
              runs longer than the arithmetic above assumes, the bar takes a
              second row rather than clipping Games off the end — a wrapped tab
              is still one tap, a clipped one is unreachable.

              The count survives the label: an inbox glyph on its own says
              nothing about whether there is anything in it, so the number
              renders separately and stays at every width. */}
          <nav className="flex flex-wrap gap-2 mt-3 pb-1">
            {NAV_ITEMS.map((item) => {
              const count = navCount(item);
              return (
                <AppLink
                  key={item.key}
                  view={item.key}
                  onNavigate={() => {
                    if (!confirmDiscardIfDirty()) return;
                    if (item.remembersReturn) setPreviousView(view);
                    setView(item.key);
                  }}
                  // The label is hidden at narrow widths, not removed, so the
                  // accessible name has to come from somewhere that survives.
                  title={item.label}
                  aria-label={item.label}
                  className={`inline-flex items-center justify-center gap-2 px-3 xl:px-4 py-2 rounded whitespace-nowrap min-h-[44px] min-w-[44px] text-sm xl:text-base ${
                    view === item.key
                      ? "bg-primary text-white shadow-sm"
                      : "bg-white text-foreground border border-border hover:border-primary"
                  }`}
                >
                  <ObjectIcon type={item.icon} />
                  <span className="hidden lg:inline">{item.label}</span>
                  {count > 0 && (
                    <span className="text-xs tabular-nums opacity-75">
                      {count}
                    </span>
                  )}
                </AppLink>
              );
            })}
          </nav>
        </div>
      </div>

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
            onEditItem={() => {
              // User can click item to edit inline
            }}
            onUpdateIntent={updateIntent}
            onSchedule={moveToPlanner}
            getIntentDisplay={getIntentDisplay}
            executions={allLiveExecutions.filter((ex) => ex.itemIds?.includes(selectedItemId))}
            onOpenExecution={openExecution}
            onStartNow={startNowFromItem}
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
            intentionsWithoutActiveEvent={intentionsWithoutActiveEvent}
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

        {/* Games View */}
        {view === "games" && <GamesPage />}

        {/* Settings View */}
        {view === "settings" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Settings</h2>
            <NotificationSettings />
            <NotificationDiagnostics />
            <div className="mt-4 p-4 sm:p-6 bg-card border border-border rounded-lg">
              <p className="text-muted-foreground">More settings coming soon...</p>
            </div>
            {process.env.REACT_APP_BUILD_TIMESTAMP && (
              <div className="mt-6 text-xs text-muted-foreground/60">
                <p>Last deployed: {new Date(process.env.REACT_APP_BUILD_TIMESTAMP).toLocaleString()}</p>
                <p>Commit: {(process.env.REACT_APP_COMMIT_SHA || 'local').slice(0, 7)}</p>
              </div>
            )}
          </div>
        )}

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
      <div className="fixed bottom-0 left-0 right-0 z-20">
        <UndoMessage
          pendingUndo={pendingUndo}
          onUndo={runUndo}
          onDismiss={dismissUndo}
        />

        {/* Capture bar */}
        <div className="bg-white border-t border-border shadow-lg">
          <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2 sm:py-4">
            <div className="flex gap-2 items-end">
              <textarea
                ref={captureRef}
                value={captureText}
                onChange={(e) => {
                  setCaptureText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.5) + "px";
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleCapture();
                  }
                }}
                placeholder="Capture anything..."
                rows={1}
                className="flex-1 px-3 sm:px-4 py-2.5 sm:py-3 border border-border rounded focus:outline-none focus:ring-2 focus:ring-primary resize-none overflow-hidden min-h-[44px] max-h-[50vh] text-base"
              />
              {/* The icon matches the Capture SOURCE tab in the inbox — Step 21b, and
                  the glyph changed in 21c. This button is what creates a 'manual'
                  capture, so the two must stay recognisably the same thing; if one moves,
                  both move. See SOURCE_GLYPHS for why it is a paper aeroplane. */}
              <button
                onClick={handleCapture}
                className="inline-flex items-center gap-2 px-3 sm:px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Send className="w-4 h-4 shrink-0" aria-hidden="true" />
                Capture
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
