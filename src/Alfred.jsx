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
import PendingReminder from "./PendingReminder";
import {
  moveRemindersToIntention,
  cancelRemindersForDiscard,
  restoreRemindersAfterDiscard,
  getListReminders,
  indexReminders,
  reminderBadge,
  archivedCaptureTarget,
  itemReminder,
} from "./utils/remindersApi";
import { useExecutionRoute } from "./useExecutionRoute";
import InboxDetailView from "./InboxDetailView";
import ClipboardCapture from "./ClipboardCapture";
import PinnedFooter from "./shared/PinnedFooter";
import InboxListCard from "./InboxListCard";
import RecentlyArchived from "./RecentlyArchived";
import UnderlineTabs from "./shared/UnderlineTabs";
import {
  archiveOutcome,
  olderArchivedCount,
  recentlyArchived,
  undoNeedsConfirming,
  undoWarning,
} from "./utils/inboxArchive";
import {
  ALL_SOURCES,
  effectiveSource,
  matchesSource,
  sourceTabsFor,
} from "./utils/inboxSourceTabs";
import { copyTextForTask, triageDataForOneTap } from "./utils/inboxSuggestions";
import { clipIdFor } from "./utils/capturedClip";
import { friendlyDate, sourceLabel } from "./CaptureMeta";
import { reconcilePushSubscription } from "./utils/pushSubscriptions";
import { takePendingNavigation } from "./utils/pushRotation";
import NotificationSettings from "./NotificationSettings";
import NotificationDiagnostics from "./NotificationDiagnostics";
import AppLink from "./shared/AppLink";
import UndoMessage, { useUndo } from "./shared/UndoMessage";
import { useSortPreference } from "./shared/SortControl";
import ListToolbar, { NoMatches } from "./shared/ListToolbar";
import ItemPicker from "./shared/ItemPicker";
import TagFilter, { collapseOnSearch } from "./shared/TagFilter";
import TagPicker from "./shared/TagPicker";
import RemovalMeta from "./shared/RemovalMeta";
import { startOfPacificDay } from "./utils/localDay";
import { tagPoolForRecords } from "./utils/tags";
import GamesPage from "./games/GamesPage";
import { sortRows } from "./utils/sortOrders";
import { intentionRowFromTriage, intentionUpdateRow } from "./utils/intentionRows";
import { matchesQuery } from "./utils/search";
import {
  createNotificationSteps,
  completeNotificationStep,
  untickNotificationStep,
  cancelNotificationSteps,
  resumeNotificationSteps,
} from "./utils/notificationStepsApi";
import {
  parseIngredient,
  matchProduct,
  findNearMisses,
} from "./utils/ingredientMatch";
import {
  Plus,
  Pause,
  X,
  Trash2,
  ArrowLeft,
  Menu,
  GripVertical,
  Tag,
  Settings,
  Archive,
  Activity,
  Wifi,
  WifiOff,
  RefreshCw,
  ArchiveRestore,
  Send,
  // Clipboard Step 22: the last two tab glyphs, chosen rather than reused.
  // `Sun` is Today; `Scissors` is a SAM snippet — see the tab rows for why.
  Sun,
} from "lucide-react";
// `supabaseUrl` used to be imported alongside this: it built the ai-enrich
// endpoint by hand. Step 14 removed the only two callers and left the import
// behind as a lint warning; dropped here.
import { supabase } from "./supabaseClient";
import { calculateNextEventDate, getRecurrenceConfig } from "./utils/recurrence";
import { storage } from "./utils/storage";
import { uid, flattenElements } from "./utils/flattenElements";
import { toLocalDateString, getTodayDate, formatEventDate } from "./utils/eventDates";
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
import { removalReasonLabel, groupRemovalsByAction } from "./utils/removalLabels";
import ObjectIcon from "./shared/ObjectIcon";
import LoginScreen from "./shared/LoginScreen";
import LoadingOverlay from "./shared/LoadingOverlay";
import AddPageChrome from "./shared/AddPageChrome";
import RecurrenceQuickSelect from "./shared/recurrence/RecurrenceQuickSelect";
import { useRecycleBin } from "./recycle/useRecycleBin";
import RecycleScreen from "./recycle/RecycleScreen";
import { useContextActions } from "./contexts/useContextActions";
import ContextsScreen from "./contexts/ContextsScreen";
import ContextCard from "./contexts/ContextCard";
import EventCard from "./schedule/EventCard";
import ExecutionBadge from "./executions/ExecutionBadge";
import ItemNameLabel from "./items/ItemNameLabel";
import CollectionCard from "./collections/CollectionCard";
import ItemCard from "./items/ItemCard";
import IntentionCard from "./intentions/IntentionCard";
import ContextDetailView from "./contexts/ContextDetailView";
import IntentionDetailView from "./intentions/IntentionDetailView";
import ItemDetailView from "./items/ItemDetailView";
import ExecutionDetailView from "./executions/ExecutionDetailView";
import {
  loadMembers,
  loadRemovals,
  addMembers,
  addOrMergeMembers,
  removeMember,
  removeMembers,
  reAddRemoval,
  updateMemberQuantity,
  updateMemberTags,
  loadCollectionTagPool,
  reorderMembers,
  REMOVAL_MANUAL,
  REMOVAL_COMPLETED,
} from "./utils/collectionMembers";
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

