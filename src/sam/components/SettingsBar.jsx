import React from "react";
import { FullSongButton } from "./TransportControls";
import AudioToolbar from "./AudioToolbar";
import SongMetadataEditor from "./SongMetadataEditor";
import NumericSettings from "./NumericSettings";
import { formatMinutesUnits } from "../lib/practiceTimeFormat";

// Layout shell composing the focused subcomponents. Forwards each prop to
// only the child that needs it. The transport, Back and the tempo box live in
// the song rail (SongRail). Each numeric input is a `useNumericInput` hook
// object passed straight through.
export default function SettingsBar({
  song, snippet,
  bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  playbackState, songDbId,
  showBpmEdit, setShowBpmEdit,
  // { ladder, source } for the song itself, for the Edit Song dialog's ladder
  // editor (warm-up spec §7.4).
  songWarmup = null,
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
  // The plan bar, placed directly under the title row.
  children = null,
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
      {/* Title row: title, range, artist and pencil (left); Practiced today
          and MIDI (right). The plan bar (`children`) renders directly under it.

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
          <FullSongButton snippet={snippet} onFullSong={onFullSong} />

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
              resolvedWarmup={songWarmup}
            />
          </div>
        </div>

        {/* Right end: the day's all-songs total, then MIDI. `shrink-0` so
            neither compresses; the title's ellipsis absorbs the squeeze. */}
        <span className="shrink-0 whitespace-nowrap flex items-center gap-2 text-sm text-muted-foreground">
          <span>Practiced today</span>
          <strong className="text-dark">{formatMinutesUnits(todayMinutes ?? 0)}</strong>
        </span>
        <span className="text-sm text-muted-foreground shrink-0 whitespace-nowrap">
          MIDI:{" "}
          {midiConnected ? (
            <strong className="text-success">{midiDevice}</strong>
          ) : (
            <span className="text-warning">Waiting...</span>
          )}
        </span>

        {/* Export, Audio, Refresh, Auto-Match: here until the More drawer
            (step 4) gives them a home. */}
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

      {children}

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
        showBpmEdit={showBpmEdit}
        setShowBpmEdit={setShowBpmEdit}
      />
    </>
  );
}
