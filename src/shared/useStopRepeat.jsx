import React, { useState } from "react";
import StatusEventsSheet from "./StatusEventsSheet";
import { loadClosePending } from "./useRowClose";
import { getRecurrenceConfig } from "../utils/recurrence";
import { getTodayDate } from "../utils/eventDates";

/** Stop is offered on a repeating intention whose repeat has not ended (Step 10). */
export function canStop(intent, today = getTodayDate()) {
  if (!intent || getRecurrenceConfig(intent).type === "once") return false;
  return !intent.endDate || intent.endDate > today;
}

/**
 * Stop on a detail page: asks the one events-and-reminders question when a live date
 * today or later, or a scheduled reminder, is pending; otherwise stops at once.
 * `onStopRepeat(intentId, { archiveEvents })`; `onDone` runs after (e.g. reload reminders).
 */
export default function useStopRepeat({ events = [], onStopRepeat, onDone }) {
  const [pending, setPending] = useState(null);

  async function stop(intent, archiveEvents) {
    await onStopRepeat(intent.id, { archiveEvents });
    onDone?.();
  }

  async function request(intent) {
    const found = await loadClosePending(events, [intent]);
    if (found.future.length || found.reminderCount) setPending({ intent, ...found });
    else await stop(intent, false);
  }

  const sheet = pending && (
    <StatusEventsSheet
      status="background"
      title="Stop repeating"
      event={pending.future[0]}
      eventCount={pending.future.length}
      reminderCount={pending.reminderCount}
      onArchive={() => {
        const held = pending;
        setPending(null);
        stop(held.intent, true);
      }}
      onKeep={() => {
        const held = pending;
        setPending(null);
        stop(held.intent, false);
      }}
      onCancel={() => setPending(null)}
    />
  );

  return { request, sheet };
}
