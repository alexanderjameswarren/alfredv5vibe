import React from "react";
import { midiDisplayName } from "../lib/vexflowHelpers";

export default function StatsBar({ lastNote, loopCount, hitCount, missCount, sessionStats, lastResult, metronome, setMetronome }) {
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
