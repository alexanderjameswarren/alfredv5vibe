import React, { useState, useEffect } from "react";
import { AudioWaveform, Save, Repeat, SlidersHorizontal } from "lucide-react";
import RestControl from "./RestControl";
import SegmentedControl from "./SegmentedControl";
import { formatMinutesUnits } from "../lib/practiceTimeFormat";
import { supabase } from "../../supabaseClient";
import { DEFAULTS } from "../lib/samConstants";

// Settings row hidden during playback. Visibility rules for BPM vs Speed %:
//   no audio          → BPM only
//   audio, default    → Speed % only, with sync icon to reveal BPM
//   audio + sync click → Speed % + BPM, icon hidden
//   speed != 100      → BPM auto-hides on Speed blur
// Inline Save button appears when any field deviates from the loaded song
// defaults; persisting clears dirty by updating the parent song state.
// Dirty is judged on the DRAFT (`.preview`), not the committed value, so Save
// appears while the field still has focus — it is meant to read as a prompt
// the moment a change is typed, not after a stray tap to blur.
//
// Save sits beside whatever is being edited: right of BPM (or Speed/BPM on
// audio songs) while Tuning is collapsed, after the Tuning fields — i.e. left
// of Repeat — while it is open.
//
// Each numeric input is a `useNumericInput` return value: the component
// reads `.input` for the draft, calls `.setInput` on change, and
// `.commit(RULES.x)` on blur.
//
// The whole-song repeat toggle + its rest stepper live here, to the right of
// Measure W. They are session-only state owned by SamPlayer — deliberately
// absent from `isDirty` and from `handleSaveSettings`, so repeat is never
// persisted and resets on song reload. The toggle is hidden while a snippet
// is selected: snippet loop and song repeat are mutually exclusive, since
// both drive `loop` / `audioEndMs` / the appended rest measures.
// The "Tuning" group's open/closed state, remembered between sessions.
// Wrapped because storage access throws outright in some contexts (private
// windows, site data blocked), and a settings row that cannot render is a much
// worse outcome than a group that forgets it was open.
const ADVANCED_OPEN_KEY = "sam.numericSettings.tuningOpen";

// Parse/clamp rules per field. One table so blur, the dirty check and Save can
// never disagree about what a draft means.
const RULES = {
  bpm: { min: 1, fallback: DEFAULTS.bpm },
  timingWindowMs: { min: 100, fallback: DEFAULTS.timingWindowMs },
  chordMs: { min: 1, fallback: DEFAULTS.chordMs },
  measureWidth: { min: 150, max: 600, fallback: 150 },
  playbackSpeed: { min: 1, max: 200, fallback: DEFAULTS.playbackSpeed },
};

