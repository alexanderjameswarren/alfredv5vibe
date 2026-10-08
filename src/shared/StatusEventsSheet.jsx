import React from "react";
import { STATUS_LABELS } from "../utils/status";
import { formatEventDate } from "../utils/eventDates";

// Asked before an intention with its one live event moves to background or
// closed. Closing always archives the date (a closed intention keeps no plan);
// parking may keep it.
export default function StatusEventsSheet({ status, event, onArchive, onKeep, onCancel }) {
  const date = event?.time ? formatEventDate(String(event.time).slice(0, 10)) : "";
  const closing = status === "closed";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Live events"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">Move to {STATUS_LABELS[status]}</h3>
        <p className="text-sm mb-4">
          Scheduled for {date}.{closing && " Closing archives that date."}
        </p>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onArchive} className="px-4 py-2 min-h-[44px] text-sm bg-primary text-white rounded hover:opacity-90">
            {closing ? "Close and archive the date" : "Archive the date"}
          </button>
          {!closing && (
            <button type="button" onClick={onKeep} className="px-4 py-2 min-h-[44px] text-sm border border-border rounded hover:bg-muted">
              Keep the date
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