function CollectionAddItems({ availableItems, contexts, onAdd, onCancel, maxItems, collection, onCreateItem }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState({});

  const filtered = availableItems.filter((item) =>
    matchesQuery(search, item.name, ...(Array.isArray(item.tags) ? item.tags : [])),
  );

  function toggleItem(itemId) {
    setSelected((prev) => {
      if (prev[itemId]) {
        const next = { ...prev };
        delete next[itemId];
        return next;
      }
      if (Object.keys(prev).length >= maxItems) return prev;
      return { ...prev, [itemId]: { itemId, quantity: "" } };
    });
  }

  function setQuantity(itemId, quantity) {
    setSelected((prev) => ({
      ...prev,
      [itemId]: { ...prev[itemId], quantity },
    }));
  }

  return (
    <div>
      <button
        onClick={onCancel}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Collection
      </button>

      <h2 className="text-lg font-medium mb-3">Add Items to Collection</h2>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search items by name or tag..."
        className="w-full px-3 py-2 border border-border rounded-lg text-base mb-3"
        autoFocus
      />

      <div className="space-y-2 mb-4" style={{ maxHeight: "50vh", overflowY: "auto" }}>
        {filtered.length === 0 && search.trim() ? (
          <div className="py-2">
            <button
              onClick={() => onCreateItem(search.trim())}
              className="w-full flex items-center gap-3 px-4 py-3 border-2 border-dashed border-primary rounded-lg hover:bg-primary/5 transition-colors"
            >
              <Plus className="w-5 h-5 text-primary flex-shrink-0" />
              <div className="text-left flex-1 min-w-0">
                <div className="font-medium text-primary">Create "{search.trim()}"</div>
                <div className="text-sm text-muted-foreground">
                  Add as new item{collection?.contextId && contexts ? ` in ${contexts.find(c => c.id === collection.contextId)?.name || 'this context'}` : ''}
                </div>
              </div>
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4 text-center">No matching items</p>
        ) : (
          filtered.map((item) => {
            const isSelected = !!selected[item.id];
            const contextName = item.contextId && contexts
              ? contexts.find((c) => c.id === item.contextId)?.name
              : null;
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 p-3 border rounded cursor-pointer ${
                  isSelected ? "border-primary bg-background" : "border-border bg-white hover:border-primary"
                }`}
                onClick={() => toggleItem(item.id)}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  className="rounded accent-primary pointer-events-none"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{item.name}</p>
                  {contextName && (
                    <span className="text-xs text-muted-foreground">{contextName}</span>
                  )}
                </div>
                {isSelected && (
                  <input
                    type="text"
                    value={selected[item.id]?.quantity || ""}
                    onChange={(e) => {
                      e.stopPropagation();
                      setQuantity(item.id, e.target.value);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Qty"
                    className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base"
                  />
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Same offsets as ContextForm's. Note this one will rarely engage: the
          item list above is capped at 50vh with its own scrollbar, so the page
          as a whole does not usually exceed the viewport. It is here for the
          cases that do — a very short window, or if that cap is ever lifted —
          rather than because it changes anything today. */}
      <PinnedFooter className="bg-background">
        <button
          onClick={() => onAdd(Object.values(selected))}
          disabled={Object.keys(selected).length === 0}
          className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
        >
          Add {Object.keys(selected).length > 0 ? `(${Object.keys(selected).length})` : ""} to Collection
        </button>
        <button
          onClick={onCancel}
          className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
        >
          Cancel
        </button>
      </PinnedFooter>
    </div>
  );
}

/**
 * Add to Collection — resolve an item's collectable elements to items in a
 * target collection's context, and pick which to add.
 *
 * Step 6 is read-only: it resolves, displays and lets the user adjust, but
 * writes nothing. The footer is inert.
 *
 * Measured on the real corpus, 55% of rows resolve to nothing and must create a
 * new item, so create-new is the common path and costs exactly one tap: the row
 * checkbox itself commits to it. There is no dialog and no detour. Rows that
 * failed to match but have plausible alternatives show them as chips, each of
 * which retargets and checks the row in one tap — that is what stops the
 * Shopping context growing "Salt", "kosher salt" and "Sea salt" separately.
 */
function ItemAddToCollection({ item, items, collections, contexts, onBack, onAdd }) {
  const available = useMemo(
    () => (collections || []).filter((c) => !c.archived),
    [collections],
  );

  // Preselect: the item context's default collection, then a capture target in
  // that context, then any capture target, then the first collection.
  //
  // The third rule is not in the spec. Without it the driving case never fires:
  // Groceries is the capture target but lives in Shopping, while recipes live
  // in Recipes, so rule two cannot match and an arbitrary "first collection"
  // wins. Preferring a capture target anywhere over an arbitrary one is
  // strictly better; flagged for review.
  const defaultCollectionId = useMemo(() => {
    const ctx = (contexts || []).find((c) => c.id === item.contextId);
    const pinned =
      ctx && ctx.defaultCollectionId
        ? available.find((c) => c.id === ctx.defaultCollectionId)
        : null;
    if (pinned) return pinned.id;
    const captureHere = available.find(
      (c) => c.isCaptureTarget && c.contextId === item.contextId,
    );
    if (captureHere) return captureHere.id;
    const captureAnywhere = available.find((c) => c.isCaptureTarget);
    if (captureAnywhere) return captureAnywhere.id;
    return available[0] ? available[0].id : "";
  }, [available, contexts, item.contextId]);

  const [collectionId, setCollectionId] = useState(defaultCollectionId);
  const [overrides, setOverrides] = useState({});
  const [pickerRow, setPickerRow] = useState(null);
  const [pickerSearch, setPickerSearch] = useState("");

  const collection = available.find((c) => c.id === collectionId) || null;
  const targetContextId = collection ? collection.contextId ?? null : null;

  // Targets are context-specific, so a change of collection invalidates every
  // resolved row. Reset rather than carry stale targets across.
  useEffect(() => {
    setOverrides({});
  }, [collectionId]);

  /**
   * Resolve once per (item, collection). Ordering is computed here and frozen:
   * unmatched first, then matched in recipe order. It deliberately does not
   * depend on `overrides`, because re-sorting as the user accepts a suggestion
   * would move rows out from under a thumb mid-tap.
   */
  const rows = useMemo(() => {
    const elements = Array.isArray(item.elements) ? item.elements : [];
    const typeOf = (el) => el.displayType || el.display_type || "step";
    // Carry the index into item.elements, not into the filtered list: Step 7
    // stamps collectable/collectableItemId back onto the original array.
    const indexed = elements.map((el, idx) => ({ el, idx }));
    const flagged = indexed.filter(({ el }) => el.collectable === true);
    // Fallback: an un-annotated item still works, on its bullets.
    const source = flagged.length
      ? flagged
      : indexed.filter(({ el }) => typeOf(el) === "bullet");

    const resolved = source.map(({ el, idx }) => {
      const text = el.name || "";
      const { quantity, product } = parseIngredient(text);
      const pinnedId = el.collectableItemId || el.collectable_item_id || null;
      // Already resolved on a previous visit: skip matching entirely.
      const pinned = pinnedId
        ? (items || []).find((i) => i.id === pinnedId && !i.archived)
        : null;
      const match =
        pinned ||
        matchProduct(product, items || [], { contextId: targetContextId });
      const near = match
        ? []
        : findNearMisses(product, items || [], { contextId: targetContextId });
      return { key: `${idx}-${text}`, elementIndex: idx, text, quantity, product, match, near };
    });

    const unmatched = resolved.filter((r) => !r.match);
    const matched = resolved.filter((r) => r.match);
    return [...unmatched, ...matched];
  }, [item.elements, items, targetContextId]);

  const stateFor = (row) => {
    const o = overrides[row.key] || {};
    return {
      checked: o.checked === true,
      quantity: o.quantity !== undefined ? o.quantity : row.quantity,
      targetId:
        o.targetId !== undefined ? o.targetId : row.match ? row.match.id : null,
    };
  };

  const patch = (key, next) =>
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));

  const selectedCount = rows.filter((r) => stateFor(r).checked).length;

  const [busy, setBusy] = useState(false);

  // "Existing" means the row currently resolves to an item that already lives
  // in the target context — either matched automatically or via an accepted
  // suggestion. Deliberately NOT create-new rows: each of those mints a new
  // item in the catalogue, and fifteen uninspected new items in one tap is how
  // a shopping catalogue fills with junk. Creating stays one deliberate tap.
  const existingRows = rows.filter((r) => stateFor(r).targetId);
  const allExistingSelected =
    existingRows.length > 0 && existingRows.every((r) => stateFor(r).checked);

  function selectExisting() {
    const keys = existingRows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: true };
      return next;
    });
  }

  function clearSelection() {
    const keys = rows.map((r) => r.key);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = { ...next[k], checked: false };
      return next;
    });
  }

  async function handleAdd() {
    if (busy || !collection) return;
    const picks = rows
      .filter((r) => stateFor(r).checked)
      .map((r) => {
        const st = stateFor(r);
        return {
          elementIndex: r.elementIndex,
          targetItemId: st.targetId,
          productName: r.product,
          quantity: st.quantity,
        };
      });
    if (picks.length === 0) return;
    setBusy(true);
    const ok = await onAdd(collection.id, picks);
    setBusy(false);
    // Stay put on failure so the selection is not lost.
    if (ok) onBack();
  }

  const pickerRowData = pickerRow ? rows.find((r) => r.key === pickerRow) : null;
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <h2 className="text-lg sm:text-xl font-medium text-foreground mb-1">
        Add to Collection
      </h2>
      <p className="text-sm text-muted-foreground mb-3">{item.name}</p>

      {available.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">
          No collections yet. Create one first.
        </p>
      ) : (
        <>
          <label className="block text-sm font-medium text-foreground mb-1">
            Collection
          </label>
          <select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            className="w-full px-3 py-2 min-h-[44px] border border-border rounded-lg text-base mb-3"
          >
            {available.map((c) => {
              const ctx = (contexts || []).find((x) => x.id === c.contextId);
              return (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {ctx ? ` — ${ctx.name}` : ""}
                </option>
              );
            })}
          </select>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              Nothing to add — this item has no collectable elements and no
              bullets.
            </p>
          ) : (
            <>
            {/* Select-all covers only rows that already resolve to an existing
                item. A create-new row mints a new catalogue entry, so it stays
                one deliberate tap. The label carries the count and the word
                "existing" for exactly that reason: a plain "Select all" here
                would claim to do something it deliberately does not. */}
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm text-muted-foreground">
                {selectedCount} of {rows.length} selected
              </span>
              {existingRows.length > 0 && (
                <button
                  onClick={allExistingSelected ? clearSelection : selectExisting}
                  className="px-3 py-2 min-h-[44px] shrink-0 rounded-lg border border-border text-sm text-primary hover:border-primary"
                >
                  {allExistingSelected
                    ? "Select none"
                    : `Select ${existingRows.length} existing`}
                </button>
              )}
            </div>
            {existingRows.length < rows.length && (
              <p className="text-xs text-muted-foreground mb-2">
                Rows that create a new item are not included — tap those
                individually.
              </p>
            )}

            {/* No interior scroll. An inner scroller nested in the page
                scroller is unusable on a phone — a 32-row recipe in a
                half-screen box is the case that breaks it. The page scrolls
                once and the sticky footer now genuinely engages, which is
                what it was always there for. */}
            <div className="space-y-2 mb-4">
              {rows.map((row) => {
                const st = stateFor(row);
                const target = st.targetId
                  ? (items || []).find((i) => i.id === st.targetId)
                  : null;
                return (
                  <div
                    key={row.key}
                    onClick={() => patch(row.key, { checked: !st.checked })}
                    className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${
                      st.checked
                        ? "border-primary bg-background"
                        : "border-border bg-white hover:border-primary"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={st.checked}
                      readOnly
                      className="mt-1 rounded accent-primary pointer-events-none shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground break-words">
                        {row.text}
                      </p>

                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPickerSearch("");
                            setPickerRow(row.key);
                          }}
                          className={`flex-1 min-w-0 text-left truncate px-2 py-2 min-h-[44px] rounded text-sm ${
                            target
                              ? "border border-border text-foreground"
                              : "border-2 border-dashed border-primary text-primary"
                          }`}
                        >
                          {target ? (
                            <span className="truncate">{target.name}</span>
                          ) : (
                            <span className="truncate">
                              Create &quot;{row.product}&quot;
                            </span>
                          )}
                        </button>
                        <input
                          type="text"
                          value={st.quantity}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            e.stopPropagation();
                            patch(row.key, { quantity: e.target.value });
                          }}
                          placeholder="Qty"
                          className="w-20 sm:w-24 shrink-0 px-2 py-2 min-h-[44px] border border-border rounded text-base"
                        />
                      </div>

                      {!target && row.near.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-2">
                          <span className="text-xs text-muted-foreground">
                            or use
                          </span>
                          {row.near.map((n) => (
                            <button
                              key={n.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                patch(row.key, { targetId: n.id, checked: true });
                              }}
                              className="px-2 py-1 min-h-[32px] rounded-full border border-border bg-secondary text-xs text-foreground hover:border-primary"
                            >
                              {n.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </>
          )}

          {/* Same offsets as CollectionAddItems. Now that the list no longer
              scrolls internally this genuinely engages on a long recipe. */}
          <PinnedFooter className="bg-background">
            <button
              onClick={handleAdd}
              disabled={busy || selectedCount === 0 || !collection}
              className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-50 text-sm"
            >
              {busy
                ? "Adding..."
                : `Add ${selectedCount > 0 ? `(${selectedCount})` : ""} to Collection`}
            </button>
            <button
              onClick={onBack}
              className="px-4 py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
            >
              Cancel
            </button>
          </PinnedFooter>
        </>
      )}

      {pickerRowData && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setPickerRow(null)}
        >
          <div
            className="bg-card p-4 sm:p-6 rounded-lg max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-medium text-foreground">Change target</h3>
              <button
                onClick={() => setPickerRow(null)}
                aria-label="Close"
                className="flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-muted-foreground mb-3 break-words">
              {pickerRowData.text}
            </p>

            <button
              onClick={() => {
                patch(pickerRowData.key, { targetId: null, checked: true });
                setPickerRow(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 min-h-[44px] mb-3 border-2 border-dashed border-primary rounded-lg text-primary text-sm"
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">
                Create &quot;{pickerRowData.product}&quot;
              </span>
            </button>

            {/* No context name on rows: every candidate is already in the
                target collection's context. */}
            <ItemPicker
              variant="popup"
              items={items}
              showContext={false}
              exclude={(i) => targetContextId != null && i.contextId !== targetContextId}
              query={pickerSearch}
              onQueryChange={setPickerSearch}
              onPick={(cand) => {
                patch(pickerRowData.key, { targetId: cand.id, checked: true });
                setPickerRow(null);
              }}
              placeholder="Search items..."
              autoFocus
            />
          </div>
        </div>
      )}
    </div>
  );
}


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

  async function handleCapture() {
    if (!captureText.trim()) return;
    return withLoading('Saving...', async () => {
      const inboxItem = {
        id: uid(),
        user_id: user.id,
        capturedText: captureText.trim(),
        createdAt: new Date().toISOString(),
        archived: false,
        triagedAt: null,
        suggestedContextId: null,
        suggestItem: false,
        suggestedItemText: null,
        suggestedItemDescription: null,
        suggestedItemElements: null,
        suggestIntent: false,
        suggestedIntentText: null,
        suggestedIntentDescription: null,
        suggestedIntentRecurrence: null,
        suggestEvent: false,
        suggestedEventDate: null,
        // NEW fields from Phase 7.2.1
        aiStatus: 'not_started',
        sourceType: 'manual',
        sourceMetadata: {},
        aiConfidence: null,
        aiReasoning: null,
        suggestedTags: [],
        suggestedItemId: null,
        suggestedCollectionId: null,
      };

      const savedCapture = await storage.set(`inbox:${inboxItem.id}`, inboxItem);
      // The saved row, not the one we built — see storage.set. Ours has no
      // `updatedAt`, which sorts a brand-new capture last under "Last modified"
      // and renders it with no timestamp line at all.
      setAllInboxItems((prev) => [...prev, savedCapture || inboxItem]); // Add to end (oldest first)
      setCaptureText("");
      if (captureRef.current) {
        captureRef.current.style.height = "auto";
      }
      setView("inbox");
    });
  }

  /**
   * Discard a capture from the inbox screen — Clipboard Step 5b.
   *
   * ⚠️ THIS ARCHIVES. IT USED TO HARD-DELETE, AND THE CHANGE FIXED A BUG RATHER
   * THAN EXPRESSING A PREFERENCE.
   *
   * The old rule was "a capture that does not make it through the inbox never
   * happened", so the row was deleted and `platform.audit_log` was the surviving
   * copy. That worked while an inbox row was the whole capture.
   *
   * A clip is TWO rows. `public.clips` holds the page text and the screenshot
   * slices; the inbox row is a lightweight pointer at it. Deleting the pointer
   * left the clip, and `get_recent_clips` decides "already handled" by reading
   * the paired inbox row — so a clip whose inbox row had been deleted looked
   * LIVE and came back to every new conversation, permanently. Binning a clip
   * was the one action that could not make it go away.
   *
   * So the row now stays, flagged: archived, stamped, and carrying WHY
   * ('discarded' — as against 'processed', which is what archive_inbox_item
   * writes when Claude has dealt with something). See spec decision 14 and
   * migration 066.
   *
   * Human triage through the process/save flow (`handleInboxSave`) is NOT
   * changed here and still deletes on success. Phase 3's one-tap process button
   * is where that becomes an archive with 'processed'.
   */
  async function discardInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Discarding...', async () => {
      const discarded = {
        ...inboxItem,
        archived: true,
        triagedAt: new Date().toISOString(),
        archiveReason: 'discarded',
      };
      const saved = await storage.set(`inbox:${inboxItem.id}`, discarded);
      // storage.set swallows its own errors and returns false. Dropping the row
      // from the list after a failed write would hide a capture that is still
      // sitting in the inbox, and it would come back on the next refresh.
      if (!saved) {
        window.alert("Could not discard that capture. It is still in your inbox.");
        return;
      }
      // The row STAYS in state and its `archived` flag flips — Step 22. It used to be
      // filtered out of the array, which was the same thing while state held the live
      // inbox only; now the live list is derived, so removing the row here would drop it
      // from "Recently archived" too and the discard would look like a delete.
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || discarded : i)),
      );

      // A binned capture's reminders would fire for something no longer on screen.
      try {
        await cancelRemindersForDiscard(inboxItem.id);
      } catch (err) {
        console.error("[Reminders] cancel on discard failed:", err);
        window.alert("Discarded, but its reminder could not be cancelled and may still fire.");
      }
      refreshReminderIndex();

      // The undo writes the ORIGINAL row back, which restores archived,
      // triagedAt and archiveReason to whatever they were — all three together,
      // as inbox_archive_reason_needs_archived requires. `storage.set` UPDATEs
      // by id, so this is a plain field reversal now rather than the
      // re-insert-a-deleted-row trick it used to be.
      offerUndoFor("Capture discarded.", async () => {
        const restored = await storage.set(`inbox:${inboxItem.id}`, inboxItem);
        setAllInboxItems((prev) =>
          prev.map((i) => (i.id === inboxItemId ? restored || inboxItem : i)),
        );
        await restoreDiscardedReminders(inboxItem.id);
      });
    });
  }

  // Undo and Put back of a discard: re-arm the reminders it cancelled that are still ahead.
  async function restoreDiscardedReminders(inboxId) {
    try {
      await restoreRemindersAfterDiscard(inboxId);
    } catch (err) {
      console.error("[Reminders] restore after discard failed:", err);
      window.alert("The capture is back, but its reminder could not be restored.");
    }
    refreshReminderIndex();
  }

  /**
   * Edit a capture's text without triaging it — Step 12.7.
   *
   * NOT triage. Step 10's disposal rule deletes a capture on successful triage;
   * this one stays, with `triagedAt` still null. The row is spread rather than
   * rebuilt so every other column, that one included, is carried through
   * untouched.
   *
   * No MCP schema is involved: `update_inbox_item` writes the `ai_*` and
   * `suggested_*` fields, and this writes `captured_text`, a different column.
   * The tool schemas are frozen and stay frozen.
   *
   * ── The enrichment decision ──────────────────────────────────────────────
   *
   * Editing the text INVALIDATES any existing enrichment, so this clears
   * `aiStatus` back to `not_started` **and nulls the suggested_* fields with
   * it**. Clearing the status alone would not be enough, and that is the whole
   * argument: the inbox detail page seeds its triage fields
   * `suggestedIntentText || capturedText`, so a stale suggestion is not merely a
   * stale column — it is what the triage form PROPOSES. Leaving it would mean a
   * user who corrected a capture still gets offered the text they corrected.
   *
   * The cost is a good enrichment lost to a typo fix. It used to be mitigated by
   * a re-enrich button one tap away in this card; Clipboard Step 14 removed
   * that, so re-enriching now means asking in claude.ai. The clear still only
   * happens when the text ACTUALLY changed, which keeps it rare, and offering
   * the text a user just corrected would be worse than making them ask again.
   *
   * If this decision is overturned, this function is the only place to change.
   */
  async function updateInboxCaptureText(inboxItemId, capturedText) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return false;

    const text = (capturedText || "").trim();
    if (!text) {
      window.alert("A capture needs some text.");
      return false;
    }

    const textChanged = text !== inboxItem.capturedText;

    return withLoading("Saving...", async () => {
      const updated = {
        ...inboxItem,
        capturedText: text,
        ...(textChanged ? CLEARED_ENRICHMENT : {}),
      };

      const saved = await storage.set(`inbox:${inboxItem.id}`, updated);
      if (saved === false) {
        window.alert("Could not save that edit. The capture is unchanged.");
        return false;
      }

      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || updated : i)),
      );
      return true;
    });
  }

  /**
   * File an enriched capture in one tap, from the list — Clipboard Step 21.
   *
   * ⚠️ IT GOES THROUGH `handleInboxSave`, and that is the whole design. The detail
   * page's Process calls the same function with the same shape, so one tap archives
   * with reason 'processed' and stamps `source_inbox_id` exactly as the careful path
   * does. `triageDataForOneTap` is tested against what the page actually emits, so
   * "one tap" cannot quietly come to mean something else.
   *
   * No confirmation. It is reversible in the sense that matters — the capture is
   * archived rather than deleted, and what it created is an ordinary item or
   * intention — and the button only appears where Claude has already proposed
   * something, which is the judgement a confirm would be asking about.
   */
  async function processInboxItemFromList(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return handleInboxSave(inboxItemId, triageDataForOneTap(inboxItem));
  }

  /**
   * Copy a task capture's text, with its id, for a Claude session — Step 21.
   *
   * The trailing `Alfred inbox item: <id>` line is the point: pasting the text alone
   * would leave that session with no way to archive the row afterwards.
   *
   * `navigator.clipboard` needs a secure context and can be refused, so the failure is
   * reported rather than swallowed — a Copy button that silently did nothing would be
   * indistinguishable from one that worked.
   */
  async function copyTaskInboxItem(inboxItemId) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    const text = copyTextForTask(inboxItem);
    try {
      await navigator.clipboard.writeText(text);
      offerUndoFor("Copied, with this item's id.", null);
    } catch (e) {
      window.alert(
        "Could not reach the clipboard, so nothing was copied. This usually means the " +
          "browser refused permission or the page is not on https.",
      );
    }
  }

  async function handleInboxSave(inboxItemId, triageData) {
    const inboxItem = inboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;
    return withLoading('Saving...', async () => {
      let createdItemId = null;

      // "Delete only on success" needs an explicit check, because none of the
      // writers below throw. `storage.set` catches its own errors and returns
      // false; `addItemsToCollection` alerts and returns false. Nothing read
      // either until now, which was survivable while disposal merely set a
      // flag — the row stayed in the table and could be recovered. A hard
      // delete on a failed triage would destroy the capture AND leave nothing
      // downstream to show for it.
      let allWritesSucceeded = true;
      // Returns the result unchanged rather than a boolean, so a caller can
      // both record the failure and use the saved row — `storage.set` returns
      // the row it wrote as of Step 12.3. `false` is still the only falsy
      // result, which is what the check above and the `saved || local`
      // fallbacks below both rely on.
      const wrote = (result) => {
        if (result === false) allWritesSucceeded = false;
        return result;
      };

      // Create item if Item section was open
      if (triageData.createItem && triageData.itemData) {
        const newItem = {
          id: uid(),
          user_id: user.id,
          name: triageData.itemData.name,
          description: triageData.itemData.description || "",
          contextId: triageData.itemData.contextId,
          elements: triageData.itemData.elements || [],
          tags: triageData.itemData.tags || [],
          isCaptureTarget: false,
          createdAt: new Date().toISOString(),
          // Where this came from — Clipboard Step 14. Only meaningful because
          // the inbox row below is now archived rather than deleted; the FK is
          // ON DELETE SET NULL, so a deleted capture would take the link with it.
          sourceInboxId: inboxItem.id,
        };

        const context = contexts.find((c) => c.id === newItem.contextId);
        const isShared = context?.shared || false;
        const savedItem = wrote(await storage.set(`item:${newItem.id}`, newItem, isShared));
        setItems((prev) => [...prev, savedItem || newItem]);
        createdItemId = newItem.id;

        // "Attach this Item" — appending the new item as a bullet element of an
        // existing one — used to happen here, driven by `triageData.itemItemLinks`.
        // Alex dropped the control in Step 17b and Step 18 deleted the form that
        // was its only source, so nothing could reach this branch again. Removed
        // rather than left looking live.
      }

      // Create intention if Intention section was open
      if (triageData.createIntention && triageData.intentionData) {
        // The row itself is built by a pure function in utils/intentionRows.js, so
        // that the mapping — `description` in particular — is reachable by a test.
        // It was not, which is why "is Details being saved?" could only be
        // answered by reading code. See that file's header.
        const newIntent = intentionRowFromTriage({
          id: uid(),
          userId: user.id,
          intentionData: triageData.intentionData,
          createdItemId,
          sourceInboxId: inboxItem.id,
          createdAt: new Date().toISOString(),
        });
        // Read back off the row rather than recomputed, so the event below and the
        // intention cannot disagree about which item this is.
        const intentionItemId = newIntent.itemId;
        const savedIntent = wrote(await storage.set(`intent:${newIntent.id}`, newIntent));
        setIntents((prev) => [...prev, savedIntent || newIntent]);

        // The capture's reminders follow it to the intention. Not a triage failure if
        // this fails: they stay on the archived capture and still fire.
        if (savedIntent) {
          try {
            await moveRemindersToIntention(inboxItem.id, newIntent.id);
          } catch (err) {
            console.error("[Reminders] move to intention failed:", err);
            window.alert("Saved, but this capture's reminder could not be moved to the new intention. It will still fire, and opens the capture.");
          }
          refreshReminderIndex();
        }

        // Create event if scheduled
        if (triageData.intentionData.createEvent && triageData.intentionData.eventDate) {
          const newEvent = {
            id: uid(),
            user_id: user.id,
            intentId: newIntent.id,
            contextId: triageData.intentionData.contextId,
            time: triageData.intentionData.eventDate,
            itemIds: intentionItemId ? [intentionItemId] : [],
            archived: false,
            createdAt: new Date().toISOString(),
            text: triageData.intentionData.text,
            // Redundant with the intention's, which carries the same value. Kept
            // so an event reached from the calendar answers "where did this come
            // from" without a join back through intents.
            sourceInboxId: inboxItem.id,
          };
          const savedEvent = wrote(await storage.set(`event:${newEvent.id}`, newEvent));
          setEvents((prev) => [...prev, savedEvent || newEvent]);
        }
      }

      // Add to collection if Collection section was open.
      //
      // ⚠️ DORMANT, NOT DEAD. The inbox detail page always sends
      // `addToCollection: false`, because the approved design hides collections
      // "for now" — docs/inbox-detail-mockups/README.md. This is kept, unlike the
      // itemItemLinks branch above, precisely because that "for now" is a plan and
      // not a removal: when the section comes back it sends the same shape and this
      // works unchanged.
      if (triageData.addToCollection && triageData.collectionData) {
        const targetItemId = triageData.collectionData.itemId || createdItemId;
        const targetCollectionId = triageData.collectionData.collectionId;
        if (targetItemId && targetCollectionId) {
          wrote(
            await addItemsToCollection(targetCollectionId, [
              {
                itemId: targetItemId,
                quantity: triageData.collectionData.quantity || '1',
              },
            ]),
          );
        }
      }

      // On failure the row stays put. Partial success is possible — the item
      // may have been created and the intention not — so this says "check what
      // was created" rather than "try again", which could duplicate the half
      // that worked.
      if (!allWritesSucceeded) {
        window.alert(
          "Some of that capture could not be saved, so it has been left in your inbox. Check what was created before filing it again.",
        );
        return;
      }

      // -------------------------------------------------------------------
      // TRIAGE ARCHIVES. IT USED TO DELETE — Clipboard Step 14.
      // -------------------------------------------------------------------
      //
      // The capture has become an item, an intention, an event or a collection
      // member, so it has no further job ON THE INBOX SCREEN. It does still have
      // a job: the records above now carry `sourceInboxId` pointing back here,
      // and the FK is ON DELETE SET NULL, so deleting this row would silently
      // cut every one of those links a moment after they were written.
      //
      // That is why the archive and the links are ONE change. Either half alone
      // is useless or actively misleading: links to a row that is about to
      // vanish, or an archived row nothing points at.
      //
      // This was the LAST hard delete on the inbox — Step 5b turned the trash
      // can into an archive with reason 'discarded' and deliberately left this
      // path alone until there was a reason to keep the row. Now there is.
      //
      // Still no Undo, and for the unchanged reason: undo would un-archive the
      // capture but could not remove the records it turned into, so it would
      // restore something already filed. A button labelled Undo that half-undoes
      // is worse than none. Discard has no such problem, which is why it offers
      // one.
      const processed = {
        ...inboxItem,
        archived: true,
        triagedAt: new Date().toISOString(),
        archiveReason: 'processed',
      };
      const disposed = await storage.set(`inbox:${inboxItem.id}`, processed);
      if (disposed === false) {
        window.alert(
          "Everything was saved, but the capture could not be filed away. It is still in your inbox — archive it by hand, and do not save it again or you will get a second copy of everything.",
        );
        return;
      }
      // Flips the flag rather than dropping the row — Step 22, same change as in
      // `discardInboxItem` and for the same reason: the live list is derived now, and
      // "Recently archived" is what this capture goes on to appear in.
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? disposed || processed : i)),
      );
      // An item filed from this capture shows the capture's reminder on its card.
      refreshReminderIndex();
    });
  }

  /**
   * Put an archived capture back in the inbox — Clipboard Step 22.
   *
   * All three archive fields move TOGETHER, because the database requires it:
   * `inbox_archive_reason_needs_archived` (migration 066) forbids a reason on a row that
   * is not archived, so clearing `archived` without clearing `archive_reason` is a
   * constraint violation rather than a partial success.
   *
   * ⚠️ IT CANNOT UNDO A PROCESSING, only the archiving. `handleInboxSave` says why it
   * offers no Undo of its own: the capture became an item, an intention or an event, and
   * putting the capture back does not remove any of them. That has not changed — what
   * changed is that the button is now asked for on every row, so instead of pretending,
   * it WARNS: `undoNeedsConfirming` is true for a processed row and `undoWarning` names
   * what is already out there. A discarded capture created nothing, so it just goes back
   * with no question.
   */
  async function unarchiveInboxItem(inboxItemId) {
    const inboxItem = allInboxItems.find((i) => i.id === inboxItemId);
    if (!inboxItem) return;

    const records = { items, intents, events };
    if (
      undoNeedsConfirming(inboxItem, records) &&
      !window.confirm(undoWarning(inboxItem, records))
    ) {
      return;
    }

    return withLoading("Putting it back...", async () => {
      const restored = {
        ...inboxItem,
        archived: false,
        triagedAt: null,
        archiveReason: null,
      };
      const saved = await storage.set(`inbox:${inboxItem.id}`, restored);
      // `storage.set` swallows its own errors and returns false. Showing the row back in
      // the inbox after a failed write would be a lie that survives until the next
      // refresh — which is exactly when it would disappear again, with no explanation.
      if (saved === false) {
        window.alert("Could not put that capture back. It is still archived.");
        return;
      }
      setAllInboxItems((prev) =>
        prev.map((i) => (i.id === inboxItemId ? saved || restored : i)),
      );
      // Only a discard cancelled anything; a processed capture's reminders never stopped.
      if (inboxItem.archiveReason === "discarded") {
        await restoreDiscardedReminders(inboxItem.id);
      }
    });
  }

  async function moveToPlanner(intentId, scheduledDate = "today") {
    return withLoading('Scheduling...', async () => {
      // Always read from storage first to get the latest data
      // (state may be stale if updateIntent was just called)
      let intent = await storage.get(`intent:${intentId}`);
      if (!intent) {
        intent = intents.find((i) => i.id === intentId);
      }

      if (!intent) {
        console.error("Intent not found:", intentId);
        return;
      }

      const eventDate = scheduledDate === "today" ? getTodayDate() : scheduledDate;

      // Create event for this intent
      const event = {
        id: uid(),
        user_id: user.id,
        intentId,
        time: eventDate,
        itemIds: intent.itemId ? [intent.itemId] : [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };

      const savedEvent = await storage.set(`event:${event.id}`, event);
      setEvents([...events, savedEvent || event]);

      // No navigation. This used to end by switching the view to the schedule
      // whenever the date was today, which is what made "Do Today" throw you
      // off whatever list you were working through. The message below is how
      // you now know it worked, and it names the date so scheduling for today
      // and scheduling for a Tuesday give the same feedback.
      //
      // (No literal call syntax in this comment — the navigation call sites are
      // counted by grep at every step of the routing work, and a comment would
      // inflate the count. Same convention as the bridge comment at the top.)
      //
      // Every caller loses the jump, not just the two surfaces Step 6 touches:
      // the add-intention forms on Intentions, Context detail and Item detail
      // all funnelled through here too. Staying put is right for all of them.
      //
      // Undo deletes rather than archives — the event was created seconds ago
      // and never seen, so an archived ghost in the recycle bin would be a
      // record of something that never happened. Same reasoning as the
      // recurrence successor in Step 2.
      offerUndoFor(`Scheduled for ${formatEventDate(eventDate)}.`, async () => {
        await storage.delete(`event:${event.id}`);
        setEvents((prev) => prev.filter((e) => e.id !== event.id));
      });
    });
  }

  async function updateIntent(intentId, updates, scheduledDate) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Saving...', async () => {
      // The whitelist lives in utils/intentionRows.js, under test. It was inline
      // here, and `description` was missing from it — which made Details silently
      // unwritable from the edit screen: typed, "saved", and gone, with no error.
      // A list like this fails invisibly once per new column, so it is somewhere a
      // test can reach.
      const updated = intentionUpdateRow(intent, updates);

      const savedIntent = await storage.set(`intent:${intent.id}`, updated);
      setIntents(intents.map((i) => (i.id === intentId ? savedIntent || updated : i)));

      // If scheduledDate provided, create an event
      if (scheduledDate) {
        await moveToPlanner(intentId, scheduledDate);
      }
    });
  }

  async function archiveIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Archiving...', async () => {
      const archivedIntent = { ...intent, archived: true };
      await storage.set(`intent:${intentId}`, archivedIntent);
      setIntents(intents.map((i) => (i.id === intentId ? archivedIntent : i)));

      // Archive all related events
      const relatedEvents = events.filter((e) => e.intentId === intentId && !e.archived);
      for (const event of relatedEvents) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents((prev) => prev.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Archiving an intention cascades to its events, so undoing it has to as
      // well — restoring the intention alone would leave its schedule silently
      // archived. `relatedEvents` holds only the ones this call actually
      // touched, so an event archived earlier stays archived.
      offerUndoFor(`Archived "${intent.text || "intention"}".`, async () => {
        await storage.set(`intent:${intentId}`, intent);
        setIntents((prev) => prev.map((i) => (i.id === intentId ? intent : i)));
        for (const event of relatedEvents) {
          await storage.set(`event:${event.id}`, event);
          setEvents((prev) => prev.map((e) => (e.id === event.id ? event : e)));
        }
      });

      // Only the detail page has to leave: it is showing the record that just
      // got archived, so staying would render an archived intention. A list row
      // simply disappears from its own list, and yanking the user to another
      // screen for that was the defect.
      //
      // `view` is derived from the URL, so this reads the screen the click
      // actually came from. The return address is `intentionReturnView` — the
      // slot `viewIntentionDetail` wrote on the way in — not the globally
      // shared `previousView`, which any intervening navigation can clobber.
      if (view === "intention-detail") {
        setSelectedIntentionId(null);
        setView(intentionReturnView);
      }
    });
  }

  async function updateItem(itemId, updates) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading('Saving...', async () => {
      const updated = {
        id: item.id,
        userId: item.userId,
        name: updates.name !== undefined ? updates.name : item.name,
        description:
          updates.description !== undefined
            ? updates.description
            : item.description || "",
        contextId:
          updates.contextId !== undefined ? updates.contextId : item.contextId,
        elements:
          updates.elements !== undefined
            ? updates.elements
            : item.elements || item.components || [],
        tags:
          updates.tags !== undefined ? updates.tags : item.tags || [],
        isCaptureTarget:
          updates.isCaptureTarget !== undefined
            ? updates.isCaptureTarget
            : item.isCaptureTarget || false,
        archived:
          updates.archived !== undefined
            ? updates.archived
            : item.archived || false,
        createdAt: item.createdAt,
      };

      const context = contexts.find((c) => c.id === updated.contextId);
      const isShared = context?.shared || false;

      const savedItem = await storage.set(`item:${item.id}`, updated, isShared);
      setItems(items.map((i) => (i.id === itemId ? savedItem || updated : i)));

      // `item` is the pre-archive snapshot, so restoring is a straight rewrite
      // rather than a flag flip — it also puts back anything the archiving edit
      // happened to change alongside `archived`.
      if (updates.archived === true) {
        offerUndoFor(`Archived "${item.name}".`, async () => {
          await storage.set(`item:${item.id}`, item, isShared);
          setItems((prev) => prev.map((i) => (i.id === itemId ? item : i)));
        });
      }
    });
  }

  async function deepCloneItem(sourceItemId, newName) {
    const source = items.find((i) => i.id === sourceItemId);
    if (!source) return null;
    return withLoading('Cloning...', async () => {
      const clonedIds = new Map(); // sourceId -> cloneId
      const newItems = [];

      // Recursively clone item and its children
      async function cloneRecursive(itemId, visited = new Set()) {
        if (visited.has(itemId) || clonedIds.has(itemId)) return clonedIds.get(itemId);
        visited.add(itemId);

        const item = items.find((i) => i.id === itemId);
        if (!item) return null;

        const cloneId = uid();
        clonedIds.set(itemId, cloneId);

        // Clone child references first
        const clonedElements = [];
        for (const el of (item.elements || [])) {
          const elItemId = el.itemId || el.item_id;
          if (elItemId) {
            const childCloneId = await cloneRecursive(elItemId, new Set(visited));
            clonedElements.push({ ...el, itemId: childCloneId || elItemId });
          } else {
            clonedElements.push({ ...el });
          }
        }

        const cloned = {
          id: cloneId,
          userId: user.id,
          name: itemId === sourceItemId ? newName : item.name,
          description: item.description || "",
          contextId: item.contextId || null,
          elements: clonedElements,
          tags: [...(item.tags || [])],
          isCaptureTarget: false,
          archived: false,
          createdAt: new Date().toISOString(),
        };

        const savedClone = await storage.set(`item:${cloneId}`, cloned);
        newItems.push(savedClone || cloned);
        return cloneId;
      }

      await cloneRecursive(sourceItemId);
      setItems((prev) => [...prev, ...newItems]);
      return newItems.find((i) => i.id === clonedIds.get(sourceItemId));
    });
  }

  async function updateEvent(eventId, updates) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Saving...', async () => {
      const updated = { ...event, ...updates };
      const savedEvent = await storage.set(`event:${event.id}`, updated);
      setEvents(events.map((e) => (e.id === eventId ? savedEvent || updated : e)));

      // If archiving a recurring event, trigger recurrence to create next event
      let successor = null;
      if (updates.archived === true && event.intentId) {
        successor = await triggerRecurrence(event.intentId, event);
      }

      if (updates.archived === true) {
        const intent = intents.find((i) => i.id === event.intentId);
        const label = event.text || intent?.text || "event";
        offerUndoFor(`Archived "${label}".`, async () => {
          await storage.set(`event:${event.id}`, event);
          setEvents((prev) => prev.map((e) => (e.id === eventId ? event : e)));
          // The successor only exists because of the archive being undone, so
          // it goes with it. Deleting rather than archiving: it was never a
          // real event the user saw, and an archived ghost would surface in the
          // recycle bin as something they never scheduled.
          if (successor) {
            await storage.delete(`event:${successor.id}`);
            setEvents((prev) => prev.filter((e) => e.id !== successor.id));
          }
        });
      }
    });
  }

  async function activate(eventId) {
    const event = events.find((e) => e.id === eventId);
    if (!event) return;
    return withLoading('Starting execution...', async () => {
      // Collection-based execution
      if (event.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId,
          intentId: event.intentId,
          contextId: event.contextId,
          collectionId: event.collectionId,
          itemIds: [],
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Item-based execution
      const itemElements = [];
      const getItem = (id) => items.find((i) => i.id === id) || null;
      if (event.itemIds && event.itemIds.length > 0) {
        for (const itemId of event.itemIds) {
          const item = items.find((i) => i.id === itemId);
          if (item && (item.elements || item.components)) {
            const rawEls = (item.elements || item.components).map((el) =>
              typeof el === "string"
                ? { name: el, displayType: "step", quantity: "", description: "" }
                : { ...el }
            );
            const flattened = await flattenElements(rawEls, getItem);
            const els = flattened.map((el) => ({
              ...el,
              isCompleted: false,
              completedAt: null,
              inProgress: false,
              startedAt: null,
              sourceItemId: el.sourceItemId || itemId,
            }));
            itemElements.push(...els);
          }
        }
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId,
        intentId: event.intentId,
        contextId: event.contextId,
        itemIds: event.itemIds,
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  /**
   * Creates the next recurring event for an intent after an event is archived.
   * Shared by closeExecution (completion) and manual event archive (skip).
   */
  // Returns the successor event it created, or null when it created none — so
  // an undo of the archive that triggered it can take that successor back out.
  // Without this, undoing left the successor behind and the intention ended up
  // with two live events.
  async function triggerRecurrence(intentId, archivedEvent) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return null;

    const config = getRecurrenceConfig(intent);
    if (config.type === "once") return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextDate = calculateNextEventDate(config, today);

    if (nextDate && (!intent.endDate || nextDate <= new Date(intent.endDate + "T23:59:59"))) {
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        // Local fields, not toISOString: calculateNextEventDate returns a
        // LOCAL-midnight Date (it normalises with setHours and parses via
        // parseLocalDate), and converting that to UTC moves it back a day in
        // any zone east of Greenwich.
        time: toLocalDateString(nextDate),
        itemIds: archivedEvent?.itemIds || [],
        contextId: intent.contextId,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, savedEvent || newEvent]);
      return newEvent;
    }
    return null;
  }

  // --- Notification chain (Phase 4) -----------------------------------------
  //
  // Every one of these is a background concern: a chain that fails to expand
  // must not stop an execution from starting, and a chain that fails to advance
  // must not stop a step being ticked. So each is wrapped and logged rather
  // than thrown — but logged loudly, because Phase 4 is verified by inspecting
  // rows and a silent no-op would look identical to an item with no offsets.
  //
  // Nothing here sends anything. The dispatcher is Phase 5.

  async function startNotificationChain(execution) {
    try {
      const rows = await createNotificationSteps(execution.id, execution.elements);
      if (rows.length > 0) {
        console.log(`[Chain] Expanded ${rows.length} notification step(s) for execution ${execution.id}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to expand notification steps:", e);
    }
  }

  // Logged on EVERY tick, not only when something changed.
  //
  // The field failure was a chain that silently stopped advancing, and the
  // three ways that can happen — the advance was never called, the rows were
  // not visible, or the writes were refused — were indistinguishable from each
  // other and from "the chain is simply finished". Each now says which.
  async function advanceNotificationChain(execution, elementIndex) {
    try {
      const { complete, schedule, rowsSeen } = await completeNotificationStep(
        execution.id,
        execution.elements,
        elementIndex
      );
      if (rowsSeen === 0) {
        console.log(
          `[Chain] Element ${elementIndex}: no notification_steps rows visible for execution ${execution.id}. ` +
            `Either this item has no offsets, or the rows exist and RLS is hiding them.`
        );
        return;
      }
      console.log(
        `[Chain] Element ${elementIndex} (seq ${elementIndex + 1}): saw ${rowsSeen} row(s), ` +
          `completed ${complete.length}, scheduled ${schedule.length}.`
      );
    } catch (e) {
      console.error("[Chain] Failed to advance notification chain:", e, e.failures ?? "");
    }
  }

  async function retreatNotificationChain(execution, elementIndex) {
    try {
      const { patches, rowsSeen } = await untickNotificationStep(
        execution.id,
        execution.elements,
        elementIndex
      );
      console.log(
        `[Chain] Element ${elementIndex} un-ticked: saw ${rowsSeen} row(s), ` +
          `returned ${patches.length} to the chain.`
      );
    } catch (e) {
      console.error("[Chain] Failed to retreat notification chain:", e, e.failures ?? "");
    }
  }

  async function endNotificationChain(executionId) {
    try {
      const cancelled = await cancelNotificationSteps(executionId);
      if (cancelled.length > 0) {
        console.log(`[Chain] Cancelled ${cancelled.length} remaining step(s) for execution ${executionId}`);
      }
    } catch (e) {
      console.error("[Chain] Failed to cancel notification steps:", e);
    }
  }

  async function rescheduleNotificationChain(executionId) {
    try {
      const moved = await resumeNotificationSteps(executionId);
      if (moved.length > 0) {
        console.log(`[Chain] Resume: moved ${moved.length} overdue step(s) to now`);
      }
    } catch (e) {
      console.error("[Chain] Failed to reschedule notification steps on resume:", e);
    }
  }

  async function closeExecution(outcome) {
    if (!activeExecution) return;
    return withLoading('Completing...', async () => {
      // Cancel = Delete: just remove active execution, don't archive anything
      if (outcome === "cancelled") {
        // Cancel the chain BEFORE deleting the execution: afterwards the rows
        // would be orphans referencing a row that no longer exists. The
        // dispatcher's join to active executions would hide them, but leaving
        // live-looking rows behind for a run that never happened is not a
        // state worth defending.
        await endNotificationChain(activeExecution.id);
        await storage.delete(`execution:${activeExecution.id}`);
        setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
        setActiveExecution(null);
        setView(previousView);
        return;
      }

      const closed = {
        ...activeExecution,
        closedAt: new Date().toISOString(),
        outcome,
        status: "closed",
      };

      // Archive the execution (notes and elements are preserved via spread)
      await storage.set(`execution:${closed.id}`, closed);
      await endNotificationChain(closed.id);

      // Archive the event
      const event = events.find((e) => e.id === activeExecution.eventId);
      if (event) {
        const archivedEvent = { ...event, archived: true };
        await storage.set(`event:${event.id}`, archivedEvent);
        setEvents(events.map((e) => (e.id === event.id ? archivedEvent : e)));
      }

      // Handle recurrence: archive one-time intents, or create next event for recurring
      const intent = intents.find((i) => i.id === activeExecution.intentId);
      if (intent) {
        const config = getRecurrenceConfig(intent);
        if (config.type === "once") {
          // One-time: archive intent on done (existing behavior)
          if (outcome === "done") {
            const archivedIntent = { ...intent, archived: true };
            await storage.set(`intent:${intent.id}`, archivedIntent);
            setIntents(intents.map((i) => (i.id === intent.id ? archivedIntent : i)));
          }
        } else {
          // Recurring: calculate and create next event
          await triggerRecurrence(intent.id, event);
        }
      }

      // Remove completed items from collection. Only an affirmative completion
      // clears anything — cancel returns above, and pause never reaches here.
      //
      // We are already inside withLoading, which clears the overlay in its
      // finally and never rethrows, so there is no nested withLoading here and
      // the failure is read off the returned result rather than thrown.
      if (outcome === "done" && activeExecution.collectionId) {
        const completedIds = activeExecution.completedItemIds || [];
        if (completedIds.length > 0) {
          await clearCompletedFromCollection(
            activeExecution.collectionId,
            completedIds,
          );
        }
      }

      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecution(null);
      setView(previousView);
    });
  }

  async function cancelExecutionForEvent(eventId) {
    const exec =
      activeExecutions.find((e) => e.eventId === eventId) ||
      pausedExecutions.find((e) => e.eventId === eventId);
    if (!exec) return;
    return withLoading('Cancelling...', async () => {
      await storage.delete(`execution:${exec.id}`);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      setPausedExecutions((prev) => prev.filter((e) => e.id !== exec.id));
      if (activeExecution && activeExecution.id === exec.id) {
        setActiveExecution(null);
      }
    });
  }

  async function pauseExecution() {
    if (!activeExecution) return;
    return withLoading('Pausing...', async () => {
      const paused = { ...activeExecution, status: "paused" };
      await storage.set(`execution:${paused.id}`, paused);
      setActiveExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setPausedExecutions((prev) => [paused, ...prev]);
      setActiveExecution(null);
      setView("home");
    });
  }

  async function makeExecutionActive() {
    if (!activeExecution) return;
    return withLoading('Resuming...', async () => {
      const activated = { ...activeExecution, status: "active" };
      await storage.set(`execution:${activated.id}`, activated);
      // Pausing writes no rows — the dispatcher filters on execution status, so
      // a paused chain is already silent. Only resuming needs to act, so that a
      // due time that passed during the pause does not fire for a moment gone by.
      await rescheduleNotificationChain(activated.id);
      setPausedExecutions((prev) => prev.filter((e) => e.id !== activeExecution.id));
      setActiveExecutions((prev) => [activated, ...prev]);
      setActiveExecution(activated);
    });
  }

  async function toggleExecutionElement(elementIndex) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    const el = updatedElements[elementIndex];
    updatedElements[elementIndex] = {
      ...el,
      isCompleted: !el.isCompleted,
      completedAt: !el.isCompleted ? new Date().toISOString() : null,
      inProgress: false,
    };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element toggle:', e);
    }

    // Advance the chain only when the element is being marked COMPLETE. This
    // is a toggle, and un-ticking must not close a row or start a clock.
    // Re-ticking is safe: planCompletion only moves rows out of `waiting`, and
    // a row already terminal is left alone.
    if (!el.isCompleted) {
      await advanceNotificationChain(updated, elementIndex);
    } else {
      // Un-ticking RETREATS the chain. It used to do nothing, which left every
      // row the completion had armed still armed — so a notification would fire
      // for a step nobody had finished.
      await retreatNotificationChain(updated, elementIndex);
    }
  }

  async function updateExecutionElement(elementIndex, fields) {
    if (!activeExecution) return;
    const updatedElements = [...activeExecution.elements];
    updatedElements[elementIndex] = { ...updatedElements[elementIndex], ...fields };
    const updated = { ...activeExecution, elements: updatedElements };

    // Optimistic: update UI immediately
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );

    // Persist — await to prevent refresh race condition
    try {
      await storage.set(`execution:${updated.id}`, updated);
    } catch (e) {
      console.error('[Execution] Failed to save element update:', e);
    }
  }

  async function updateExecutionNotes(notes) {
    if (!activeExecution) return;
    const updated = { ...activeExecution, notes };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  async function toggleCollectionItem(itemId) {
    if (!activeExecution) return;
    const completed = activeExecution.completedItemIds || [];
    const isCompleted = completed.includes(itemId);
    const updatedIds = isCompleted
      ? completed.filter((id) => id !== itemId)
      : [...completed, itemId];
    const updated = { ...activeExecution, completedItemIds: updatedIds };
    await storage.set(`execution:${updated.id}`, updated);
    setActiveExecution(updated);
    setActiveExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
    setPausedExecutions((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e))
    );
  }

  /**
   * Load membership rows for the given collections from collection_items.
   *
   * loadMembers reports failure by returning an error rather than throwing,
   * because withLoading swallows exceptions. A read failure must not look like
   * an empty collection, so it is surfaced in the UI rather than logged only.
   */
  async function loadCollectionMembers(collectionIds, options = {}) {
    const ids = (collectionIds || []).filter(Boolean);
    if (ids.length === 0) return;

    const results = await Promise.all(
      ids.map(async (id) => ({ id, ...(await loadMembers(id)) })),
    );

    const failed = results.filter((r) => r.error);
    if (failed.length > 0) {
      console.error("[collections] failed to load members:", failed[0].error);
      // `quiet` is for the five-second poll. A failed tick means what is on
      // screen is five seconds old, not that it is wrong, and a banner that
      // flickers every five seconds would be worse than the staleness. A
      // foreground load still raises it, and a later success still clears it.
      if (!options.quiet) {
        setCollectionMembersError(`Could not load collection contents: ${failed[0].error}`);
      }
    } else {
      setCollectionMembersError(null);
    }

    setCollectionMembers((prev) => {
      const next = { ...prev };
      for (const r of results) {
        if (!r.error) next[r.id] = r.data;
      }
      return next;
    });
  }

  function membersOf(collectionId) {
    return collectionMembers[collectionId] || [];
  }

  function setMembersFor(collectionId, updater) {
    setCollectionMembers((prev) => ({
      ...prev,
      [collectionId]: updater(prev[collectionId] || []),
    }));
  }

  // ─── Collection membership writes ──────────────────────────────────────────
  //
  // These target collection_items. The item_collections.items jsonb is no longer
  // written by any of them and is now a frozen rollback snapshot.
  //
  // The data layer reports failure by returning { data, error } rather than
  // throwing, because withLoading catches and never rethrows — a thrown error
  // would be swallowed and the person would believe their edit had saved. Every
  // helper below inspects error and puts it in front of the user.

  function reportMembershipError(action, message) {
    console.error(`[collections] failed to ${action}:`, message);
    window.alert(`Could not ${action}: ${message}`);
  }

  async function addItemsToCollection(collectionId, entries) {
    const result = await addMembers(collectionId, entries, { userId: user.id });
    if (result.error) {
      reportMembershipError("add to this collection", result.error);
      return false;
    }
    await loadCollectionMembers([collectionId]);
    if (result.skipped.length > 0) {
      window.alert(
        result.skipped.length === 1
          ? "That item is already in this collection."
          : `${result.skipped.length} of those items were already in this collection.`,
      );
    }
    return true;
  }

  /**
   * Step 7 write path for Add to Collection.
   *
   * Three things happen, in this order:
   *   1. create any items the user chose to create
   *   2. ONE save of the source item's elements, stamping collectable and
   *      collectableItemId onto every row that was added
   *   3. add-or-merge the membership rows
   *
   * Returns true only if all three succeeded. The caller stays on the page on
   * false so the selection is not lost.
   *
   * Deliberately does NOT call updateItem: that helper ends with
   * `setItems(items.map(...))` over a closed-over snapshot, which would drop
   * the items created moments earlier in this same handler. State is updated
   * once here, functionally.
   */
  async function addElementsToCollection(collectionId, sourceItem, picks) {
    if (!collectionId || !sourceItem || !picks || picks.length === 0) return false;
    const coll = collections.find((c) => c.id === collectionId);
    if (!coll) return false;

    return withLoading("Adding...", async () => {
      const targetContext = contexts.find((c) => c.id === coll.contextId);
      const targetShared = targetContext?.shared || false;

      const created = [];
      const entries = [];
      const stamp = new Map();
      // One recipe can yield two create-new rows for the same product —
      // "Salt for the bean water" and "1/4 tsp salt" both reduce to salt.
      // Creating two items would be the catalogue pollution this feature
      // exists to prevent, so the first creation wins and the second reuses it.
      const createdByName = new Map();

      try {
        for (const pick of picks) {
          let itemId = pick.targetItemId;
          const nameKey = (pick.productName || "").trim().toLowerCase();
          if (!itemId && createdByName.has(nameKey)) {
            itemId = createdByName.get(nameKey);
          }
          if (!itemId) {
            // Same on-the-fly shape as CollectionAddItems.
            const newItem = {
              id: uid(),
              user_id: user.id,
              name: pick.productName,
              description: "",
              contextId: coll.contextId,
              elements: [],
              tags: [],
              isCaptureTarget: false,
              createdAt: new Date().toISOString(),
            };
            await storage.set(`item:${newItem.id}`, newItem, targetShared);
            created.push(newItem);
            itemId = newItem.id;
            createdByName.set(nameKey, itemId);
          }
          entries.push({ itemId, quantity: pick.quantity });
          if (Number.isInteger(pick.elementIndex)) stamp.set(pick.elementIndex, itemId);
        }

        // One save of the elements array, not one per row.
        const nextElements = (sourceItem.elements || []).map((el, idx) =>
          stamp.has(idx)
            ? { ...el, collectable: true, collectableItemId: stamp.get(idx) }
            : el,
        );
        const updatedSource = { ...sourceItem, elements: nextElements };
        const sourceContext = contexts.find((c) => c.id === updatedSource.contextId);
        await storage.set(
          `item:${updatedSource.id}`,
          updatedSource,
          sourceContext?.shared || false,
        );

        // One functional update covering both writes above.
        setItems((prev) => [
          ...prev.map((i) => (i.id === updatedSource.id ? updatedSource : i)),
          ...created,
        ]);
      } catch (error) {
        // storage.set throws; the module contract does not apply to it.
        console.error("[addElementsToCollection]", error);
        window.alert(
          "Could not save: " + (error?.message || "Unknown error") +
            ". Nothing was added to the collection.",
        );
        return false;
      }

      const result = await addOrMergeMembers(collectionId, entries, {
        userId: user.id,
      });
      await loadCollectionMembers([collectionId]);
      if (result.error) {
        reportMembershipError("add to this collection", result.error);
        return false;
      }
      return true;
    });
  }

  // OPTIMISTIC as of Step 12.4b — the row leaves the list on the tap, not on the
  // round trip. Same shape as toggleExecutionElement, which is why ticking items
  // off in an execution always felt instant and this did not.
  //
  // Step 12.4 removed the overlay but the wait stayed, because the row was still
  // gated on a write plus three reloads. Taking a spinner off a slow action makes
  // it feel broken rather than fast; the two halves only work together.
  //
  // ORDER MATTERS, and it is the whole correctness argument:
  //
  //   1. `memberWriteInFlight` is raised FIRST, before the optimistic update, not
  //      around the write. The five-second poll refetches membership; a tick
  //      landing between "row dropped from state" and "row deleted in Postgres"
  //      would read the pre-delete rows and put the row back under the user's
  //      thumb. That window is precisely what going optimistic creates.
  //   2. It is a COUNTER, not a flag, which is what makes three quick taps safe:
  //      they raise it to 3 and it returns to 0 only when the last settles. A
  //      boolean would let the second removal's completion clear the first's
  //      guard while the first was still in flight.
  //   3. The state update is FUNCTIONAL, so overlapping removals compose rather
  //      than clobber. Each filter runs against what the previous one left, not
  //      against a snapshot captured when this handler was created.
  //
  // On failure the row comes back by RELOADING rather than by re-inserting a
  // snapshot. The server owns the order; a partial failure (row deleted, removal
  // log not written) is real; and a reload is correct in every case where a
  // spliced snapshot would be correct in most. One round trip on a rare path, in
  // exchange for never showing a removal that did not happen.
  async function removeItemFromCollection(collectionId, itemId) {
    memberWriteInFlight.current += 1;
    setMembersFor(collectionId, (prev) => prev.filter((m) => m.itemId !== itemId));

    try {
      const result = await removeMember(collectionId, itemId, {
        reason: REMOVAL_MANUAL,
        userId: user.id,
      });

      if (result.error) {
        reportMembershipError("remove that item", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }

      // Membership is deliberately NOT reloaded on success: state already holds
      // the right answer, and a refetch would be a round trip whose only visible
      // effect is confirming what the user can already see. These two feed the
      // "Recently removed" panel and the history view, neither of which anyone is
      // waiting on.
      await loadCollectionRemovals(collectionId);
      await loadCollectionHistory(collectionId);
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  /**
   * Load manual removal history for the recently-removed panel.
   *
   * Only reason='manual'. A single execution completion can clear a dozen items
   * at once, and mixing those in would bury the accidental removal this panel
   * exists to catch; they show up in the full history view instead.
   *
   * Fetches a wider window than the panel displays, because entries whose item
   * is back in the collection are filtered out at render — fetching exactly five
   * could leave the panel showing fewer than it could.
   */
  async function loadCollectionRemovals(collectionId, options = {}) {
    const result = await loadRemovals(collectionId, {
      reason: REMOVAL_MANUAL,
      // Everything removed since midnight, uncapped. It used to be the most
      // recent 25, trimmed to 5 on render — which meant a shopping trip that
      // took more than five things off the list could not show you the sixth,
      // and one that took off more than 25 had already lost them before the
      // render ever saw them.
      //
      // PACIFIC midnight, not the browser's. `removed_at` is a server
      // timestamp and the boundary comes from an IANA rule, so the device's
      // TIMEZONE is consulted for nothing: a phone in Tokyo and a phone at home
      // show the same list, at the same moment, for the same collection.
      //
      // The device clock is not entirely out of it, and the comment here used
      // to overclaim that. `startOfPacificDay()` reads `new Date()` to decide
      // WHICH Pacific day is current — unavoidable for a window meaning
      // "today". A clock wrong by minutes or hours lands on the same day and
      // changes nothing; only one wrong enough to cross a Pacific day boundary
      // would pick the wrong day. That is also what makes this testable without
      // waiting: set the phone a day forward and the panel should empty.
      since: startOfPacificDay(),
      limit: null,
    });
    if (result.error) {
      // Surfaced in the panel rather than as an alert: this is a background read
      // on view open, and an alert on every visit would be intolerable. Poll
      // ticks pass `quiet` and do not raise the banner at all — see
      // loadCollectionMembers.
      console.error("[collections] failed to load removal history:", result.error);
      if (!options.quiet) {
        setCollectionRemovalsError(`Could not load removal history: ${result.error}`);
      }
      return false;
    }
    setCollectionRemovalsError(null);
    setCollectionRemovals((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Load the full removal history for the history view: both kinds, nothing
   * filtered out, newest first, capped at 50.
   *
   * Kept as a separate fetch from loadCollectionRemovals rather than deriving
   * both from one query. The panel wants the most recent *manual* removals, and
   * a collection with heavy completion churn could push every manual row out of
   * a mixed 50-row window while manual removals still exist.
   */
  async function loadCollectionHistory(collectionId) {
    const result = await loadRemovals(collectionId, { limit: 50 });
    if (result.error) {
      console.error("[collections] failed to load full history:", result.error);
      setCollectionHistoryError(`Could not load removal history: ${result.error}`);
      return false;
    }
    setCollectionHistoryError(null);
    setCollectionHistory((prev) => ({ ...prev, [collectionId]: result.data }));
    return true;
  }

  /**
   * Put a removed item back. The removal record is left in place — the table is
   * append-only and the item genuinely was removed at that time. The entry drops
   * out of the panel because the item is a member again, not because the history
   * was rewritten.
   */
  // Optimistic too, for consistency as much as speed: this sits a few inches
  // below the remove button on the same screen, in the same aisle. One instant
  // and one laggy would read as a bug in whichever felt slower.
  //
  // The provisional row carries only what the member list renders — `id`,
  // `itemId`, `quantity` — and is swapped for the real row the insert returns.
  // Its `id` is namespaced so it can never collide with a database id if
  // something goes wrong before the swap.
  //
  // Adding the member row is all that is needed to clear the entry from the
  // "Recently removed" panel: `recentRemovals` filters out removals whose item is
  // back in the collection, so the panel row disappears as a consequence rather
  // than needing its own optimistic update. One write, both halves of the
  // feedback.
  async function putBackRemoval(removal) {
    if (reAddingRemovalId) return false;
    setReAddingRemovalId(removal.id);
    memberWriteInFlight.current += 1;

    const provisional = {
      id: `pending:${removal.id}`,
      itemId: removal.itemId,
      quantity: removal.quantity,
    };
    setMembersFor(removal.collectionId, (prev) =>
      prev.some((m) => m.itemId === removal.itemId) ? prev : [...prev, provisional],
    );

    try {
      const result = await reAddRemoval(removal, { userId: user.id });

      if (result.error) {
        reportMembershipError("put that item back", result.error);
        setMembersFor(removal.collectionId, (prev) =>
          prev.filter((m) => m.id !== provisional.id),
        );
        return false;
      }

      // alreadyPresent means a double tap, or the other person restored it first.
      // That is the desired end state, so it is a quiet success, not a warning —
      // but it also means `result.data` is null, so the provisional row has no
      // real row to become and a reload is the only way to learn the true one.
      if (result.data) {
        setMembersFor(removal.collectionId, (prev) =>
          prev.map((m) => (m.id === provisional.id ? result.data : m)),
        );
      } else {
        await loadCollectionMembers([removal.collectionId]);
      }

      await loadCollectionRemovals(removal.collectionId);
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
      setReAddingRemovalId(null);
    }
  }

  // saveMemberQuantity and saveMemberOrder are not wrapped in withLoading, so
  // nothing else stops a poll tick landing in the middle of one and reverting the
  // change until the next tick. They hold the poll off for their own duration.
  //
  // As of Step 12.4 removeItemFromCollection and putBackRemoval are in this set
  // too — every write on the shopping path now holds the poll off explicitly
  // rather than as a side effect of raising a full-screen overlay.
  /**
   * Load the tag vocabulary for one collection's picker.
   *
   * Non-fatal by design: a picker with no suggestions still lets you create a
   * tag, so a failure here logs and leaves the pool empty rather than blocking
   * the control or raising an alert mid-shop.
   */
  /**
   * Close whichever collection tag editor is open.
   *
   * THE single close path. Tapping Done, tapping the open row's own Tag button,
   * switching to a different row, and leaving the view all route through here,
   * so none of them can drift from the others as this grows. Right now the
   * cleanup is one state write; the point is that when it stops being one, it
   * stops being one everywhere at once.
   *
   * Uncommitted text in the picker is discarded rather than committed, which is
   * the Phase 4 rule holding: a tag is created only by an explicit act. The
   * picker unmounts with the row, taking its query state with it.
   *
   * Clearing this also un-pauses the collection poll, via the effect that reads
   * `editingTagsItemId`.
   */
  function closeTagEditor() {
    setEditingTagsItemId(null);
  }

  /**
   * Open the tag editor on one member row, closing any other first.
   *
   * The close goes through `closeTagEditor` rather than being implied by
   * overwriting the id, so switching rows and closing a row share a path. React
   * batches the two writes, so the outgoing picker unmounts and the incoming
   * one mounts in a single commit — no flicker, and no window where the poll
   * sees "nothing open" and resumes mid-switch.
   */
  function openTagEditor(itemId) {
    closeTagEditor();
    setEditingTagsItemId(itemId);
  }

  /** Tapping a row's Tag button: close it if it is the open one, else switch. */
  function toggleTagEditor(itemId) {
    if (editingTagsItemId === itemId) closeTagEditor();
    else openTagEditor(itemId);
  }

  async function loadCollectionTags(collectionId) {
    const result = await loadCollectionTagPool(collectionId);
    if (result.error) {
      console.error("[collections] failed to load the tag pool:", result.error);
      return;
    }
    setCollectionTagPool((prev) => ({ ...prev, [collectionId]: result.data }));
  }

  /**
   * Write a member row's tags.
   *
   * Optimistic, like the quantity save: the chips change on the tap and the
   * write follows. A failure reloads membership so the row snaps back to what
   * the database actually holds rather than lying about it.
   *
   * The new tag is folded into the pool immediately so it is offered on the
   * next row without waiting for a refetch — tagging three items for the same
   * store in a row is the normal case, and only the first should cost a
   * "Create".
   */
  async function saveMemberTags(collectionId, itemId, tags) {
    memberWriteInFlight.current += 1;
    try {
      setCollectionTagPool((prev) => {
        const pool = prev[collectionId] || [];
        const added = tags.filter((tag) => !pool.includes(tag));
        return added.length === 0
          ? prev
          : { ...prev, [collectionId]: [...pool, ...added] };
      });

      const result = await updateMemberTags(collectionId, itemId, tags);
      if (result.error) {
        reportMembershipError("save those tags", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      setMembersFor(collectionId, (prev) =>
        prev.map((m) => (m.itemId === itemId ? result.data : m)),
      );
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  async function saveMemberQuantity(collectionId, itemId, quantity) {
    memberWriteInFlight.current += 1;
    try {
      const result = await updateMemberQuantity(collectionId, itemId, quantity);
      if (result.error) {
        reportMembershipError("save that quantity", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      setMembersFor(collectionId, (prev) =>
        prev.map((m) => (m.itemId === itemId ? result.data : m)),
      );
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  /**
   * Clear the items checked off during an execution, recording each as a
   * 'completed' removal.
   *
   * One removeMembers call rather than a loop over singular removals: every row
   * must land in a single INSERT so they share the server's transaction
   * timestamp exactly, which is what lets the history view group a bulk
   * clear-out under one heading.
   */
  async function clearCompletedFromCollection(collectionId, itemIds) {
    const result = await removeMembers(collectionId, itemIds, {
      reason: REMOVAL_COMPLETED,
      userId: user.id,
    });
    await loadCollectionMembers([collectionId]);
    if (result.error) {
      reportMembershipError("clear the completed items", result.error);
      return false;
    }
    return true;
  }

  async function saveMemberOrder(collectionId, orderedMembers) {
    memberWriteInFlight.current += 1;
    try {
      const result = await reorderMembers(collectionId, orderedMembers);
      if (result.error) {
        reportMembershipError("save the new order", result.error);
        await loadCollectionMembers([collectionId]);
        return false;
      }
      return true;
    } finally {
      memberWriteInFlight.current -= 1;
    }
  }

  async function refreshCollection(collectionId) {
    const coll = await storage.get(`item_collections:${collectionId}`);
    if (coll) {
      setCollections((prev) =>
        prev.map((c) => (c.id === collectionId ? coll : c))
      );
    }
    await loadCollectionMembers([collectionId]);
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


  // Collection CRUD
  async function addCollection(name, contextId = null) {
    return withLoading('Creating collection...', async () => {
      const newColl = {
        id: uid(),
        userId: user.id,
        name: name || "New Collection",
        contextId: contextId || null,
        shared: false,
        isCaptureTarget: false,
        // Explicit rather than leaning on the column default, so the object in
        // local state has the same shape as one read back from the database —
        // `updateCollection` spreads the whole row, and `activeCollections`
        // filters on this field.
        archived: false,
        // No items seed: membership lives in collection_items now. The jsonb
        // column keeps its own '[]' default and is never written again.
        createdAt: new Date().toISOString(),
      };
      const savedColl = await storage.set(`item_collections:${newColl.id}`, newColl);
      // Collections have NO realtime channel, so this is the only chance to
      // learn the database's `updated_at` short of a manual refresh.
      setCollections((prev) => [...prev, savedColl || newColl]);
      return newColl.id;
    });
  }

  // Collection metadata only — name, context, shared, pinned. Membership goes
  // through the collection_items helpers above.
  //
  // The `silent` flag STAYS. Step 12.4 briefly removed it and made every field
  // here quiet; that was the wrong target. These four settings — Context,
  // Shared, Pinned, Capture-target — are configuration, changed rarely and at a
  // desk, not the per-item taps done one-handed in a supermarket aisle. The
  // overlay was never the complaint here, so it goes back rather than leaving an
  // unrequested change behind. The shopping-path writes are the ones that lost
  // it: see removeItemFromCollection and putBackRemoval.
  //
  // What 12.4 DID leave behind is the error handling, and that was a real bug
  // independent of any screen. `storage.set` returns false rather than throwing,
  // so the silent branch's `catch` never fired for the failure that actually
  // happens: a failed save left the control showing a value the database did not
  // have, with nothing on screen and nothing in the console. Both branches now
  // report it and re-read the truth.
  async function updateCollection(collId, updates, silent = false) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;

    const reportFailure = async () => {
      window.alert("That change could not be saved. Reloading this collection.");
      await refreshData();
    };

    const doSave = async () => {
      const savedColl = await storage.set(`item_collections:${coll.id}`, { ...coll, ...updates });

      if (savedColl === false) {
        await reportFailure();
        return;
      }

      // Functional updater: apply the patch to the freshest state rather than
      // replacing the row with a snapshot captured at render time, which is an
      // independent cause of lost concurrent edits.
      //
      // `savedColl` sits in the MIDDLE of the spread as of Step 12.3, not at the
      // end: it carries the columns the database assigns — `updated_at` above
      // all — while `updates` stays the winner for the fields the user just
      // edited. Replacing the row with `savedColl` outright would take the
      // server's copy of every field and reintroduce exactly the clobber this
      // functional updater exists to prevent.
      setCollections((prev) =>
        prev.map((c) => (c.id === collId ? { ...c, ...savedColl, ...updates } : c)),
      );
    };

    if (silent) {
      try {
        await doSave();
      } catch (e) {
        console.error("Collection save error:", e);
        await reportFailure();
      }
    } else {
      return withLoading("Saving...", doSave);
    }
  }

  // Archive, not delete. Hard-deleting a collection cascades to
  // `collection_items` AND `collection_item_removals` — and the latter is an
  // append-only log of what was taken out of the collection and when, which is
  // the recovery path for accidental removals during shopping. Destroying that
  // behind a 5-second Undo was not acceptable, so collections became
  // soft-deletable like every other Alfred entity. See the spec's Undo section,
  // exception 2. The only hard delete left is the Recycle Bin's terminal one.
  //
  // Membership is deliberately left in `collectionMembers`: a soft delete does
  // not touch `collection_items`, so the cached rows stay correct and Undo has
  // nothing to rebuild.
  async function archiveCollection(collId) {
    const coll = collections.find((c) => c.id === collId);
    if (!coll) return;
    return withLoading('Archiving...', async () => {
      const archived = { ...coll, archived: true };
      await storage.set(`item_collections:${collId}`, archived);
      setCollections((prev) => prev.map((c) => (c.id === collId ? archived : c)));

      offerUndoFor(`Archived "${coll.name}".`, async () => {
        await storage.set(`item_collections:${collId}`, coll);
        setCollections((prev) => prev.map((c) => (c.id === collId ? coll : c)));
      });
    });
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

  async function startNowFromItem(itemId) {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    return withLoading('Starting execution...', async () => {
      // Create intention linked to this item
      const newIntent = {
        id: uid(),
        user_id: user.id,
        text: item.name,
        createdAt: new Date().toISOString(),
        isIntention: true,
        isItem: false,
        archived: false,
        itemId: item.id,
        contextId: item.contextId || null,
        recurrenceConfig: { type: "once" },
      };
      const savedIntent = await storage.set(`intent:${newIntent.id}`, newIntent);
      setIntents((prev) => [...prev, savedIntent || newIntent]);

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: newIntent.id,
        time: getTodayDate(),
        itemIds: [item.id],
        contextId: item.contextId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, savedEvent || newEvent]);

      // Build execution inline (can't call activate — state hasn't updated yet)
      let itemElements = [];
      if (item.elements || item.components) {
        const rawEls = (item.elements || item.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        // Flatten item references
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || item.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: newIntent.id,
        contextId: item.contextId || null,
        itemIds: [item.id],
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
  }

  async function startNowFromIntention(intentId) {
    const intent = intents.find((i) => i.id === intentId);
    if (!intent) return;
    return withLoading('Starting execution...', async () => {
      // Find linked item if any
      const linkedItem = intent.itemId
        ? items.find((i) => i.id === intent.itemId)
        : null;

      // Create event for today
      const newEvent = {
        id: uid(),
        user_id: user.id,
        intentId: intent.id,
        time: getTodayDate(),
        itemIds: linkedItem ? [linkedItem.id] : [],
        contextId: intent.contextId || null,
        collectionId: intent.collectionId || null,
        archived: false,
        createdAt: new Date().toISOString(),
      };
      const savedEvent = await storage.set(`event:${newEvent.id}`, newEvent);
      setEvents((prev) => [...prev, savedEvent || newEvent]);

      // Collection-based execution
      if (intent.collectionId) {
        const execution = {
          id: uid(),
          user_id: user.id,
          eventId: newEvent.id,
          intentId: intent.id,
          contextId: intent.contextId || null,
          collectionId: intent.collectionId,
          itemIds: [],
          startedAt: new Date().toISOString(),
          status: "active",
          notes: "",
          elements: [],
          completedItemIds: [],
          progress: [],
        };
        await storage.set(`execution:${execution.id}`, execution);
        await startNotificationChain(execution);
        setActiveExecution(execution);
        setActiveExecutions((prev) => [execution, ...prev]);
        setPreviousView(view);
        goToExecution(execution);
        return;
      }

      // Build execution elements from linked item
      let itemElements = [];
      if (linkedItem && (linkedItem.elements || linkedItem.components)) {
        const rawEls = (linkedItem.elements || linkedItem.components).map((el) =>
          typeof el === "string"
            ? { name: el, displayType: "step", quantity: "", description: "" }
            : { ...el }
        );
        const getItem = (id) => items.find((i) => i.id === id) || null;
        const flattened = await flattenElements(rawEls, getItem);
        itemElements = flattened.map((el) => ({
          ...el,
          isCompleted: false,
          completedAt: null,
          inProgress: false,
          startedAt: null,
          sourceItemId: el.sourceItemId || linkedItem.id,
        }));
      }

      const execution = {
        id: uid(),
        user_id: user.id,
        eventId: newEvent.id,
        intentId: intent.id,
        contextId: intent.contextId || null,
        itemIds: linkedItem ? [linkedItem.id] : [],
        startedAt: new Date().toISOString(),
        status: "active",
        notes: "",
        elements: itemElements,
        progress: [],
      };

      await storage.set(`execution:${execution.id}`, execution);
      await startNotificationChain(execution);
      setActiveExecution(execution);
      setActiveExecutions((prev) => [execution, ...prev]);
      setPreviousView(view);
      goToExecution(execution);
    });
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
          <div>
            {/* Executions & Today Tabs */}
            <div className="mb-8">
              {/* The same component the Recycle Bin and the Inbox use. Paused keeps its
                  rule: no tab while nothing is paused.

                  EVERY TAB CARRIES AN ICON — Clipboard Step 22. Not decoration: below
                  `lg` a tab compresses to its icon and its count, and a tab without one
                  cannot, so a row of three would behave differently from the row of
                  seven next door. Two of the three are reused rather than chosen:

                    Active   `Activity`, which is OBJECT_ICONS.execution — the same pulse
                             the cards in this tab already carry.
                    Paused   `Pause`, which ALREADY means "this is paused" in Alfred: an
                             execution badge writes `Pause` beside the word "Paused". The
                             Pause BUTTON is the same glyph, and that is the one reuse
                             here that is a verb next to a noun — accepted because the
                             noun is the state the verb produces, and no other glyph says
                             "set aside" without inventing a meaning.
                    Today    `Sun`, chosen. Nothing else in the app uses it, and `Calendar`
                             is already the Schedule while `CalendarClock` is an event —
                             so the two glyphs that mean "time" both mean something else. */}
              <UnderlineTabs
                ariaLabel="Executions and today"
                activeKey={executionTab}
                onSelect={setExecutionTab}
                tabs={[
                  { key: "active", label: "Active", count: activeExecutions.length, icon: Activity },
                  ...(pausedExecutions.length > 0
                    ? [{ key: "paused", label: "Paused", count: pausedExecutions.length, icon: Pause }]
                    : []),
                  { key: "today", label: "Today", count: todayEvents.length, icon: Sun },
                ]}
              />

              {executionTab === "active" && (
                <div className="space-y-2">
                  {activeExecutions.length > 0 ? (
                    activeExecutions.map((exec) => (
                      <ExecutionBadge
                        key={exec.id}
                        exec={exec}
                        intents={intents}
                        contexts={contexts}
                        getIntentDisplay={getIntentDisplay}
                        onOpen={openExecution}
                      />
                    ))
                  ) : (
                    <p className="text-muted-foreground text-sm">No active executions.</p>
                  )}
                </div>
              )}

              {executionTab === "paused" && (
                <div className="space-y-2">
                  {pausedExecutions.length > 0 ? (
                    pausedExecutions.map((exec) => (
                      <ExecutionBadge
                        key={exec.id}
                        exec={exec}
                        intents={intents}
                        contexts={contexts}
                        getIntentDisplay={getIntentDisplay}
                        onOpen={openExecution}
                      />
                    ))
                  ) : (
                    <p className="text-muted-foreground text-sm">No paused executions.</p>
                  )}
                </div>
              )}

              {executionTab === "today" && (
                <div className="space-y-2">
                  {/* Inside the Today panel, not above the tab bar — Active and
                      Paused are execution lists ordered by started_at and this
                      does not govern them. */}
                  {todayEvents.length > 0 && (
                    <ListToolbar
                      query={searchFor("home")}
                      onQueryChange={setSearchFor("home")}
                      searchLabel="Search today's events"
                      sortId="home-sort"
                      sortOptions={EVENT_SORT_OPTIONS}
                      sort={homeSort}
                      className="mb-3"
                    />
                  )}
                  {visibleTodayEvents.length > 0 ? (
                    visibleTodayEvents.map((event) => {
                      const intent = intents.find((i) => i.id === event.intentId);
                      if (!intent) return null;
                      return (
                        <EventCard
                          key={event.id}
                          event={event}
                          intent={intent}
                          contexts={contexts}
                          onUpdate={updateEvent}
                          onActivate={activate}
                          getIntentDisplay={getIntentDisplay}
                          executions={allLiveExecutions}
                          onOpenExecution={openExecution}
                          onCancelExecution={cancelExecutionForEvent}
                          items={items}
                          onViewIntention={(id) => viewIntentionDetail(id, "home")}
                          onViewItem={(id) => viewItemDetail(id, "home")}
                          onViewContextDetail={viewContextDetail}
                        />
                      );
                    })
                  ) : (
                    todayEvents.length > 0 ? (
                      <NoMatches noun="events" query={searchFor("home")} />
                    ) : (
                      <p className="text-muted-foreground text-sm">No events scheduled for today.</p>
                    )
                  )}
                </div>
              )}
            </div>

            {/* Pinned Collections Section */}
            {pinnedCollections.length > 0 && (
              <div>
                <h3 className="text-lg font-medium mb-3 text-foreground">Pinned Collections</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pinnedCollections.map((coll) => (
                    <CollectionCard
                      key={coll.id}
                      collection={coll}
                      contexts={contexts}
                      memberCount={membersOf(coll.id).length}
                      onOpen={() => {
                        setPreviousView("home");
                        setSelectedCollectionId(coll.id);
                        setView("collection-detail");
                      }}
                      onArchive={archiveCollection}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Pinned Contexts Section */}
            <div className="mt-6">
              <h3 className="text-lg font-medium mb-3 text-foreground">Pinned Contexts</h3>
              {pinnedContexts.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No pinned contexts. Pin contexts to see them here.
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {pinnedContexts.map((context) => (
                    <ContextCard
                      key={context.id}
                      context={context}
                      onClick={() => viewContextDetail(context.id)}
                      showSettings={false}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Inbox View */}
        {view === "inbox" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Inbox</h2>
            {/* The source filter — Clipboard Step 21b.

                TABS, not pills. It was `TagFilter` in Step 21, which worked and read
                wrong: the source pills sat directly above cards carrying real tag
                pills, so two different things looked identical. A tab says "this is a
                view of one list"; a pill says "this is a property of these rows". */}
            {inboxItems.length > 0 && (
              <UnderlineTabs
                ariaLabel="Filter the inbox by source"
                tabs={inboxSourceTabs}
                activeKey={activeInboxSource}
                onSelect={setInboxSourceTab}
                className="gap-4 sm:gap-6 mb-3"
              />
            )}
            {inboxItems.length > 0 && (
              <ListToolbar
                query={searchFor("inbox")}
                onQueryChange={setSearchFor("inbox")}
                searchLabel="Search inbox"
                sortId="inbox-sort"
                sortOptions={INBOX_SORT_OPTIONS}
                sort={inboxSort}
                className="mb-3"
              />
            )}
            {inboxItems.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>Empty inbox.</p>
                <p className="text-sm mt-2">This is success, not failure.</p>
              </div>
            ) : visibleInboxItems.length === 0 ? (
              <NoMatches noun="captures" query={searchFor("inbox")} />
            ) : (
              <div className="space-y-2.5">
                {visibleInboxItems.map((inboxItem) => (
                  <InboxListCard
                    key={inboxItem.id}
                    inboxItem={inboxItem}
                    contexts={contexts}
                    onOpen={openInboxDetail}
                    onProcess={processInboxItemFromList}
                    onCopy={copyTaskInboxItem}
                    onDiscard={discardInboxItem}
                    reminder={reminderBadge(reminderIndex.byInbox[inboxItem.id])}
                  />
                ))}
              </div>
            )}

            {/* "Recently archived (n)" — Clipboard Step 22.

                OUTSIDE the empty/no-matches branches above, deliberately. An empty inbox
                is exactly when this section matters most: you have just processed the
                last capture, and "Empty inbox — this is success, not failure" with no way
                back would make a mistaken tap unrecoverable on the one screen that
                celebrates it. It hides itself when there is genuinely nothing archived. */}
            <RecentlyArchived
              rows={archivedInboxItems}
              olderCount={olderArchived}
              showAll={archivedShowAll}
              onToggleShowAll={() => setArchivedShowAll((v) => !v)}
              expanded={archivedExpanded}
              onToggleExpanded={() => setArchivedExpanded((v) => !v)}
              outcomeFor={(row) => archiveOutcome(row, { items, intents, events })}
              onUndo={unarchiveInboxItem}
            />
          </div>
        )}

        {/* Inbox Detail View — Alfred Clipboard, Step 17.

            Rendered from `routeInboxItem`, which is resolved from the URL rather
            than from state, so a refresh or a pasted link opens the same capture.
            `key` is the capture id: moving from one capture to another remounts
            the page rather than re-seeding it, which is what keeps a half-typed
            triage from bleeding into the next one. */}
        {view === "inbox-detail" && routeInboxItem && (
          <InboxDetailView
            key={routeInboxItem.id}
            inboxItem={routeInboxItem}
            contexts={contexts}
            items={items}
            tagPool={tagPool}
            onProcess={handleInboxSave}
            onDiscard={discardInboxItem}
            // Guarded: Back is the one exit that can be taken with a form full of
            // unsaved work and no intention of abandoning it. Cancel and Discard
            // clear the flag themselves before calling this.
            onBack={() => guardedSetView("inbox")}
            onDirtyChange={setUnsavedChanges}
            // Step 17b. Correcting a capture's text, which is not triage: the row
            // stays in the inbox. Alex ruled this back in — without it, retiring
            // the inbox card in Step 18 would leave no way to fix a typo.
            onSaveCaptureText={updateInboxCaptureText}
            // Passed in rather than imported: RecurrenceQuickSelect lives in this
            // file, which imports InboxDetailView, so importing back would be a
            // cycle — and moving it would drag its two dialogs along.
            renderRecurrence={({ value, onChange, onEndDateChange }) => (
              <RecurrenceQuickSelect
                value={value}
                onChange={onChange}
                onEndDateChange={onEndDateChange}
              />
            )}
            // Step 19. What a clipboard or CLI capture actually captured. Keyed by
            // clip id so moving between two captures remounts it rather than
            // showing the previous one's screenshot while the new one loads.
            renderCapturedContent={(item) => {
              const clipId = clipIdFor(item);
              if (!clipId) return null;
              return <ClipboardCapture key={clipId} clipId={clipId} inboxItem={item} />;
            }}
            renderReminders={(item) => <PendingReminder key={item.id} inboxId={item.id} />}
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
        )}

        {view === "intention-add" && (
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

        {/* Opening an execution from a URL rather than from in-app state —
            a pasted link, a refresh, or a notification tap. Without this the
            pane is blank for the length of the fetch, which reads as a broken
            link on the one path where the user has no other context. */}
        {view === "execution-detail" && !executionForRoute && awaitingExecutionLoad && (
          <div className="p-6 text-center text-muted-foreground">
            Opening execution…
          </div>
        )}

        {/* Execution Detail View. Rendered from executionForRoute, not
            activeExecution: on the render after the URL changes to a different
            execution, state still holds the previous one, and drawing it under
            the new address would show the wrong execution. */}
        {view === "execution-detail" && executionForRoute && (
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
          />
        )}

        {/* Schedule View */}
        {view === "schedule" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Schedule</h2>
            {allNonArchivedEvents.length > 0 && (
              <ListToolbar
                query={searchFor("schedule")}
                onQueryChange={setSearchFor("schedule")}
                searchLabel="Search scheduled events"
                sortId="schedule-sort"
                sortOptions={EVENT_SORT_OPTIONS}
                sort={scheduleSort}
                className="mb-3"
              />
            )}
            {allNonArchivedEvents.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No scheduled events.</p>
                <p className="text-sm mt-2">This is a valid state.</p>
              </div>
            ) : visibleScheduleEvents.length === 0 ? (
              <NoMatches noun="events" query={searchFor("schedule")} />
            ) : (
              <div className="space-y-3">
                {visibleScheduleEvents.map((event) => {
                  const intent = intents.find((i) => i.id === event.intentId);
                  if (!intent) return null;

                  return (
                    <EventCard
                      key={event.id}
                      event={event}
                      intent={intent}
                      contexts={contexts}
                      onUpdate={updateEvent}
                      onActivate={activate}
                      getIntentDisplay={getIntentDisplay}
                      executions={allLiveExecutions}
                      onOpenExecution={openExecution}
                      onCancelExecution={cancelExecutionForEvent}
                      items={items}
                      onViewIntention={(id) => viewIntentionDetail(id, "schedule")}
                      onViewItem={(id) => viewItemDetail(id, "schedule")}
                      onViewContextDetail={viewContextDetail}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Intentions View */}
        {view === "intentions" && (
          <div>
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-lg sm:text-xl font-medium">Intentions</h2>
              <button
                onClick={() => openAddPage("intention-add")}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                Add Intention
              </button>
            </div>

            <TagFilter
              entities={intentionsWithoutActiveEvent}
              activeTag={filterTag}
              onFilter={setFilterTag}
              collapsed={tagsCollapsedFor("intentions")}
              onToggleCollapsed={toggleTagsFor("intentions")}
            />

            {/* Step 12.8. This page was missed by Step 9b, so until now it had no
                sort control AND no ordering — a bare `.filter()` over a query with
                no ORDER BY, which is arbitrary rather than merely undocumented. */}
            {intentionsWithoutActiveEvent.length > 0 && (
              <ListToolbar
                query={searchFor("intentions")}
                onQueryChange={setSearchFor("intentions")}
                searchLabel="Search intentions"
                sortId="intentions-sort"
                sortOptions={INTENTION_SORT_OPTIONS}
                sort={intentionsSort}
                className="mb-3"
              />
            )}

            {intentionsWithoutActiveEvent.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No available intentions.</p>
                <p className="text-sm mt-2">
                  All intentions are currently scheduled.
                </p>
              </div>
            ) : searchFor("intentions").trim() && visibleIntentions.length === 0 ? (
              <NoMatches noun="intentions" query={searchFor("intentions")} />
            ) : (
              <div className="space-y-3">
                {visibleIntentions.map((intent) => (
                  <IntentionCard
                    tagPool={tagPool}
                    key={intent.id}
                    intent={intent}
                    contexts={contexts}
                    items={items}
                    collections={activeCollections}
                    onUpdate={updateIntent}
                    onSchedule={moveToPlanner}
                    onStartNow={startNowFromIntention}
                    getIntentDisplay={getIntentDisplay}
                    showScheduling={true}
                    onViewDetail={(id) => viewIntentionDetail(id, "intentions")}
                    reminder={reminderBadge(reminderIndex.byIntent[intent.id])}
                    events={validEvents}
                    onUpdateEvent={updateEvent}
                    onActivate={activate}
                    executions={allLiveExecutions}
                    onOpenExecution={openExecution}
                    onCancelExecution={cancelExecutionForEvent}
                    onArchive={archiveIntention}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Memories View */}
        {view === "memories" && (
          <div>
            <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Memories</h2>
            <TagFilter
              entities={memoriesWithoutContext}
              activeTag={filterTag}
              onFilter={setFilterTag}
              collapsed={tagsCollapsedFor("memories")}
              onToggleCollapsed={toggleTagsFor("memories")}
            />

            {/* Step 12.8. Missed by Step 9b in exactly the same way as Intentions,
                and with the same consequence: no control and no order. */}
            {memoriesWithoutContext.length > 0 && (
              <ListToolbar
                query={searchFor("memories")}
                onQueryChange={setSearchFor("memories")}
                searchLabel="Search memories"
                sortId="memories-sort"
                sortOptions={NAMED_RECORD_SORT_OPTIONS}
                sort={memoriesSort}
                className="mb-3"
              />
            )}

            {memoriesWithoutContext.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <p>No memories without context.</p>
              </div>
            ) : searchFor("memories").trim() && visibleMemories.length === 0 ? (
              <NoMatches noun="memories" query={searchFor("memories")} />
            ) : (
              <div className="space-y-3">
                {visibleMemories.map((item) => (
                  <ItemCard
                    tagPool={tagPool}
                    key={item.id}
                    item={item}
                    contexts={contexts}
                    onUpdate={updateItem}
                    onViewDetail={(id) => viewItemDetail(id, "memories")}
                    // An item has no reminder link: its reminder stays on the capture it came from.
                    reminder={reminderBadge(itemReminder(item, reminderIndex))}
                    executions={allLiveExecutions.filter((ex) => ex.itemIds?.includes(item.id))}
                    intents={intents}
                    getIntentDisplay={getIntentDisplay}
                    onOpenExecution={openExecution}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Collections View */}
        {view === "collections" && (
          <div>
            <div className="flex items-center justify-between mb-3 sm:mb-4">
              <h2 className="text-lg sm:text-xl font-medium">Collections</h2>
              <button
                onClick={async () => {
                  const id = await addCollection("New Collection");
                  if (id) {
                    setPreviousView("collections");
                    setSelectedCollectionId(id);
                    setView("collection-detail");
                  }
                }}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                New Collection
              </button>
            </div>

            {contexts.length > 0 && (
              <div className="mb-3">
                <select
                  value={collectionContextFilter}
                  onChange={(e) => setCollectionContextFilter(e.target.value)}
                  className="px-3 py-2 min-h-[44px] border border-border rounded text-base"
                >
                  <option value="">All Contexts</option>
                  <option value="__none__">No Context</option>
                  {contexts.filter((c) => !c.archived).map((ctx) => (
                    <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
                  ))}
                </select>
              </div>
            )}

            {(() => {
              const filtered = activeCollections.filter((coll) => {
                if (!collectionContextFilter) return true;
                if (collectionContextFilter === "__none__") return !coll.contextId;
                return coll.contextId === collectionContextFilter;
              });

              if (filtered.length === 0) return (
                <div className="text-center py-12 text-muted-foreground">
                  <p>No collections{collectionContextFilter ? " in this context" : " yet"}.</p>
                  <p className="text-sm mt-2">Create a collection to group items together.</p>
                </div>
              );

              // Searched AFTER the empty check above, so a search that matches
              // nothing leaves the toolbar in place instead of replacing the
              // whole page with "No collections yet".
              const visible = sortRows(
                filtered, collectionsSort.sortKey, NAMED_RECORD_ACCESSORS, collectionsSort.sortDir,
              ).filter((coll) => matchesQuery(searchFor("collections"), coll.name));

              return (
              <div className="space-y-2">
                <ListToolbar
                  query={searchFor("collections")}
                  onQueryChange={setSearchFor("collections")}
                  searchLabel="Search collections"
                  sortId="collections-sort"
                  sortOptions={NAMED_RECORD_SORT_OPTIONS}
                  sort={collectionsSort}
                  className="mb-1"
                />
                {visible.length === 0 ? (
                  <NoMatches noun="collections" query={searchFor("collections")} />
                ) : (
                  visible.map((coll) => (
                    <CollectionCard
                      key={coll.id}
                      collection={coll}
                      contexts={contexts}
                      memberCount={membersOf(coll.id).length}
                      onOpen={() => {
                        setPreviousView("collections");
                        setSelectedCollectionId(coll.id);
                        setView("collection-detail");
                      }}
                      onArchive={archiveCollection}
                    />
                  ))
                )}
              </div>
              );
            })()}
          </div>
        )}

        {/* Collection Detail View */}
        {view === "collection-detail" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const members = membersOf(coll.id);
          // An item that has been put back is a resolved problem, so it drops out
          // of a panel meant for unresolved ones. The removal record itself stays
          // in the table — the history stays honest.
          const memberItemIds = new Set(members.map((m) => m.itemId));
          // Filtered for display only. Drag-to-reorder still works against the
          // full `members` list — reordering a filtered subset would write
          // positions that mean nothing once the filter is cleared, so the
          // handles are hidden while a filter is on.
          const visibleMembers = collectionFilterTag
            ? members.filter((m) => (m.tags || []).includes(collectionFilterTag))
            : members;
          const tagPoolForCollection = collectionTagPool[coll.id] || [];
          // No .slice() any more — the fetch is already bounded to today, and
          // capping a time window by count as well is what hid the older half
          // of a heavy shopping day.
          //
          // The still-a-member filter STAYS. It is how "Put back" clears a row
          // without needing its own optimistic update: re-adding the member is
          // enough to drop its removal out of the panel.
          const recentRemovals = (collectionRemovals[coll.id] || []).filter(
            (r) => !memberItemIds.has(r.itemId),
          );
          const history = collectionHistory[coll.id] || [];
          return (
            <div>
              <button
                onClick={() => {
                  setSelectedCollectionId(null);
                  setView(previousView || "collections");
                }}
                className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Name</label>
                  <input
                    type="text"
                    value={coll.name}
                    onChange={(e) => {
                      const updated = { ...coll, name: e.target.value };
                      setCollections(collections.map((c) => (c.id === coll.id ? updated : c)));
                    }}
                    onBlur={() => updateCollection(coll.id, { name: coll.name }, true)}
                    className="w-full px-3 py-2 border border-border rounded text-base"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Context</label>
                  <select
                    value={coll.contextId || ""}
                    onChange={(e) => updateCollection(coll.id, { contextId: e.target.value || null })}
                    className="w-full px-3 py-2 border border-border rounded text-base"
                  >
                    <option value="">No context</option>
                    {/* Filtered inline rather than by swapping the prop: this
                        component also looks context names up by id for badges,
                        and an archived context must still resolve there. */}
                    {contexts.filter((c) => !c.archived).map((ctx) => (
                      <option key={ctx.id} value={ctx.id}>{ctx.name}</option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={coll.shared || false}
                    onChange={(e) => updateCollection(coll.id, { shared: e.target.checked })}
                    className="rounded accent-primary"
                  />
                  <span className="text-sm">Shared collection</span>
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={coll.pinned || false}
                    onChange={(e) => updateCollection(coll.id, { pinned: e.target.checked })}
                    className="rounded accent-primary"
                  />
                  <span className="text-sm">Pin to home</span>
                </label>

                {/* The column has existed since the collections migration and
                    enrichment has been reading it to decide where a capture
                    should go, but there was no UI — the only way to set it was
                    raw SQL, which is how Groceries got its flag. (That reader is
                    the alfred-enrich skill in claude.ai now, not the ai-enrich
                    function — Clipboard Step 14.) */}
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={coll.isCaptureTarget || false}
                    onChange={(e) =>
                      updateCollection(coll.id, { isCaptureTarget: e.target.checked })
                    }
                    className="mt-1 rounded accent-primary"
                  />
                  <span className="text-sm">
                    Capture target
                    <span className="block text-xs text-muted-foreground">
                      Alfred files new captures here by default, and it is
                      preselected when adding an item's ingredients to a
                      collection.
                    </span>
                  </span>
                </label>

                <div>
                  {/* Membership — reads and writes both go to collection_items. */}
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-base font-medium">
                      Items ({members.length})
                    </h3>
                    <button
                      onClick={() => setView("collection-add-items")}
                      className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Add Items
                    </button>
                  </div>

                  {collectionMembersError && (
                    <p className="text-xs text-destructive mb-2">{collectionMembersError}</p>
                  )}

                  {members.length >= 50 && members.length < 200 && (
                    <p className="text-xs text-warning mb-2">Warning: {members.length} items. Performance may degrade above 200.</p>
                  )}
                  {members.length >= 200 && (
                    <p className="text-xs text-destructive mb-2">Maximum 200 items reached.</p>
                  )}

                  {/* Store filter. Same component the item and intention lists
                      use, handed the members so it counts this collection's
                      tags — but wired to `collectionFilterTag`, which is NOT
                      the `filterTag` those lists share. See the state
                      declaration for why they must stay apart. */}
                  {/* This view has no search box, so nothing ever collapses
                      this bar for you — the toggle is the only way, and it is
                      here so the control exists on every bar rather than on
                      three of the four. Its own collapse key for the same
                      reason `collectionFilterTag` is its own filter. */}
                  <TagFilter
                    entities={members}
                    activeTag={collectionFilterTag}
                    onFilter={setCollectionFilterTag}
                    collapsed={tagsCollapsedFor("collection-detail")}
                    onToggleCollapsed={toggleTagsFor("collection-detail")}
                  />

                  {members.length === 0 ? (
                    <p className="text-muted-foreground text-sm py-4 text-center">No items in this collection</p>
                  ) : visibleMembers.length === 0 ? (
                    <p className="text-muted-foreground text-sm py-4 text-center">
                      No items tagged &quot;{collectionFilterTag}&quot;
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {visibleMembers.map((member, index) => {
                        const linkedItem = items.find((i) => i.id === member.itemId);
                        const memberTags = member.tags || [];
                        const tagsOpen = editingTagsItemId === member.itemId;
                        return (
                          <div
                            key={member.id || member.itemId || index}
                            ref={tagsOpen ? editingTagsRowRef : undefined}
                            className={`p-3 bg-card border border-border rounded-lg ${collDragIdx === index ? "opacity-50" : ""}`}
                            draggable={!collectionFilterTag && !tagsOpen}
                            onDragStart={(e) => { setCollDragIdx(index); e.dataTransfer.effectAllowed = "move"; }}
                            onDragOver={(e) => {
                              e.preventDefault();
                              if (collDragIdx === null || collDragIdx === index) return;
                              setMembersFor(coll.id, (prev) => {
                                const next = [...prev];
                                const [dragged] = next.splice(collDragIdx, 1);
                                next.splice(index, 0, dragged);
                                return next;
                              });
                              setCollDragIdx(index);
                            }}
                            onDragEnd={() => {
                              setCollDragIdx(null);
                              saveMemberOrder(coll.id, members);
                            }}
                          >
                          <div className="flex items-center gap-2">
                            {/* Hidden while filtering: the visible rows are a
                                subset, so a drop position would be a lie. */}
                            {!collectionFilterTag && (
                              <GripVertical className="w-4 h-4 text-muted-foreground cursor-move flex-shrink-0" title="Drag to reorder" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">
                                <ItemNameLabel name={linkedItem?.name} />
                              </p>
                              {/* Tag chips, under the name rather than beside
                                  it. At 360px the row has no spare width — name,
                                  quantity and the two buttons already fill it —
                                  and the tag has to be readable at a glance in
                                  an aisle, which a count badge or an icon is not.
                                  A second line only appears when a row actually
                                  has tags, so an untagged list is exactly as
                                  compact as it was before this phase.

                                  Each chip removes itself. Removing a tag used
                                  to mean opening the editor to reach a second
                                  copy of the same chips; now it is one tap on
                                  the chip you are already looking at, and the
                                  editor is only for ADDING.

                                  The × is a 32px target inside a ~30px chip, not
                                  the usual 44px. 44 would make a chip taller than
                                  the item name it sits under and would crowd the
                                  row it is meant to annotate. 32 is a
                                  comfortable deliberate tap, and mis-taps while
                                  scrolling are not the risk they look like —
                                  a browser cancels the click once the finger
                                  moves, so a scroll never fires one. gap-1.5
                                  keeps two ×s from sitting shoulder to shoulder,
                                  which is the mis-tap that could happen. */}
                              {memberTags.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1">
                                  {memberTags.map((tag) => (
                                    <span
                                      key={tag}
                                      className="inline-flex items-center gap-0.5 pl-2.5 pr-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
                                    >
                                      {tag}
                                      <button
                                        onClick={() =>
                                          saveMemberTags(
                                            coll.id,
                                            member.itemId,
                                            memberTags.filter((t) => t !== tag),
                                          )
                                        }
                                        aria-label={`Remove tag ${tag}`}
                                        title={`Remove tag ${tag}`}
                                        className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-full hover:text-destructive"
                                      >
                                        <X className="w-3 h-3" />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                            {/* Quantity is disabled when the item cannot be shown:
                                setting an amount on something you cannot identify
                                is a guess, and it would be a silent edit to data
                                the owner can see and you cannot. Removing the row
                                stays available — a member you cannot see is exactly
                                the one you may need to get rid of. */}
                            <input
                              type="text"
                              value={member.quantity || ""}
                              disabled={!linkedItem}
                              title={linkedItem ? undefined : "This item cannot be shown, so its quantity cannot be edited"}
                              onChange={(e) => {
                                const quantity = e.target.value;
                                setMembersFor(coll.id, (prev) =>
                                  prev.map((m) => (m.itemId === member.itemId ? { ...m, quantity } : m)),
                                );
                              }}
                              // The typed value lives in collectionMembers until
                              // blur, which is exactly what the poll overwrites.
                              // Focus pauses the poll; the pause is not lifted
                              // until the save has settled, so a tick cannot land
                              // between blur and the write completing.
                              onFocus={() => setEditingQuantityItemId(member.itemId)}
                              onBlur={async () => {
                                await saveMemberQuantity(coll.id, member.itemId, member.quantity);
                                setEditingQuantityItemId(null);
                              }}
                              placeholder="Qty"
                              className="w-20 sm:w-24 px-2 py-2 border border-border rounded text-base disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            {/* Opens the picker below this row, one at a time.
                                Disabled for an unreadable item for the same
                                reason quantity is: tagging something you cannot
                                identify is a guess. */}
                            <button
                              {...{ [TAG_TOGGLE_ATTR]: "" }}
                              // Switches on the PRESS, not the click, and this
                              // is load-bearing rather than stylistic.
                              //
                              // An open editor makes its row taller, so every
                              // row below it sits lower. Closing one on
                              // mousedown moved those rows back UP between the
                              // press and the release, so the button that was
                              // under the finger on press was somewhere else on
                              // release and the click never completed on it.
                              // Tapping a row BELOW the open one did nothing;
                              // tapping one ABOVE worked, because rows above
                              // never move. Doing the whole switch on the press
                              // means no click has to land anywhere.
                              //
                              // preventDefault keeps focus off the button, so
                              // the phone keyboard does not flicker on the way
                              // from one editor to the next.
                              onMouseDown={(e) => {
                                e.preventDefault();
                                toggleTagEditor(member.itemId);
                              }}
                              // Keyboard only. A click from Enter or Space
                              // carries detail 0; a pointer click carries 1 or
                              // more and was already handled above. The guard
                              // also absorbs a stray click that reflow lands on
                              // the wrong button.
                              onClick={(e) => {
                                if (e.detail === 0) toggleTagEditor(member.itemId);
                              }}
                              disabled={!linkedItem}
                              aria-label={tagsOpen ? "Done tagging" : "Tag this item"}
                              title={
                                linkedItem
                                  ? tagsOpen
                                    ? "Done tagging"
                                    : "Tag this item"
                                  : "This item cannot be shown, so it cannot be tagged"
                              }
                              className={`p-1 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                                tagsOpen
                                  ? "bg-primary text-white"
                                  : "text-muted-foreground hover:text-primary"
                              }`}
                            >
                              <Tag className="w-4 h-4" />
                            </button>
                            <button
                              // No overlay — Step 12.4. This is THE shopping
                              // action: one-handed, in an aisle, once per item.
                              // A full-screen scrim per tick was the complaint.
                              // The row disappearing is the confirmation, and
                              // removeItemFromCollection reports its own failures
                              // through reportMembershipError.
                              onClick={() =>
                                removeItemFromCollection(coll.id, member.itemId)
                              }
                              className="p-1 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>

                          {/* The editor, expanded under its own row. One at a
                              time — two of them open at once would push the list
                              off a phone screen.

                              Input and dropdown ONLY. It used to carry its own
                              copy of the chips and a Done button; the chips are
                              now removable in the row directly above, which
                              makes both redundant. What is left is the one thing
                              the editor is for: adding. The row's chips stay
                              visible while it is open, so a tag landing is still
                              confirmed on screen.

                              No Done button either — tapping anywhere outside
                              the row closes it. See the dismissal effect.

                              Its pool is the COLLECTION pool: this collection's
                              members plus its removal history. It never mixes
                              with the item/intent pool — "tjs" has no business
                              on a recipe and "vegetarian" none on a shopping
                              row. */}
                          {tagsOpen && (
                            <div className="mt-3 pt-3 border-t border-border">
                              <TagPicker
                                value={memberTags}
                                pool={tagPoolForCollection}
                                onChange={(next) =>
                                  saveMemberTags(coll.id, member.itemId, next)
                                }
                                // Not "a store": a collection's tags are
                                // whatever splits the list usefully, and that is
                                // not always a shop.
                                placeholder="Search or add"
                                label="Search or add a tag"
                                // Opened by tapping the Tag button, so it is
                                // ready to type into. Raises the keyboard
                                // immediately, which is the intent. The four
                                // item/intention pickers do NOT pass this —
                                // they sit in a form you may be scrolling past.
                                autoFocus
                                // The row above already shows these, removably.
                                showChips={false}
                              />
                            </div>
                          )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Recently removed — manual removals only, most recent first,
                    plus the entry point to the full history. The whole region
                    disappears when there is neither history nor an error to
                    report; an empty panel on a fresh collection is noise. */}
                {(recentRemovals.length > 0 ||
                  collectionRemovalsError ||
                  history.length > 0 ||
                  collectionHistoryError) && (
                  <div className="pt-4 border-t border-border">
                    {(recentRemovals.length > 0 || collectionRemovalsError) && (
                      <>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-base font-medium">Recently removed</h3>
                          {/* Also shown when the panel has rows but `history` is
                              stale: the poll refreshes removals, not history, so
                              a removal polled in from the other person would
                              otherwise have no way through to the full view.
                              The history view reloads on entry regardless. */}
                          {(history.length > 0 || recentRemovals.length > 0) && (
                            <button
                              onClick={() => setView("collection-history")}
                              className="min-h-[44px] text-sm text-primary hover:text-primary-hover"
                            >
                              View all
                            </button>
                          )}
                        </div>

                        {collectionRemovalsError && (
                          <p className="text-xs text-destructive mb-2">{collectionRemovalsError}</p>
                        )}

                        <div className="space-y-2">
                          {recentRemovals.map((removal) => (
                            <div
                              key={removal.id}
                              className="flex items-center gap-2 p-3 bg-card border border-border rounded-lg"
                            >
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">
                                  <ItemNameLabel name={removal.itemName} />
                                </p>
                                <RemovalMeta
                                  quantity={removal.quantity}
                                  tags={removal.tags}
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                  {friendlyDate(removal.removedAt)}
                                </p>
                              </div>
                              <button
                                // No overlay — Step 12.4, same aisle, same hand.
                                // The button disables via reAddingRemovalId while
                                // the write runs, which is feedback enough for a
                                // single row, and putBackRemoval reports its own
                                // failures.
                                onClick={() => putBackRemoval(removal)}
                                disabled={reAddingRemovalId !== null}
                                className="flex items-center gap-2 px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm shrink-0 disabled:opacity-50"
                              >
                                <ArchiveRestore className="w-4 h-4" />
                                Put back
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* A collection can have history worth reading while the panel
                        itself is empty — every removal was a completion, or every
                        manual one has been put back. Keep the history reachable. */}
                    {recentRemovals.length === 0 && !collectionRemovalsError && history.length > 0 && (
                      <button
                        onClick={() => setView("collection-history")}
                        className="flex items-center gap-2 min-h-[44px] text-sm text-primary hover:text-primary-hover"
                      >
                        <Archive className="w-4 h-4" />
                        View removal history
                      </button>
                    )}

                    {collectionHistoryError && (
                      <p className="text-xs text-destructive mt-2">{collectionHistoryError}</p>
                    )}
                  </div>
                )}

                <div className="pt-4 border-t border-border">
                  {/* Relabelled with the behaviour: this archives now, and the
                      row is recoverable from the Recycle Bin. The confirm is
                      gone — safety is the 5-second Undo, per governing rule 3.
                      Navigating away is unconditional because this page is
                      showing the record being archived. */}
                  <button
                    onClick={() => {
                      archiveCollection(coll.id);
                      setSelectedCollectionId(null);
                      setView("collections");
                    }}
                    className="px-4 py-2.5 min-h-[44px] bg-destructive hover:bg-destructive-hover text-white rounded-lg text-sm"
                  >
                    Archive Collection
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Collection Removal History View */}
        {view === "collection-history" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const history = collectionHistory[coll.id] || [];
          const groups = groupRemovalsByAction(history);

          return (
            <div>
              <button
                onClick={() => setView("collection-detail")}
                className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Collection
              </button>

              <h2 className="text-lg font-medium mb-1">Removal history</h2>
              <p className="text-sm text-muted-foreground mb-3">
                {coll.name.trim()} — newest first
                {history.length >= 50 ? ", most recent 50" : ""}
              </p>

              {collectionHistoryError && (
                <p className="text-xs text-destructive mb-2">{collectionHistoryError}</p>
              )}

              {groups.length === 0 ? (
                !collectionHistoryError && (
                  <p className="text-muted-foreground text-sm py-4 text-center">
                    Nothing has been removed from this collection.
                  </p>
                )
              ) : (
                <div className="space-y-3">
                  {groups.map((group, groupIndex) =>
                    // A single removal carries its own timestamp inline, the same
                    // shape as the panel row. A heading over one item would be
                    // ceremony for nothing. Bulk actions get the heading, so the
                    // timestamp is stated once instead of on every row.
                    group.rows.length === 1 ? (
                      <div
                        key={group.rows[0].id}
                        className="flex items-start gap-2 p-3 bg-card border border-border rounded-lg"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            <ItemNameLabel name={group.rows[0].itemName} />
                          </p>
                          <RemovalMeta
                            quantity={group.rows[0].quantity}
                            tags={group.rows[0].tags}
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            {friendlyDate(group.removedAt)}
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {removalReasonLabel(group.reason)}
                        </span>
                      </div>
                    ) : (
                      <div
                        key={`${group.removedAt}-${group.reason}-${groupIndex}`}
                        className="p-3 bg-card border border-border rounded-lg"
                      >
                        {/* Same header shape as a single entry — count in the slot
                            a lone item's name occupies, timestamp beneath, reason
                            label on the right — so the two read as two shapes of
                            one thing rather than two components. */}
                        <div className="flex items-start gap-2 pb-2 mb-2 border-b border-border">
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{group.rows.length} items</p>
                            <p className="text-xs text-muted-foreground">
                              {friendlyDate(group.removedAt)}
                            </p>
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {removalReasonLabel(group.reason)}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {group.rows.map((removal) => (
                            <div key={removal.id} className="min-w-0">
                              <p className="text-sm truncate">
                                <ItemNameLabel name={removal.itemName} />
                              </p>
                              {/* The group heading already states the time and
                                  the reason once; what a row still needs to say
                                  for itself is what it was. */}
                              <RemovalMeta
                                quantity={removal.quantity}
                                tags={removal.tags}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Collection Add Items View */}
        {/* The picker. Back is a bare setView("item-detail"): it touches
            neither previousView (the shared slot holding where item detail
            itself came from) nor itemHistoryStack (a stack of item ids for
            item-to-item navigation). selectedItemId is untouched by this
            navigation and this view is keyed on it in DETAIL_VIEW_STATE, so
            no return address is needed. Same as collection-add-items. */}
        {view === "item-add-to-collection" && (() => {
          const target = items.find((i) => i.id === selectedItemId);
          if (!target) return <p className="text-muted-foreground">Item not found</p>;
          return (
            <ItemAddToCollection
              item={target}
              items={items}
              collections={collections}
              contexts={contexts}
              onBack={() => setView("item-detail")}
              onAdd={(collectionId, picks) =>
                addElementsToCollection(collectionId, target, picks)
              }
            />
          );
        })()}

        {view === "collection-add-items" && (() => {
          const coll = collections.find((c) => c.id === selectedCollectionId);
          if (!coll) return <p className="text-muted-foreground">Collection not found</p>;
          const members = membersOf(coll.id);
          const existingItemIds = new Set(members.map((m) => m.itemId));
          const availableItems = items.filter((i) => !i.archived && !existingItemIds.has(i.id) && (!coll.contextId || i.contextId === coll.contextId));

          return (
            <CollectionAddItems
              availableItems={availableItems}
              contexts={contexts}
              collection={coll}
              onAdd={async (selectedItems) => {
                const added = await withLoading('Saving...', () =>
                  addItemsToCollection(
                    coll.id,
                    selectedItems.map((s) => ({ itemId: s.itemId, quantity: s.quantity })),
                  ),
                );
                // Stay on this screen if it failed, so the selection is not lost.
                if (added) setView("collection-detail");
              }}
              onCreateItem={async (itemName) => {
                // Create new item
                const newItem = {
                  id: uid(),
                  user_id: user.id,
                  name: itemName,
                  description: '',
                  contextId: coll.contextId,
                  elements: [],
                  tags: [],
                  isCaptureTarget: false,
                  createdAt: new Date().toISOString(),
                };

                // Save to database
                const context = contexts.find((c) => c.id === newItem.contextId);
                const isShared = context?.shared || false;
                const savedItem = await storage.set(`item:${newItem.id}`, newItem, isShared);

                // Add to local items state
                setItems((prev) => [...prev, savedItem || newItem]);

                // Add to collection
                const added = await addItemsToCollection(coll.id, [
                  { itemId: newItem.id, quantity: '' },
                ]);

                // Close dialog
                if (added) setView("collection-detail");
              }}
              onCancel={() => setView("collection-detail")}
              maxItems={200 - members.length}
            />
          );
        })()}

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

// Helper functions for the inbox screens
// Everything an enrichment produced, reset — Step 12.7.
//
// Applied when a capture's text is edited, because the suggestions describe text
// that no longer exists. `aiStatus` alone would not do it: the inbox detail page seeds its
// triage fields `suggestedIntentText || capturedText`, so a stale suggestion is
// what the form PROPOSES, not just a column nobody reads.
//
// Written out in full rather than derived, so adding a `suggested_*` column and
// forgetting it here shows up as a field this list does not mention. The columns
// are the ones enrichment writes — the alfred-enrich skill through
// `update_inbox_item` as of Clipboard Step 14, the ai-enrich function before
// that. Both write the same set; see the inbox table comment.
const CLEARED_ENRICHMENT = {
  aiStatus: "not_started",
  aiConfidence: null,
  aiReasoning: null,
  suggestedContextId: null,
  suggestItem: false,
  suggestedItemText: null,
  suggestedItemDescription: null,
  suggestedItemElements: null,
  suggestedItemId: null,
  suggestIntent: false,
  suggestedIntentText: null,
  suggestedIntentDescription: null,
  suggestedIntentRecurrence: null,
  suggestEvent: false,
  suggestedEventDate: null,
  suggestedTags: [],
  suggestedCollectionId: null,
};
