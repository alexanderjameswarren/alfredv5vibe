import React from "react";
import { Pin } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import { RowMetaLine } from "../shared/TagChips";
import { shortDate } from "../notes/noteFormat";

/**
 * The row's last line, in the item row's words: "2 recipes · last done: Oct 21,
 * 2026 · last updated: Oct 23, 2026". Recipes for a menu (a together type),
 * members for others; an empty date is left out. Pure.
 */
export function groupRowSummary(row) {
  const menu = row.type?.executionMode === "together";
  const n = row.memberCount || 0;
  return [
    menu ? `${n} recipe${n === 1 ? "" : "s"}` : `${n} member${n === 1 ? "" : "s"}`,
    row.lastCompletedAt && `last done: ${shortDate(row.lastCompletedAt)}`,
    row.updatedAt && `last updated: ${shortDate(row.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A group in a list (Restructure P5 step 11), in the row card's four lines: type
 * icon and name; status and context; when ("Not scheduled" until step 13); the
 * member count and dates. No action buttons yet. Tapping opens the group.
 */
export default function GroupRowCard({ row, contextName, onOpen }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(row.group.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen?.(row.group.id);
        }
      }}
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow"
    >
      <p className="flex items-start gap-1.5 font-medium">
        <GroupTypeIcon icon={row.type?.icon} className="w-4 h-4 text-primary" align="first-line" />
        {/* The pin sits inline after the last word, as on pinned collections and contexts;
            as a flex sibling of the clamped name Chrome pushed it to the card's right edge. */}
        <span className="min-w-0 line-clamp-2" title={row.name}>
          {row.name || "Untitled"}
          {row.group?.pinned && (
            <Pin className="inline-block w-3.5 h-3.5 ml-1.5 align-[-0.1em] text-muted-foreground" aria-label="Pinned" />
          )}
        </span>
      </p>
      <RowMetaLine statusRow={row.group} contextName={contextName} />
      <div className="flex items-center gap-1 mt-1 text-xs text-foreground">
        <ObjectIcon type="event" className="w-3.5 h-3.5 text-muted-foreground" />
        Not scheduled
      </div>
      <span className="text-xs text-muted-foreground mt-1 block">{groupRowSummary(row)}</span>
    </div>
  );
}
