import React from "react";
import SortControl from "./SortControl";
import SearchInput from "./SearchInput";

// The row above a list: search on the left, sort on the right. One component
// so the eight pages that carry it cannot drift apart.
//
// The search takes whatever width the sort control leaves. On a screen too
// narrow for both (under ~140px for the box) it wraps onto its own line and
// the sort control stays right-aligned beneath it.
//
// `sort` is the object `useSortPreference` returns.
export default function ListToolbar({
  query,
  onQueryChange,
  searchLabel,
  sortId,
  sortOptions,
  sort,
  className = "",
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <SearchInput
        value={query}
        onChange={onQueryChange}
        label={searchLabel}
        className="flex-1 min-w-[140px]"
      />
      <SortControl
        id={sortId}
        options={sortOptions}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onChooseKey={sort.chooseKey}
        onToggleDir={sort.toggleDir}
        className="ml-auto"
      />
    </div>
  );
}

// Shown in place of a list whose search matched nothing. The list's own
// "nothing here yet" message is for an empty list, which is a different state.
export function NoMatches({ noun, query }) {
  return (
    <p className="text-muted-foreground text-sm">
      No {noun} match &quot;{query.trim()}&quot;
    </p>
  );
}
