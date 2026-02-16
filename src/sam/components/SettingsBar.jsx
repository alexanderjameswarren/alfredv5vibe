import React from "react";
import { Play, Square } from "lucide-react";

export default function SettingsBar({
  song, snippet,
  bpm, bpmInput, setBpm, setBpmInput,
  chordMs, chordMsInput, setChordMs, setChordMsInput,
  playing, songDbId,
  onPlayToggle, onChangeSong,
  midiConnected, midiDevice,
}) {
  return (
    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div className="flex items-center gap-3">
        <button
          onClick={onPlayToggle}
          disabled={!playing && !songDbId}
          className={`flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors ${
            !playing && !songDbId
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : playing
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-primary hover:bg-primary-hover text-white"
          }`}
        >
          {playing ? (
            <><Square className="w-4 h-4" /> Stop</>
          ) : !songDbId ? (
            <><Play className="w-4 h-4" /> Saving...</>
          ) : (
            <><Play className="w-4 h-4" /> Play</>
          )}
        </button>
        <h2 className="text-sm font-medium text-dark">
          {song.title || "Untitled"}
          <span className="text-muted font-normal">
            {snippet
              ? ` (${snippet.title || `m.${snippet.startMeasure}–${snippet.endMeasure}`} · ${bpm} BPM${snippet.restMeasures > 0 ? ` · ${snippet.restMeasures} rest` : ""})`
              : ` (full song · ${bpm} BPM)`}
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
      {!playing && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-muted">
            BPM:{" "}
            <input
              type="number"
              value={bpmInput}
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
          <label className="text-sm text-muted">
            Chord ms:{" "}
            <input
              type="number"
              value={chordMsInput}
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
