import React from "react";
import { ArrowRight } from "lucide-react";
import { itemShortRange, nextItemLabel } from "../lib/activePlan";

// "Next: Autumn Leaves m.1–16" — the one control that moves him from a
// finished plan item to the next one (2026-09-19). It lives on the PLAYER's
// plan line only: that is the whole point of it, since finishing an item at
// the keyboard should not mean walking back to the home page to start the
// next. The home page needs no such button — it already lists every item, and
// tapping a row opens it.
//
// `onOpen` is the caller's existing open-plan-item handler, so tapping Next
// does exactly what tapping that item on the checklist does, including loading
// its snippet and putting its target tempo in the tempo box for the sitting.
//
// STYLE: the outline of its neighbours Save and Tuning — same border, radius,
// background, muted text and body size — but about a quarter shorter and
// narrower, because it sits beside the plan line and must not compete with it
// for attention. The SHRINKING IS VISUAL ONLY: the button element stays 44px
// tall and pads the smaller box inside itself, so the thing a finger has to
// land on is full size. The song title truncates; the range never does,
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
      // No border or background of its own: this is the 44px hit area, and the
      // visible button is the box inside it.
      className={"group inline-flex max-w-full items-center min-h-[44px] py-1.5 " + className}
    >
      <span
        data-next-box=""
        className="inline-flex max-w-full items-center gap-1.5 px-2.5 min-h-[33px] border border-border
          rounded text-sm text-muted-foreground group-hover:text-dark transition-colors"
      >
        <span className="shrink-0">Next:</span>
        <span className="min-w-0 truncate">{item.song_title || "Untitled"}</span>
        {range && <span className="shrink-0">{range}</span>}
        <ArrowRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      </span>
    </button>
  );
}
