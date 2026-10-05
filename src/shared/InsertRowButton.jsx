import React from "react";

// The small green plus that inserts a row at a position in a list.
//
// EXTRACTED, NOT INVENTED (2026-09-27). This markup existed twice already —
// between the elements of an item in Alfred.jsx and in InboxDetailView.jsx, both
// copies identical down to the `-my-1` that lets it sit in the gap between two
// rows rather than adding a row of its own. The warm-up ladder editor needed the
// same control, so rather than write a third copy the two were replaced by this.
//
// `align` is "center" (a plus under a full-width block, which is what Alfred's
// element list wants) or "start" (lined up with the left edge of a row of fields,
// which is what a table of rungs wants).
//
// `title` is the tooltip; `label` is the accessible name and falls back to it,
// because a lone "+" tells a screen reader nothing about where the new row lands.
// They differ when the control is refused: the tooltip becomes the reason, while the
// name still says which position it is.
export default function InsertRowButton({
  onClick, title, label, disabled = false, align = "center", className = "",
}) {
  return (
    <div className={`flex -my-1 ${align === "start" ? "justify-start" : "justify-center"} ${className}`}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="text-success hover:text-success-hover text-lg disabled:opacity-40 disabled:hover:text-success"
        title={title}
        aria-label={label || title}
      >
        +
      </button>
    </div>
  );
}
