import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { storage } from "../utils/storage";
import { tagPoolForRecords } from "../utils/tags";
import {
  ARCHIVE_PAGE_SIZE,
  inboxRowsByIdQuery,
  liveInboxQuery,
  mergeInboxRefresh,
  mergeInboxRows,
  olderArchivedCountQuery,
  olderArchivedPageQuery,
  recentArchivedQuery,
  warnIfCapped,
} from "./inboxQueries";

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
   * It is NOT the whole table any more (inbox_rowcap-x7k): past 1000 rows PostgREST cut
   * the read off. The loaders bring the live rows and the last RECENT_ARCHIVE_DAYS of
   * archived ones; "Show all" pages and `ensureInboxRows` add older rows to the same list.
   */
  const [allInboxItems, setAllInboxItems] = useState([]);
  /** The live inbox: what the Inbox screen, the nav count and the detail route all mean. */
  const inboxItems = useMemo(() => allInboxItems.filter((i) => !i.archived), [allInboxItems]);

  // "Show all": how many older archived rows exist (a count query), and how far the
  // pages have read.
  const [olderArchivedTotal, setOlderArchivedTotal] = useState(0);
  const [olderArchivedOffset, setOlderArchivedOffset] = useState(0);
  const [loadingOlderArchived, setLoadingOlderArchived] = useState(false);

  // Captures fetched by id. The ref answers lookups at once, before the merge into state
  // has rendered; `pendingInboxIds` lets a route wait instead of bouncing.
  const allInboxRef = useRef([]);
  allInboxRef.current = allInboxItems;
  const fetchedInboxRef = useRef(new Map());
  const askedInboxIdsRef = useRef(new Set());
  const [pendingInboxIds, setPendingInboxIds] = useState(() => new Set());

  const [collections, setCollections] = useState([]);
  // Restructure P5 groups: the three tables whole; src/groups/groupModel.js derives the rest.
  const [groupTypes, setGroupTypes] = useState([]);
  const [itemGroups, setItemGroups] = useState([]);
  const [groupMembers, setGroupMembers] = useState([]);
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
      await applyCoreData(await Promise.all(coreQueries()), { initial: true });
    });
  }

  // What both loaders read, in the order applyCoreData takes it.
  function coreQueries() {
    return [
      supabase.from("contexts").select("*"),
      supabase.from("items").select("*"),
      supabase.from("intents").select("*"),
      supabase.from("events").select("*"),
      liveInboxQuery(supabase),
      recentArchivedQuery(supabase),
      olderArchivedCountQuery(supabase),
      supabase.from("item_collections").select("*"),
      supabase.from("executions").select("*").eq("status", "active").order("started_at", { ascending: false }),
      supabase.from("executions").select("*").eq("status", "paused").order("started_at", { ascending: false }),
      ...groupQueries(),
    ];
  }

  // `initial` (sign-in load) starts the inbox list afresh; a refresh keeps the older
  // archived rows already paged in or fetched by id.
  async function applyCoreData(results, { initial }) {
    const [
      contextsRes, itemsRes, intentsRes, eventsRes,
      liveInboxRes, recentArchivedRes, olderCountRes,
      collectionsRes, activeExecRes, pausedExecRes,
      ...groupData
    ] = results;
    const camel = (data) => (data || []).map(d => storage.toCamelCase(d));
    const whole = (table, res) => camel(warnIfCapped(table, res?.data));

    setContexts(whole("contexts", contextsRes));
    setItems(whole("items", itemsRes));
    setIntents(whole("intents", intentsRes));
    setEvents(whole("events", eventsRes));
    const inbox = [...whole("inbox", liveInboxRes), ...whole("inbox (recently archived)", recentArchivedRes)];
    if (initial) {
      fetchedInboxRef.current.clear();
      askedInboxIdsRef.current.clear();
      setOlderArchivedOffset(0);
    }
    setAllInboxItems(prev => (initial ? mergeInboxRows([], inbox) : mergeInboxRefresh(inbox, prev)));
    setOlderArchivedTotal(olderCountRes?.count ?? 0);
    const collectionsData = collectionsRes?.data || [];
    setCollections(whole("item_collections", collectionsRes));
    setGroupData(groupData);
    await loadCollectionMembers(collectionsData.map(d => d.id));
    const activeExecs = camel(activeExecRes?.data);
    const pausedExecs = camel(pausedExecRes?.data);
    setActiveExecutions(activeExecs);
    setPausedExecutions(pausedExecs);

    // Sync activeExecution if one is currently being viewed
    setActiveExecution(prev => {
      if (!prev) return prev;
      const refreshed = [...activeExecs, ...pausedExecs].find(e => e.id === prev.id);
      return refreshed || prev;
    });
  }

  /** The next page of older archived captures, merged into the one inbox list. */
  async function loadOlderArchived() {
    if (loadingOlderArchived) return;
    setLoadingOlderArchived(true);
    try {
      const { data, error } = await olderArchivedPageQuery(supabase, olderArchivedOffset);
      if (error) throw error;
      const rows = (data || []).map(d => storage.toCamelCase(d));
      setAllInboxItems(prev => mergeInboxRows(prev, rows));
      setOlderArchivedOffset(olderArchivedOffset + rows.length);
      // A short page is the end, whatever the count said when it was taken.
      if (rows.length < ARCHIVE_PAGE_SIZE) setOlderArchivedTotal(olderArchivedOffset + rows.length);
    } catch (e) {
      console.error("[Inbox] loading older archived failed:", e);
      window.alert("Could not load older archived captures. Try again.");
    } finally {
      setLoadingOlderArchived(false);
    }
  }

  /** A capture by id from the list or from an earlier fetch, or null. Safe during render. */
  function findInboxRow(id) {
    if (!id) return null;
    return allInboxRef.current.find((i) => i.id === id) || fetchedInboxRef.current.get(id) || null;
  }

  /** "loaded" | "pending" | "missing" (fetched, not there or not yours) | "unknown" (not asked yet). */
  function inboxRowState(id) {
    if (findInboxRow(id)) return "loaded";
    if (pendingInboxIds.has(id)) return "pending";
    return askedInboxIdsRef.current.has(id) ? "missing" : "unknown";
  }

  /**
   * Fetch captures that are not in the list (older archived ones) and merge them in.
   * Each id is asked for once per sign-in, so a miss cannot loop. Call from effects or
   * async code, never during render.
   */
  async function ensureInboxRows(ids) {
    const want = [...new Set((ids || []).filter(Boolean))].filter(
      (id) => !findInboxRow(id) && !askedInboxIdsRef.current.has(id),
    );
    if (!want.length) return;
    want.forEach((id) => askedInboxIdsRef.current.add(id));
    setPendingInboxIds(prev => new Set([...prev, ...want]));
    try {
      const { data, error } = await inboxRowsByIdQuery(supabase, want);
      if (error) throw error;
      const rows = (data || []).map(d => storage.toCamelCase(d));
      rows.forEach((r) => fetchedInboxRef.current.set(r.id, r));
      if (rows.length) setAllInboxItems(prev => mergeInboxRows(prev, rows));
    } catch (e) {
      console.error("[Inbox] fetching captures by id failed:", e);
    } finally {
      setPendingInboxIds(prev => {
        const next = new Set(prev);
        want.forEach((id) => next.delete(id));
        return next;
      });
    }
  }

  // The three group tables, in the order setGroupData reads them.
  function groupQueries() {
    return [
      supabase.from("group_types").select("*"),
      supabase.from("item_groups").select("*"),
      supabase.from("item_group_members").select("*"),
    ];
  }

  function setGroupData([typesResult, groupsResult, membersResult] = []) {
    const rows = (result) => (result?.data || []).map(d => storage.toCamelCase(d));
    setGroupTypes(rows(typesResult));
    setItemGroups(rows(groupsResult));
    setGroupMembers(rows(membersResult));
  }

  async function refreshData() {
    try {
      console.log('[Refresh] Silent background refresh...');
      await applyCoreData(await Promise.all(coreQueries()), { initial: false });
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
    olderArchivedTotal,
    hasMoreOlderArchived: olderArchivedOffset < olderArchivedTotal,
    olderArchivedLoaded: olderArchivedOffset > 0,
    loadingOlderArchived,
    loadOlderArchived,
    findInboxRow,
    inboxRowState,
    ensureInboxRows,
    collections,
    setCollections,
    groupTypes,
    setGroupTypes,
    itemGroups,
    setItemGroups,
    groupMembers,
    setGroupMembers,
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
