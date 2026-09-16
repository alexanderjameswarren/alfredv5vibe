import React from "react";
import { Play, Pause, RotateCcw, Square, Disc } from "lucide-react";
import BackButton from "./BackButton";

// Stateless cluster of playback transport buttons. Visibility per state:
//   always         → Back to Alfred (far left)
//   stopped        → Play
//   playing        → Pause
//   paused         → Resume + Restart + Stop
//   any + snippet  → Full Song (returns to full song view)
export default function TransportControls({
  onBack,
  playbackState,
  songDbId,
  snippet,
  onPlay,
  onPause,
  onResume,
  onRestart,
  onStop,
  onFullSong,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  return (
    <>
      {/* Far left of the row, ahead of Play — the page header that used to hold
          it is gone (M4 part 1). */}
      {onBack && <BackButton onBack={onBack} title="Back to song library" />}

      {!isPlaying && (
        <button
          onClick={isPaused ? onResume : onPlay}
          disabled={isStopped && !songDbId}
          className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors ${
            isStopped && !songDbId
              ? "bg-secondary text-muted-foreground cursor-not-allowed"
              : "bg-primary hover:bg-primary-hover text-white"
          }`}
        >
          <Play className="w-4 h-4" />
          {isStopped && !songDbId ? "Saving..." : isPaused ? "Resume" : "Play"}
        </button>
      )}

      {isPlaying && (
        <button
          onClick={onPause}
          className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-amber-500 hover:bg-amber-600 text-white"
        >
          <Pause className="w-4 h-4" /> Pause
        </button>
      )}

      {isPaused && (
        <button
          onClick={onRestart}
          className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-red-500 hover:bg-red-600 text-white"
        >
          <RotateCcw className="w-4 h-4" /> Restart
        </button>
      )}

      {isPaused && (
        <button
          onClick={onStop}
          className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-secondary hover:bg-secondary text-foreground border border-border"
        >
          <Square className="w-4 h-4" /> Stop
        </button>
      )}

      {snippet && (
        <button
          onClick={onFullSong}
          className="shrink-0 whitespace-nowrap flex items-center gap-1.5 px-3 py-2 rounded min-h-[44px] text-sm font-medium transition-colors border border-border text-muted-foreground hover:text-dark"
        >
          <Disc className="w-4 h-4" />
          Full Song
        </button>
      )}
    </>
  );
}
