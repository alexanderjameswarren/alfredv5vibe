import React, { useState } from "react";
import { AudioWaveform, Save, Repeat } from "lucide-react";
import RestControl from "./RestControl";
import SegmentedControl from "./SegmentedControl";
import { supabase } from "../../supabaseClient";
import { DEFAULTS } from "../lib/samConstants";
import { heardTempo } from "../lib/activePlan";
import { UI } from "./MoreDrawer";

// The song page's numeric settings, as pieces placed by the song rail layout:
//   TempoControls   → the rail: BPM (Speed % on audio songs), Goal, Save
//   SpeedField, AudioSyncBpm → More drawer, Audio
//   SoundControls   → More drawer, Sound (Metronome, Score playback)
//   TuningControls  → More drawer, Tuning (always open)
//   LoopControl     → More drawer, Tools
//
// Visibility rules for BPM vs Speed %:
//   no audio          → BPM only
//   audio, default    → Speed % only, with sync icon to reveal BPM
//   audio + sync click → Speed % + BPM, icon hidden
//   speed != 100      → BPM auto-hides on Speed blur
// Save appears when any field deviates from the loaded song defaults;
// persisting clears dirty by updating the parent song state. Dirty is judged on
// the DRAFT (`.preview`), not the committed value, so Save appears while the
// field still has focus — it is meant to read as a prompt the moment a change
// is typed, not after a stray tap to blur.
//
// Each numeric input is a `useNumericInput` return value: the component
// reads `.input` for the draft, calls `.setInput` on change, and
// `.commit(RULES.x)` on blur.
//
// The whole-song repeat toggle + its rest stepper (LoopControl) are
// session-only state owned by SamPlayer — deliberately absent from `isDirty`
// and from `handleSaveSettings`, so repeat is never persisted and resets on
// song reload. The toggle is hidden while a snippet is selected: snippet loop
// and song repeat are mutually exclusive, since both drive `loop` /
// `audioEndMs` / the appended rest measures.

// Parse/clamp rules per field. One table so blur, the dirty check and Save can
// never disagree about what a draft means.
const RULES = {
  bpm: { min: 1, fallback: DEFAULTS.bpm },
  timingWindowMs: { min: 100, fallback: DEFAULTS.timingWindowMs },
  chordMs: { min: 1, fallback: DEFAULTS.chordMs },
  measureWidth: { min: 150, max: 600, fallback: 150 },
  playbackSpeed: { min: 1, max: 200, fallback: DEFAULTS.playbackSpeed },
};

const FIELD = `w-16 ${UI.input}`;
// A label and its box kept together as one unit, so a row wraps between fields.
const LABEL = "inline-flex items-center gap-1 whitespace-nowrap text-sm text-foreground";

// "Goal 75" beside the tempo box (practice plans spec §7.4). Shown only for a
// confirmed goal (goalSetAt set). A button styled like its Save and Tuning
// neighbours: amber while the heard tempo is below the goal, disabled when it
// already equals the goal. Tapping it puts the goal in the tempo box for this
// sitting — the BPM for a song without audio, the speed for a song with audio
// (its BPM is the scroll-sync calibration and stays put). Nothing is saved.
function GoalLabel({ song, hasAudio, bpm, playbackSpeed, className = "" }) {
  if (!song?.goalSetAt || song.goalEffectiveBpm == null) return null;
  const heard = heardTempo(bpm.value, playbackSpeed.value);
  const below = heard != null && heard < song.goalEffectiveBpm;
  const atGoal = heard === song.goalEffectiveBpm;
  const label = "Set tempo to goal (this session only)";

  function applyGoal() {
    if (hasAudio) {
      if (song.goalPlaybackSpeed != null) playbackSpeed.set(song.goalPlaybackSpeed);
    } else if (song.goalBpm != null) {
      bpm.set(song.goalBpm);
    }
  }

  return (
    <button
      type="button"
      onClick={applyGoal}
      disabled={atGoal}
      title={label}
      aria-label={label}
      data-below={below ? "true" : "false"}
      className={`shrink-0 whitespace-nowrap flex items-center gap-1 px-3 py-1.5 border text-sm min-h-[44px] disabled:opacity-50 disabled:cursor-default ${UI.radius} ${UI.press} ${
        below
          ? "border-amber-600 text-amber-700 bg-card"
          : "border-border text-muted-foreground bg-card"
      } ${className}`}
    >
      Goal {song.goalEffectiveBpm}
    </button>
  );
}

