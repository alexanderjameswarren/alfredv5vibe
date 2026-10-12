/**
 * The reminder line for an inbox item or an intention, in Pacific time: every
 * scheduled reminder, or — when none is scheduled — the most recent sent one, muted.
 * Renders nothing when there is neither, or when the read fails (logged): a missing
 * line is better than an error box on a detail page.
 *
 * Restructure P3:
 * - `editable` (inbox detail): pending reminders as a grouped list with Cancel.
 * - `IntentionReminderLines` (intention detail): one small line per pending reminder
 *   with a Cancel link (confirm only, no Undo), and an "Add reminder" link that opens
 *   the Schedule popover in its time mode.
 */

import { useCallback, useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  cancelReminder,
  createIntentionReminder,
  formatPacific,
  getReminderSummary,
  localInputToIso,
  nextWholeHour,
} from "../utils/remindersApi";
import { NOTE_LIST, NOTE_ROW } from "../notes/noteFormat";
import SchedulePopover from "../shared/recurrence/SchedulePopover";

const LINK = "underline-offset-2 hover:underline disabled:opacity-50";
const EMPTY = { scheduled: [], lastSent: null };

/** { scheduled, lastSent, reload } for one inbox item or intention. */
export function useReminderSummary({ inboxId = null, intentId = null }) {
  const [summary, setSummary] = useState(EMPTY);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    getReminderSummary({ inboxId, intentId })
      .then((s) => live && setSummary(s))
      .catch((err) => {
        console.error("[PendingReminder]", err);
        if (live) setSummary(EMPTY);
      });
    return () => {
      live = false;
    };
  }, [inboxId, intentId, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...summary, reload };
}

/** Confirm, cancel, then reload; alerts on failure. Returns true when cancelled. */
async function confirmCancel(reminder, onCancelled) {
  const when = formatPacific(reminder.due_at);
  if (!window.confirm(`Cancel the reminder for ${when}?`)) return false;
  try {
    await cancelReminder(reminder.id);
    onCancelled();
    return true;
  } catch (err) {
    console.error("[PendingReminder] cancel", err);
    window.alert("Could not cancel that reminder. It is still scheduled.");
    return false;
  }
}

export default function PendingReminder({ inboxId = null, intentId = null, editable = false }) {
  const { scheduled, lastSent, reload } = useReminderSummary({ inboxId, intentId });

  if (editable) {
    if (scheduled.length === 0) return null;
    return (
      <div className="mt-3 space-y-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Bell className="w-4 h-4 text-primary" aria-hidden="true" />
          Reminders
        </h3>
        <ul className={NOTE_LIST}>
          {scheduled.map((r) => (
            <ReminderRow key={r.id} reminder={r} onCancelled={reload} />
          ))}
        </ul>
      </div>
    );
  }

  if (scheduled.length > 0) {
    return (
      <ul className="mt-2 space-y-1">
        {scheduled.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bell className="w-4 h-4 shrink-0 text-primary" aria-hidden="true" />
            <span>Reminder: {formatPacific(r.due_at)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (lastSent) {
    return (
      <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground opacity-70">
        <Bell className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>Reminder sent: {formatPacific(lastSent.sent_at || lastSent.due_at)}</span>
      </p>
    );
  }
  return null;
}

function ReminderRow({ reminder, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const when = formatPacific(reminder.due_at);

  async function cancel() {
    setBusy(true);
    if (!(await confirmCancel(reminder, onCancelled))) setBusy(false);
  }

  return (
    <li className={`${NOTE_ROW} flex items-center justify-between gap-3`}>
      <span className="text-sm text-foreground">{when}</span>
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        aria-label={`Cancel reminder: ${when}`}
        className="inline-flex items-center gap-1.5 shrink-0 px-3 py-2 min-h-[44px] border-2 border-destructive text-destructive hover:bg-destructive/10 rounded-lg text-sm transition-colors disabled:opacity-50"
      >
        <X className="w-4 h-4" aria-hidden="true" />
        Cancel
      </button>
    </li>
  );
}

/**
 * Intention header lines, directly under the schedule line and in its text size:
 * "Reminder · <PT time>  Cancel" per pending reminder, then "Add reminder".
 * `scheduled` and `onChanged` come from the page's `useReminderSummary`.
 * `disabledReason` (the page's closed title) disables Add, as it does Start Now
 * and Schedule; pending lines and their Cancel stay.
 */
export function IntentionReminderLines({ intentId, text, scheduled = [], onChanged, disabledReason = null }) {
  return (
    <>
      {scheduled.map((r) => (
        <CompactReminder key={r.id} reminder={r} onCancelled={onChanged} />
      ))}
      <AddReminderLine intentId={intentId} text={text} onAdded={onChanged} disabledReason={disabledReason} />
    </>
  );
}

function CompactReminder({ reminder, onCancelled }) {
  const [busy, setBusy] = useState(false);
  const when = formatPacific(reminder.due_at);

  async function cancel() {
    setBusy(true);
    if (!(await confirmCancel(reminder, onCancelled))) setBusy(false);
  }

  return (
    <p className="text-sm mt-1 flex items-center gap-1.5 flex-wrap">
      <Bell className="w-3.5 h-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span>Reminder · {when}</span>
      <button
        type="button"
        onClick={cancel}
        disabled={busy}
        aria-label={`Cancel reminder: ${when}`}
        className={`ml-1 text-destructive ${LINK}`}
      >
        Cancel
      </button>
    </p>
  );
}

/** "Add reminder" opens the Schedule popover in its time mode ("Remind me at"). */
function AddReminderLine({ intentId, text, onAdded, disabledReason }) {
  const next = nextWholeHour();

  async function save(date, time) {
    const dueAt = localInputToIso(date, time);
    if (!dueAt) return;
    if (new Date(dueAt) <= new Date()) {
      window.alert("Pick a time in the future.");
      return;
    }
    try {
      await createIntentionReminder({ intentId, text: (text || "").trim() || "Reminder", dueAt });
      onAdded();
    } catch (err) {
      console.error("[PendingReminder] add", err);
      window.alert("Could not set that reminder.");
    }
  }

  return (
    <div className="text-sm mt-1 flex items-center gap-1.5">
      <Bell className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <SchedulePopover
        label="Add reminder"
        fieldLabel="Remind me at"
        confirmLabel="Set reminder"
        initialDate={next.date}
        initialTime={next.time}
        onPick={save}
        disabled={Boolean(disabledReason)}
        title={disabledReason || undefined}
        className={`text-primary ${LINK} disabled:cursor-not-allowed disabled:no-underline`}
      />
    </div>
  );
}
