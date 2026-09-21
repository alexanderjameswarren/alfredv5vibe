import React, { useState } from "react";
import { Check } from "lucide-react";
import { planLineText } from "../lib/activePlan";
import PlanNextButton from "./PlanNextButton";

// The practice plan, as it applies to what is loaded in the player (practice
// plans spec §7.4). One compact line directly under the stats row:
//
//   Plan · 60 BPM · 90% · 2/4 today · Count out loud      [Set tempo]
//   Song goal: Master m.16–17, then start m.18.
//
// The first line appears when the loaded range matches an item, and — since
// 2026-09-21, see OFF PLAN below — reads "Not in today's plan" when it matches
// none. The second appears when the song is in the plan and has a song note
// (alone when the range has no item and the plan has nothing left to offer).
// Counts come from `state` — sam_plan_item_progress — never from passes.
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
// OFF PLAN (2026-09-21): the same button also appears when the loaded range is
// in NO item at all —
//
//   Not in today's plan                                   [Next: Pastorale m.1–8]
//
// He taps a plan item, finds he needs a different range, makes his own snippet
// and practises that. The plan has not moved, but nothing on screen said so,
// and the only way back was the home page.
//
// WHY A LABELLED LINE RATHER THAN A BARE BUTTON. "Next:" is relative, and on a
// done item the line above it supplies what it is next to. Off plan there is no
// such anchor, and a lone "Next: Pastorale m.1–8" reads as though the plan
// believes he is part-way through something — the one thing that is not true.
// Four words fix it, and they answer the question the button cannot: not where
// to go, but where he IS. It also keeps this block's shape fixed — line one is
// always what the plan says about what is loaded, line two is always the song
// goal — so the score below does not jump as he moves on and off the plan.
//
// Unfinished plan item: still no button. He is exactly where the plan wants
// him, and the way on appears when he has earned it.
//
// READABILITY (2026-09-17): read from the keyboard, further away than normal
// use. Everything here is body size (text-sm) at full `foreground` contrast —
// a done item keeps its check mark rather than being dimmed — and amber is
// `amber-800` (7.1:1 on the card). The song note stays a step down in weight
// only, not in contrast. "Not in today's plan" is plan content, so it takes the
// same full contrast; the button beside it stays muted, exactly as it does
// beside Set tempo.
export default function PlanLine({ item, state, songNote, heardTempo, onSetTempo, nextItem, onOpenNext }) {
  const [noteOpen, setNoteOpen] = useState(false);
  // The loaded range is in no item, but the plan still has work left in it.
  // `nextItem` is null when there is no plan or everything is done, and that
  // is what keeps this row off screen in both of those cases.
  const offPlan = !item && !!nextItem;
  if (!item && !songNote && !offPlan) return null;

  const tone = item && state.amber ? "text-amber-800" : "text-foreground";
  const showSetTempo = item && heardTempo !== item.target_effective_bpm;

  return (
    <div className="mb-2 px-1 text-sm" aria-label="Practice plan">
      {offPlan && (
        <div className="flex items-center gap-2 flex-wrap min-h-[44px]" data-state="off-plan">
          <span className="text-foreground">Not in today&apos;s plan</span>
          <PlanNextButton item={nextItem} onOpen={onOpenNext} />
        </div>
      )}
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
