import React, { useState } from "react";
import { Check, Repeat } from "lucide-react";
import { longDate } from "../utils/recurrenceDisplay";

// Asked on Complete: when it was done, a note box, and for a repeating intention the
// next date. The box starts with the note already written during the run, so
// finishing edits that one note.
//
// `completion` (Restructure P4 Step 7): { today } — "Completed on" may be any past
// day (backfilling is fine), never a future one.
// `next`, only for a repeat: { defaultDate, kind, today, endDate, recompute } where
// defaultDate is nextOccurrence's answer ("YYYY-MM-DD", or null when the repeat has
// ended), kind is the repeat line's text, and recompute(completedOn) gives the next
// date for another completion date (it matters only for "after completion" repeats).
// onComplete(text, nextDate, completedOn).
export default function CompleteNoteDialog({ initialNote = "", onComplete, onCancel, next = null, completion = null }) {
  const today = completion?.today || next?.today;
  const [text, setText] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [completedOn, setCompletedOn] = useState(today || null);
  const [nextDate, setNextDate] = useState(next?.defaultDate || null);
  // Once Next is chosen by hand, a new Completed on leaves it alone.
  const [nextChosen, setNextChosen] = useState(false);

  function pickCompletedOn(value) {
    if (value > completion.today) return "It cannot be completed in the future.";
    setCompletedOn(value);
    if (next?.recompute && !nextChosen) setNextDate(next.recompute(value));
    return null;
  }

  function pickNext(value) {
    if (value < next.today) return "Pick today or a later date.";
    if (next.endDate && value > next.endDate) {
      return `The repeat ends on ${longDate(next.endDate, next.today)}.`;
    }
    setNextDate(value);
    setNextChosen(true);
    return null;
  }

  async function complete() {
    setBusy(true);
    setFailed(false);
    const ok = await onComplete(text, nextDate, completedOn);
    if (!ok) {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-label="Complete execution"
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-3">Complete</h3>
        {(completion || next) && (
          <div className="mb-4 p-3 rounded-lg bg-muted/50 border border-border space-y-3">
            {completion && (
              <DateRow
                id="complete-completed-on"
                label="Completed on"
                value={completedOn}
                today={completion.today}
                max={completion.today}
                onPick={pickCompletedOn}
                disabled={busy}
              />
            )}
            {next &&
              (nextDate ? (
                <DateRow
                  id="complete-next-date"
                  label="Next"
                  value={nextDate}
                  today={next.today}
                  min={next.today}
                  max={next.endDate}
                  onPick={pickNext}
                  disabled={busy}
                >
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Repeat className="w-3.5 h-3.5" aria-hidden="true" />
                    {next.kind}
                  </p>
                </DateRow>
              ) : (
                <p className="text-sm">Repeat has ended</p>
              ))}
          </div>
        )}
        <label htmlFor="complete-note" className="block text-sm font-medium text-foreground mb-2">
          Note (optional)
        </label>
        <textarea
          id="complete-note"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="How did it go?"
          className="w-full px-3 py-2 border border-border rounded min-h-[120px] text-base"
        />
        {failed && (
          <p className="text-sm text-destructive mt-2">The note was not saved. Try again, or clear it to complete without one.</p>
        )}
        <div className="flex flex-col gap-2 mt-4">
          <button
            type="button"
            onClick={complete}
            disabled={busy}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] bg-primary hover:bg-primary-hover text-white rounded-lg shadow-sm disabled:opacity-60"
          >
            <Check className="w-5 h-5" />
            Complete
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

/**
 * "Label: Friday, October 16" with Change. While picking, a date input labelled
 * with the same word takes the line's place: one date, one label.
 * onPick(value) returns an error to show, or null when the date was taken.
 * `min` and `max` are plain "YYYY-MM-DD" dates, as a date input expects.
 */
function DateRow({ id, label, value, today, min, max, onPick, disabled, children }) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState(null);
  return (
    <div>
      {picking ? (
        <div>
          <label htmlFor={id} className="block text-sm font-medium mb-1">
            {label}
          </label>
          <input
            id={id}
            type="date"
            defaultValue={value}
            min={min || undefined}
            max={max || undefined}
            onChange={(e) => {
              if (!e.target.value) return;
              const problem = onPick(e.target.value);
              setError(problem);
              if (!problem) setPicking(false);
            }}
            className="w-full px-2 py-1 border border-border rounded text-sm"
          />
          {error && (
            <p role="alert" className="text-xs text-destructive mt-1">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {label}: {longDate(value, today)}
          </p>
          <button
            type="button"
            onClick={() => setPicking(true)}
            disabled={disabled}
            aria-label={`Change ${label.toLowerCase()}`}
            className="text-sm text-primary hover:text-primary-hover min-h-[44px] px-2"
          >
            Change
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
