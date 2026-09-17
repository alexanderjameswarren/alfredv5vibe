import React, { useState } from "react";
import { Check } from "lucide-react";
import { planLineText } from "../lib/activePlan";

// The practice plan, as it applies to what is loaded in the player (practice
// plans spec §7.4). One compact line directly under the stats row, shown only
// when the loaded song or range is in the plan:
//
//   Plan · 60 BPM · 90% · 2/4 today · Count out loud      [Set tempo]
//   Song goal: Master m.16–17, then start m.18.
//
// The first line appears when the loaded range matches an item; the second
// when the song is in the plan and has a song note (alone when the range has no
// item). Counts come from `state` — sam_plan_item_progress — never from passes.
//
// "Set tempo" appears only when the heard tempo differs from the item's target.
// It changes the tempo box for this sitting; nothing is saved to the song.
export default function PlanLine({ item, state, songNote, heardTempo, onSetTempo }) {
  const [noteOpen, setNoteOpen] = useState(false);
  if (!item && !songNote) return null;

  const tone = !item ? "" : state.done ? "text-muted-foreground" : state.amber ? "text-amber-700" : "text-dark";
  const showSetTempo = item && heardTempo !== item.target_effective_bpm;

  return (
    <div className="mb-2 px-1 text-sm" aria-label="Practice plan">
      {item && (
        <div
          className="flex items-center gap-2 flex-wrap min-h-[44px]"
          data-state={state.done ? "done" : state.amber ? "amber" : "open"}
        >
          {state.done && <Check className="w-4 h-4 text-success shrink-0" role="img" aria-label="Done" />}
          <span className={tone}>{planLineText(item, state)}</span>
          {showSetTempo && (
            <button
              type="button"
              onClick={onSetTempo}
              title={`Set the tempo box to ${item.target_effective_bpm} BPM for this session`}
              className="flex items-center gap-1 px-3 py-1.5 border border-border rounded text-sm text-muted-foreground hover:text-dark min-h-[44px]"
            >
              Set tempo
            </button>
          )}
        </div>
      )}
      {songNote && (
        <button
          type="button"
          onClick={() => setNoteOpen((o) => !o)}
          aria-expanded={noteOpen}
          className={`block w-full text-left text-muted-foreground ${noteOpen ? "whitespace-pre-wrap" : "truncate"}`}
        >
          Song goal: {songNote}
        </button>
      )}
    </div>
  );
}
