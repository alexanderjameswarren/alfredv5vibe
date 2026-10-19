import React from "react";
import { STATUS_LABELS, statusOf, statusOptionsFor } from "../utils/status";

// Segmented status control. `options` defaults to what the row may move to:
// someday only while it is still someday (the database refuses the move back).
// `blocked`: { [status]: reason } — that choice is disabled, its reason shown below.
export default function StatusPicker({ value, onChange, options, disabled = false, label = "Status", blocked = {} }) {
  const current = statusOf({ status: value });
  const choices = options || statusOptionsFor(current);
  const reasons = [...new Set(choices.map((s) => blocked[s]).filter(Boolean))];
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-border overflow-hidden">
        {choices.map((status) => {
          const on = status === current;
          return (
            <button
              key={status}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || Boolean(blocked[status])}
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
      {reasons.map((r) => (
        <p key={r} className="mt-1 text-xs text-muted-foreground">
          {r}
        </p>
      ))}
    </div>
  );
}
