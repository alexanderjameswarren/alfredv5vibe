import React from "react";

// Number bar for RH fingering entry (edit view, fingering mode on).
//
// Renders inline in the toolbar row above the score, on the same line as the
// Undo and Fingering-mode buttons (per user request, overriding the spec's
// "docked at the bottom of the score pane"). Not a floating popover — no
// flip/clip logic, and it stays put for consecutive entry. Contents: 1–5, ✕
// (clear), › (advance to next RH note). Buttons are ≥56px, spaced 8px. The
// action buttons enable once a note is selected. For a multi-notehead (chord)
// event, a stacked-dot notehead picker appears; it defaults to the top notehead
// (the melody note).
//
// Pure presentational — all state lives in the parent.
const BTN = "h-14 w-14 rounded-lg border text-lg font-semibold flex items-center justify-center transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed";

export default function FingeringBar({
  hasSelection,
  currentFinger = null,
  noteheadCount = 0,
  selectedNoteIndex = 0,
  canAdvance = false,
  onNumber,
  onClear,
  onAdvance,
  onPickNotehead,
}) {
  const accentStyle = { backgroundColor: "var(--fingering-accent)", color: "var(--fingering-accent-fg)", borderColor: "transparent" };

  // Notehead picker: dots top→bottom = highest→lowest note_index (top = melody).
  const noteheadDots = [];
  if (noteheadCount > 1) {
    for (let ni = noteheadCount - 1; ni >= 0; ni--) {
      const active = ni === selectedNoteIndex;
      noteheadDots.push(
        <button
          key={ni}
          type="button"
          aria-label={`Notehead ${ni + 1}`}
          aria-pressed={active}
          onClick={() => onPickNotehead?.(ni)}
          className="w-6 h-6 rounded-full border flex items-center justify-center"
          style={active ? accentStyle : { borderColor: "var(--border)" }}
        >
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: active ? "var(--fingering-accent-fg)" : "var(--muted-foreground)" }} />
        </button>
      );
    }
  }

  return (
    <div className="flex items-center gap-2">
      {noteheadCount > 1 && (
        <div className="flex flex-col gap-1 mr-1" title="Choose notehead (top = melody)">
          {noteheadDots}
        </div>
      )}

      {[1, 2, 3, 4, 5].map((n) => {
        const active = hasSelection && currentFinger === n;
        return (
          <button
            key={n}
            type="button"
            disabled={!hasSelection}
            onClick={() => onNumber?.(n)}
            className={BTN}
            style={active ? accentStyle : { borderColor: "var(--border)" }}
          >
            {n}
          </button>
        );
      })}

      <button
        type="button"
        disabled={!hasSelection}
        onClick={() => onClear?.()}
        aria-label="Clear fingering"
        className={`${BTN} text-muted-foreground`}
        style={{ borderColor: "var(--border)" }}
      >
        ✕
      </button>

      <button
        type="button"
        disabled={!hasSelection || !canAdvance}
        onClick={() => onAdvance?.()}
        aria-label="Next note"
        className={BTN}
        style={{ borderColor: "var(--border)" }}
      >
        ›
      </button>
    </div>
  );
}
