import React, { useState } from "react";
import { Archive, ArrowLeft, ChevronDown, Plus, Settings } from "lucide-react";
import { sortRows } from "../utils/sortOrders";
import { matchesQuery } from "../utils/search";
import {
  NAMED_RECORD_SORT_OPTIONS,
  NAMED_RECORD_ACCESSORS,
  INTENTION_ACCESSORS,
  itemSearchFields,
} from "../utils/listSortOptions";
import ObjectIcon from "../shared/ObjectIcon";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import TagFilter from "../shared/TagFilter";
import ContextForm from "./ContextForm";
import ItemCard from "../items/ItemCard";
import IntentionCard from "../intentions/IntentionCard";
import CollectionCard from "../collections/CollectionCard";

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
  events = [],
  onUpdateEvent,
  onActivate,
  onCancelExecution,
  onStartNow,
  onArchiveIntention,
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
}) {
  const [itemsExpanded, setItemsExpanded] = useState(true);
  const [intentionsExpanded, setIntentionsExpanded] = useState(true);
  // Editing happens here now. It used to set two pieces of Alfred state and
  // then navigate to the Contexts list to render the form there, so "Edit" on
  // this page silently moved you to a different screen — and browser Back left
  // the form open on a page that had not asked for it.
  const [isEditingContext, setIsEditingContext] = useState(false);
  const searching = search.trim() !== "";

  if (!context) return null;

  // One sort and one search drive all three lists, each filtered on its own —
  // nothing is merged or ranked. Filters what is already loaded: elements come
  // in with `select("*")` on items, so element text is searchable without a
  // fetch.
  const sortBy = (rows, accessors) =>
    sortRows(rows, sort.sortKey, accessors, sort.sortDir);
  const visibleItems = sortBy(items, NAMED_RECORD_ACCESSORS)
    .filter((item) => !filterTag || (item.tags && item.tags.includes(filterTag)))
    .filter((item) => matchesQuery(search, ...itemSearchFields(item)));
  const visibleIntents = sortBy(intents, INTENTION_ACCESSORS).filter((intent) =>
    matchesQuery(search, getIntentDisplay(intent)),
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
          {/* Record actions, top right. The spec asks for Edit · Archive here;
              Archive is absent because `contexts` has no `archived` column and
              adding one is a migration. See the Step 5 findings. */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0">
            <button
              onClick={() => setIsEditingContext((v) => !v)}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">
                {isEditingContext ? "Close Editor" : "Edit Context"}
              </span>
              <span className="sm:hidden">{isEditingContext ? "Close" : "Edit"}</span>
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
                <span className="hidden sm:inline">Archive</span>
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

      <div className="space-y-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setItemsExpanded(!itemsExpanded)}
              className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${itemsExpanded ? "" : "-rotate-90"}`} />
              Items ({searching ? `${visibleItems.length} of ${items.length}` : items.length})
            </button>
            <button
              onClick={() => onOpenAddItem()}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Plus className="w-4 h-4" />
              Add Item
            </button>
          </div>

          {itemsExpanded && (
            <>
              <TagFilter
                entities={items}
                activeTag={filterTag}
                onFilter={onFilterTag}
                collapsed={tagsCollapsed}
                onToggleCollapsed={onToggleTags}
              />
              {items.length === 0 ? (
                <p className="text-muted-foreground text-sm">No items in this context</p>
              ) : searching && visibleItems.length === 0 ? (
                <NoMatches noun="items" query={search} />
              ) : (
                <div className="space-y-2">
                  {visibleItems.map((item) => (
                    <ItemCard
                      tagPool={tagPool}
                      key={item.id}
                      item={item}
                      contexts={contexts}
                      onUpdate={onUpdateItem}
                      onViewDetail={onViewItemDetail}
                      allItems={allItems}
                      executions={executions.filter((ex) => ex.itemIds?.includes(item.id))}
                      intents={intents}
                      getIntentDisplay={getIntentDisplay}
                      onOpenExecution={onOpenExecution}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setIntentionsExpanded(!intentionsExpanded)}
              className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${intentionsExpanded ? "" : "-rotate-90"}`} />
              Intentions ({searching ? `${visibleIntents.length} of ${intents.length}` : intents.length})
            </button>
            <button
              onClick={() => onOpenAddIntention()}
              className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
            >
              <Plus className="w-4 h-4" />
              Add Intention
            </button>
          </div>

          {intentionsExpanded && (
            <>
              {intents.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No intentions in this context
                </p>
              ) : searching && visibleIntents.length === 0 ? (
                <NoMatches noun="intentions" query={search} />
              ) : (
                <div className="space-y-2">
                  {visibleIntents.map((intent) => (
                    <IntentionCard
                      tagPool={tagPool}
                      key={intent.id}
                      intent={intent}
                      contexts={contexts}
                      items={items}
                      collections={collections}
                      getIntentDisplay={getIntentDisplay}
                      onUpdate={onUpdateIntent}
                      onSchedule={onSchedule}
                      onStartNow={onStartNow}
                      showScheduling={true}
                      onViewDetail={onViewIntentionDetail}
                      events={events}
                      onUpdateEvent={onUpdateEvent}
                      onActivate={onActivate}
                      executions={executions}
                      onOpenExecution={onOpenExecution}
                      onCancelExecution={onCancelExecution}
                      onArchive={onArchiveIntention}
                    />
                  ))}
                </div>
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
      </div>
    </div>
  );
}
