/**
 * The reminder line for an inbox item or an intention, in Pacific time: every
 * scheduled reminder, or — when none is scheduled — the most recent sent one, muted.
 * Renders nothing when there is neither, or when the read fails (logged): a missing
 * line is better than an error box on a detail page.
 *
 * `editable` (Restructure P3): pending reminders become a grouped list with Cancel,
 * and `addText` adds an "Add reminder" action that sets one on the intention.
 */

import { useEffect, useState } from "react";
import { Bell, Plus, X } from "lucide-react";
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

export default function PendingReminder({ inboxId = null, intentId = null, editable = false, addText = null }) {
  const [summary, setSummary] = useState({ scheduled: [], lastSent: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    getReminderSummary({ inboxId, intentId })
      .then((s) => live && setSummary(s))
      .catch((err) => {
        console.error("[PendingReminder]", err);
        if (live) setSummary({ scheduled: [], lastSent: null });
      });
    return () => {
      live = false;
    };
  }, [inboxId, intentId, version]);

  const { scheduled, lastSent } = summary;
  const reload = () => setVersion((v) => v + 1);

  if (editable) {
    return (
      <div className="mt-3 space-y-2">
        {scheduled.length > 0 && (
          <>
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Bell className="w-4 h-4 text-primary" aria-hidden="true" />
              Reminders
            </h3>
            <ul className={NOTE_LIST}>
              {scheduled.map((r) => (
                <ReminderRow key={r.id} reminder={r} onCancelled={reload} />
              ))}
            </ul>
          </>
        )}
        {addText != null && intentId && (
          <AddReminder intentId={intentId} text={addText} onAdded={reload} />
        )}
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
    if (!window.confirm(`Cancel the reminder for ${when}?`)) return;
    setBusy(true);
    try {
      await cancelReminder(reminder.id);
      onCancelled();
    } catch (err) {
      console.error("[PendingReminder] cancel", err);
      window.alert("Could not cancel that reminder. It is still scheduled.");
      setBusy(false);
    }
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

function AddReminder({ intentId, text, onAdded }) {
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

  if (!open) {
    return (
      <button
        type="button"
        onClick={start}
        className="inline-flex items-center gap-2 px-3 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm text-sm"
      >
        <Bell className="w-4 h-4" aria-hidden="true" />
        Add reminder
      </button>
    );
  }

  return (
    <div className="space-y-2">
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
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !localInputToIso(date, time)}
          className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg text-sm disabled:opacity-50"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
          Set reminder
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-4 py-2 min-h-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