// The Save-as-song-defaults logic, shared by the rail's tempo Save and the
// Tuning group's Save so the two can never disagree about what is dirty.
function useSaveSettings({ song, songDbId, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed, onSongUpdate }) {
  const [savingSettings, setSavingSettings] = useState(false);

  const tuningDirty =
    timingWindowMs.preview(RULES.timingWindowMs) !== (song?.defaultTimingWindowMs ?? DEFAULTS.timingWindowMs) ||
    chordMs.preview(RULES.chordMs) !== (song?.defaultChordMs ?? DEFAULTS.chordMs) ||
    measureWidth.preview(RULES.measureWidth) !== (song?.defaultMeasureWidth ?? DEFAULTS.measureWidth);
  const tempoDirty =
    bpm.preview(RULES.bpm) !== (song?.defaultBpm ?? DEFAULTS.bpm) ||
    playbackSpeed.preview(RULES.playbackSpeed) !== (song?.playbackSpeed ?? DEFAULTS.playbackSpeed);

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
  // Each Save shows for its own fields — the rail's for tempo (BPM / Speed %),
  // Tuning's for Timing / Chord / Measure W — and either saves everything, so
  // with both kinds pending both show and one tap saves both.
  function saveButton(className = "", tuningOnly = false) {
    return (tuningOnly ? tuningDirty : tempoDirty) && (
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleSaveSettings}
        disabled={savingSettings || !songDbId}
        className={`flex items-center justify-center gap-1 px-3 py-1.5 text-sm min-h-[44px] disabled:opacity-50 ${UI.outline} ${className}`}
      >
        <Save className="w-3.5 h-3.5" />
        {savingSettings ? "Saving..." : "Save"}
      </button>
    );
  }

  return { saveButton };
}

// The tempo box for the rail: BPM on a song without audio, Speed % on a song
// with it (its BPM is the scroll-sync calibration, edited in the drawer),
// then Goal, then Save while anything differs from the song's defaults.
export function TempoControls({
  song, songDbId, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed,
  onSongUpdate, onHideBpmEdit,
}) {
  const { saveButton } = useSaveSettings({
    song, songDbId, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed, onSongUpdate,
  });
  const hasAudio = !!song?.audioFilePath;
  const field = hasAudio ? playbackSpeed : bpm;
  const inputClass = `w-full ${UI.input}`;

  return (
    <div className="flex flex-col gap-2 w-full">
      <label className="flex flex-col gap-1 text-sm text-foreground">
        {hasAudio ? "Speed %:" : "BPM:"}
        <input
          type="number"
          value={field.input}
          onFocus={(e) => e.target.select()}
          onChange={(e) => field.setInput(e.target.value)}
          onBlur={() => {
            if (!hasAudio) {
              bpm.commit(RULES.bpm);
              return;
            }
            const n = playbackSpeed.commit(RULES.playbackSpeed);
            if (n !== DEFAULTS.playbackSpeed) onHideBpmEdit?.();
          }}
          className={inputClass}
          min={hasAudio ? 10 : 20} max={hasAudio ? 200 : 300}
        />
      </label>
      <GoalLabel song={song} hasAudio={hasAudio} bpm={bpm} playbackSpeed={playbackSpeed} className="w-full justify-center" />
      {saveButton("w-full")}
    </div>
  );
}

// Playback Speed % for an audio song, in the drawer's Audio section. The same
// hook as the rail's box, so the two always agree.
export function SpeedField({ playbackSpeed, onHideBpmEdit }) {
  return (
    <label className={LABEL}>
      Playback Speed %:{" "}
      <input
        type="number"
        value={playbackSpeed.input}
        onFocus={(e) => e.target.select()}
        onChange={(e) => playbackSpeed.setInput(e.target.value)}
        onBlur={() => {
          const n = playbackSpeed.commit(RULES.playbackSpeed);
          if (n !== DEFAULTS.playbackSpeed) onHideBpmEdit?.();
        }}
        className={FIELD}
        min={10} max={200}
      />
    </label>
  );
}

