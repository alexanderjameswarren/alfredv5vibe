import React from "react";
import { Plus } from "lucide-react";
import ListToolbar, { NoMatches } from "../shared/ListToolbar";
import { NAMED_RECORD_SORT_OPTIONS } from "../utils/listSortOptions";
import ContextForm from "./ContextForm";
import ContextCard from "./ContextCard";

// The Contexts list screen, moved out of Alfred.jsx unchanged. Everything it reads
// comes in as props from Alfred.
export default function ContextsScreen({
  activeContexts,
  visibleContexts,
  collections,
  showContextForm,
  setShowContextForm,
  editingContext,
  setEditingContext,
  saveContext,
  setUnsavedChanges,
  searchFor,
  setSearchFor,
  contextsSort,
  viewContextDetail,
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <h2 className="text-lg sm:text-xl font-medium">Contexts</h2>
        <button
          onClick={() => {
            setEditingContext(null);
            setShowContextForm(true);
          }}
          className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base"
        >
          <Plus className="w-4 h-4" />
          Add Context
        </button>
      </div>

      {showContextForm ? (
        <ContextForm
          editing={editingContext}
          stickyFooter
          collections={collections}
          onSave={saveContext}
          onCancel={() => {
            setShowContextForm(false);
            setEditingContext(null);
          }}
          onDirtyChange={setUnsavedChanges}
        />
      ) : activeContexts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p>No contexts yet.</p>
          <p className="text-sm mt-2">
            Add a context to define how things get done.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <ListToolbar
            query={searchFor("contexts")}
            onQueryChange={setSearchFor("contexts")}
            searchLabel="Search contexts"
            sortId="contexts-sort"
            sortOptions={NAMED_RECORD_SORT_OPTIONS}
            sort={contextsSort}
            className="mb-1"
          />
          {/* Was a hardcoded `.sort(a.name.localeCompare(b.name))`. That
              order is now this page's DEFAULT rather than its only option.

              Context DETAIL has its own control as of the search work —
              one row for all three of its lists; see `contextDetailSort`. */}
          {visibleContexts.length === 0 ? (
            <NoMatches noun="contexts" query={searchFor("contexts")} />
          ) : (
            visibleContexts.map((context) => (
              <ContextCard
                key={context.id}
                context={context}
                onClick={() => viewContextDetail(context.id)}
                onEdit={() => {
                  setEditingContext(context);
                  setShowContextForm(true);
                }}
                showSettings={true}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
