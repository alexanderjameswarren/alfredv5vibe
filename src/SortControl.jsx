import React, { useEffect, useState } from "react";
import { ArrowUp, ArrowDown } from "lucide-react";
import {
  defaultDirectionFor,
  readStoredSort,
  writeStoredSort,
} from "./utils/sortOrders";

// The shared sort control. Step 9a of
// docs/technical-spec-ui-standardization.md.
//
// Extracted from BrowseTabs.jsx, where it was inline JSX. The markup is
// unchanged apart from taking its options as a prop — including the two
// accessibility hooks SAM's tests bind to, which are load-bearing rather than
// decorative:
//
//   * the <label> reads "Sort by" and is associated with the <select>, so the
//     dropdown is reachable by its name;
//   * the direction button's aria-label names both the ACTION and the CURRENT
//     STATE ("Sort ascending — currently descending"), so a screen reader user
//     knows which way the list is ordered without inspecting it, and a test can
//     assert the label stays truthful.
//
// Deliberately not styled per-page: the same control on five list pages plus
// SAM should look like one control.

/**
 * Owns the sort preference for one page, including its persistence.
 *
 * @param {string} storageKey  e.g. "alfred.sort.schedule" — one per page
 * @param {Array}  options     [{ value, label, defaultDir }]
 * @param {string} defaultKey  the page's default field
 */
export function useSortPreference(storageKey, options, defaultKey) {
  // Read synchronously on first render rather than in an effect, so the first
  // paint is already in the stored order. Restoring afterwards would show the
  // default order for a frame and then reshuffle.
  const [sort, setSort] = useState(() =>
    readStoredSort(storageKey, options, defaultKey),
  );

  useEffect(() => {
    writeStoredSort(storageKey, sort);
  }, [storageKey, sort]);

  // Choosing a FIELD resets the direction to that field's natural one rather
  // than carrying over whatever the previous field was flipped to. Going from
  // "Name, A→Z" to "Last modified" should land on most-recent-first, not on the
  // rows you have not touched since spring.
  function chooseKey(value) {
    setSort({ key: value, dir: defaultDirectionFor(value, options) });
  }

  function toggleDir() {
    setSort((prev) => ({
      ...prev,
      dir: prev.dir === "asc" ? "desc" : "asc",
    }));
  }

  return { sortKey: sort.key, sortDir: sort.dir, chooseKey, toggleDir };
}

export default function SortControl({
  id,
  options,
  sortKey,
  sortDir,
  onChooseKey,
  onToggleDir,
  className = "",
}) {
  const ascending = sortDir === "asc";
  const DirIcon = ascending ? ArrowUp : ArrowDown;
  const nextDirWord = ascending ? "descending" : "ascending";

  return (
    // The direction button sits OUTSIDE the label. A <label> forwards clicks to
    // its control, so an interactive element nested inside it would toggle the
    // direction and then open the select.
    <div className={`flex items-center justify-end gap-2 ${className}`}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Sort by
      </label>
      <select
        id={id}
        value={sortKey}
        onChange={(e) => onChooseKey(e.target.value)}
        className="min-h-[36px] px-2 py-1 text-sm rounded-lg border border-border bg-card text-dark hover:bg-secondary transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={onToggleDir}
        className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
        title={`Sort ${nextDirWord}`}
        aria-label={`Sort ${nextDirWord} — currently ${
          ascending ? "ascending" : "descending"
        }`}
      >
        <DirIcon className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
