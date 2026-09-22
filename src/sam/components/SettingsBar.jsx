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
  onBack,
  song, snippet,
  bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  playbackState, songDbId,
  onPlay, onPractice, onPause, onResume, onRestart, onStop,
  onExport,
  midiConnected, midiDevice,
  pausedMeasure,
  onSongUpdate,
  onAudioUploaded,
  onFullSong,
  onLyricsChanged,
  skipTiedNotes,
  hasImportedFingerings,
  songRepeat,
  onSongRepeatChange,
  songRestMeasures,
  onSongRestMeasuresChange,
  metronome,
  setMetronome,
  scorePlayback,
  setScorePlayback,
  todayMinutes,
}) {
  const isPaused = playbackState === "paused";

  // Plain-text form of what the heading renders, for the hover tooltip — the
  // heading truncates, so the full text has to be reachable some other way.
  const rangeLabel = snippet
    ? `${snippet.title || `m.${snippet.startMeasure}–${snippet.endMeasure}`} · ${bpm.value} BPM${snippet.restMeasures > 0 ? ` · ${snippet.restMeasures} rest` : ""}`
    : `full song · ${bpm.value} BPM`;
  const fullTitleText = [
    song.title || "Untitled",
    ` (${rangeLabel})`,
    isPaused && pausedMeasure != null ? ` — paused at m.${pausedMeasure}` : "",
    song.artist ? ` — ${song.artist}` : "",
  ].join("");

  return (
    <>
      {/* Top row: playback controls and title (left), utility actions (right).
          
          NOT `flex-wrap`, and that is the fix. With wrapping on, nothing in the
          row was allowed to shrink, so the only way flexbox could resolve an
          overflow was to push the action cluster onto a second line and wrap
          the title — which is exactly what long titles produced.
          
          Now one element is designated flexible and everything else is fixed:
          the title gets `flex-1 min-w-0` and truncates, the actions get
          `shrink-0` and never move. A title of any length is absorbed by the
          ellipsis instead of by the layout. */}
      <div className="flex items-center gap-2 mb-2">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <TransportControls
            onBack={onBack}
            playbackState={playbackState}
            songDbId={songDbId}
            snippet={snippet}
            onPlay={onPlay}
            onPractice={onPractice}
            onPause={onPause}
            onResume={onResume}
            onRestart={onRestart}
            onStop={onStop}
            onFullSong={onFullSong}
          />

          <div className="flex items-center gap-2 flex-1 min-w-0">
            {/* The one flexible element in the row. `min-w-0` is what lets it
                shrink below its content width at all — without it `truncate`
                never engages and the row overflows instead. */}
            <h2
              className="text-sm font-medium text-dark truncate min-w-0"
              title={fullTitleText}
            >
              {song.title || "Untitled"}
              <span className="text-muted-foreground font-normal">
                {` (${rangeLabel})`}
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

          <span className="text-sm text-muted-foreground shrink-0 whitespace-nowrap">
            MIDI:{" "}
            {midiConnected ? (
              <strong className="text-success">{midiDevice}</strong>
            ) : (
              <span className="text-warning">Waiting...</span>
            )}
          </span>
        </div>

        {/* Anchored right at every width: `shrink-0` so it never compresses,
            and no wrapping so it can never be pushed to a row of its own. */}
        <div className="flex items-center gap-2 shrink-0">
          <AudioToolbar
            song={song}
            songDbId={songDbId}
            skipTiedNotes={skipTiedNotes}
            onSongUpdate={onSongUpdate}
            onAudioUploaded={onAudioUploaded}
            onLyricsChanged={onLyricsChanged}
            onExport={onExport}
          />
        </div>
      </div>

      <NumericSettings
        song={song}
        snippet={snippet}
        songDbId={songDbId}
        playbackState={playbackState}
        bpm={bpm}
        timingWindowMs={timingWindowMs}
        chordMs={chordMs}
        measureWidth={measureWidth}
        playbackSpeed={playbackSpeed}
        songRepeat={songRepeat}
        onSongRepeatChange={onSongRepeatChange}
        songRestMeasures={songRestMeasures}
        onSongRestMeasuresChange={onSongRestMeasuresChange}
        onSongUpdate={onSongUpdate}
        metronome={metronome}
        setMetronome={setMetronome}
        scorePlayback={scorePlayback}
        setScorePlayback={setScorePlayback}
        todayMinutes={todayMinutes}
      />
    </>
  );
}
