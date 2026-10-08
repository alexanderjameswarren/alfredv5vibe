import React from "react";
import { STATUS_LABELS, statusOf } from "../utils/status";

// Same shape as the StatusFilterChips (rounded-full, bordered) at tag size.
export const PILL_CLASS = "px-2 py-0.5 text-xs rounded-full border border-border bg-background text-muted-foreground";

// A row's status, always shown, Active included.
export default function StatusPill({ row }) {
  const status = statusOf(row);
  return (
    <span data-status={status} className={PILL_CLASS}>
      {STATUS_LABELS[status]}
    </span>
  );
}
