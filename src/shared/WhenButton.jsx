import React from "react";

/**
 * One choice in a When control (inbox detail, intention edit form). Tan
 * secondary with a brown edge when chosen, plain when not. Not teal: teal means
 * an execution is in progress.
 */
export default function WhenButton({ on, onClick, icon: Glyph, label }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 rounded-lg border text-sm transition-colors ${
        on
          ? "border-primary bg-secondary text-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      <Glyph className="w-4 h-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
