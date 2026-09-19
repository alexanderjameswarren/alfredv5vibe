import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import {
  firstIncompleteItem, itemRangeText, itemState, itemTargetText, planIsComplete, planSummary,
} from "../lib/activePlan";

// Today's practice plan, on the SAM home page directly above the 7-day
// snapshot (practice plans spec §7.3). Renders nothing without an active plan.
//
// Collapsed (the default): one summary line and the day note, truncated.
// Expanded: the full day note, the plan's items in order, then the optional
// Free Play items under their own label. Tapping an item opens its song and
// snippet at the item's target tempo (SamPlayer's openPlanItem).
//
// Every count comes from `progress` — sam_plan_item_progress for today — and
// is never worked out from passes here.
//
// ON LOAD (2026-09-19), once and only once `progressReady` says the counts are
// real: an expanded strip scrolls the first item still to do into view near the
// top, main work before Free Play; a plan with nothing left to do renders
// collapsed instead. Both are decisions for that load alone — the stored
// expanded/collapsed preference is never overwritten by them — and neither
// happens again, so the page cannot move while he is reading it.
//
// There is deliberately no "Next" button here. This page already lists every
// item, and tapping a row already opens it; Next exists only to save a trip
// BACK to this page, so it lives on the player's plan line alone.
//
// READABILITY (2026-09-17): this is read from across the room, without
// glasses. Nothing here is smaller than text-sm, the body size used across
// SAM; the progress count is a step larger than the title because it is the
// number glanced at most. The target and instruction carry full `foreground`
// contrast (15.2:1 on the card) and only the range line stays muted
// (`muted-foreground`, 8.4:1 — the darkest muted token there is). A done item
// keeps its strikethrough but NOT reduced contrast: finished still has to be
// readable. Amber is `amber-800` (7.1:1 on the card), which stays clearly
// apart from the plain rows at this weight; `amber-700` was 5.0:1.

const STORAGE_KEY = "sam.planChecklist.expanded";

function readExpanded() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* Storage unavailable: the choice just isn't remembered. */
  }
}

// A jump rather than a glide when the system asks for less motion.
function scrollBehavior() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

// Four lines, so two items on one song never look alike even when a long song
// title is cut short:
//   1. song title (truncated), progress kept visible on the right
//   2. range — "m.1–2 · RH", "Whole song", or "(snippet archived)" — muted
//   3. target
//   4. instruction, when there is one
//
// Each row is a tap target that opens the song (and its snippet) at the item's
// tempo, so it has to LOOK like one on a tablet, where there is no hover to
// discover it with: its own outlined surface, a chevron at the trailing edge,
// and a pressed state.
function ItemRow({ item, progress, onOpen, rowRef }) {
  const st = itemState(item, progress);
  // Done is struck through, never dimmed; amber stays full-contrast too.
  const tone = st.amber ? "text-amber-800" : "text-foreground";
  const strike = st.done ? "line-through" : "";

  return (
    // `scroll-mt-4` keeps the auto-scrolled row off the very top edge.
    <li ref={rowRef} className="scroll-mt-4">
      <button
        type="button"
        onClick={() => onOpen?.(item)}
        className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left border border-border bg-card hover:bg-secondary/60 active:bg-secondary transition-colors min-h-[52px]"
        data-state={st.done ? "done" : st.amber ? "amber" : "open"}
      >
        <span className="w-5 h-5 mt-0.5 flex-shrink-0 flex items-center justify-center">
          {st.done && <Check className="w-4 h-4 text-success" role="img" aria-label="Done" />}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-3">
            <span className={`flex-1 min-w-0 text-sm font-medium truncate ${tone} ${strike}`}>
              {item.song_title}
            </span>
            <span
              className={`text-base font-mono font-semibold tabular-nums flex-shrink-0 ${tone}`}
              aria-label={`${st.shown} of ${st.target} passes${st.done ? ", done" : ""}`}
            >
              {st.shown}/{st.target}
            </span>
            {/* The "this opens" cue, in the same place as the practice
                snapshot's. Decorative: the row's own text is its name. */}
            <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          </span>
          <span className={`block text-sm text-muted-foreground ${strike}`}>{itemRangeText(item)}</span>
          <span className={`block text-sm ${tone} ${strike}`}>{itemTargetText(item)}</span>
          {item.instruction && (
            <span className={`block text-sm ${tone} ${strike}`}>{item.instruction}</span>
          )}
        </span>
      </button>
    </li>
  );
}

export default function PlanChecklist({ plan, progress, progressReady = false, onOpenItem }) {
  const [expanded, setExpanded] = useState(readExpanded);
  // A display decision for THIS load only, never written to storage: a plan
  // that is already finished opens collapsed, so tomorrow's unfinished plan
  // still opens expanded exactly as he left it.
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const rowRefs = useRef(new Map());
  const didAuto = useRef(false);

  // On load, once, and only once progress has actually arrived — an empty
  // progress map looks identical to "nothing done yet", which would scroll to
  // the top item and then be wrong a moment later. After this has run the page
  // is his: it must never move under him while he is reading or scrolling.
  useEffect(() => {
    if (didAuto.current || !plan || !progressReady) return;
    if (!(plan.items || []).length) return;
    didAuto.current = true;

    if (planIsComplete(plan, progress)) {
      setAutoCollapsed(true);
      return;
    }
    if (!readExpanded()) return; // collapsed: there is nothing on screen to scroll to
    const target = firstIncompleteItem(plan, progress);
    const el = target && rowRefs.current.get(target.id);
    // `block: "start"` puts the row near the top of the viewport; the browser
    // default would leave it hard against the bottom edge when scrolling down.
    el?.scrollIntoView?.({ block: "start", behavior: scrollBehavior() });
  }, [plan, progress, progressReady]);

  if (!plan) return null;

  const items = plan.items || [];
  const main = items.filter((i) => !i.is_free_play);
  const free = items.filter((i) => i.is_free_play);
  const showExpanded = expanded && !autoCollapsed;

  function toggle() {
    const next = !showExpanded;
    setAutoCollapsed(false); // his tap wins over the auto-collapse for this load
    setExpanded(next);
    writeExpanded(next);
  }

  function rowFor(item) {
    return (
      <ItemRow
        key={item.id}
        item={item}
        progress={progress}
        onOpen={onOpenItem}
        rowRef={(el) => {
          if (el) rowRefs.current.set(item.id, el);
          else rowRefs.current.delete(item.id);
        }}
      />
    );
  }

  return (
    <section className="mt-2 w-full bg-card border border-border rounded-lg" aria-label="Today's practice plan">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={showExpanded}
        className="w-full flex items-center gap-3 p-3 text-left rounded-lg hover:bg-secondary/40 transition-colors min-h-[56px]"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-foreground">{planSummary(plan, progress)}</span>
          {!showExpanded && plan.day_note && (
            <span className="block text-sm text-muted-foreground truncate">{plan.day_note}</span>
          )}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${showExpanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {showExpanded && (
        <div className="px-2 pb-3">
          {plan.day_note && (
            <p className="pb-3 text-sm text-foreground whitespace-pre-wrap">{plan.day_note}</p>
          )}
          <ul className="flex flex-col gap-2">{main.map(rowFor)}</ul>
          {free.length > 0 && (
            <>
              <div className="pt-3 pb-2 text-sm uppercase tracking-wide text-muted-foreground">
                Optional Free Play
              </div>
              <ul className="flex flex-col gap-2">{free.map(rowFor)}</ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
