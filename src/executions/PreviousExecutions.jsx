import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { formatEventDate, toLocalDateString } from "../utils/eventDates";

const LIMIT = 10;

// Closed executions of one intention: date and outcome, newest first. A stopgap
// list only — Phase 2's execution history (with notes) replaces it.
export default function PreviousExecutions({ intentId }) {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let live = true;
    supabase
      .from("executions")
      .select("id, outcome, started_at, closed_at")
      .eq("intent_id", intentId)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(LIMIT)
      .then(({ data, error }) => {
        if (error) console.error("[PreviousExecutions] load failed:", error);
        if (live) setRows(data || []);
      });
    return () => {
      live = false;
    };
  }, [intentId]);

  return (
    <div className="mb-6">
      <h3 className="text-lg font-medium mb-3">Previous executions</h3>
      {rows === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">None yet</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => {
            const when = r.closed_at || r.started_at;
            const outcome = r.outcome ? r.outcome[0].toUpperCase() + r.outcome.slice(1) : "Closed";
            return (
              <li key={r.id} className="text-sm">
                {when ? formatEventDate(toLocalDateString(new Date(when))) : "Undated"}
                <span className="text-muted-foreground"> · {outcome}</span>
              </li>
            );
          })}
        </ul>
      )}
      {rows?.length === LIMIT && (
        <p className="text-xs text-muted-foreground mt-2">Latest {LIMIT} shown.</p>
      )}
    </div>
  );
}
