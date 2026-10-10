import React, { useState } from "react";
import { Check } from "lucide-react";

// Asked on Complete: a note box and nothing else. The box starts with the note
// already written during the run, so finishing edits that one note.
export default function CompleteNoteDialog({ initialNote = "", onComplete, onCancel }) {
  const [text, setText] = useState(initialNote);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function complete() {
    setBusy(true);
    setFailed(false);
    const ok = await onComplete(text);
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
