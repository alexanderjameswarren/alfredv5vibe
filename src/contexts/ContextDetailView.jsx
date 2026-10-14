import React, { useState } from "react";
import { Archive, ArrowLeft, ChevronDown, Plus, Settings } from "lucide-react";
import { sortRows } from "../utils/sortOrders";
import { matchesQuery } from "../utils/search";
import {
  NAMED_RECORD_SORT_OPTIONS,
  NAMED_RECORD_ACCESSORS,
  itemSearchFields,
} from "../utils/listSortOptions";
import { buildRows, rankRows, rowSearchFields, ROW_ACCESSORS } from "../utils/rowModel";
import useRowClose from "../shared/useRowClose";
import ObjectIcon from "../shared/ObjectIcon";
import StatusFilterChips from "../shared/StatusFilterChips";
import {
  DEFAULT_STATUS_FILTER,
  STATUS_LABELS,
  statusOf,
  statusCounts,
  filterByStatus,
  rankByStatus,
  withTag,
} from "../utils/status";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import TagFilter from "../shared/TagFilter";
import ContextForm from "./ContextForm";
import ItemCard from "../items/ItemCard";
import IntentionCard from "../intentions/IntentionCard";
import CollectionCard from "../collections/CollectionCard";
import AppIcon from "../apps/AppIcon";
import { findApp } from "../apps/appsApi";
import useApps from "../apps/useApps";

