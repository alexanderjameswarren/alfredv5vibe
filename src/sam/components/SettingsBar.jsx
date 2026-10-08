import React from "react";
import SongMetadataEditor from "./SongMetadataEditor";
import { formatMinutesUnits } from "../lib/practiceTimeFormat";

// The song page's title row, with the plan bar and snippet tray (`children`)
// directly under it. Transport, Back and the tempo box live in the song rail
// (SongRail); every other setting, tool and stat lives in the More drawer.
export default function SettingsBar({
  song, snippet,
  bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  playbackState, songDbId,
  // { ladder, source } for the song itself, for the Edit Song dialog's ladder
  // editor (warm-up spec §7.4).
  songWarmup = null,
  midiConnected, midiDevice,
  pausedMeasure,
  onSongUpdate,
  hasImportedFingerings,
  todayMinutes,
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
          and MIDI (right).

          NOT `flex-wrap`, and that is the fix. With wrapping on, nothing in the
          row was allowed to shrink, so the only way flexbox could resolve an
          overflow was to push the right-hand items onto a second line and wrap
          the title — which is exactly what long titles produced.

          Now one element is designated flexible and everything else is fixed:
          the title gets `flex-1 min-w-0` and truncates, the rest get
          `shrink-0` and never move. A title of any length is absorbed by the
          ellipsis instead of by the layout. */}
      <div className="flex items-center gap-2 mb-2">
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

        {/* Right end: the day's all-songs total, then MIDI. */}
        <span className="shrink-0 whitespace-nowrap flex items-center gap-2 text-sm text-muted-foreground">
          <span>Practiced today</span>
          <strong className="text-dark">{formatMinutesUnits(todayMinutes ?? 0)}</strong>
        </span>
        <span className="text-sm text-muted-foreground shrink-0 whitespace-nowrap pr-1">
          MIDI:{" "}
          {midiConnected ? (
            <strong className="text-success">{midiDevice}</strong>
          ) : (
            <span className="text-warning">Waiting...</span>
          )}
        </span>
      </div>

      {children}
    </>
  );
}
