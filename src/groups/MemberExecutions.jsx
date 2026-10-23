import React, { useEffect, useState } from "react";
import { CalendarX } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";
import { formatEventDate } from "../utils/eventDates";
import { storage } from "../utils/storage";
import { onNotesChanged } from "../notes/notesApi";
import { RECENT_LIMIT } from "../notes/RecentCompletions";
import { memberScope } from "./groupModel";
import { listMemberExecutions, memberNameFor } from "./groupHistory";

const ALL_LIMIT = 50;

/**
 * A project's or series' Recent executions (Restructure P5 step 15): one dated list
 * of every live member's completed and skipped executions, newest first, each naming
 * its member ("Bug A · Mon, Oct 19") and opening that execution. Phase 4's "Show all
 * (N older)" beyond the first five. The group's own intention (a Completed close)
 * counts too, under the group's name.
 */
export default function MemberExecutions({ groupId, lists, ownIntention = null, groupName = "", onOpenExecution }) {
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const { live, intentIds, itemIds } = memberScope(groupId, lists);
  const ids = [...intentIds, ...(ownIntention ? [ownIntention.id] : [])];
  const key = `${ids.sort().join(",")}|${[...itemIds].sort().join(",")}`;

  useEffect(() => {
    let alive = true;
    const load = () =>
      listMemberExecutions({ intentIds: ids, itemIds: [...itemIds], limit: showAll ? ALL_LIMIT : RECENT_LIMIT })
        .then(({ rows: found, total: count }) => {
          if (!alive) return;
          setRows(found);
          setTotal(count);
        })
        .catch((e) => {
          console.error("[Groups] member executions failed:", e);
          if (alive) setRows([]);
        });
    load();
    // Completions announce themselves (completionsChanged): reload, as Recent executions does.
    const stop = onNotesChanged(load);
    return () => {
      alive = false;
      stop();
    };
  }, [key, showAll]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id) {
    const exec = await storage.get(`execution:${id}`);
    if (exec) onOpenExecution?.(exec);
  }

  const olderCount = Math.max(0, total - RECENT_LIMIT);
  return (
    <section className="mb-6" aria-label="Recent executions">
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
          {rows.map((r) => {
            const name = memberNameFor(r, { live, intents: lists.intents, ownIntentionId: ownIntention?.id, groupName });
            const skipped = r.outcome === "skipped";
            const text = `${name ? `${name} · ` : ""}${r.day ? formatEventDate(r.day) : "Undated"}${skipped ? " (skipped)" : ""}`;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  disabled={!onOpenExecution}
                  className={
                    skipped
                      ? "w-full text-left text-sm px-3 sm:px-4 py-2 min-h-[44px] rounded-lg text-muted-foreground hover:bg-muted"
                      : "w-full text-left text-sm p-3 sm:p-4 bg-card border border-border rounded-lg shadow-sm hover:border-primary hover:shadow-md transition-shadow duration-200 min-h-[44px]"
                  }
                >
                  <span className={`flex items-start gap-1.5 ${skipped ? "" : "font-medium text-foreground"}`}>
                    {skipped ? (
                      <CalendarX className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    ) : (
                      <ObjectIcon type="execution" className="w-4 h-4" align="first-line" />
                    )}
                    <span className="min-w-0">{text}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