export default function ContextDetailView({
  tagPool = [],
  // Step 12.6: both add forms are pages now, so this view only has to say
  // "open the add page for THIS context" — the target travels in the URL.
  onOpenAddItem,
  onOpenAddIntention,
  contextId,
  context,
  items,
  intents,
  contexts,
  onBack,
  getIntentDisplay,
  onUpdateItem,
  onUpdateIntent,
  onSchedule,
  onSaveContext,
  onArchiveContext,
  archiveBlockers = [],
  onAddItem,
  onAddIntention,
  onViewIntentionDetail,
  onViewItemDetail,
  executions = [],
  onOpenExecution,
  allIntents,
  events = [],
  onUpdateEvent,
  onActivate,
  onCancelExecution,
  onStartNow,
  onCloseRecords,
  // Item detail's own Start Now and Schedule, for item rows with no live intention.
  onStartNowItem,
  onScheduleItem,
  filterTag,
  onFilterTag,
  // Owned by Alfred alongside `search`, for the same reason: both must survive
  // opening a record here and pressing Back.
  tagsCollapsed = false,
  onToggleTags,
  allItems = [],
  collections = [],
  collectionMembers = {},
  onViewCollection,
  onArchiveCollection,
  onDirtyChange,
  // Owned by Alfred so they survive opening a record here and pressing Back.
  sort,
  search = "",
  onSearchChange,
  // Status chips (088), one row for items and intentions alike, saved per page.
  statusFilter = { selected: DEFAULT_STATUS_FILTER, toggle: () => {} },
  // This context's archived records: the record of what has shipped.
  archivedItems = [],
  archivedIntents = [],
}) {
  const [rowsExpanded, setRowsExpanded] = useState(true);
  const rowClose = useRowClose({ events, executions, onCloseRecords });
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // Editing happens here now. It used to set two pieces of Alfred state and
  // then navigate to the Contexts list to render the form there, so "Edit" on
  // this page silently moved you to a different screen — and browser Back left
  // the form open on a page that had not asked for it.
  const [isEditingContext, setIsEditingContext] = useState(false);
  const apps = useApps();
  const searching = search.trim() !== "";

  if (!context) return null;
  const app = findApp(apps, context.appId);

  // One row per thing (Restructure P4): an item and its intentions are one row.
  // Status chips, tag filter, sort and search all apply to the same rows, so the
  // counts match what the list shows.
  const sortBy = (rows, accessors) =>
    rankByStatus(sortRows(rows, sort.sortKey, accessors, sort.sortDir));
  const rows = buildRows({ items, intents, events, openExecutions: executions });
  // Tag and search first, so each chip counts the rows it would show on its own.
  // Each filter's counts apply every other filter: tags count under search and
  // status chips, status chips under search and tag.
  const searched = rows.filter((row) => matchesQuery(search, ...rowSearchFields(row, itemSearchFields)));
  const matching = withTag(searched, filterTag);
  const statusCountsHere = statusCounts(matching);
  const tagCountRows = filterByStatus(searched, statusFilter.selected);
  // What is happening now first, the chosen sort within each group.
  const visibleRows = rankRows(
    sortRows(filterByStatus(matching, statusFilter.selected), sort.sortKey, ROW_ACCESSORS, sort.sortDir),
  );
  // "n of m" whenever anything is hidden, by search or by a chip.
  const countLabel = (shown, total) => (shown === total ? `${total}` : `${shown} of ${total}`);
  const archivedRows = [
    ...archivedItems.map((r) => ({ kind: "item", id: r.id, label: r.name, row: r })),
    ...archivedIntents.map((r) => ({ kind: "intention", id: r.id, label: getIntentDisplay(r), row: r })),
  ].sort((a, b) =>
    String(b.row.statusChangedAt || b.row.updatedAt || "").localeCompare(
      String(a.row.statusChangedAt || a.row.updatedAt || ""),
    ),
  );
  const contextCollections = collections.filter((c) => c.contextId === contextId);
  const visibleCollections = sortBy(contextCollections, NAMED_RECORD_ACCESSORS).filter(
    (coll) => matchesQuery(search, coll.name),
  );

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      {isEditingContext && (
        <div className="mb-4 sm:mb-6">
          {/* onSave below forwards with (...args), so it is positionally
              transparent: the new defaultCollectionId argument flows through
              without an edit here. The other three layers are explicit and all
              had to change. */}
          <ContextForm
            editing={context}
            collections={collections}
            onSave={async (...args) => {
              await onSaveContext(context, ...args);
              setIsEditingContext(false);
            }}
            onCancel={() => setIsEditingContext(false)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold">
            <ObjectIcon type="context" className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{context.name}</span>
          </h2>
          {/* Record actions, top right: Edit · Archive. */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            <button
              onClick={() => setIsEditingContext((v) => !v)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              {isEditingContext ? "Close" : "Edit"}
            </button>
            {/* Only while the context is empty. Contexts are taxonomy: nothing
                cascades, so archiving one that still holds records would strand
                them under a parent the UI no longer shows — and an archived
                child would be strandable in a way nothing could reach.
                Disabled-with-a-reason, reading the same way as the
                active-execution guards on EventCard and IntentionCard. */}
            {onArchiveContext && (
              <button
                onClick={() => onArchiveContext(context.id)}
                disabled={archiveBlockers.length > 0}
                title={
                  archiveBlockers.length > 0
                    ? `Cannot archive: still holds ${archiveBlockers.join(", ")}`
                    : "Archive this context"
                }
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base ${
                  archiveBlockers.length > 0
                    ? "bg-secondary text-muted-foreground cursor-not-allowed"
                    : "bg-destructive hover:bg-destructive-hover text-white"
                }`}
              >
                <Archive className="w-4 h-4" />
                Archive
              </button>
            )}
          </div>
        </div>
        {context.description && (
          <p className="text-muted-foreground">{context.description}</p>
        )}
        {context.keywords && (
          <p className="text-sm text-muted-foreground mt-1">
            Keywords: {context.keywords}
          </p>
        )}
        {app && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground mt-1">
            App:
            <AppIcon icon={app.icon} className="w-4 h-4 text-primary" />
            <span>{app.name}</span>
          </p>
        )}
      </div>

      {(items.length > 0 || intents.length > 0 || contextCollections.length > 0) && (
        <ListToolbar
          query={search}
          onQueryChange={onSearchChange}
          searchLabel="Search this context"
          sortId="context-detail-sort"
          sortOptions={NAMED_RECORD_SORT_OPTIONS}
          sort={sort}
          className="mb-3"
        />
      )}
      {(items.length > 0 || intents.length > 0) && (
        <StatusFilterChips
          counts={statusCountsHere}
          selected={statusFilter.selected}
          onToggle={statusFilter.toggle}
        />
      )}

      <div className="space-y-6">
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <button
              onClick={() => setRowsExpanded(!rowsExpanded)}
              className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${rowsExpanded ? "" : "-rotate-90"}`} />
              Items and intentions ({countLabel(visibleRows.length, rows.length)})
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => onOpenAddItem()}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                Add Item
              </button>
              <button
                onClick={() => onOpenAddIntention()}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
              >
                <Plus className="w-4 h-4" />
                Add Intention
              </button>
            </div>
          </div>

          {rowsExpanded && (
            <>
              {/* Counts rows the search and status chips let through. */}
              <TagFilter
                entities={tagCountRows}
                activeTag={filterTag}
                onFilter={onFilterTag}
                collapsed={tagsCollapsed}
                onToggleCollapsed={onToggleTags}
              />
              {rows.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing in this context yet</p>
              ) : searching && visibleRows.length === 0 ? (
                <NoMatches noun="items or intentions" query={search} />
              ) : visibleRows.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing matches the filters above</p>
              ) : (
                <div className="space-y-2">
                  {visibleRows.map((row) =>
                    row.intent ? (
                      <IntentionCard
                        tagPool={tagPool}
                        key={row.key}
                        row={row}
                        intent={row.intent}
                        contexts={contexts}
                        items={items}
                        collections={collections}
                        getIntentDisplay={getIntentDisplay}
                        onUpdate={onUpdateIntent}
                        onSchedule={onSchedule}
                        onStartNow={onStartNow}
                        showScheduling={true}
                        // A merged row is the item: it opens item detail, and has no
                        // Archive, which would archive only the intention.
                        onViewDetail={row.item ? () => onViewItemDetail?.(row.item.id) : onViewIntentionDetail}
                        events={events}
                        onUpdateEvent={onUpdateEvent}
                        onActivate={onActivate}
                        executions={executions}
                        onOpenExecution={onOpenExecution}
                        onCancelExecution={onCancelExecution}
                        // Rows close; Archive is on the detail pages.
                        {...rowClose.closeProps(row)}
                      />
                    ) : (
                      <ItemCard
                        tagPool={tagPool}
                        key={row.key}
                        item={row.item}
                        contexts={contexts}
                        onUpdate={onUpdateItem}
                        onViewDetail={onViewItemDetail}
                        allItems={allItems}
                        executions={executions.filter((ex) => ex.itemIds?.includes(row.item.id))}
                        // Every intention, not this context's: a run's intention may
                        // live elsewhere, and a badge that cannot find it reads "Execution".
                        intents={allIntents || intents}
                        getIntentDisplay={getIntentDisplay}
                        onOpenExecution={onOpenExecution}
                        scheduleLine={row.intents.length > 0 ? "Not scheduled" : null}
                        onStartNow={onStartNowItem}
                        onSchedule={onScheduleItem}
                        {...rowClose.closeProps(row)}
                      />
                    ),
                  )}
                </div>
              )}
              {rowClose.sheet}
            </>
          )}
        </div>

        {/* Collections Section */}
        <div>
          <h3 className="text-base sm:text-lg font-medium mb-3">
            Collections ({searching ? `${visibleCollections.length} of ${contextCollections.length}` : contextCollections.length})
          </h3>
          {(() => {
            if (contextCollections.length === 0) {
              return (
                <p className="text-muted-foreground text-sm">
                  No collections in this context
                </p>
              );
            }
            if (visibleCollections.length === 0) {
              return <NoMatches noun="collections" query={search} />;
            }
            return (
              <div className="space-y-2">
                {visibleCollections.map((coll) => (
                  <CollectionCard
                    key={coll.id}
                    collection={coll}
                    memberCount={(collectionMembers[coll.id] || []).length}
                    // Every row here already shares this context, so the chip
                    // would repeat the page heading. This is the one difference
                    // between the three sites that was adaptation, not drift.
                    showContextBadge={false}
                    onOpen={() => onViewCollection && onViewCollection(coll.id)}
                    onArchive={onArchiveCollection}
                  />
                ))}
              </div>
            );
          })()}
        </div>

        {/* Archived items and intentions — what this context has shipped.
            Collapsed; newest change first. Restoring stays in the Recycle Bin. */}
        <div>
          <button
            onClick={() => setArchivedExpanded((v) => !v)}
            aria-expanded={archivedExpanded}
            className="flex items-center gap-2 mb-3 text-base sm:text-lg font-medium text-foreground"
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${archivedExpanded ? "" : "-rotate-90"}`} />
            Archived ({archivedRows.length})
          </button>
          {archivedExpanded &&
            (archivedRows.length === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing archived in this context</p>
            ) : (
              <ul className="space-y-1.5">
                {archivedRows.map((r) => (
                  <li key={`${r.kind}-${r.id}`}>
                    <button
                      onClick={() =>
                        r.kind === "item" ? onViewItemDetail?.(r.id) : onViewIntentionDetail?.(r.id)
                      }
                      className="w-full flex items-center gap-2 px-3 py-2 min-h-[44px] text-left bg-card border border-border rounded-lg hover:border-primary transition-colors"
                    >
                      <ObjectIcon
                        type={r.kind === "item" ? "item" : "intention"}
                        className="w-4 h-4 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 flex-1 truncate">{r.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {STATUS_LABELS[statusOf(r.row)]}
                        {archivedDate(r.row) && ` · ${archivedDate(r.row)}`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </div>
  );
}

function archivedDate(row) {
  const raw = row.statusChangedAt || row.updatedAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
