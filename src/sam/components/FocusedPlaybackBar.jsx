import React from "react";
import { Pause, Flame, Check, ArrowDown, OctagonX } from "lucide-react";
import LiveSessionCounter from "./LiveSessionCounter";
import WarmupStrip from "./WarmupStrip";
import ConsecutiveStrip from "./ConsecutiveStrip";
import { formatAccuracy, goalState } from "../lib/practiceScoring";

// Collapsed top chrome during `playbackState === "playing"`. Everything the
// user doesn't need mid-play (song title, transport speed controls, MIDI
// status, metronome radios, etc.) is dropped from the tree entirely — the
// parent renders this instead of the full SettingsBar / StatsBar stack.
//
// Row 1  → Pause | Warm up again | Session badge + Playthrough badge + Completed Passes + live Today
// Row 2  → Loop / Hits / Misses / Session accuracy (muted, secondary)
// Row 3  → the warm-up ladder strip, while a ladder is running
// Row 4  → the in-a-row strip, on a consecutive plan item
//
// THE WARM-UP STRIP LIVES HERE, NOT BESIDE THE PLAN LINE (warm-up spec §7.2).
// The spec asks for it "near the plan line", but the plan line is part of the
// stack this component REPLACES while playing — and a ladder only runs while
// playing, so a strip rendered next to the plan line could never be seen doing
// its job. It sits here for the run, and the plan line's own warm-up summary
// (§7.3) covers the stopped and paused views.
//
// Playthrough accuracy is the one number worth reading mid-play, so it gets
// the same oversized badge treatment as the Session timer rather than a slot
// in the muted row. The paused/stopped StatsBar keeps it inline instead.
//
// AGAINST THE TARGET, NOT ON ITS OWN (2026-09-28). When the loaded range has an
// accuracy target the badge reads "100% / 95%": the pass, then the bar it has to
// clear. A bare 88% says nothing about whether the pass counted, and at the
// keyboard that is the only question.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Green and red carry it for anyone who sees
// them, and for anyone who does not there is a WORD in the badge label — MET,
// SHORT, or CAN'T REACH — and a shape beside the figure: a tick, a down arrow,
// or a stop sign. Any one of the three is enough on its own.
//
// CAN'T REACH is the §6 warning: enough beats have been missed that the target
// is out of reach for this pass however clean the rest of it is, so the badge
// turns red-on-white-text to say stop and start again rather than finish a pass
// that cannot qualify. It clears when the next playthrough starts.
export default function FocusedPlaybackBar({
  onPause,
  todayMinutes,
  passesToday,
  loopCount,
  hitCount,
  missCount,
  accuracyPercent,
  playthroughPercent,
  hasPlaythrough,
  // { text: "Plan 2/4" | "Plan ✓", state: "open" | "amber" | "done" } when the
  // loaded range is a plan item (practice plans §7.4); null otherwise.
  planBadge = null,
  // The live ladder (warm-up spec §7.2), or null when none is running.
  warmupView = null,
  // The live run on a consecutive item (practice plans §5.3), or null.
  consecutiveView = null,
  // The accuracy a pass must reach right now: the running rung's, else the plan
  // item's. Null off plan with no ladder, where there is no target to show.
  accuracyGoal = null,
  // Enough beats missed that `accuracyGoal` can no longer be reached this pass.
  playthroughImpossible = false,
  // "Warm up again" (§7.1): only reachable mid-play, since the ladder ends with
  // the session and completion leaves him still looping.
  onWarmUp = null,
}) {
  // Null accuracy means nothing was measured; formatAccuracy shows "—".
  const playthroughPct = hasPlaythrough ? playthroughPercent : null;
  const goal = Number.isFinite(accuracyGoal) ? accuracyGoal : null;
  // "met" | "short" | null (no target, or nothing measured yet).
  const met = goalState(playthroughPct, goal);
  const state = playthroughImpossible ? "impossible" : met;
  const word = state === "impossible" ? "can't reach" : state === "met" ? "met" : state === "short" ? "short" : null;
  const ICON = "w-5 h-5 shrink-0";

  return (
    <>
      {/* Top row: Pause button + Session/Today counters, all left-aligned */}
      <div className="flex items-center gap-4 mb-2 px-1 flex-wrap">
        <button
          onClick={onPause}
          className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-amber-500 hover:bg-amber-600 text-white"
        >
          <Pause className="w-4 h-4" /> Pause
        </button>

        {onWarmUp && warmupView && (
          <button
            onClick={onWarmUp}
            className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors border border-border text-muted-foreground hover:text-dark"
          >
            <Flame className="w-4 h-4" />
            Warm up again
          </button>
        )}

        {/* LiveSessionCounter self-gates on playing; passing "playing"
            since FocusedPlaybackBar itself only renders during play. */}
        <LiveSessionCounter
          playbackState="playing"
          todayMinutes={todayMinutes}
          passesToday={passesToday}
          afterPasses={planBadge && (
            <span
              className={`text-sm font-medium ${
                planBadge.state === "amber" ? "text-amber-700"
                  : planBadge.state === "done" ? "text-muted-foreground"
                  : "text-dark"
              }`}
              data-state={planBadge.state}
            >
              {planBadge.text}
            </span>
          )}
        >
          <div
            data-goal={state || "none"}
            className={`flex items-center gap-2 px-3 py-1 rounded-md border ${
              state === "impossible"
                ? "bg-destructive border-destructive"
                : "bg-secondary/40 border-border"
            }`}
          >
            <span className={`text-xs uppercase tracking-wide ${
              state === "impossible" ? "text-destructive-foreground" : "text-muted-foreground"
            }`}>
              Playthrough{word ? ` · ${word}` : ""}
            </span>
            {state === "impossible" ? (
              <OctagonX className={`${ICON} text-destructive-foreground`} role="img" aria-label="Target out of reach" />
            ) : state === "met" ? (
              <Check className={`${ICON} text-success`} role="img" aria-label="Target met" />
            ) : state === "short" ? (
              <ArrowDown className={`${ICON} text-destructive`} role="img" aria-label="Below target" />
            ) : null}
            <span className={`text-2xl font-mono font-bold tabular-nums leading-none ${
              state === "impossible" ? "text-destructive-foreground"
                : state === "met" ? "text-success"
                : state === "short" ? "text-destructive"
                : playthroughPct === 100 ? "text-success"
                : "text-primary"
            }`}>
              {formatAccuracy(playthroughPct)}
            </span>
            {goal != null && (
              <span className={`text-sm font-mono tabular-nums ${
                state === "impossible" ? "text-destructive-foreground" : "text-muted-foreground"
              }`}>
                / {goal}%
              </span>
            )}
          </div>
        </LiveSessionCounter>
      </div>

      {/* Second row: compact practice-progress numbers */}
      <div className="flex items-center gap-6 mb-2 px-1 text-xs text-muted-foreground">
        <span>Loop: <strong className="text-dark">{loopCount}</strong></span>
        <span>Hits: <strong className="text-success">{hitCount}</strong></span>
        <span>Misses: <strong className="text-destructive">{missCount}</strong></span>
        <span>Session Accuracy: <strong className="text-dark">{formatAccuracy(accuracyPercent)}</strong></span>
      </div>

      <WarmupStrip view={warmupView} />
      <ConsecutiveStrip view={consecutiveView} />
    </>
  );
}