// An audio song's BPM is its scroll-sync calibration: hidden behind the sync
// icon, which resets the speed to 100% and reveals the box.
export function AudioSyncBpm({ bpm, playbackSpeed, showBpmEdit = false, setShowBpmEdit = () => {} }) {
  function handleEnableBpmEdit() {
    playbackSpeed.set(DEFAULTS.playbackSpeed);
    setShowBpmEdit(true);
  }

  return showBpmEdit ? (
    <label className={LABEL}>
      BPM:{" "}
      <input
        type="number"
        value={bpm.input}
        onFocus={(e) => e.target.select()}
        onChange={(e) => bpm.setInput(e.target.value)}
        onBlur={() => bpm.commit(RULES.bpm)}
        className={FIELD}
        min={20} max={300}
      />
    </label>
  ) : (
    <button
      type="button"
      onClick={handleEnableBpmEdit}
      title="Edit audio sync"
      aria-label="Edit audio sync"
      className={`min-h-[44px] min-w-[44px] flex items-center justify-center ${UI.outline}`}
    >
      <AudioWaveform className="w-4 h-4" />
    </button>
  );
}

// Timing / Chord / Measure W: the drawer's Tuning section, always open, with
// their own Save (shown only while something differs from the saved song).
export function TuningControls({
  song, songDbId, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed, onSongUpdate,
}) {
  const { saveButton } = useSaveSettings({
    song, songDbId, bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed, onSongUpdate,
  });

  return (
    <div className="flex items-center gap-3 flex-wrap">
          <label className={LABEL}>
            Timing ±ms:{" "}
            <input
              type="number"
              value={timingWindowMs.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => timingWindowMs.setInput(e.target.value)}
              onBlur={() => timingWindowMs.commit(RULES.timingWindowMs)}
              className={FIELD}
              min={100} max={2000}
            />
          </label>
          <label className={LABEL}>
            Chord ms:{" "}
            <input
              type="number"
              value={chordMs.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => chordMs.setInput(e.target.value)}
              onBlur={() => chordMs.commit(RULES.chordMs)}
              className={FIELD}
              min={10} max={500}
            />
          </label>
          <label className={LABEL}>
            Measure W:{" "}
            <input
              type="number"
              value={measureWidth.input}
              onFocus={(e) => e.target.select()}
              onChange={(e) => measureWidth.setInput(e.target.value)}
              onBlur={() => measureWidth.commit(RULES.measureWidth)}
              className={FIELD}
              min={150} max={600} step={50}
            />
          </label>
          {saveButton("", true)}
    </div>
  );
}

// Whole-song repeat and its rest count. Hidden while a snippet is loaded.
export function LoopControl({ snippet, songRepeat, onSongRepeatChange, songRestMeasures, onSongRestMeasuresChange }) {
  if (snippet) return null;
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label
        title="Repeat whole song"
        className={`px-2 py-1 border min-h-[44px] flex items-center gap-1.5 text-sm cursor-pointer ${UI.radius} ${UI.pressLabel} ${songRepeat ? UI.on : UI.off}`}
      >
        <input
          type="checkbox"
          checked={songRepeat}
          onChange={(e) => onSongRepeatChange(e.target.checked)}
          className="sr-only"
        />
        <Repeat className="w-4 h-4" />
        Loop song
      </label>
      {songRepeat && (
        <RestControl value={songRestMeasures} onChange={onSongRestMeasuresChange} />
      )}
    </div>
  );
}

// Metronome and score playback. Each group gets its own visible heading here;
// SegmentedControl's built-in label (shown only at xl) is hidden so it never
// reads twice.
export function SoundControls({ metronome, setMetronome, scorePlayback, setScorePlayback }) {
  const group = "flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-foreground [&>span>span:first-child]:!hidden";
  return (
    <div className="flex flex-col gap-2">
      <div className={group}>
        <span className="w-28">Metronome</span>
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
      </div>
      <div className={group}>
        <span className="w-28">Score playback</span>
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
      </div>
    </div>
  );
}
