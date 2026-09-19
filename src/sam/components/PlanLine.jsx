import React, { useState } from "react";
import { Check } from "lucide-react";
import { planLineText } from "../lib/activePlan";
import PlanNextButton from "./PlanNextButton";

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
//
// Once the item is done, a "Next: <song> <range>" button appears beside it
// (2026-09-19) — the same PlanNextButton the home page checklist uses, calling
// the same open-plan-item handler. This is the important one: after finishing
// an item at the keyboard he can go straight to the next without leaving the
// song view.
//
// READABILITY (2026-09-17): read from the keyboard, further away than normal
// use. Everything here is body size (text-sm) at full `foreground` contrast —
// a done item keeps its check mark rather than being dimmed — and amber is
// `amber-800` (7.1:1 on the card). The song note stays a step down in weight
// only, not in contrast.
export default function PlanLine({ item, state, songNote, heardTempo, onSetTempo, nextItem, onOpenNext }) {
  const [noteOpen, setNoteOpen] = useState(false);
  if (!item && !songNote) return null;

  const tone = item && state.amber ? "text-amber-800" : "text-foreground";
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
          {state.done && <PlanNextButton item={nextItem} onOpen={onOpenNext} />}
        </div>
      )}
      {songNote && (
        <button
          type="button"
          onClick={() => setNoteOpen((o) => !o)}
          aria-expanded={noteOpen}
          className={`block w-full text-left text-foreground ${noteOpen ? "whitespace-pre-wrap" : "truncate"}`}
        >
          Song goal: {songNote}
        </button>
      )}
    </div>
  );
}
