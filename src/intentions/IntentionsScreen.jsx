import React from "react";
import { Plus } from "lucide-react";
import TagFilter from "../shared/TagFilter";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { INTENTION_SORT_OPTIONS } from "../utils/listSortOptions";
import { reminderBadge } from "../utils/remindersApi";
import IntentionCard from "./IntentionCard";

// The Intentions list screen, moved out of Alfred.jsx unchanged. Everything it reads
// comes in as props from Alfred.
export default function IntentionsScreen({
  intentionsWithoutActiveEvent,
  visibleIntentions,
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
  updateEvent,
  activate,
  openExecution,
  cancelExecutionForEvent,
  archiveIntention,
}) {
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
  );
}
