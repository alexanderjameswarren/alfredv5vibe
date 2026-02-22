import React from "react";
import { Play, Pause, RotateCcw, Download } from "lucide-react";

export default function SettingsBar({
  song, snippet,
  bpm, bpmInput, setBpm, setBpmInput,
  windowMs, windowMsInput, setWindowMs, setWindowMsInput,
  chordMs, chordMsInput, setChordMs, setChordMsInput,
  measureWidth, measureWidthInput, setMeasureWidth, setMeasureWidthInput,
  playbackState, songDbId,
  onPlay, onPause, onResume, onRestart,
  onChangeSong,
  onExport,
  midiConnected, midiDevice,
  pausedMeasure,
  metronome, setMetronome,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  return (
    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div className="flex items-center gap-3">
        {/* Play / Resume button — visible when stopped or paused */}
        {!isPlaying && (
          <button
            onClick={isPaused ? onResume : onPlay}
            disabled={isStopped && !songDbId}
            className={`flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors ${
              isStopped && !songDbId
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-primary hover:bg-primary-hover text-white"
            }`}
          >
            <Play className="w-4 h-4" />
            {isStopped && !songDbId ? "Saving..." : isPaused ? "Resume" : "Play"}
          </button>
        )}

        {/* Pause button — visible when playing */}
        {isPlaying && (
          <button
            onClick={onPause}
            className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-amber-500 hover:bg-amber-600 text-white"
          >
            <Pause className="w-4 h-4" /> Pause
          </button>
        )}

        {/* Restart button — visible when paused */}
        {isPaused && (
          <button
            onClick={onRestart}
            className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-red-500 hover:bg-red-600 text-white"
          >
            <RotateCcw className="w-4 h-4" /> Restart
          </button>
        )}

        <h2 className="text-sm font-medium text-dark">
          {song.title || "Untitled"}
          <span className="text-muted font-normal">
            {snippet
              ? ` (${snippet.title || `m.${snippet.startMeasure}–${snippet.endMeasure}`} · ${bpm} BPM${snippet.restMeasures > 0 ? ` · ${snippet.restMeasures} rest` : ""})`
              : ` (full song · ${bpm} BPM)`}
            {isPaused && pausedMeasure != null && ` — paused at m.${pausedMeasure}`}
          </span>
          {song.artist && (
            <span className="text-muted"> — {song.artist}</span>
          )}
        </h2>
        {/* MIDI status — always visible */}
        <span className="text-sm text-muted">
          MIDI:{" "}
          {midiConnected ? (
            <strong className="text-green-600">{midiDevice}</strong>
          ) : (
            <span className="text-amber-600">Waiting...</span>
          )}
        </span>
      </div>

      {/* Tunable inputs — hidden during play */}
      {!isPlaying && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-muted">
            BPM:{" "}
            <input
              type="number"
              value={bpmInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setBpmInput(e.target.value);
                const n = Number(e.target.value);
                if (n > 0) setBpm(n);
              }}
              onBlur={() => {
                const n = Number(bpmInput);
                if (!n || n <= 0) { setBpm(68); setBpmInput("68"); }
                else setBpmInput(String(n));
              }}
              className="w-16 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
              min={20} max={300}
            />
          </label>
          <label className="text-sm text-muted flex items-center gap-1 min-h-[44px] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={metronome}
              onChange={(e) => setMetronome(e.target.checked)}
              className="w-4 h-4"
            />
            Metronome
          </label>
          <label className="text-sm text-muted">
            Window ms:{" "}
            <input
              type="number"
              value={windowMsInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setWindowMsInput(e.target.value);
                const n = Number(e.target.value);
                if (n > 0) setWindowMs(n);
              }}
              onBlur={() => {
                const n = Number(windowMsInput);
                if (!n || n <= 0) { setWindowMs(500); setWindowMsInput("500"); }
                else setWindowMsInput(String(n));
              }}
              className="w-16 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
              min={100} max={2000}
            />
          </label>
          <label className="text-sm text-muted">
            Chord ms:{" "}
            <input
              type="number"
              value={chordMsInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setChordMsInput(e.target.value);
                const n = Number(e.target.value);
                if (n > 0) setChordMs(n);
              }}
              onBlur={() => {
                const n = Number(chordMsInput);
                if (!n || n <= 0) { setChordMs(80); setChordMsInput("80"); }
                else setChordMsInput(String(n));
              }}
              className="w-16 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
              min={10} max={500}
            />
          </label>
          <label className="text-sm text-muted">
            Measure W:{" "}
            <input
              type="number"
              value={measureWidthInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setMeasureWidthInput(e.target.value);
                const n = Number(e.target.value);
                if (n >= 150 && n <= 600) setMeasureWidth(n);
              }}
              onBlur={() => {
                let n = Number(measureWidthInput);
                if (!n || n < 150) n = 150;
                if (n > 600) n = 600;
                setMeasureWidth(n);
                setMeasureWidthInput(String(n));
              }}
              className="w-16 px-2 py-1 border border-gray-300 rounded text-sm min-h-[44px]"
              min={150} max={600} step={50}
            />
          </label>
          <button
            onClick={onExport}
            className="flex items-center gap-1 text-sm text-muted hover:text-dark min-h-[44px] px-2"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button
            onClick={onChangeSong}
            className="text-sm text-muted hover:text-dark min-h-[44px] px-2"
          >
            Change song
          </button>
        </div>
      )}
    </div>
  );
}
