import React from "react";
import TransportControls from "./TransportControls";
import AudioToolbar from "./AudioToolbar";
import SongMetadataEditor from "./SongMetadataEditor";
import NumericSettings from "./NumericSettings";

// Layout shell composing the four focused subcomponents. Forwards each prop to
// only the child that needs it. The static song-title block + MIDI status live
// here because they read from props that span both transport and metadata
// contexts. Each numeric input is a `useNumericInput` hook object passed
// straight through.
export default function SettingsBar({
  song, snippet,
  bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  playbackState, songDbId,
  onPlay, onPause, onResume, onRestart, onStop,
  onChangeSong,
  onExport,
  midiConnected, midiDevice,
  pausedMeasure,
  onSongUpdate,
  onAudioUploaded,
  onFullSong,
  onLyricsChanged,
  skipTiedNotes,
  hasImportedFingerings,
}) {
  const isPaused = playbackState === "paused";

  return (
    <>
      {/* Top row: playback controls (left) + utility buttons (right) */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <TransportControls
            playbackState={playbackState}
            songDbId={songDbId}
            snippet={snippet}
            onPlay={onPlay}
            onPause={onPause}
            onResume={onResume}
            onRestart={onRestart}
            onStop={onStop}
            onFullSong={onFullSong}
          />

          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-dark">
              {song.title || "Untitled"}
              <span className="text-muted-foreground font-normal">
                {snippet
                  ? ` (${snippet.title || `m.${snippet.startMeasure}–${snippet.endMeasure}`} · ${bpm.value} BPM${snippet.restMeasures > 0 ? ` · ${snippet.restMeasures} rest` : ""})`
                  : ` (full song · ${bpm.value} BPM)`}
                {isPaused && pausedMeasure != null && ` — paused at m.${pausedMeasure}`}
              </span>
              {song.artist && (
                <span className="text-muted-foreground"> — {song.artist}</span>
              )}
            </h2>
            <SongMetadataEditor
              song={song}
              songDbId={songDbId}
              bpm={bpm}
              timingWindowMs={timingWindowMs}
              chordMs={chordMs}
              measureWidth={measureWidth}
              playbackSpeed={playbackSpeed}
              onSongUpdate={onSongUpdate}
              hasImportedFingerings={hasImportedFingerings}
            />
          </div>

          <span className="text-sm text-muted-foreground">
            MIDI:{" "}
            {midiConnected ? (
              <strong className="text-success">{midiDevice}</strong>
            ) : (
              <span className="text-warning">Waiting...</span>
            )}
          </span>
        </div>

        <AudioToolbar
          song={song}
          songDbId={songDbId}
          skipTiedNotes={skipTiedNotes}
          onSongUpdate={onSongUpdate}
          onAudioUploaded={onAudioUploaded}
          onLyricsChanged={onLyricsChanged}
          onExport={onExport}
          onChangeSong={onChangeSong}
        />
      </div>

      <NumericSettings
        song={song}
        songDbId={songDbId}
        playbackState={playbackState}
        bpm={bpm}
        timingWindowMs={timingWindowMs}
        chordMs={chordMs}
        measureWidth={measureWidth}
        playbackSpeed={playbackSpeed}
        onSongUpdate={onSongUpdate}
      />
    </>
  );
}
