import React, { useState } from "react";
import { CircleCheckBig } from "lucide-react";
import CloseDialog from "./CloseDialog";
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
/**
 * What closing or stopping these intentions archives and cancels: every live event,
 * past-due ones too (parked, one would sit overdue forever), and scheduled reminders.
 */
export async function loadClosePending(events, intents) {
  const future = intents
    .flatMap((i) => liveEventsFor(events, i.id))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  let reminderCount = 0;
  try {
    for (const i of intents) reminderCount += (await getReminderSummary({ intentId: i.id })).scheduled.length;
  } catch (err) {
    console.error("[Reminders] count before close failed:", err);
  }
  return { future, reminderCount };
}

/**
 * The Close pop-up's defaults (close reason): Closed on is the picked intention's live
 * date, even a past one, else today; Completed is preselected when a completed
 * execution already exists (a record's last_completed_at).
 */
export function closeDefaults({ item = null, intents = [], picked = null, events = [] }) {
  const today = getTodayDate();
  const live = picked ? liveEventsFor(events, picked.id)[0] : null;
  const liveDay = live ? String(live.time).slice(0, 10) : null;
  const done = [item, ...intents].some((r) => r?.lastCompletedAt);
  return { today, defaultClosedOn: liveDay && liveDay <= today ? liveDay : today, defaultReason: done ? "done" : null };
}

export default function useRowClose({ events = [], executions = [], onCloseRecords }) {
  const [pending, setPending] = useState(null);

  async function request(row) {
    const targets = closeTargets(row);
    const picked = row.intent && targets.intents.some((i) => i.id === row.intent.id) ? row.intent : targets.intents[0] || null;
    setPending({ row, targets, picked, ...closeDefaults({ item: targets.item, intents: targets.intents, picked, events }), loading: true });
    const found = await loadClosePending(events, targets.intents);
    setPending((p) => p && p.row === row && { ...p, ...found, loading: false });
  }

  function closeProps(row) {
    const targets = closeTargets(row);
    // A row whose chip reads Closed has no Close, even if an item's intention is still open.
    if (!onCloseRecords || row.status === "closed" || (!targets.item && targets.intents.length === 0)) return {};
    return { onClose: () => request(row), closeBlocked: closeBlocked(row, executions) ? CLOSE_BLOCKED : null };
  }

  const sheet = pending && (
    <CloseDialog
      title={`Close "${pending.row.name}"`}
      today={pending.today}
      defaultClosedOn={pending.defaultClosedOn}
      defaultReason={pending.defaultReason}
      pending={pending.loading ? null : pending}
      onCancel={() => setPending(null)}
      onConfirm={async ({ reason, note, closedOn }) => {
        const held = pending;
        setPending(null);
        await onCloseRecords({
          item: held.targets.item,
          intentIds: held.targets.intents.map((i) => i.id),
          label: held.row.name,
          reason,
          note,
          closedOn,
          pickedIntentId: held.picked?.id || null,
        });
        return true;
      }}
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
      className="flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-2.5 min-h-[44px] whitespace-nowrap bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
    >
      <CircleCheckBig className="w-4 h-4" />
      Close
    </button>
  );
}
