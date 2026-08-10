import React from "react";
import { midiDisplayName } from "../lib/vexflowHelpers";
import PracticeTimeIndicator from "./PracticeTimeIndicator";

export default function StatsBar({
  lastNote,
  loopCount,
  hitCount,
  missCount,
  sessionStats,
  lastResult,
  metronome,
  setMetronome,
  scorePlayback,
  setScorePlayback,
  playbackState,
  todayMinutes = 0,
  perSongTotalSeconds = 0,
}) {
  return (
    <div className="flex items-center gap-4 mb-2 px-1 text-sm text-muted-foreground flex-wrap">
      {lastNote != null && (
        <span>
          Last: <strong className="text-dark">{midiDisplayName(lastNote)}</strong>
        </span>
      )}
      <span>Loop: <strong className="text-dark">{loopCount}</strong></span>
      <span>Hits: <strong className="text-success">{hitCount}</strong></span>
      <span>Misses: <strong className="text-destructive">{missCount}</strong></span>
      <span>Accuracy: <strong className="text-dark">{sessionStats.accuracyPercent}%</strong></span>
      {sessionStats.avgTimingDeltaMs !== 0 && (
        <span>
          Avg timing: <strong className="text-dark">
            {sessionStats.avgTimingDeltaMs > 0 ? "+" : ""}{sessionStats.avgTimingDeltaMs}ms
          </strong>
        </span>
      )}

      {/* Metronome radio group */}
      <span className="flex items-center gap-2">
        <span>Metronome:</span>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name="metronome"
            value="off"
            checked={metronome === "off"}
            onChange={(e) => setMetronome(e.target.value)}
            className="w-3 h-3"
          />
          <span>Off</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name="metronome"
            value="beat"
            checked={metronome === "beat"}
            onChange={(e) => setMetronome(e.target.value)}
            className="w-3 h-3"
          />
          <span>Beat (♩)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name="metronome"
            value="halfbeat"
            checked={metronome === "halfbeat"}
            onChange={(e) => setMetronome(e.target.value)}
            className="w-3 h-3"
          />
          <span>Half Beat (♪)</span>
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="radio"
            name="metronome"
            value="quarterbeat"
            checked={metronome === "quarterbeat"}
            onChange={(e) => setMetronome(e.target.value)}
            className="w-3 h-3"
          />
          <span>Quarter Beat (♬)</span>
        </label>
      </span>

      {/* Score playback radio group — a separate dimension from the metronome
          (spec D4), so synth and click can be on at once. Like the metronome,
          this row is unmounted during playback, which is why the mode is fixed
          for the duration of a run (D5).

          LH / RH sound one hand only. This is independent of a snippet's
          handMode (which selects the hand the PLAYER is scored on), so the two
          compose: practise RH while the synth plays LH. LH/RH labels match
          SnippetPanel's vocabulary; "Full" is both hands. */}
      <span className="flex items-center gap-2">
        <span>Score playback:</span>
        {[
          ["off", "Off"],
          ["lh", "LH"],
          ["rh", "RH"],
          ["full", "Full (♫)"],
        ].map(([value, label]) => (
          <label key={value} className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              name="scorePlayback"
              value={value}
              checked={scorePlayback === value}
              onChange={(e) => setScorePlayback(e.target.value)}
              className="w-3 h-3"
            />
            <span>{label}</span>
          </label>
        ))}
      </span>

      {playbackState !== "playing" && (
        <PracticeTimeIndicator
          todayMinutes={todayMinutes}
          perSongTotalSeconds={perSongTotalSeconds}
        />
      )}

      {lastResult && (
        <span className={
          lastResult.result === "hit" ? "text-success" :
          lastResult.result === "partial" ? "text-warning" :
          lastResult.result === "none" ? "text-primary" :
          "text-destructive"
        }>
          {lastResult.result === "none"
            ? `♪ ${lastResult.noteName}`
            : `${lastResult.result} ${lastResult.noteName}`}
        </span>
      )}
    </div>
  );
}
