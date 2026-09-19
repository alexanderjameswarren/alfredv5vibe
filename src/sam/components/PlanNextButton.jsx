import React from "react";
import { ArrowRight } from "lucide-react";
import { itemShortRange, nextItemLabel } from "../lib/activePlan";

// "Next: Autumn Leaves m.1–16" — the one control that moves him from a
// finished plan item to the next one (2026-09-19). Shown on a completed row,
// on the home page checklist AND on the player's plan line, which is the one
// that matters: finishing an item at the keyboard should not mean walking back
// to the home page to start the next.
//
// It is deliberately the SAME component in both places, so the two can never
// drift apart in wording or behaviour, and `onOpen` is the caller's existing
// open-plan-item handler — tapping Next does exactly what tapping that item on
// the checklist does, including loading its snippet and putting its target
// tempo in the tempo box for the sitting.
//
// READABILITY: read at arm's length, without glasses, so unlike the muted
// outlined Save and Goal buttons this one is FILLED — `primary` on white is
// 7.2:1, and white on `primary` the same — at body size, 44px tall, with an
// arrow to say where it goes. The song title truncates; the range never does,
// because "Next: Autumn Le…" is useless but "Next: Autumn… m.1–16" is not.
export default function PlanNextButton({ item, onOpen, className = "" }) {
  if (!item) return null;
  const label = nextItemLabel(item);
  const range = itemShortRange(item);

  return (
    <button
      type="button"
      onClick={() => onOpen?.(item)}
      aria-label={label}
      title={label}
      data-next-item-id={item.id}
      className={
        "max-w-full inline-flex items-center gap-2 px-3 py-1.5 min-h-[44px] rounded-lg border " +
        "border-primary bg-primary text-primary-foreground text-sm font-medium " +
        "hover:bg-primary-hover active:bg-primary-dark transition-colors " +
        className
      }
    >
      <span className="shrink-0">Next:</span>
      <span className="min-w-0 truncate">{item.song_title || "Untitled"}</span>
      {range && <span className="shrink-0">{range}</span>}
      <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
    </button>
  );
}
