import React from "react";
import { ArrowLeft, ListMusic, MoreHorizontal, X } from "lucide-react";
import TransportControls from "./TransportControls";
import { TempoControls } from "./NumericSettings";
import { UI } from "./MoreDrawer";

// The song page's left rail (layout "D"): transport, tempo, Snippets, More and
// Back in one fixed column, so a left hand reaches everything without crossing
// the score. Stopped and paused only — the playing screen keeps its own bar.
// Every control here is an existing one; the rail only places them.
function Divider() {
  return <hr className="w-full border-border" />;
}

const SHAPE = "w-full flex items-center justify-center gap-1.5 px-1 py-2 min-h-[44px] text-sm font-medium disabled:opacity-40";

export default function SongRail({
  playbackState, songDbId,
  onPlay, onPractice, onPause, onResume, onRestart, onStop,
  onWarmUp, warmUpVisible, warmUpPrimary, warmUpDisabledReason,
  song, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  onSongUpdate, onHideBpmEdit,
  snippetsOpen = false, onToggleSnippets = null,
  moreOpen = false, onToggleMore = null,
  onBack,
}) {
  return (
    <nav
      aria-label="Song controls"
      className="w-28 shrink-0 sticky top-2 self-start h-[calc(100dvh-1rem)] flex flex-col items-stretch gap-2 pr-3 mr-3 border-r border-border overflow-y-auto"
    >
      <TransportControls
        vertical
        playbackState={playbackState}
        songDbId={songDbId}
        onPlay={onPlay}
        onPractice={onPractice}
        onPause={onPause}
        onResume={onResume}
        onRestart={onRestart}
        onStop={onStop}
        onWarmUp={onWarmUp}
        warmUpVisible={warmUpVisible}
        warmUpPrimary={warmUpPrimary}
        warmUpDisabledReason={warmUpDisabledReason}
      />

      <Divider />

      <TempoControls
        song={song}
        songDbId={songDbId}
        bpm={bpm}
        timingWindowMs={timingWindowMs}
        chordMs={chordMs}
        measureWidth={measureWidth}
        playbackSpeed={playbackSpeed}
        onSongUpdate={onSongUpdate}
        onHideBpmEdit={onHideBpmEdit}
      />

      <Divider />

      <button
        type="button"
        onClick={onToggleSnippets ?? undefined}
        disabled={!onToggleSnippets}
        aria-pressed={snippetsOpen}
        className={`${SHAPE} ${UI.toggle(snippetsOpen)}`}
      >
        <ListMusic className="w-4 h-4" />
        Snippets
      </button>

      <div className="flex-1" />

      <button
        type="button"
        onClick={onToggleMore ?? undefined}
        disabled={!onToggleMore}
        aria-expanded={moreOpen}
        aria-pressed={moreOpen}
        className={`${SHAPE} ${UI.toggle(moreOpen)}`}
      >
        {moreOpen ? <X className="w-4 h-4" /> : <MoreHorizontal className="w-4 h-4" />}
        {moreOpen ? "Close" : "More"}
      </button>

      <button
        type="button"
        onClick={onBack}
        title="Back to song library"
        aria-label="Back to song library"
        className={`${SHAPE} ${UI.outline}`}
      >
        <ArrowLeft className="w-5 h-5" />
        Back
      </button>
    </nav>
  );
}
