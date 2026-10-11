/**
 * The reminder line for an inbox item or an intention, in Pacific time: every
 * scheduled reminder, or — when none is scheduled — the most recent sent one, muted.
 * Renders nothing when there is neither, or when the read fails (logged): a missing
 * line is better than an error box on a detail page.
 *
 * Restructure P3:
 * - `editable` (inbox detail): pending reminders as a grouped list with Cancel.
 * - `IntentionReminderLines` (intention detail): one small line per pending reminder
 *   with a Cancel link, and an "Add reminder" link that opens date and time inline.
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

// The event scheduling form's input (SchedulePopover).
const INPUT = "w-full px-3 py-2 min-h-[44px] border border-border rounded text-base";
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
 */
export function IntentionReminderLines({ intentId, text, scheduled = [], onChanged }) {
  return (
    <>
      {scheduled.map((r) => (
        <CompactReminder key={r.id} reminder={r} onCancelled={onChanged} />
      ))}
      <AddReminderLine intentId={intentId} text={text} onAdded={onChanged} />
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

function AddReminderLine({ intentId, text, onAdded }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [busy, setBusy] = useState(false);

  function start() {
    const next = nextWholeHour();
    setDate(next.date);
    setTime(next.time);
    setOpen(true);
  }

  async function save() {
    const dueAt = localInputToIso(date, time);
    if (!dueAt) return;
    if (new Date(dueAt) <= new Date()) {
      window.alert("Pick a time in the future.");
      return;
    }
    setBusy(true);
    try {
      await createIntentionReminder({ intentId, text: (text || "").trim() || "Reminder", dueAt });
      setOpen(false);
      onAdded();
    } catch (err) {
      console.error("[PendingReminder] add", err);
      window.alert("Could not set that reminder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1">
      <p className="text-sm flex items-center gap-1.5">
        <Bell className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        {open ? (
          <span>Add reminder</span>
        ) : (
          <button type="button" onClick={start} className={`text-primary ${LINK}`}>
            Add reminder
          </button>
        )}
      </p>
      {open && (
        <div className="mt-2 space-y-2 max-w-sm">
          <div className="flex gap-2">
            <label className="flex-1 text-xs font-medium text-muted-foreground">
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${INPUT} mt-1`} />
            </label>
            <label className="flex-1 text-xs font-medium text-muted-foreground">
              Time
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={`${INPUT} mt-1`} />
            </label>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={save}
              disabled={busy || !localInputToIso(date, time)}
              className="px-4 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg text-sm disabled:opacity-50"
            >
              Set reminder
            </button>
            <button type="button" onClick={() => setOpen(false)} className={`text-sm text-muted-foreground ${LINK}`}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