function readAdvancedOpen() {
  try {
    return window.localStorage.getItem(ADVANCED_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function writeAdvancedOpen(open) {
  try {
    window.localStorage.setItem(ADVANCED_OPEN_KEY, open ? "true" : "false");
  } catch {
    /* ignore — the group just won't be remembered */
  }
}

export default function NumericSettings({
  song,
  snippet,
  songDbId,
  playbackState,
  bpm,
  timingWindowMs,
  chordMs,
  measureWidth,
  playbackSpeed,
  songRepeat,
  onSongRepeatChange,
  songRestMeasures,
  onSongRestMeasuresChange,
  onSongUpdate,
  metronome,
  setMetronome,
  scorePlayback,
  setScorePlayback,
  todayMinutes = 0,
}) {
  const [showBpmEdit, setShowBpmEdit] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  // Above the early return below: this component bails out during playback, and
  // hooks must run in the same order on every render.
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen);
  useEffect(() => {
    writeAdvancedOpen(advancedOpen);
  }, [advancedOpen]);

  if (playbackState === "playing") return null;

  const hasAudio = !!song?.audioFilePath;

  const isDirty =
    bpm.preview(RULES.bpm) !== (song?.defaultBpm ?? DEFAULTS.bpm) ||
    timingWindowMs.preview(RULES.timingWindowMs) !== (song?.defaultTimingWindowMs ?? DEFAULTS.timingWindowMs) ||
    chordMs.preview(RULES.chordMs) !== (song?.defaultChordMs ?? DEFAULTS.chordMs) ||
    measureWidth.preview(RULES.measureWidth) !== (song?.defaultMeasureWidth ?? DEFAULTS.measureWidth) ||
    playbackSpeed.preview(RULES.playbackSpeed) !== (song?.playbackSpeed ?? DEFAULTS.playbackSpeed);

  function handleEnableBpmEdit() {
    playbackSpeed.set(DEFAULTS.playbackSpeed);
    setShowBpmEdit(true);
  }

  async function handleSaveSettings() {
    if (!songDbId) return;
    // Commit every draft first. The field being edited may still have focus
    // (on iOS a tap on a button does not always blur it), so the committed
    // `.value`s can be stale; `commit` returns the number to save.
    const v = {
      bpm: bpm.commit(RULES.bpm),
      timingWindowMs: timingWindowMs.commit(RULES.timingWindowMs),
      chordMs: chordMs.commit(RULES.chordMs),
      measureWidth: measureWidth.commit(RULES.measureWidth),
      playbackSpeed: playbackSpeed.commit(RULES.playbackSpeed),
    };
    // Now drop focus so the phone keyboard closes; the field's own onBlur
    // re-commits the same draft, which is harmless.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setSavingSettings(true);
    const { error } = await supabase
      .from("sam_songs")
      .update({
        default_bpm: v.bpm,
        default_timing_window_ms: v.timingWindowMs,
        default_chord_ms: v.chordMs,
        default_measure_width: v.measureWidth,
        playback_speed: v.playbackSpeed,
      })
      .eq("id", songDbId);
    if (error) {
      console.error("[Sam] Settings save failed:", error);
      alert("Failed to save settings");
    } else if (onSongUpdate) {
      onSongUpdate({
        ...song,
        defaultBpm: v.bpm,
        defaultTimingWindowMs: v.timingWindowMs,
        defaultChordMs: v.chordMs,
        defaultMeasureWidth: v.measureWidth,
        playbackSpeed: v.playbackSpeed,
      });
    }
    setSavingSettings(false);
  }

  // `onMouseDown` preventDefault keeps focus in the field being edited, so the
  // tap lands on Save instead of being spent blurring the input — and blur
  // re-rendering the row cannot move the button out from under the finger.
  const saveButton = isDirty && (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleSaveSettings}
      disabled={savingSettings || !songDbId}
      className="flex items-center gap-1 px-3 py-1.5 border border-border rounded text-sm text-muted-foreground hover:text-dark min-h-[44px] disabled:opacity-50"
    >
      <Save className="w-3.5 h-3.5" />
      {savingSettings ? "Saving..." : "Save"}
    </button>
  );

  return (
    <div className="flex items-center gap-3 mb-3 flex-wrap">
      {/* Advanced group toggle. Timing / Chord / Measure W are set once and
          then left alone for months, but they were costing a permanent slot in
          this row and pushing it onto a second line on a laptop screen (M3.5).
          Collapsed by default, and the choice is remembered between sessions.
          BPM, Repeat and Speed stay out here because they get changed mid-run. */}
      {!hasAudio && (
        <label className="text-sm text-foreground">
          BPM:{" "}
          <input
            type="number"
            value={bpm.input}
            onFocus={(e) => e.target.select()}
            onChange={(e) => bpm.setInput(e.target.value)}
            onBlur={() => bpm.commit(RULES.bpm)}
            className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
            min={20} max={300}
          />
        </label>
      )}
      {!advancedOpen && !hasAudio && saveButton}
      <button
        type="button"
        onClick={() => setAdvancedOpen((open) => !open)}
        aria-expanded={advancedOpen}
        title="Timing window, chord grouping and measure width"
        className={`flex items-center gap-1.5 px-2 py-1 border rounded text-sm min-h-[44px] transition-colors ${
          advancedOpen
            ? "border-primary bg-primary-light text-primary"
            : "border-border text-muted-foreground hover:text-dark"
        }`}
      >
        <SlidersHorizontal className="w-4 h-4" />
        Tuning
      </button>

      {advancedOpen && (
        <>
      <label className="text-sm text-foreground">
        Timing ±ms:{" "}
        <input
          type="number"
          value={timingWindowMs.input}
          onFocus={(e) => e.target.select()}
          onChange={(e) => timingWindowMs.setInput(e.target.value)}
          onBlur={() => timingWindowMs.commit(RULES.timingWindowMs)}
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
          onBlur={() => chordMs.commit(RULES.chordMs)}
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
          onBlur={() => measureWidth.commit(RULES.measureWidth)}
          className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
          min={150} max={600} step={50}
        />
      </label>
      {saveButton}
        </>
      )}

      {!snippet && (
        <>
          <label
            title="Repeat whole song"
            className={`px-2 py-1 border rounded min-h-[44px] flex items-center cursor-pointer ${songRepeat ? "border-primary bg-primary-light text-primary" : "border-border text-muted"}`}
          >
            <input
              type="checkbox"
              checked={songRepeat}
              onChange={(e) => onSongRepeatChange(e.target.checked)}
              className="sr-only"
            />
            <Repeat className="w-4 h-4" />
          </label>
          {songRepeat && (
            <RestControl
              value={songRestMeasures}
              onChange={onSongRestMeasuresChange}
            />
          )}
        </>
      )}
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
                const n = playbackSpeed.commit(RULES.playbackSpeed);
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
                onBlur={() => bpm.commit(RULES.bpm)}
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
      {!advancedOpen && hasAudio && saveButton}

      {/* Metronome and score playback moved here from the stats row (option D).
          They are playback settings, so they belong with BPM, Tuning and
          Repeat — and the stats row needed the width back to carry this song's
          passes and practice time on one line. Still one click to change, still
          not inside the collapsed Tuning group.

          Wrapped together in one flex item so they can never be separated: a
          wrap point between them is what put Score playback alone on a row.
          What gives first is their text labels, hidden below 1280px by
          `SegmentedControl` itself; only after that can this pair move, and it
          moves as a pair. */}
      <span className="flex items-center gap-3 shrink-0">
      <SegmentedControl
        label="Metronome:"
        value={metronome}
        onChange={setMetronome}
        options={[
          ["off", "Off", "No click"],
          ["beat", "Beat", "Click on every beat (♩)"],
          ["halfbeat", "½", "Click on every half beat (♪)"],
          ["quarterbeat", "¼", "Click on every quarter beat (♬)"],
        ]}
      />

      <SegmentedControl
        label="Score playback:"
        value={scorePlayback}
        onChange={setScorePlayback}
        options={[
          ["off", "Off", "No synth"],
          ["lh", "LH", "Synth plays the left hand"],
          ["rh", "RH", "Synth plays the right hand"],
          ["full", "Full", "Synth plays both hands (♫)"],
        ]}
      />
      </span>

      {/* Pushed right so it lands under the utility cluster on the row
          above. That separation is the point: this is a fact about the DAY,
          across every song, and it used to sit inline with song-scoped figures
          under a "Today:" label that read as though it were about this song. */}
      {/* `pr-2` matches the `px-2` on the toolbar buttons in the row above, so
          the two right edges line up. Without it this text sits flush to the
          row while those buttons are inset by their own padding, and the
          mismatch reads as a stray 8px. */}
      <span className="ml-auto pr-2 shrink-0 whitespace-nowrap flex items-center gap-2 text-sm text-muted-foreground">
        <span>Practiced today</span>
        <strong className="text-dark">{formatMinutesUnits(todayMinutes)}</strong>
      </span>
    </div>
  );
}
