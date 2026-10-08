import React, { useState } from "react";
import { Check, Circle, CircleAlert, CircleDot, CircleSlash, Flame, Mountain } from "lucide-react";
import { planLineText } from "../lib/activePlan";
import PlanNextButton from "./PlanNextButton";

// WHY Mountain FOR THE SONG GOAL (2026-09-27). It must not be confusable with the
// plan line's circle family at a glance, which rules out both of the obvious "goal"
// glyphs: Target is three concentric rings and Crosshair is a ring with ticks, and
// at 16px a step back from the keyboard either reads as "another plan circle". Flag
// was the first pick and Mountain replaced it on sight — same reasoning, a shape
// with no circle in it, and the thing being climbed rather than the marker at the
// top of it.
//
// ONE ICON SLOT, SO THE THREE LINES READ AS A COLUMN (2026-09-27). Same size,
// same left edge, same gap on every row — which is what makes the text of all
// three start at one place. Before this the plan line was the only one with an
// icon, so its text sat indented from the two lines under it.
//
// `shrink-0` matters: these rows wrap, and an icon allowed to squash would take
// the column with it.
const ICON = "w-4 h-4 shrink-0";

// The plan line's state, as one shape with only the fill changing (Circle →
// CircleDot → Check), plus CircleAlert for the amber case. One family means the
// four states are told apart by fill rather than by four unrelated glyphs.
//
// The COLOUR follows the line's own text: `state.amber` still decides that, and
// still means exactly what it meant before — attempted today, not finished — so
// nothing about the plan line's colouring or the home checklist changes here.
function PlanIcon({ state, tone }) {
  if (state.done) {
    return <Check className={`${ICON} ${tone}`} role="img" aria-label="Done" />;
  }
  // Attempts today but not one of them qualifying: the case worth flagging.
  if (state.amber && !state.shown) {
    return <CircleAlert className={`${ICON} text-amber-800`} role="img" aria-label="Attempted, none counted yet" />;
  }
  if (state.shown > 0) {
    return <CircleDot className={`${ICON} ${tone}`} role="img" aria-label="In progress" />;
  }
  return <Circle className={`${ICON} text-muted-foreground`} role="img" aria-label="Not started" />;
}

// The practice plan, as it applies to what is loaded in the player (practice
// plans spec §7.4). One compact line directly under the stats row, each line led
// by an icon at a shared size and left edge so the block reads as a column:
//
//   ◉ Plan · 60 BPM · 90% · 2/4 today · Count out loud    [Set tempo]
//   ▲ Warm-up · 70% → 100% · from this snippet
//   ⛰ Song goal: Master m.16–17, then start m.18.
//
// A warm-up line sits between them whenever the Warm up button is available for
// the loaded range (warm-up spec §7.3), whether or not that range is in the plan:
//
//   Warm-up · 50% → 70% → 100% · from the plan
//   Warm-up · 70% → 100% · from this snippet
//   Warm-up · 70% → 85% → 100% · default
//
// IT IS NOT CONDITIONAL ON A PLAN ITEM (2026-09-27). It used to render only under
// the plan line, so off plan — and in particular when the ladder came from the app
// DEFAULT — nothing on screen said what Warm up would do. Alex ran a three-rung
// default believing it was his own two-rung ladder. Its slot in this block is
// fixed, third of four, so the lines below it do not move as he goes on and off
// the plan.
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
export default function PlanLine({
  item, state, songNote, heardTempo, onSetTempo, nextItem, onOpenNext,
  warmupSummary = null, warmupSourceLabel = null,
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  // The loaded range is in no item, but the plan still has work left in it.
  // `nextItem` is null when there is no plan or everything is done, and that
  // is what keeps this row off screen in both of those cases.
  const offPlan = !item && !!nextItem;
  if (!item && !songNote && !offPlan && !warmupSummary) return null;

  const tone = item && state.amber ? "text-amber-800" : "text-foreground";
  const showSetTempo = item && heardTempo !== item.target_effective_bpm;

  return (
    <div className="mb-2 px-1 text-sm" aria-label="Practice plan">
      {offPlan && (
        <div className="flex items-center gap-2 min-h-[44px]" data-state="off-plan">
          {/* A SLASHED circle, which is the one shape that says what this row
              means: the loaded range is not a plan item at all, so none of the
              four plan states applies to it. Muted, because it is the absence of
              plan work rather than plan work going badly. */}
          <CircleSlash className={`${ICON} text-muted-foreground`} role="img" aria-label="Not in the plan" />
          <span className="text-foreground min-w-0 truncate">Not in today&apos;s plan</span>
          <PlanNextButton item={nextItem} onOpen={onOpenNext} className="ml-auto min-w-0" />
        </div>
      )}
      {/* The plan bar: one line, the text truncating (full text in its title)
          so Set tempo and Next never wrap; Next sits at the right end. */}
      {item && (
        <div
          className="flex items-center gap-2 min-h-[44px]"
          data-state={state.done ? "done" : state.amber ? "amber" : "open"}
        >
          <PlanIcon state={state} tone={tone} />
          <span className={`${tone} min-w-0 truncate`} title={planLineText(item, state)}>{planLineText(item, state)}</span>
          {showSetTempo && (
            <button
              type="button"
              onClick={onSetTempo}
              title={`Set the tempo box to ${item.target_effective_bpm} BPM for this session`}
              className="shrink-0 whitespace-nowrap flex items-center gap-1 px-3 py-1.5 border border-border rounded text-sm text-muted-foreground hover:text-dark min-h-[44px]"
            >
              Set tempo
            </button>
          )}
          {state.done && <PlanNextButton item={nextItem} onOpen={onOpenNext} className="ml-auto min-w-0" />}
        </div>
      )}
      {/* Whenever Warm up is available — see the note at the top. A ramp that
          appears on Warm up without warning is the thing the source label exists
          to prevent, and the default is the case that most needs saying. */}
      {warmupSummary && (
        <div
          className="flex items-center gap-2 flex-wrap text-foreground"
          data-state="warmup-summary"
          data-testid="warmup-line"
        >
          <Flame className={`${ICON} text-muted-foreground`} aria-hidden="true" />
          <span>
            Warm-up · {warmupSummary}
            {warmupSourceLabel ? ` · ${warmupSourceLabel}` : ""}
          </span>
        </div>
      )}
      {songNote && (
        <button
          type="button"
          onClick={() => setNoteOpen((o) => !o)}
          aria-expanded={noteOpen}
          className="flex w-full items-start gap-2 text-left text-foreground"
        >
          <Mountain className={`${ICON} mt-0.5 text-muted-foreground`} aria-hidden="true" />
          <span className={`min-w-0 ${noteOpen ? "whitespace-pre-wrap" : "truncate"}`}>
            Song goal: {songNote}
          </span>
        </button>
      )}
    </div>
  );
}
