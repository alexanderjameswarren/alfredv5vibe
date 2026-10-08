import React from "react";
import { Play, Pause, RotateCcw, Square, GraduationCap, Flame } from "lucide-react";
import BackButton from "./BackButton";
import { UI } from "./MoreDrawer";

// Stateless cluster of playback transport buttons. Visibility per state:
//   always         → Back to Alfred (far left)
//   stopped        → Play + Warm up + Practice
//   playing        → Pause
//   paused         → Resume + Restart + Stop
// (Full Song is the snippet tray's "Whole song" button now.)
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
  onPlay,
  onPractice,
  onPause,
  onResume,
  onRestart,
  onStop,
  onWarmUp,
  warmUpVisible = false,
  warmUpPrimary = false,
  warmUpDisabledReason = null,
  // The song rail: full-width buttons stacked top to bottom, Play tallest, and
  // Warm up always under Practice (still filled when it is the item's goal).
  vertical = false,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  const showWarmUp = isStopped && !!onWarmUp && warmUpVisible;
  const warmUpDisabled = !songDbId || !!warmUpDisabledReason;

  // Shared shape of every transport button; only the colours differ per button.
  // Radius and hover/press darkening are the song page's one look (UI).
  const shape = vertical
    ? `w-full flex items-center justify-center gap-1.5 px-1 py-2 min-h-[44px] font-medium text-sm ${UI.radius} ${UI.press}`
    : `shrink-0 whitespace-nowrap flex items-center gap-1.5 px-4 py-2 min-h-[44px] font-medium text-sm ${UI.radius} ${UI.press}`;
  const playShape = vertical ? `${shape} flex-col min-h-[72px]` : shape;

  const warmUpButton = showWarmUp ? (
    <button
      onClick={onWarmUp}
      disabled={warmUpDisabled}
      title={warmUpDisabledReason || undefined}
      data-variant={warmUpPrimary ? "primary" : "outline"}
      className={`${shape} ${
        warmUpDisabled
          ? "border border-border text-muted-foreground opacity-50 cursor-not-allowed"
          : warmUpPrimary
            ? "bg-primary text-white"
            : `border ${UI.off}`
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
      {!vertical && warmUpPrimary && warmUpButton}

      {!isPlaying && (
        <button
          onClick={isPaused ? onResume : onPlay}
          disabled={isStopped && !songDbId}
          className={`${playShape} ${
            isStopped && !songDbId
              ? "bg-secondary text-muted-foreground cursor-not-allowed"
              : "bg-primary text-white"
          }`}
        >
          <Play className="w-4 h-4" />
          {isStopped && !songDbId ? "Saving..." : isPaused ? "Resume" : "Play"}
        </button>
      )}

      {/* Between Play and Practice unless it led the row (§7.1). */}
      {!vertical && !warmUpPrimary && warmUpButton}

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
          className={`${shape} border ${UI.off} ${!songDbId ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          <GraduationCap className="w-4 h-4" />
          Practice
        </button>
      )}

      {vertical && warmUpButton}

      {isPlaying && (
        <button
          onClick={onPause}
          className={`${shape} bg-amber-500 text-white`}
        >
          <Pause className="w-4 h-4" /> Pause
        </button>
      )}

      {isPaused && (
        <button
          onClick={onRestart}
          className={`${shape} bg-red-500 text-white`}
        >
          <RotateCcw className="w-4 h-4" /> Restart
        </button>
      )}

      {isPaused && (
        <button
          onClick={onStop}
          className={`${shape} bg-secondary text-foreground border border-border`}
        >
          <Square className="w-4 h-4" /> Stop
        </button>
      )}

    </>
  );
}
