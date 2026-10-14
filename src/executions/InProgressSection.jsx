import React from "react";
import ExecutionBadge from "./ExecutionBadge";

/** Home's Active and Paused list: one teal ExecutionBadge per run, tapping opens it. */
// `extraFor(exec)` is optional content under a card (item detail's run notes).
export function ExecutionList({ executions, intents, contexts, getIntentDisplay, onOpen, emptyText = null, extraFor = null }) {
  return (
    <div className="space-y-2">
      {executions.length > 0
        ? executions.map((exec) => (
            <ExecutionBadge
              key={exec.id}
              exec={exec}
              intents={intents}
              contexts={contexts}
              getIntentDisplay={getIntentDisplay}
              onOpen={onOpen}
            >
              {extraFor?.(exec)}
            </ExecutionBadge>
          ))
        : emptyText && <p className="text-muted-foreground text-sm">{emptyText}</p>}
    </div>
  );
}

/**
 * The lists' "In progress" section (Restructure P4): every running, then paused,
 * run in scope, as Home shows them. Ignores search, tags, chips and sort.
 * Renders nothing when nothing is in progress.
 */
export default function InProgressSection({ executions, ...listProps }) {
  if (executions.length === 0) return null;
  const ordered = [...executions.filter((x) => x.status !== "paused"), ...executions.filter((x) => x.status === "paused")];
  return (
    <section className="mb-4" aria-label="In progress">
      <h3 className="text-base sm:text-lg font-medium text-foreground mb-2">In progress ({ordered.length})</h3>
      <ExecutionList executions={ordered} {...listProps} />
    </section>
  );
}
