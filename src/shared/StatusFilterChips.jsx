import React from "react";
import { STATUSES, STATUS_LABELS } from "../utils/status";

// One chip per status. Every chip shows its count, on or off, so a filter
// never hides rows without saying how many.
export default function StatusFilterChips({ counts, selected, onToggle }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="Filter by status">
      {STATUSES.map((status) => {
        const on = selected.includes(status);
        return (
          <button
            key={status}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(status)}
            className={`px-3 py-1.5 min-h-[36px] text-sm rounded-full border transition-colors ${
              on
                ? "bg-primary text-white border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-secondary"
            }`}
          >
            {STATUS_LABELS[status]} ({counts[status] ?? 0})
          </button>
        );
      })}
    </div>
  );
}
