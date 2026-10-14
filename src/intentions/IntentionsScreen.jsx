import React from "react";
import { Plus } from "lucide-react";
import TagFilter from "../shared/TagFilter";
import StatusFilterChips from "../shared/StatusFilterChips";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import RowList from "../shared/RowList";
import InProgressSection from "../executions/InProgressSection";
import { INTENTION_SORT_OPTIONS, itemSearchFields } from "../utils/listSortOptions";
import { reminderBadge } from "../utils/remindersApi";
import { buildRows, listRows } from "../utils/rowModel";

// The Intentions list. Restructure P4: one row per item, built and filtered by the
// same row model as context detail (buildRows, listRows, RowList), so the two
// screens read and act alike. Items with no intention are not listed here.
export default function IntentionsScreen({
  liveIntentions,
  intentionsStatus,
  validEvents,
  allLiveExecutions,
  reminderIndex,
  tagPool,
  contexts,
  items,
  activeCollections,
  filterTag,
  setFilterTag,
  tagsCollapsedFor,
  toggleTagsFor,
  searchFor,
  setSearchFor,
  intentionsSort,
  getIntentDisplay,
  openAddPage,
  updateIntent,
  moveToPlanner,
  startNowFromIntention,
  viewIntentionDetail,
  viewItemDetail,
  startNowFromItem,
  scheduleFromItem,
  closeRecords,
  updateEvent,
  activate,
  openExecution,
  cancelExecutionForEvent,
}) {
  const search = searchFor("intentions");
  const rows = buildRows({
    items: (items || []).filter((i) => !i.archived),
    intents: liveIntentions,
    events: validEvents,
    openExecutions: allLiveExecutions,
    itemsWithoutIntents: false,
  });
  const { visibleRows, statusCounts, tagCountRows, total } = listRows({
    rows,
    openExecutions: allLiveExecutions,
    search,
    itemFields: itemSearchFields,
    filterTag,
    statuses: intentionsStatus.selected,
    sortKey: intentionsSort.sortKey,
    sortDir: intentionsSort.sortDir,
  });
  // The picked intention's reminder, else any of the row's intentions'.
  const reminderFor = (row) => {
    const ids = [row.intent?.id, ...row.intents.map((i) => i.id)].filter(Boolean);
    const hit = ids.find((id) => reminderIndex.byIntent[id]);
    return hit ? reminderBadge(reminderIndex.byIntent[hit]) : null;
  };

  return (
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

      {/* Every running and paused run, above the filters, which it ignores. */}
      <InProgressSection
        executions={allLiveExecutions}
        intents={liveIntentions}
        contexts={contexts}
        getIntentDisplay={getIntentDisplay}
        onOpen={openExecution}
      />

      <StatusFilterChips
        counts={statusCounts}
        selected={intentionsStatus.selected}
        onToggle={intentionsStatus.toggle}
      />

      {/* Counts rows the search and status chips let through. */}
      <TagFilter
        entities={tagCountRows}
        activeTag={filterTag}
        onFilter={setFilterTag}
        collapsed={tagsCollapsedFor("intentions")}
        onToggleCollapsed={toggleTagsFor("intentions")}
      />

      {/* Step 12.8. This page was missed by Step 9b, so until now it had no
          sort control AND no ordering — a bare `.filter()` over a query with
          no ORDER BY, which is arbitrary rather than merely undocumented. */}
      {total > 0 && (
        <ListToolbar
          query={search}
          onQueryChange={setSearchFor("intentions")}
          searchLabel="Search intentions"
          sortId="intentions-sort"
          sortOptions={INTENTION_SORT_OPTIONS}
          sort={intentionsSort}
          className="mb-3"
        />
      )}

      {total === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>{rows.length === 0 ? "No intentions yet." : "Everything here is in progress."}</p>
        </div>
      ) : search.trim() && visibleRows.length === 0 ? (
        <NoMatches noun="intentions" query={search} />
      ) : visibleRows.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>Nothing matches the filters above.</p>
        </div>
      ) : (
        <RowList
          rows={visibleRows}
          events={validEvents}
          executions={allLiveExecutions}
          contexts={contexts}
          allItems={items || []}
          allIntents={liveIntentions}
          collections={activeCollections}
          tagPool={tagPool}
          getIntentDisplay={getIntentDisplay}
          onUpdateIntent={updateIntent}
          onSchedule={moveToPlanner}
          onStartNow={startNowFromIntention}
          onStartNowItem={startNowFromItem}
          onScheduleItem={scheduleFromItem}
          onViewItemDetail={(id) => viewItemDetail?.(id, "intentions")}
          onViewIntentionDetail={(id) => viewIntentionDetail(id, "intentions")}
          onUpdateEvent={updateEvent}
          onActivate={activate}
          onOpenExecution={openExecution}
          onCancelExecution={cancelExecutionForEvent}
          onCloseRecords={closeRecords}
          reminderFor={reminderFor}
        />
      )}
    </div>
  );
}
