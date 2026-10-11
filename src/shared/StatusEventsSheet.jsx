import React from "react";
import { STATUS_LABELS } from "../utils/status";
import { formatEventDate } from "../utils/eventDates";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The sheet's words for an intention with a live event, scheduled reminders, or both.
 * One answer covers both: archive the date and cancel the reminders, or keep them.
 */
export function sheetWording(status, date, reminderCount) {
  const closing = status === "closed";
  const hasEvent = Boolean(date);
  const r = reminderCount > 0 ? plural(reminderCount, "reminder") : "";
  const them = reminderCount === 1 ? "the reminder" : "the reminders";
  if (hasEvent && !r) {
    return {
      summary: `Scheduled for ${date}.${closing ? " Closing archives that date." : ""}`,
      archive: closing ? "Close and archive the date" : "Archive the date",
      keep: "Keep the date",
    };
  }
  if (!hasEvent) {
    return {
      summary: `${r} pending.${closing ? ` Closing cancels ${reminderCount === 1 ? "it" : "them"}.` : ""}`,
      archive: closing ? `Close and cancel ${them}` : `Cancel ${them}`,
      keep: `Keep ${them}`,
    };
  }
  return {
    summary: `1 scheduled event (${date}) and ${r}.${closing ? ` Closing archives the date and cancels ${them}.` : ""}`,
    archive: closing ? `Close, archive the date and cancel ${them}` : `Archive the date and cancel ${them}`,
    keep: "Keep them",
  };
}

// Asked before an intention with its one live event, or scheduled reminders, moves
// to background or closed. Closing always archives the date and cancels the
// reminders (a closed intention keeps no plan); parking may keep them.
export default function StatusEventsSheet({ status, event, reminderCount = 0, onArchive, onKeep, onCancel }) {
  const date = event?.time ? formatEventDate(String(event.time).slice(0, 10)) : "";
  const closing = status === "closed";
  const words = sheetWording(status, date, reminderCount);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Live events"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">Move to {STATUS_LABELS[status]}</h3>
        <p className="text-sm mb-4">{words.summary}</p>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onArchive} className="px-4 py-2 min-h-[44px] text-sm bg-primary text-white rounded hover:opacity-90">
            {words.archive}
          </button>
          {!closing && (
            <button type="button" onClick={onKeep} className="px-4 py-2 min-h-[44px] text-sm border border-border rounded hover:bg-muted">
              {words.keep}
            </button>
          )}
          <button type="button" onClick={onCancel} className="px-4 py-2 min-h-[44px] text-sm text-muted-foreground rounded hover:bg-muted">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
