import React from "react";
import { Play, Pause, RotateCcw, Square, Disc, GraduationCap, Flame } from "lucide-react";
import BackButton from "./BackButton";

// Stateless cluster of playback transport buttons. Visibility per state:
//   always         → Back to Alfred (far left)
//   stopped        → Play + Warm up + Practice
//   playing        → Pause
//   paused         → Resume + Restart + Stop
//   any + snippet  → Full Song (returns to full song view)
//
// WARM UP (spec §7.1). Between Play and Practice, in Practice's outline
// treatment — or first in the transport and filled, when the loaded range is a
// plan item whose goal IS the warm-up, because then it is the primary action and
// Play is the deviation.
//
// Stopped only, like Play and Practice. "Warm up again" (§7.1) lives in
// FocusedPlaybackBar instead: this whole row is replaced while playing, and a
// completed ladder leaves him still looping, so that is the only place the label
// can ever be true. Paused has none deliberately — pause ends the session and
// therefore the ladder (§6.6), so there is nothing to restart.
export default function TransportControls({
  onBack,
  playbackState,
  songDbId,
  snippet,
  onPlay,
  onPractice,
  onPause,
  onResume,
  onRestart,
  onStop,
  onFullSong,
  onWarmUp,
  warmUpVisible = false,
  warmUpPrimary = false,
  warmUpDisabledReason = null,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  const showWarmUp = isStopped && !!onWarmUp && warmUpVisible;
  const warmUpDisabled = !songDbId || !!warmUpDisabledReason;

  const warmUpButton = showWarmUp ? (
    <button
      onClick={onWarmUp}
      disabled={warmUpDisabled}
      title={warmUpDisabledReason || undefined}
      data-variant={warmUpPrimary ? "primary" : "outline"}
      className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors ${
        warmUpDisabled
          ? "border border-border text-muted-foreground opacity-50 cursor-not-allowed"
          : warmUpPrimary
            ? "bg-primary hover:bg-primary-hover text-white"
            : "border border-border text-muted-foreground hover:text-dark"
      }`}
    >
      <Flame className="w-4 h-4" />
      Warm up
    </button>
  ) : null;

  return (
    <>
      {/* Far left of the row, ahead of Play — the page header that used to hold
          it is gone (M4 part 1). */}
      {onBack && <BackButton onBack={onBack} title="Back to song library" />}

      {/* A warm-up item's ladder IS the goal, so its button leads the transport,
          ahead of Play. Still after the back arrow, which is not a transport. */}
      {warmUpPrimary && warmUpButton}

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

      {/* Between Play and Practice unless it led the row (§7.1). */}
      {!warmUpPrimary && warmUpButton}

      {/* Practice — immediately to the right of Play, at Play's size, but in
          the OUTLINE treatment its neighbours Tuning, Next and Full Song share:
          border, no fill, muted text darkening on hover. Play is the filled
          button because Play is the primary action; a second filled button
          beside it competed with that and read as harsh.
          Stopped-only: a run is either Play or Practice, never both, and the
          paused row already has Resume for whichever one is in flight. */}
      {isStopped && onPractice && (
        <button
          onClick={onPractice}
          disabled={!songDbId}
          className={`shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors border border-border ${
            !songDbId
              ? "text-muted-foreground opacity-50 cursor-not-allowed"
              : "text-muted-foreground hover:text-dark"
          }`}
        >
          <GraduationCap className="w-4 h-4" />
          Practice
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
