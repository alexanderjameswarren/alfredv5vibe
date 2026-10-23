import React from "react";
import { Activity, Pause, Sun } from "lucide-react";
import UnderlineTabs from "../shared/UnderlineTabs";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { EVENT_SORT_OPTIONS } from "../utils/listSortOptions";
import { ExecutionList } from "../executions/InProgressSection";
import CollectionCard from "../collections/CollectionCard";
import ContextCard from "../contexts/ContextCard";
import GroupRowCard from "../groups/GroupRowCard";
import EventCard from "./EventCard";

// The Home screen, moved out of Alfred.jsx unchanged. Everything it reads comes in
// as props from Alfred.
export default function HomeScreen({
  executionTab,
  setExecutionTab,
  activeExecutions,
  pausedExecutions,
  allLiveExecutions,
  todayEvents,
  visibleTodayEvents,
  pinnedCollections,
  pinnedContexts,
  // Restructure P5: standard group rows (rowModel.buildGroupRows) for pinned, live groups.
  pinnedGroupRows = [],
  onOpenGroup,
  intents,
  contexts,
  items,
  getIntentDisplay,
  searchFor,
  setSearchFor,
  homeSort,
  updateEvent,
  activate,
  openExecution,
  cancelExecutionForEvent,
  viewIntentionDetail,
  viewItemDetail,
  viewContextDetail,
  membersOf,
  setPreviousView,
  setSelectedCollectionId,
  setView,
  archiveCollection,
}) {
  return (
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

        {/* Shared with the lists' In progress section (Restructure P4). */}
        {executionTab === "active" && (
          <ExecutionList
            executions={activeExecutions}
            intents={intents}
            contexts={contexts}
            getIntentDisplay={getIntentDisplay}
            onOpen={openExecution}
            emptyText="No active executions."
          />
        )}

        {executionTab === "paused" && (
          <ExecutionList
            executions={pausedExecutions}
            intents={intents}
            contexts={contexts}
            getIntentDisplay={getIntentDisplay}
            onOpen={openExecution}
            emptyText="No paused executions."
          />
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

      {/* Pinned Groups (Restructure P5): groups with pinned on, as Pinned Collections. */}
      {pinnedGroupRows.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-medium mb-3 text-foreground">Pinned Groups</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {pinnedGroupRows.map((row) => (
              <GroupRowCard
                key={row.key}
                row={row}
                contextName={contexts.find((c) => c.id === row.group.contextId)?.name}
                onOpen={onOpenGroup}
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
  );
}
