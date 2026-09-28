import React from "react";
import TargetGroup from "./TargetGroup";

// The live run on a CONSECUTIVE plan item, in the playing bar beside the warm-up
// strip and in the same style (warm-up spec §7.2 wording, practice plans §5.3):
//
//   In a row  95% (40) ●●○  ·  best 2 of 3 today
//
// The circles are the CURRENT run: they fill as qualifying passes land and go
// back to empty the moment one does not. That is the number he cannot get from
// anywhere else on screen, and it is the one that decides whether to keep going
// or take the phrase again.
//
// TWO NUMBERS, LABELLED, BECAUSE THEY DISAGREE ON PURPOSE (2026-09-28).
// `sam_plan_item_progress` returns longest_qualifying_streak — the BEST run of
// the day — and that is the right number for deciding whether the item is done,
// so it never rolls back when a later pass fails. The checklist keeps it, and it
// is repeated here as "best N of M today" so the two are on screen together and
// cannot be mistaken for each other: circles are now, text is the best so far.
// Seeing 2/3 stand still after a miss is the system working, not a stale count.
//
// The circles are never the source of truth for "done" — that stays the
// database's number, which counts passes this strip may not have seen (an
// earlier sitting today, the same item practised from another device).
export default function ConsecutiveStrip({ view }) {
  if (!view) return null;
  const { accuracy, effectiveBpm, target, filled, best } = view;

  return (
    <div className="mb-2 px-1 text-sm" aria-label="Passes in a row">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium text-foreground shrink-0">In a row</span>
        <TargetGroup
          accuracy={accuracy}
          effectiveBpm={effectiveBpm}
          target={target}
          filled={filled}
          state="current"
          label="current run"
        />
        <span className="text-muted-foreground" data-testid="consecutive-best">
          · best {best} of {target} today
        </span>
      </div>
    </div>
  );
}
