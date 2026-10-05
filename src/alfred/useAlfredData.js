import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { storage } from "../utils/storage";
import { tagPoolForRecords } from "../utils/tags";

// Alfred's record state and its loaders, moved out of Alfred.jsx unchanged. No
// effects: the collection poll is `useCollectionPoll` below, called where its two
// effects were.
//
// `loadCollectionMembers` belongs to useCollections, which itself needs
// `refreshData` from here, so Alfred passes it in as a deferred call.
export function useAlfredData({ withLoading, loadCollectionMembers }) {
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

  const [collections, setCollections] = useState([]);
  // Step 3b: collection membership is READ from the collection_items table,
  // keyed by collection id. Writes still land in the item_collections.items
  // jsonb until Step 3c, so the two sources can diverge in between.
  const [collectionMembers, setCollectionMembers] = useState({});
  const [collectionMembersError, setCollectionMembersError] = useState(null);

  // Live-refresh support for the collection detail view. The poll must never
  // land on top of an edit in progress, so these track what is being touched.
  // Refs rather than state: the interval callback closes over the render that
  // created it, and reading stale values here would defeat the guard.
  const [editingQuantityItemId, setEditingQuantityItemId] = useState(null);
  const pollPausedRef = useRef(false);
  const memberWriteInFlight = useRef(0);

  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState('disconnected'); // 'connected', 'connecting', 'disconnected'

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

  return {
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
  };
}

// The collection detail poll and the guard it reads, moved out of Alfred.jsx
// unchanged and called where they were, after Alfred's other collection effects.
export function useCollectionPoll({
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
}) {
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
    // pollPausedRef is a ref passed in from useAlfredData: stable, as when it was local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
}
