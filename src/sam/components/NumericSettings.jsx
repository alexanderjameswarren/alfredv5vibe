import React, { useState } from "react";
import { AudioWaveform, Save } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { DEFAULTS } from "../lib/samConstants";

// Settings row hidden during playback. Visibility rules for BPM vs Speed %:
//   no audio          → BPM only
//   audio, default    → Speed % only, with sync icon to reveal BPM
//   audio + sync click → Speed % + BPM, icon hidden
//   speed != 100      → BPM auto-hides on Speed blur
// Inline Save button appears when any field deviates from the loaded song
// defaults; persisting clears dirty by updating the parent song state.
//
// Each numeric input is a `useNumericInput` return value: the component
// reads `.input` for the draft, calls `.setInput` on change, and
// `.commit({ min, max, fallback })` on blur.
export default function NumericSettings({
  song,
  songDbId,
  playbackState,
  bpm,
  timingWindowMs,
  chordMs,
  measureWidth,
  playbackSpeed,
  onSongUpdate,
}) {
  const [showBpmEdit, setShowBpmEdit] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  if (playbackState === "playing") return null;

  const hasAudio = !!song?.audioFilePath;

  const isDirty =
    bpm.value !== (song?.defaultBpm ?? DEFAULTS.bpm) ||
    timingWindowMs.value !== (song?.defaultTimingWindowMs ?? DEFAULTS.timingWindowMs) ||
    chordMs.value !== (song?.defaultChordMs ?? DEFAULTS.chordMs) ||
    measureWidth.value !== (song?.defaultMeasureWidth ?? DEFAULTS.measureWidth) ||
    playbackSpeed.value !== (song?.playbackSpeed ?? DEFAULTS.playbackSpeed);

  function handleEnableBpmEdit() {
    playbackSpeed.set(DEFAULTS.playbackSpeed);
    setShowBpmEdit(true);
  }

  async function handleSaveSettings() {
    if (!songDbId) return;
    setSavingSettings(true);
    const { error } = await supabase
      .from("sam_songs")
      .update({
        default_bpm: bpm.value,
        default_timing_window_ms: timingWindowMs.value,
        default_chord_ms: chordMs.value,
        default_measure_width: measureWidth.value,
        playback_speed: playbackSpeed.value,
      })
      .eq("id", songDbId);
    if (error) {
      console.error("[Sam] Settings save failed:", error);
      alert("Failed to save settings");
    } else if (onSongUpdate) {
      onSongUpdate({
        ...song,
        defaultBpm: bpm.value,
        defaultTimingWindowMs: timingWindowMs.value,
        defaultChordMs: chordMs.value,
        defaultMeasureWidth: measureWidth.value,
        playbackSpeed: playbackSpeed.value,
      });
    }
    setSavingSettings(false);
  }

  return (
    <div className="flex items-center gap-3 mb-3 flex-wrap">
      {!hasAudio && (
        <label className="text-sm text-foreground">
          BPM:{" "}
          <input
            type="number"
            value={bpm.input}
            onFocus={(e) => e.target.select()}
            onChange={(e) => bpm.setInput(e.target.value)}
            onBlur={() => bpm.commit({ min: 1, fallback: DEFAULTS.bpm })}
            className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
            min={20} max={300}
          />
        </label>
      )}
      <label className="text-sm text-foreground">
        Timing ±ms:{" "}
        <input
          type="number"
          value={timingWindowMs.input}
          onFocus={(e) => e.target.select()}
          onChange={(e) => timingWindowMs.setInput(e.target.value)}
          onBlur={() => timingWindowMs.commit({ min: 100, fallback: DEFAULTS.timingWindowMs })}
          className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
          min={100} max={2000}
        />
      </label>
      <label className="text-sm text-foreground">
        Chord ms:{" "}
        <input
          type="number"
          value={chordMs.input}
          onFocus={(e) => e.target.select()}
          onChange={(e) => chordMs.setInput(e.target.value)}
          onBlur={() => chordMs.commit({ min: 1, fallback: DEFAULTS.chordMs })}
          className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
          min={10} max={500}
        />
      </label>
      <label className="text-sm text-foreground">
        Measure W:{" "}
        <input
          type="number"
          value={measureWidth.input}
          onFocus={(e) => e.target.select()}
          onChange={(e) => measureWidth.setInput(e.target.value)}
          onBlur={() => measureWidth.commit({ min: 150, max: 600, fallback: 150 })}
          className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
          min={150} max={600} step={50}
        />
      </label>
      {hasAudio && (
        <>
          <label className="text-sm text-foreground">
            Playback Speed %:{" "}
            <input
              type="number"
              value={playbackSpeed.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => playbackSpeed.setInput(e.target.value)}
              onBlur={() => {
                const n = playbackSpeed.commit({ min: 1, max: 200, fallback: DEFAULTS.playbackSpeed });
                if (n !== DEFAULTS.playbackSpeed) setShowBpmEdit(false);
              }}
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={10} max={200}
            />
          </label>
          {showBpmEdit ? (
            <label className="text-sm text-foreground">
              BPM:{" "}
              <input
                type="number"
                value={bpm.input}
                onFocus={(e) => e.target.select()}
                onChange={(e) => bpm.setInput(e.target.value)}
                onBlur={() => bpm.commit({ min: 1, fallback: DEFAULTS.bpm })}
                className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
                min={20} max={300}
              />
            </label>
          ) : (
            <AudioWaveform
              onClick={handleEnableBpmEdit}
              title="Edit audio sync"
              className="w-4 h-4 text-muted hover:text-dark cursor-pointer"
            />
          )}
        </>
      )}
      {isDirty && (
        <button
          onClick={handleSaveSettings}
          disabled={savingSettings || !songDbId}
          className="flex items-center gap-1 px-3 py-1.5 border border-border rounded text-sm text-muted-foreground hover:text-dark min-h-[44px] disabled:opacity-50"
        >
          <Save className="w-3.5 h-3.5" />
          {savingSettings ? "Saving..." : "Save"}
        </button>
      )}
    </div>
  );
}
