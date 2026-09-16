import React from "react";
import { midiDisplayName } from "../lib/vexflowHelpers";
import PracticeFigures from "./PracticeFigures";

export default function StatsBar({
  lastNote,
  loopCount,
  hitCount,
  missCount,
  sessionStats,
  lastResult,
  playbackState,
  songTodaySeconds = 0,
  songTotalSeconds = 0,
  songPassesToday = 0,
  songPassesTotal = 0,
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
      <span>Session Accuracy: <strong className="text-dark">{sessionStats.accuracyPercent}%</strong></span>
      {/* The current pass through the snippet, so a clean run reads 100% even
          when earlier fumbles are still dragging the session average down. */}
      <span>
        Playthrough Accuracy:{" "}
        <strong className={
          sessionStats.hasPlaythrough && sessionStats.playthroughAccuracyPercent === 100
            ? "text-success"
            : "text-dark"
        }>
          {sessionStats.hasPlaythrough ? `${sessionStats.playthroughAccuracyPercent}%` : "—"}
        </strong>
        {sessionStats.hasPlaythrough && (
          <span className="ml-1 opacity-70">
            ({sessionStats.playthroughHits}/{sessionStats.playthroughScored})
          </span>
        )}
      </span>
      {sessionStats.avgTimingDeltaMs !== 0 && (
        <span>
          Avg timing: <strong className="text-dark">
            {sessionStats.avgTimingDeltaMs > 0 ? "+" : ""}{sessionStats.avgTimingDeltaMs}ms
          </strong>
        </span>
      )}

      {/* This song's own passes and practice time, on the same row as the
          session numbers (option D). Every figure names its own scope, and all
          four are song-scoped — the all-songs "Practiced today" lives on the
          settings row above, so nothing here is borrowing a label that means
          something else. The pass numbers count only rows where `snippet_id` is
          null, so a loaded snippet's practice never inflates them. */}
      {playbackState !== "playing" && (
        <span className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-dark">This song</span>
          <PracticeFigures
            passesToday={songPassesToday}
            passesAllTime={songPassesTotal}
            timeTodayMinutes={songTodaySeconds / 60}
            timeAllTimeMinutes={songTotalSeconds / 60}
          />
        </span>
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
