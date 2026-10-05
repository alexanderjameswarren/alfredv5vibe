import React from "react";
import UnderlineTabs from "../shared/UnderlineTabs";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { INBOX_SORT_OPTIONS } from "../utils/listSortOptions";
import { reminderBadge } from "../utils/remindersApi";
import { archiveOutcome } from "../utils/inboxArchive";
import InboxListCard from "./InboxListCard";
import RecentlyArchived from "./RecentlyArchived";

// The inbox list, moved out of Alfred.jsx unchanged apart from the
// `view === "inbox"` test, which stays in Alfred around this component.
export default function InboxScreen({
  inboxItems,
  visibleInboxItems,
  inboxSourceTabs,
  activeInboxSource,
  setInboxSourceTab,
  searchFor,
  setSearchFor,
  inboxSort,
  contexts,
  items,
  intents,
  events,
  reminderIndex,
  openInboxDetail,
  processInboxItemFromList,
  copyTaskInboxItem,
  discardInboxItem,
  archivedInboxItems,
  olderArchived,
  archivedShowAll,
  setArchivedShowAll,
  archivedExpanded,
  setArchivedExpanded,
  unarchiveInboxItem,
}) {
  return (
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
  );
}
