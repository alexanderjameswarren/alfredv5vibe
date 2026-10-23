import React, { useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, Plus, Settings } from "lucide-react";
import { sortRows } from "../utils/sortOrders";
import { matchesQuery } from "../utils/search";
import {
  CONTEXT_DETAIL_SORT_OPTIONS,
  NAMED_RECORD_ACCESSORS,
  itemSearchFields,
} from "../utils/listSortOptions";
import { buildGroupRows, buildRows, hasOpenRun, listRows, rowTabs, rowsForTab } from "../utils/rowModel";
import RowList from "../shared/RowList";
import UnderlineTabs from "../shared/UnderlineTabs";
import InProgressSection from "../executions/InProgressSection";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import { groupDisplayName } from "../groups/groupModel";
import { archivedOnLabel, byNewestArchive } from "../shared/archivedRecord";
import StatusFilterChips from "../shared/StatusFilterChips";
import {
  DEFAULT_STATUS_FILTER,
  STATUS_LABELS,
  statusOf,
  rankByStatus,
} from "../utils/status";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import TagFilter from "../shared/TagFilter";
import ContextForm from "./ContextForm";
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
  // Arrived from a context card's gear: open on the edit page, and say so once.
  openInEdit = false,
  onEditOpened,
  // Restructure P5 (step 11): this context's groups (archived ones included) and
  // what names and counts them.
  groups = [],
  groupTypes = [],
  groupMembers = [],
  onViewGroupDetail,
  onOpenCreateGroup,
  // The selected tab, held by Alfred per context so Back from a record keeps it
  // (as the inbox's source tab is). Falls back to local state when not given.
  rowTab: heldTab,
  onRowTabChange,
}) {
  const [rowsExpanded, setRowsExpanded] = useState(true);
  const [localTab, setLocalTab] = useState("all");
  const rowTab = heldTab ?? localTab;
  const setRowTab = onRowTabChange || setLocalTab;
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  // The one context edit form (Restructure P4): a full page, as item detail's
  // edit is, reached from Edit here or from a context card's gear (`openInEdit`).
  // Leaving it returns to where you came from.
  const [isEditingContext, setIsEditingContext] = useState(Boolean(openInEdit));
  const [cameFromList] = useState(Boolean(openInEdit));
  useEffect(() => {
    if (openInEdit) onEditOpened?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const apps = useApps();
  const searching = search.trim() !== "";

  if (!context) return null;
  const app = findApp(apps, context.appId);
  const leaveEdit = () => (cameFromList ? onBack() : setIsEditingContext(false));

  if (isEditingContext) {
    return (
      <div>
        <button
          onClick={leaveEdit}
          className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        {/* onSave forwards with (...args), so it is positionally transparent. */}
        <ContextForm
          editing={context}
          collections={collections}
          groupTypes={groupTypes}
          stickyFooter
          onSave={async (...args) => {
            await onSaveContext(context, ...args);
            leaveEdit();
          }}
          onCancel={leaveEdit}
          onDirtyChange={onDirtyChange}
          onArchive={
            onArchiveContext &&
            (async () => {
              await onArchiveContext(context.id);
              onBack();
            })
          }
          archiveBlockers={archiveBlockers}
        />
      </div>
    );
  }

  // One row per thing (Restructure P4): an item and its intentions are one row.
  // Status chips, tag filter, sort and search all apply to the same rows, so the
  // counts match what the list shows.
  const sortBy = (rows, accessors) =>
    rankByStatus(sortRows(rows, sort.sortKey, accessors, sort.sortDir));
  // Groups sit in the same list (Restructure P5), sorted and filtered with the rest.
  const memberLists = { members: groupMembers, items: allItems.length ? allItems : items, intents: allIntents || intents };
  const liveGroups = groups.filter((g) => !g.archived);
  const rows = [
    ...buildRows({ items, intents, events, openExecutions: executions }),
    ...buildGroupRows({ groups: liveGroups, groupTypes, ...memberLists }),
  ];
  const { visibleRows: filteredRows, statusCounts: statusCountsHere, tagCountRows, total } = listRows({
    rows,
    openExecutions: executions,
    search,
    itemFields: itemSearchFields,
    filterTag,
    statuses: statusFilter.selected,
    sortKey: sort.sortKey,
    sortDir: sort.sortDir,
  });
  // Tabs only once the context has a live group; their counts follow the filters.
  const tabs = liveGroups.length > 0 ? rowTabs(filteredRows) : [];
  const activeTab = tabs.some((t) => t.key === rowTab) ? rowTab : "all";
  const visibleRows = rowsForTab(filteredRows, activeTab);
  const typePlurals = [...new Set(rows.filter((r) => r.kind === "group").map((r) => (r.type?.labelPlural || "groups").toLowerCase()))];
  const sectionTitle =
    typePlurals.length === 0
      ? "Items and intentions"
      : `Items, intentions${typePlurals.length > 1 ? `, ${typePlurals.slice(0, -1).join(", ")}` : ""} and ${typePlurals[typePlurals.length - 1]}`;
  const defaultType = groupTypes.find((t) => t.id === context.defaultGroupTypeId);
  const createGroupLabel = createGroupButtonLabel(defaultType);
  // "n of m" whenever anything is hidden, by search or by a chip.
  const countLabel = (shown, total) => (shown === total ? `${total}` : `${shown} of ${total}`);
  const archivedRows = [
    ...archivedItems.map((r) => ({ kind: "item", id: r.id, label: r.name, row: r })),
    ...archivedIntents.map((r) => ({ kind: "intention", id: r.id, label: getIntentDisplay(r), row: r })),
    ...groups
      .filter((g) => g.archived)
      .map((g) => ({
        kind: "group",
        id: g.id,
        label: groupDisplayName(g, memberLists) || "Untitled group",
        icon: groupTypes.find((t) => t.id === g.groupTypeId)?.icon,
        row: g,
      })),
  ].sort((a, b) => byNewestArchive(a.row, b.row));
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

      <div className="mb-4 sm:mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h2 className="flex items-start gap-2 text-xl sm:text-2xl font-bold">
            <ObjectIcon type="context" className="w-6 h-6 text-primary" align="first-line" />
            <span className="min-w-0">{context.name}</span>
          </h2>
          {/* Record actions, top right: Edit. */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            <button
              onClick={() => setIsEditingContext(true)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              Edit
            </button>
            {/* Archive moved to the edit form (Restructure P4). Still only while
                the context is empty: contexts are taxonomy and nothing cascades. */}
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

      {/* Above the search: runs here ignore search, tags, chips and sort. */}
      <InProgressSection
        // This context's runs, and any run that takes one of its rows out of the list.
        executions={executions.filter(
          (x) => x.contextId === contextId || rows.some((r) => hasOpenRun(r, [x])),
        )}
        intents={allIntents || intents}
        contexts={contexts}
        getIntentDisplay={getIntentDisplay}
        onOpen={onOpenExecution}
      />

      {(items.length > 0 || intents.length > 0 || liveGroups.length > 0 || contextCollections.length > 0) && (
        <ListToolbar
          query={search}
          onQueryChange={onSearchChange}
          searchLabel="Search this context"
          sortId="context-detail-sort"
          sortOptions={CONTEXT_DETAIL_SORT_OPTIONS}
          sort={sort}
          className="mb-3"
        />
      )}
      {(items.length > 0 || intents.length > 0 || liveGroups.length > 0) && (
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
              {sectionTitle} ({countLabel(filteredRows.length, total)})
            </button>
            <div className="flex flex-wrap gap-2">
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
              {onOpenCreateGroup && (
                <button
                  onClick={() => onOpenCreateGroup()}
                  className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
                >
                  <Plus className="w-4 h-4" />
                  {createGroupLabel}
                </button>
              )}
            </div>
          </div>

          {rowsExpanded && (
            <>
              {tabs.length > 0 && (
                <UnderlineTabs
                  ariaLabel="Show items, intentions or groups"
                  tabs={tabs.map(({ key, label, count }) => ({ key, label, count }))}
                  activeKey={activeTab}
                  onSelect={setRowTab}
                  className="gap-4 sm:gap-6 mb-3"
                />
              )}
              {/* Counts rows the search and status chips let through. */}
              <TagFilter
                entities={tagCountRows}
                activeTag={filterTag}
                onFilter={onFilterTag}
                collapsed={tagsCollapsed}
                onToggleCollapsed={onToggleTags}
              />
              {total === 0 ? (
                <p className="text-muted-foreground text-sm">
                  {rows.length === 0 ? "Nothing in this context yet" : "Everything here is in progress"}
                </p>
              ) : searching && visibleRows.length === 0 ? (
                <NoMatches noun={liveGroups.length > 0 ? "items, intentions or groups" : "items or intentions"} query={search} />
              ) : visibleRows.length === 0 ? (
                <p className="text-muted-foreground text-sm">Nothing matches the filters above</p>
              ) : (
                <RowList
                  rows={visibleRows}
                  events={events}
                  executions={executions}
                  contexts={contexts}
                  allItems={allItems.length ? allItems : items}
                  allIntents={allIntents || intents}
                  collections={collections}
                  tagPool={tagPool}
                  getIntentDisplay={getIntentDisplay}
                  onUpdateIntent={onUpdateIntent}
                  onUpdateItem={onUpdateItem}
                  onSchedule={onSchedule}
                  onStartNow={onStartNow}
                  onStartNowItem={onStartNowItem}
                  onScheduleItem={onScheduleItem}
                  onViewItemDetail={onViewItemDetail}
                  onViewIntentionDetail={onViewIntentionDetail}
                  onUpdateEvent={onUpdateEvent}
                  onActivate={onActivate}
                  onOpenExecution={onOpenExecution}
                  onCancelExecution={onCancelExecution}
                  onCloseRecords={onCloseRecords}
                  onViewGroupDetail={onViewGroupDetail}
                />
              )}
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
                        r.kind === "item"
                          ? onViewItemDetail?.(r.id)
                          : r.kind === "group"
                            ? onViewGroupDetail?.(r.id)
                            : onViewIntentionDetail?.(r.id)
                      }
                      className="w-full flex items-center gap-2 px-3 py-2 min-h-[44px] text-left bg-card border border-border rounded-lg hover:border-primary transition-colors"
                    >
                      {r.kind === "group" ? (
                        <GroupTypeIcon icon={r.icon} className="w-4 h-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ObjectIcon
                          type={r.kind === "item" ? "item" : "intention"}
                          className="w-4 h-4 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{r.label}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {STATUS_LABELS[statusOf(r.row)]}
                        {archivedOnLabel(r.row) && ` · ${archivedOnLabel(r.row)}`}
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

/** "Create Menu" from the context's default group type; "Add Group" when it has none. */
export function createGroupButtonLabel(defaultType) {
  return defaultType?.labelSingular ? `Create ${defaultType.labelSingular}` : "Add Group";
}
