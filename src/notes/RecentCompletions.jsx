import React, { useEffect, useState } from "react";
import { CalendarX } from "lucide-react";
import { formatEventDate, toLocalDateString } from "../utils/eventDates";
import { storage } from "../utils/storage";
import { countRecentExecutions, currentUserId, listRecentCompletions, listRecentSkips, onNotesChanged } from "./notesApi";
import { NoteLine } from "./noteFormat";
import ObjectIcon from "../shared/ObjectIcon";

export const RECENT_LIMIT = 5;
const ALL_LIMIT = 50; // alfred_recent_completions' cap

const localDay = (iso) => (iso ? toLocalDateString(new Date(iso)) : null);

/**
 * Completed and skipped executions in one timeline, newest first, the last five
 * (Restructure P4 Step 9). A completed one is dated by its completion, a skipped
 * one by the date it skipped. Exported for tests.
 */
export function mergeRecent(done, skipped, limit = RECENT_LIMIT) {
  const rows = [
    ...done.map((r) => ({ ...r, kind: "done", id: r.executionId, day: localDay(r.completedAt), at: r.completedAt })),
    ...skipped.map((r) => ({ ...r, kind: "skipped", day: r.skippedOn || localDay(r.closedAt), at: r.closedAt })),
  ];
  rows.sort((a, b) => (b.day || "").localeCompare(a.day || "") || String(b.at || "").localeCompare(String(a.at || "")));
  return rows.slice(0, limit);
}

// The last five executions — of an item across all its intentions (`intentIds`),
// or of one intention — completed ones with the notes written during them, skipped
// ones greyed with the Skip icon. Every row opens that execution's (read-only) page.
export default function RecentCompletions({ itemId = null, intentId = null, intentIds = null, intentNames = {}, showIntention = false, onOpenExecution }) {
  const [rows, setRows] = useState(null);
  const [userId, setUserId] = useState(null);
  const [total, setTotal] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const skipIds = intentIds || (intentId ? [intentId] : []);
  const skipKey = skipIds.join(",");

  useEffect(() => {
    let live = true;
    // "Show all" reads as many as the completions function returns (its cap).
    const limit = showAll ? ALL_LIMIT : RECENT_LIMIT;
    const load = () =>
      Promise.all([
        currentUserId(),
        listRecentCompletions({ itemId, intentId, limit }),
        listRecentSkips(skipIds, limit),
        // Only the count for "Show all": a failure hides the control, not the list.
        Promise.resolve(countRecentExecutions({ itemId, intentIds: skipIds })).catch(() => 0),
      ])
        .then(([uid, done, skipped, count]) => {
          if (!live) return;
          setUserId(uid);
          setRows(mergeRecent(done || [], skipped || [], limit * 2));
          setTotal(count);
        })
        .catch((e) => {
          console.error("[Notes] recent executions failed:", e);
          if (live) setRows([]);
        });
    load();
    const stop = onNotesChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [itemId, intentId, skipKey, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  const olderCount = Math.max(0, total - RECENT_LIMIT);
  const shown = rows && !showAll ? rows.slice(0, RECENT_LIMIT) : rows;

  async function open(executionId) {
    const exec = await storage.get(`execution:${executionId}`);
    if (exec) onOpenExecution(exec);
  }

  return (
    <section className="mb-6" aria-label="Recent executions">
      {/* The inbox's "Recently archived" control: same wording, place and style. */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-medium">Recent executions</h3>
        {olderCount > 0 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-sm text-primary hover:underline">
            {showAll ? `Last ${RECENT_LIMIT}` : `Show all (${olderCount} older)`}
          </button>
        )}
      </div>
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((r) => {
            const intentText = r.kind === "done" ? r.intentText : intentNames[r.intentId];
            const label = (
              <>
                {r.day ? formatEventDate(r.day) : "Undated"}
                {r.kind === "skipped" && " (skipped)"}
                {showIntention && intentText && <span className="font-normal"> · {intentText}</span>}
              </>
            );
            return (
              <li key={r.id}>
                {r.kind === "skipped" ? (
                  // A skip is history, not a completion: greyed, no card border, the Skip icon.
                  <button
                    type="button"
                    onClick={() => open(r.id)}
                    disabled={!onOpenExecution}
                    title="Open this skipped execution"
                    className="w-full text-left text-sm px-3 sm:px-4 py-2 min-h-[44px] rounded-lg text-muted-foreground hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <span className="flex items-start gap-1.5">
                      <CalendarX className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">{label}</span>
                    </span>
                  </button>
                ) : (
                  // The app's standard white card with the execution glyph.
                  <button
                    type="button"
                    onClick={() => open(r.id)}
                    disabled={!onOpenExecution}
                    title="Open this completed execution"
                    data-state="closed"
                    className="w-full text-left text-sm p-3 sm:p-4 bg-card border border-border rounded-lg shadow-sm hover:border-primary hover:shadow-md transition-shadow duration-200 min-h-[44px] disabled:cursor-default disabled:hover:shadow-sm disabled:hover:border-border"
                  >
                    <span className="flex items-start gap-1.5 font-medium text-foreground">
                      <ObjectIcon type="execution" className="w-4 h-4" align="first-line" />
                      <span className="min-w-0">{label}</span>
                    </span>
                    {r.notes.map((n) => (
                      <NoteLine key={n.id}>
                        {n.body}
                        {userId && n.userId !== userId && <span className="text-xs text-muted-foreground"> · shared</span>}
                      </NoteLine>
                    ))}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
