import React from "react";
import TagFilter from "../shared/TagFilter";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { NAMED_RECORD_SORT_OPTIONS } from "../utils/listSortOptions";
import { reminderBadge, itemReminder } from "../utils/remindersApi";
import ItemCard from "./ItemCard";

// The Memories list screen, moved out of Alfred.jsx unchanged. Everything it reads
// comes in as props from Alfred.
export default function MemoriesScreen({
  memoriesWithoutContext,
  visibleMemories,
  allLiveExecutions,
  reminderIndex,
  tagPool,
  contexts,
  intents,
  filterTag,
  setFilterTag,
  tagsCollapsedFor,
  toggleTagsFor,
  searchFor,
  setSearchFor,
  memoriesSort,
  getIntentDisplay,
  updateItem,
  viewItemDetail,
  openExecution,
}) {
  return (
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
  );
}
