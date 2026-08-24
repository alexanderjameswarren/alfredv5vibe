import React, { useEffect, useRef, useState } from "react";
import { Undo2, X } from "lucide-react";

// The 5-second Undo message. Step 2 of docs/technical-spec-ui-standardization.md.
//
// This replaces confirmation dialogs, so it is the ONLY thing standing between a
// destructive click and permanent loss. That shapes the design in three ways:
//
//   1. It is a single slot. Two overlapping messages would mean the second one
//      silently strands the first offer, and the user would have no way to know
//      which record they were about to rescue. Offering a new undo therefore
//      cancels the previous timer and replaces the message.
//   2. The restore is an arbitrary async function, not a record + a flag. The
//      spec names two shapes and the app already needs a third:
//
//        flip a flag back   archive          write the record with archived: false
//        put the row back   hard delete      write the whole row, id and all
//        compound           archive+cascade  several of the above, plus a delete
//
//      `archiveIntention` archives an intention *and* every event hanging off
//      it, and archiving a recurring event *creates* its successor — so a
//      faithful undo has to insert and delete in the same breath. A closure
//      covers all three; a { record, flag } payload covers only the first.
//   3. Nothing here talks to the database. The caller owns its own state
//      setters, so the restore closure is written where those setters are in
//      scope. This module owns the message, the timer, and the single slot.
//
// On the "put the row back" shape specifically: Alfred's `storage.set` is
// already an id-preserving upsert — it UPDATEs by id and INSERTs only when that
// matches no rows — so re-inserting a deleted row is the same one-line call as
// any other write, and the original id survives for free. Nothing extra is
// needed to satisfy the spec's "preserve the original id".

export const UNDO_DURATION_MS = 5000;

/**
 * Owns the pending undo offer and its expiry timer.
 *
 * @param {number} [durationMs] - How long an offer stays on screen.
 * @returns {{
 *   pendingUndo: {message: string, restore: Function}|null,
 *   offerUndo: (message: string, restore: Function) => void,
 *   runUndo: () => Promise<void>,
 *   dismissUndo: () => void,
 * }}
 */
export function useUndo(durationMs = UNDO_DURATION_MS) {
  const [pendingUndo, setPendingUndo] = useState(null);
  const timerRef = useRef(null);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // A timer that outlives the component would call setState on an unmounted
  // tree. Alfred itself never unmounts, but the hook must not depend on that.
  useEffect(() => clearTimer, []);

  /**
   * Offer an undo. Replaces any offer already on screen — see note 1 above.
   *
   * `restore` may be async and may do as much work as it needs to; it runs
   * inside the caller's own loading wrapper, not here.
   */
  function offerUndo(message, restore) {
    // Cleared before the new timer is scheduled, so exactly one timer is ever
    // live. That is what makes a stale timer unable to expire a fresh offer.
    clearTimer();
    setPendingUndo({ message, restore });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPendingUndo(null);
    }, durationMs);
  }

  function dismissUndo() {
    clearTimer();
    setPendingUndo(null);
  }

  async function runUndo() {
    if (!pendingUndo) return;
    const { restore } = pendingUndo;
    // Taken down first: the work can take a moment, and leaving an Undo button
    // live during it invites a second click that would restore twice.
    dismissUndo();
    await restore();
  }

  return { pendingUndo, offerUndo, runUndo, dismissUndo };
}

/**
 * The message itself. Presentational — it renders whatever `pendingUndo` holds
 * and reports clicks back.
 *
 * Deliberately NOT positioned. The spec requires it to sit above the Capture
 * bar, and the Capture bar's height changes as its textarea grows, so any
 * `bottom-N` offset here would be a number that goes wrong the moment somebody
 * types a long capture. Alfred renders this as an ordinary block directly above
 * the Capture bar inside the one shared fixed container, which makes "above the
 * Capture bar" structural instead of arithmetic.
 */
export default function UndoMessage({ pendingUndo, onUndo, onDismiss }) {
  if (!pendingUndo) return null;

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 pb-2">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2 bg-foreground text-white rounded-lg shadow-lg"
      >
        <span className="text-sm min-w-0 truncate">{pendingUndo.message}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onUndo}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-sm font-medium rounded-lg hover:bg-white/15 transition-colors"
          >
            <Undo2 className="w-4 h-4" />
            Undo
          </button>
          <button
            onClick={onDismiss}
            title="Dismiss"
            aria-label="Dismiss"
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-white/15 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
