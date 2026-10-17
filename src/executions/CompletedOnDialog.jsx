import React, { useState } from "react";
import { getTodayDate } from "../utils/eventDates";

/**
 * Change a completed execution's date (Restructure P4 Step 7): any past day, never a
 * future one, as "Completed on" in the Complete pop-up. onSave(date) resolves to true
 * when saved.
 */
export default function CompletedOnDialog({ initialDate, onSave, onCancel, today = getTodayDate() }) {
  const [date, setDate] = useState(initialDate || today);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!date) return setError("Pick a date.");
    if (date > today) return setError("It cannot be completed in the future.");
    setBusy(true);
    const ok = await onSave(date);
    if (!ok) setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-label="Change completion date"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <label htmlFor="completed-on-edit" className="block text-sm font-medium mb-1">
          Completed on
        </label>
        <input
          id="completed-on-edit"
          type="date"
          value={date}
          max={today}
          onChange={(e) => {
            setDate(e.target.value);
            setError(null);
          }}
          className="w-full px-3 py-2 min-h-[44px] border border-border rounded text-base"
        />
        {error && (
          <p role="alert" className="text-xs text-destructive mt-1">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 mt-4">
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-60"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 min-h-[44px] text-sm text-muted-foreground rounded hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
