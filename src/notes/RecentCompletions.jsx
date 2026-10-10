import React, { useEffect, useState } from "react";
import { formatEventDate, toLocalDateString } from "../utils/eventDates";
import { storage } from "../utils/storage";
import { currentUserId, listRecentCompletions, onNotesChanged } from "./notesApi";
import { NoteLine } from "./noteFormat";
import ObjectIcon from "../shared/ObjectIcon";

const day = (iso) => (iso ? formatEventDate(toLocalDateString(new Date(iso))) : "Undated");

// The last three completed executions — of an item across all its intentions,
// or of one intention — each with the notes written during it. A row opens
// that execution's (read-only) page.
export default function RecentCompletions({ itemId = null, intentId = null, showIntention = false, onOpenExecution }) {
  const [rows, setRows] = useState(null);
  const [userId, setUserId] = useState(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([currentUserId(), listRecentCompletions({ itemId, intentId, limit: 3 })])
        .then(([uid, data]) => {
          if (!live) return;
          setUserId(uid);
          setRows(data);
        })
        .catch((e) => {
          console.error("[Notes] recent completions failed:", e);
          if (live) setRows([]);
        });
    load();
    const stop = onNotesChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [itemId, intentId]);

  async function open(executionId) {
    const exec = await storage.get(`execution:${executionId}`);
    if (exec) onOpenExecution(exec);
  }

  return (
    <section className="mb-6" aria-label="Recent completions">
      <h3 className="text-lg font-medium mb-3">Recent completions</h3>
      {rows === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.executionId}>
              {/* The app's standard white card (ItemCard's surface, border and
                  radius) with the execution glyph: completed is neither running
                  (teal) nor paused (amber). */}
              <button
                type="button"
                onClick={() => open(r.executionId)}
                disabled={!onOpenExecution}
                title="Open this completed execution"
                data-state="closed"
                className="w-full text-left text-sm p-3 sm:p-4 bg-card border border-border rounded-lg shadow-sm hover:border-primary hover:shadow-md transition-shadow duration-200 min-h-[44px] disabled:cursor-default disabled:hover:shadow-sm disabled:hover:border-border"
              >
                <span className="flex items-start gap-2">
                  <span className="flex items-start gap-1.5 font-medium text-foreground">
                    <ObjectIcon type="execution" className="w-4 h-4" align="first-line" />
                    <span className="min-w-0">
                      {day(r.completedAt)}
                      {showIntention && r.intentText && <span className="font-normal"> · {r.intentText}</span>}
                    </span>
                  </span>
                </span>
                {r.notes.map((n) => (
                  <NoteLine key={n.id}>
                    {n.body}
                    {userId && n.userId !== userId && <span className="text-xs text-muted-foreground"> · shared</span>}
                  </NoteLine>
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
