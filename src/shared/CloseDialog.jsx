import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Check, CircleCheckBig } from "lucide-react";
import ToggleButton from "./ToggleButton";
import CancelButton from "./CancelButton";
import { DateRow } from "../notes/CompleteNoteDialog";
import { sheetWording } from "./StatusEventsSheet";
import { formatEventDate } from "../utils/eventDates";

// Completed has the Complete button's check; Won't do the slashed circle (Ban).
// Tones as the inbox's New Item (brown) and New Intention (tan).
export const CLOSE_REASONS = [
  { value: "done", label: "Completed", icon: Check, tone: "primary" },
  { value: "wont_do", label: "Won't do", icon: Ban, tone: "secondary" },
];

/**
 * The one Close pop-up (Restructure P4, close reason), in all six places Closed can be
 * chosen: Completed / Won't do, an optional note, Closed on, and, when something is
 * pending, what closing does to future events and reminders (closing always archives
 * and cancels them; no Keep).
 *
 * pending: { future: [event], reminderCount } or null.
 * onConfirm({ reason, note, closedOn }) => Promise<boolean>; false keeps it open.
 */
export default function CloseDialog({ title, today, defaultClosedOn, defaultReason = null, pending = null, onConfirm, onCancel }) {
  const [reason, setReason] = useState(defaultReason);
  const [note, setNote] = useState("");
  const [closedOn, setClosedOn] = useState(defaultClosedOn || today);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const future = pending?.future || [];
  const reminderCount = pending?.reminderCount || 0;
  const question =
    future.length || reminderCount
      ? sheetWording("closed", future[0] ? formatEventDate(String(future[0].time).slice(0, 10)) : "", reminderCount, future.length)
      : null;

  function pickClosedOn(value) {
    if (value > today) return "It cannot be closed in the future.";
    setClosedOn(value);
    return null;
  }

  async function confirm() {
    setBusy(true);
    setFailed(false);
    const ok = await onConfirm({ reason, note, closedOn });
    if (!ok) {
      setFailed(true);
      setBusy(false);
    }
  }

  // At the page root, not inside the edit card it may be opened from: nothing in
  // the form (its pinned footer, its own Cancel) can sit over it or take its taps.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-label="Close"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-3">{title}</h3>
        {/* The inbox's New Item / New Intention toggles, one shared style. */}
        <div role="radiogroup" aria-label="Why" className="flex gap-2 mb-4">
          {CLOSE_REASONS.map((r) => (
            <ToggleButton
              key={r.value}
              role="radio"
              on={reason === r.value}
              onClick={() => setReason(r.value)}
              disabled={busy}
              icon={r.icon}
              label={r.label}
              tone={r.tone}
            />
          ))}
        </div>
        <div className="mb-4 p-3 rounded-lg bg-muted/50 border border-border">
          <DateRow id="close-closed-on" label="Closed on" value={closedOn} today={today} max={today} onPick={pickClosedOn} disabled={busy} />
        </div>
        <label htmlFor="close-note" className="block text-sm font-medium text-foreground mb-2">
          Note (optional)
        </label>
        <textarea
          id="close-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full px-3 py-2 border border-border rounded min-h-[96px] text-base"
        />
        {question && <p className="text-sm mt-3">{question.summary}</p>}
        {failed && <p className="text-sm text-destructive mt-2">It was not closed. Try again.</p>}
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            onClick={confirm}
            disabled={busy || !reason}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-60"
          >
            <CircleCheckBig className="w-5 h-5" />
            Close
          </button>
          <CancelButton onClick={onCancel} disabled={busy} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
