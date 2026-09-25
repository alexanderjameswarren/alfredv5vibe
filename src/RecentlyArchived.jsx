/**
 * "Recently archived (n)" — Alfred Clipboard, Step 22.
 *
 * Design: docs/inbox-list-mockups/README.md §5, approved 2026-09-24.
 *
 * The last seven days of captures that have LEFT the inbox, each saying what became of
 * it, with an Undo. It sits under the live list and is collapsible, styled like
 * "Items (26)" on the context detail page — the same chevron button, the same
 * `text-base sm:text-lg font-medium`, the same control on the right of the header row.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 *
 * Archiving replaced deleting in Steps 5b and 14, for reasons that had nothing to do
 * with undo: a clip is two rows, and deleting the inbox pointer left the clip looking
 * live forever. The consequence was a table quietly filling with rows no screen showed.
 * A capture you discarded by mistake was recoverable in principle and unreachable in
 * practice.
 *
 * ── Muted, and only muted ────────────────────────────────────────────────────
 *
 * These rows are not cards. `InboxListCard` is a thing you act on — it has a Process
 * button, a preview of what it will become, a hover border. These are history: one line
 * of text, one line of meta, one button, on the page background rather than on a card.
 * The visual difference is the point, because the section directly below a list of
 * actionable rows is exactly where a reader would otherwise lose track of which is which.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────────
 *
 * It does not open the detail page. An archived capture is not in `inboxItems`, so the
 * route would resolve to nothing and bounce back — see the `routeInboxItem` comment in
 * Alfred.jsx. Undo first, then open it; that is one extra tap on the rare path rather
 * than a link that sometimes works.
 */

import { ChevronDown, Undo2 } from "lucide-react";
import { friendlyDate, sourceLabel, SourceIcon } from "./CaptureMeta";
import { listTitleFor } from "./utils/inboxSuggestions";
import { archivedAt, RECENT_ARCHIVE_DAYS } from "./utils/inboxArchive";

/**
 * @param {Array}    rows        The archived captures to show, already windowed and
 *   ordered by `recentlyArchived`. Newest departure first.
 * @param {number}   olderCount  How many more "Show all" would reveal. 0 hides it.
 * @param {boolean}  showAll     Whether the window is currently off.
 * @param {Function} onToggleShowAll
 * @param {boolean}  expanded
 * @param {Function} onToggleExpanded
 * @param {Function} outcomeFor  (row) => `{ label, tone }`. Injected rather than computed
 *   here because it needs the items, intents and events, and this component has no
 *   business knowing about any of them.
 * @param {Function} onUndo      (id) => void. Un-archives, and warns first where it has
 *   to — see `undoNeedsConfirming`.
 */
export default function RecentlyArchived({
  rows = [],
  olderCount = 0,
  showAll = false,
  onToggleShowAll,
  expanded,
  onToggleExpanded,
  outcomeFor,
  onUndo,
}) {
  // Nothing archived and nothing hidden: no section at all. An empty "Recently archived
  // (0)" on a fresh account is a heading explaining a feature rather than using it.
  if (rows.length === 0 && olderCount === 0) return null;

  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="flex items-center gap-2 text-base sm:text-lg font-medium text-foreground"
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform ${expanded ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
          Recently archived ({rows.length})
        </button>
        {olderCount > 0 && (
          <button
            type="button"
            onClick={onToggleShowAll}
            className="text-sm text-primary hover:underline"
          >
            {showAll ? `Last ${RECENT_ARCHIVE_DAYS} days` : `Show all (${olderCount} older)`}
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-1">
          {/* Only reachable with the window ON: `olderCount > 0` put the control there,
              and turning it off is what emptied the list. So the message names the way
              out rather than saying "nothing here". */}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing archived in the last {RECENT_ARCHIVE_DAYS} days.
            </p>
          ) : (
            rows.map((row) => {
              const { label, tone } = outcomeFor(row);
              return (
                <div
                  key={row.id}
                  className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-secondary/60 transition-colors"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    <SourceIcon sourceType={row.sourceType} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* One line, not two. These are not being triaged, and a history
                        where every entry can run to two lines is a history you scroll
                        past rather than read. */}
                    <p className="m-0 text-sm text-muted-foreground truncate">
                      {listTitleFor(row)}
                    </p>
                    <p className="m-0 flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
                      <span>{sourceLabel(row.sourceType)}</span>
                      <span aria-hidden="true">·</span>
                      {/* The outcome carries its own colour — "Discarded" is the one
                          thing on this row that is not muted, because it is the one an
                          Undo is usually looking for. */}
                      <span className={tone}>{label}</span>
                      <span aria-hidden="true">·</span>
                      {/* ⚠️ The DEPARTURE date, not `createdAt` — which is what every
                          other inbox surface shows. A capture made in June and discarded
                          this morning would otherwise read as three months old in a
                          section titled "recently". `archivedAt` is the one place that
                          chain is written. */}
                      <span>{friendlyDate(archivedAt(row))}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onUndo(row.id)}
                    aria-label={`Put back: ${listTitleFor(row)}`}
                    title="Put this capture back in your inbox"
                    className="inline-flex items-center gap-1.5 shrink-0 min-h-[44px] px-3 rounded-lg text-sm text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
                  >
                    <Undo2 className="w-4 h-4" aria-hidden="true" />
                    Undo
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
