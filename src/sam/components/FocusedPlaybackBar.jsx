import React from "react";
import { Pause } from "lucide-react";
import LiveSessionCounter from "./LiveSessionCounter";

// Collapsed top chrome during `playbackState === "playing"`. Everything the
// user doesn't need mid-play (song title, transport speed controls, MIDI
// status, metronome radios, etc.) is dropped from the tree entirely — the
// parent renders this instead of the full SettingsBar / StatsBar stack.
//
// Row 1  → Pause | Session badge + Playthrough badge + live Today
// Row 2  → Loop / Hits / Misses / Session accuracy (muted, secondary)
//
// Playthrough accuracy is the one number worth reading mid-play, so it gets
// the same oversized badge treatment as the Session timer rather than a slot
// in the muted row. The paused/stopped StatsBar keeps it inline instead.
export default function FocusedPlaybackBar({
  onPause,
  todayMinutes,
  loopCount,
  hitCount,
  missCount,
  accuracyPercent,
  playthroughPercent,
  hasPlaythrough,
}) {
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

        {/* LiveSessionCounter self-gates on playing; passing "playing"
            since FocusedPlaybackBar itself only renders during play. */}
        <LiveSessionCounter playbackState="playing" todayMinutes={todayMinutes}>
          <div className="flex items-center gap-2 px-3 py-1 rounded-md bg-secondary/40 border border-border">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Playthrough
            </span>
            <span className={`text-2xl font-mono font-bold tabular-nums leading-none ${
              hasPlaythrough && playthroughPercent === 100 ? "text-success" : "text-primary"
            }`}>
              {hasPlaythrough ? `${playthroughPercent}%` : "—"}
            </span>
          </div>
        </LiveSessionCounter>
      </div>

      {/* Second row: compact practice-progress numbers */}
      <div className="flex items-center gap-6 mb-2 px-1 text-xs text-muted-foreground">
        <span>Loop: <strong className="text-dark">{loopCount}</strong></span>
        <span>Hits: <strong className="text-success">{hitCount}</strong></span>
        <span>Misses: <strong className="text-destructive">{missCount}</strong></span>
        <span>Session Accuracy: <strong className="text-dark">{accuracyPercent}%</strong></span>
      </div>
    </>
  );
}
