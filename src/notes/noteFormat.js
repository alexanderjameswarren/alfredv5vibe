import React from "react";
import { formatEventDate, toLocalDateString } from "../utils/eventDates";
import ObjectIcon from "../shared/ObjectIcon";

// Notes are read, not tapped, so they sit in one grouped list: a single white
// container with the card border and radius (rounded-lg, design-system.md
// "Tokens"), thin dividers between notes, no border round each one.
export const NOTE_LIST = "bg-card border border-border rounded-lg divide-y divide-border";
export const NOTE_ROW = "px-3 py-2.5";

// The card meta-line date format ("last updated: Oct 9, 2026").
export function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function noteDate(n) {
  return formatEventDate(toLocalDateString(new Date(n.createdAt)));
}

// A note inside another card (an execution or a completion): a plain line led
// by the note icon, the same size and gap as the card's header icon so the two
// icons form one column.
// `oneLine` cuts it to a single line with an ellipsis (list cards).
export function NoteLine({ children, oneLine = false }) {
  return (
    <span className="flex items-start gap-1.5 mt-1.5 text-sm text-foreground">
      <ObjectIcon type="note" className="w-4 h-4" align="first-line" />
      <span className={`min-w-0 ${oneLine ? "truncate" : "whitespace-pre-wrap"}`}>{children}</span>
    </span>
  );
}
