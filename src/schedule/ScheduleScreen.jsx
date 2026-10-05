import React from "react";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { EVENT_SORT_OPTIONS } from "../utils/listSortOptions";
import EventCard from "./EventCard";

// The Schedule screen, moved out of Alfred.jsx unchanged. Everything it reads comes
// in as props from Alfred.
export default function ScheduleScreen({
  allNonArchivedEvents,
  visibleScheduleEvents,
  allLiveExecutions,
  intents,
  contexts,
  items,
  getIntentDisplay,
  searchFor,
  setSearchFor,
  scheduleSort,
  updateEvent,
  activate,
  openExecution,
  cancelExecutionForEvent,
  viewIntentionDetail,
  viewItemDetail,
  viewContextDetail,
}) {
  return (
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
  );
}
