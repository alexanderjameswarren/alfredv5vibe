import React from "react";
import { STATUS_LABELS, statusOf, statusOptionsFor } from "../utils/status";

// Segmented status control. `options` defaults to what the row may move to:
// someday only while it is still someday (the database refuses the move back).
export default function StatusPicker({ value, onChange, options, disabled = false, label = "Status" }) {
  const current = statusOf({ status: value });
  const choices = options || statusOptionsFor(current);
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border overflow-hidden">
      {choices.map((status) => {
        const on = status === current;
        return (
          <button
            key={status}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !on && onChange(status)}
            className={`px-3 py-1.5 min-h-[40px] text-sm transition-colors disabled:opacity-50 ${
              on ? "bg-primary text-white" : "bg-background text-foreground hover:bg-secondary"
            }`}
          >
            {STATUS_LABELS[status]}
          </button>
        );
      })}
    </div>
  );
}
