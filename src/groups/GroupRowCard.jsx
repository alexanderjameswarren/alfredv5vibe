import React from "react";
import { Pin, Play } from "lucide-react";
import ObjectIcon, { GroupTypeIcon } from "../shared/ObjectIcon";
import { RowMetaLine } from "../shared/TagChips";
import ScheduledLine from "../shared/ScheduledLine";
import SchedulePopover from "../shared/recurrence/SchedulePopover";
import { CloseRowButton } from "../shared/useRowClose";
import { getTodayDate } from "../utils/eventDates";
import { closedBlockTitle, RUN_ACTIVE_MOVE_REASON } from "../utils/status";
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
 * A group in a list (Restructure P5), in the row card's four lines: type icon and
 * name; status and context; when (its own intention's live date, step 13); the
 * member count and dates. Schedule and Close (step 13). Tapping opens the group.
 */
export default function GroupRowCard({ row, contextName, onOpen, onSchedule, onClose, closeBlocked, onStartNow, onOpenExecution }) {
  const closedTitle = closedBlockTitle(row.group, "group");
  const moveBlocked = row.open?.status === "active" ? RUN_ACTIVE_MOVE_REASON : null;
  const liveDate = row.event ? String(row.event.time).slice(0, 10) : null;
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
      {/* The row cards' layout: text left, buttons right and centred (stacked below sm). */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex-1 min-w-0">
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
            <ScheduledLine actions={{ live: row.event, open: row.open }} />
          </div>
          <span className="text-xs text-muted-foreground mt-1 block">{groupRowSummary(row)}</span>
        </div>
        {(onSchedule || onClose || onStartNow) && (
          <div data-row-actions className="flex items-center gap-3 shrink-0 self-end sm:self-auto">
            {/* Step 14: a menu row starts (or continues) its cook. */}
            {onStartNow && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (row.open) onOpenExecution?.(row.open);
                  else onStartNow(row.group.id);
                }}
                disabled={Boolean(closedTitle)}
                title={closedTitle || undefined}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] whitespace-nowrap bg-success hover:bg-success-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-4 h-4" />
                {row.open ? "Continue" : "Start Now"}
              </button>
            )}
            {onSchedule && (
              <span onClick={(e) => e.stopPropagation()} title={closedTitle || moveBlocked || undefined}>
                <SchedulePopover
                  label={row.event ? "Reschedule" : "Schedule"}
                  initialDate={liveDate || getTodayDate()}
                  minDate={getTodayDate()}
                  onPick={(date) => onSchedule(row.group.id, date)}
                  disabled={Boolean(closedTitle || moveBlocked)}
                  className="px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-secondary disabled:hover:bg-secondary disabled:text-foreground disabled:shadow-none disabled:hover:shadow-none"
                />
              </span>
            )}
            {onClose && <CloseRowButton onClose={onClose} closeBlocked={closeBlocked} />}
          </div>
        )}
      </div>
    </div>
  );
}
