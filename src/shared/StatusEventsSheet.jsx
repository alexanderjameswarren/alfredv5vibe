import React from "react";
import { STATUS_LABELS } from "../utils/status";
import { formatEventDate } from "../utils/eventDates";
import CancelButton from "./CancelButton";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The sheet's words for an intention with a live event, scheduled reminders, or both.
 * One answer covers both: archive the event and cancel the reminders, or keep them.
 */
export function sheetWording(status, date, reminderCount, eventCount = date ? 1 : 0) {
  const closing = status === "closed";
  const hasEvent = Boolean(date);
  const r = reminderCount > 0 ? plural(reminderCount, "reminder") : "";
  const them = reminderCount === 1 ? "the reminder" : "the reminders";
  // Several events: only from a list row closing an item with several intentions.
  if (eventCount > 1) {
    const events = `${eventCount} scheduled events (from ${date})`;
    return {
      summary: `${events}${r ? ` and ${r}` : ""}. Closing archives these events${r ? ` and cancels ${them}` : ""}.`,
      archive: closing ? `Close, archive these events${r ? ` and cancel ${them}` : ""}` : `Archive these events${r ? ` and cancel ${them}` : ""}`,
      keep: "Keep them",
    };
  }
  if (hasEvent && !r) {
    return {
      summary: `Scheduled for ${date}.${closing ? " Closing archives this event." : ""}`,
      archive: closing ? "Close and archive this event" : "Archive this event",
      keep: "Keep this event",
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
    summary: `1 scheduled event (${date}) and ${r}.${closing ? ` Closing archives this event and cancels ${them}.` : ""}`,
    archive: closing ? `Close, archive this event and cancel ${them}` : `Archive this event and cancel ${them}`,
    keep: "Keep them",
  };
}

// Asked before an intention with its one live event, or scheduled reminders, moves
// to background or closed. Closing always archives the event and cancels the
// reminders (a closed intention keeps no plan); parking may keep them.
// `eventCount` and `title` are for a list row's Close (Restructure P4).
export default function StatusEventsSheet({ status, event, eventCount, reminderCount = 0, title, onArchive, onKeep, onCancel }) {
  const date = event?.time ? formatEventDate(String(event.time).slice(0, 10)) : "";
  const closing = status === "closed";
  const words = sheetWording(status, date, reminderCount, eventCount);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Live events"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">{title || `Move to ${STATUS_LABELS[status]}`}</h3>
        <p className="text-sm mb-4">{words.summary}</p>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <button type="button" onClick={onArchive} className="flex-1 px-4 py-2 min-h-[44px] text-sm bg-primary text-white rounded-lg hover:opacity-90">
              {words.archive}
            </button>
            <CancelButton onClick={onCancel} />
          </div>
          {!closing && (
            <button type="button" onClick={onKeep} className="px-4 py-2 min-h-[44px] text-sm border border-border rounded-lg hover:bg-muted">
              {words.keep}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
