import React from "react";
import { Plus } from "lucide-react";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { sortRows } from "../utils/sortOrders";
import { matchesQuery } from "../utils/search";
import {
  NAMED_RECORD_SORT_OPTIONS,
  NAMED_RECORD_ACCESSORS,
} from "../utils/listSortOptions";
import CollectionCard from "./CollectionCard";

// The collections list, moved out of Alfred.jsx unchanged apart from the
// `view === "collections"` test, which stays in Alfred around this component.
export default function CollectionsScreen({
  activeCollections,
  contexts,
  collectionContextFilter,
  setCollectionContextFilter,
  collectionsSort,
  searchFor,
  setSearchFor,
  membersOf,
  addCollection,
  archiveCollection,
  setPreviousView,
  setSelectedCollectionId,
  setView,
}) {
  return (
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
  );
}
