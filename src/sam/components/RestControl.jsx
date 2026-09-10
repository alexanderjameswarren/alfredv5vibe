import React from "react";

// Shared −/value/+ stepper for a rest-measure count. Extracted from
// SnippetPanel so the snippet control and the song-level repeat control
// stay identical: min 0, no max, step 1, default 0, and a read-only value
// display (the count is only changeable via the buttons, never typed).
export default function RestControl({ label = "Rest:", value, onChange }) {
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      {label}
      <button
        onClick={() => onChange(Math.max(0, value - 1))}
        className="w-8 h-8 flex items-center justify-center border border-border rounded text-lg min-h-[44px] min-w-[44px]"
      >
        −
      </button>
      <span className="w-6 text-center font-medium text-dark">{value}</span>
      <button
        onClick={() => onChange(value + 1)}
        className="w-8 h-8 flex items-center justify-center border border-border rounded text-lg min-h-[44px] min-w-[44px]"
      >
        +
      </button>
    </div>
  );
}
