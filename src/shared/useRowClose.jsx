import React, { useState } from "react";
import { CircleCheckBig } from "lucide-react";
import StatusEventsSheet from "./StatusEventsSheet";
import { getReminderSummary } from "../utils/remindersApi";
import { getTodayDate } from "../utils/eventDates";
import { liveEventsFor, statusOf } from "../utils/status";
import { hasOpenRun } from "../utils/rowModel";

export const CLOSE_BLOCKED = "Finish the execution first";

/** What Close on a list row closes: the item, if any, and its intentions not yet closed. */
export function closeTargets(row) {
  return {
    item: row.item && statusOf(row.item) !== "closed" ? row.item : null,
    intents: row.intents.filter((i) => statusOf(i) !== "closed"),
  };
}

/** True while the row's item or any of its intentions has an open (active or paused) run. */
export const closeBlocked = hasOpenRun;

/**
 * Close on list rows (Restructure P4). `closeProps(row)` feeds a card's Close
 * button; `sheet` is the one question, asked only when an intention being closed
 * has a live event dated today or later, or scheduled reminders.
 */
export default function useRowClose({ events = [], executions = [], onCloseRecords }) {
  const [pending, setPending] = useState(null);

  function close({ row, targets }) {
    return onCloseRecords({
      item: targets.item,
      intentIds: targets.intents.map((i) => i.id),
      label: row.name,
    });
  }

  async function request(row) {
    const targets = closeTargets(row);
    const today = getTodayDate();
    const future = targets.intents
      .flatMap((i) => liveEventsFor(events, i.id))
      .filter((e) => String(e.time).slice(0, 10) >= today)
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));
    let reminderCount = 0;
    try {
      for (const i of targets.intents) reminderCount += (await getReminderSummary({ intentId: i.id })).scheduled.length;
    } catch (err) {
      console.error("[Reminders] count before close failed:", err);
    }
    if (future.length || reminderCount) setPending({ row, targets, future, reminderCount });
    else await close({ row, targets });
  }

  function closeProps(row) {
    const targets = closeTargets(row);
    // A row whose chip reads Closed has no Close, even if an item's intention is still open.
    if (!onCloseRecords || row.status === "closed" || (!targets.item && targets.intents.length === 0)) return {};
    return { onClose: () => request(row), closeBlocked: closeBlocked(row, executions) ? CLOSE_BLOCKED : null };
  }

  const sheet = pending && (
    <StatusEventsSheet
      status="closed"
      title={`Close "${pending.row.name}"`}
      event={pending.future[0]}
      eventCount={pending.future.length}
      reminderCount={pending.reminderCount}
      onArchive={() => {
        const held = pending;
        setPending(null);
        close(held);
      }}
      onKeep={() => setPending(null)}
      onCancel={() => setPending(null)}
    />
  );

  return { closeProps, sheet };
}

/** The row's Close button: neutral, since nothing is destroyed. */
export function CloseRowButton({ onClose, closeBlocked: blocked }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      disabled={Boolean(blocked)}
      title={blocked || "Close"}
      className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] whitespace-nowrap bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
    >
      <CircleCheckBig className="w-4 h-4" />
      Close
    </button>
  );
}
