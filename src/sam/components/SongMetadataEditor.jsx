import React, { useState, useEffect } from "react";
import { Pencil, AudioWaveform } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { DEFAULTS } from "../lib/samConstants";
import { goalFromEditor, heardGoalTempo } from "../lib/goalTempo";

// The Edit Song dialog — the ONE implementation, used by the player (pencil
// beside the song title, via the default export below) and by the song
// library (pencil on a row, which renders SongEditDialog directly after
// loading the row with fetchSongForEdit). Same fields, layout, help text,
// validation and saved columns in both places.
//
// Owns all dialog-local form state, initialised from `song` when it mounts.
// On save it writes sam_songs, hands the updated song to `onSongUpdate`, and —
// only when the caller passes the live `useNumericInput` hooks (the player) —
// applies the new defaults to them via `.set()` so the session reflects them
// immediately. The library has no live session, so it passes none.
//
// The goal tempo is edited here, and ONLY here in the app (the tempo-box Save
// in NumericSettings never touches it). One field, required:
//   no audio -> "Goal BPM"      saves goal_bpm, goal_playback_speed = 100
//   audio    -> "Goal Speed %"  saves goal_playback_speed, goal_bpm = the
//               Default BPM being saved (the scroll-sync calibration)
// The goal is never applied to the live tempo hooks — it is a target, not a
// setting.
//
// Props:
//   song                   in-memory song shape (mapSongRow); audio is
//                          detected from song.audioFilePath
//   songDbId               sam_songs id to write
//   onSongUpdate           receives the updated song after a successful save
//   onClose                called on Cancel and after a successful save
//   hasImportedFingerings  shows the "Show imported fingerings" checkbox
//   bpm, timingWindowMs, chordMs, measureWidth, playbackSpeed
//                          OPTIONAL live tempo hooks (player only)
export function SongEditDialog({
  song,
  songDbId,
  bpm,
  timingWindowMs,
  chordMs,
  measureWidth,
  playbackSpeed,
  onSongUpdate,
  onClose,
  hasImportedFingerings = false,
}) {
  const hasAudio = !!song?.audioFilePath;

  // The one goal box: Goal BPM without audio, Goal Speed % with it.
  const goalTextFor = (goalBpm, goalPlaybackSpeed) => {
    const v = hasAudio ? goalPlaybackSpeed : goalBpm;
    return v != null ? String(v) : "";
  };

  const [editTitle, setEditTitle] = useState(song.title || "");
  const [editArtist, setEditArtist] = useState(song.artist || "");
  const [editBpm, setEditBpm] = useState(
    String(song.defaultBpm || bpm?.value || DEFAULTS.bpm)
  );
  const [editPlaybackSpeed, setEditPlaybackSpeed] = useState(
    String(song.playbackSpeed ?? playbackSpeed?.value ?? DEFAULTS.playbackSpeed)
  );
  const [editTimingWindow, setEditTimingWindow] = useState(
    song.defaultTimingWindowMs != null ? String(song.defaultTimingWindowMs) : ""
  );
  const [editChordMs, setEditChordMs] = useState(
    song.defaultChordMs != null ? String(song.defaultChordMs) : ""
  );
  const [editMeasureWidth, setEditMeasureWidth] = useState(
    song.defaultMeasureWidth != null ? String(song.defaultMeasureWidth) : ""
  );
  const [editShowBpm, setEditShowBpm] = useState(false);
  // Default true (matches the app-wide "imported shown by default" behavior)
  // so saving an unchanged fresh import doesn't silently hide them.
  const [editShowImported, setEditShowImported] = useState(song.showImportedFingerings ?? true);
  const [editGoal, setEditGoal] = useState(goalTextFor(song.goalBpm, song.goalPlaybackSpeed));
  const [saving, setSaving] = useState(false);

  // Live validation and heard tempo, recomputed on every keystroke.
  const goal = goalFromEditor({ hasAudio, goalText: editGoal, defaultBpm: Number(editBpm) });
  const heardGoal = goal.error ? null : heardGoalTempo(goal.goal_bpm, goal.goal_playback_speed);

  // A song imported this session is still the parsed file in memory, which
  // knows no goal — but the database does (the insert trigger filled it).
  // Read the real value rather than leaving the required box blank, and never
  // overwrite anything the user has already typed. Runs once, on open.
  useEffect(() => {
    if (song.goalBpm != null || !songDbId) return undefined;
    let cancelled = false;
    supabase
      .from("sam_songs")
      .select("goal_bpm, goal_playback_speed")
      .eq("id", songDbId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          if (error) console.error("[Sam] Goal tempo fetch failed:", error);
          return;
        }
        const text = goalTextFor(data.goal_bpm, data.goal_playback_speed);
        setEditGoal((prev) => (prev === "" ? text : prev));
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleEditEnableBpm() {
    setEditPlaybackSpeed(String(DEFAULTS.playbackSpeed));
    setEditShowBpm(true);
  }

  async function handleSaveEdit() {
    const bpmNum = Number(editBpm);
    const psNum = Number(editPlaybackSpeed) || DEFAULTS.playbackSpeed;
    if (!editTitle.trim() || !bpmNum || bpmNum <= 0) {
      alert("Please provide a valid title and BPM");
      return;
    }
    // Save is disabled while the goal is invalid; this is the backstop.
    const goalToSave = goalFromEditor({ hasAudio, goalText: editGoal, defaultBpm: bpmNum });
    if (goalToSave.error) return;

    const timingNum = editTimingWindow !== "" ? Number(editTimingWindow) : null;
    const chordNum = editChordMs !== "" ? Number(editChordMs) : null;
    const widthNum = editMeasureWidth !== "" ? Number(editMeasureWidth) : null;

    setSaving(true);

    // Update Supabase if we have a songDbId
    if (songDbId) {
      const { error: dbError } = await supabase
        .from("sam_songs")
        .update({
          title: editTitle.trim(),
          artist: editArtist.trim() || null,
          default_bpm: bpmNum,
          playback_speed: psNum,
          default_timing_window_ms: timingNum,
          default_chord_ms: chordNum,
          default_measure_width: widthNum,
          show_imported_fingerings: editShowImported,
          goal_bpm: goalToSave.goal_bpm,
          goal_playback_speed: goalToSave.goal_playback_speed,
        })
        .eq("id", songDbId);

      if (dbError) {
        console.error("[Sam] Song update failed:", dbError);
        alert("Failed to update song");
        setSaving(false);
        return;
      }
    }

    // Update local song state
    const updatedSong = {
      ...song,
      title: editTitle.trim(),
      artist: editArtist.trim() || null,
      defaultBpm: bpmNum,
      playbackSpeed: psNum,
      defaultTimingWindowMs: timingNum,
      defaultChordMs: chordNum,
      defaultMeasureWidth: widthNum,
      showImportedFingerings: editShowImported,
      goalBpm: goalToSave.goal_bpm,
      goalPlaybackSpeed: goalToSave.goal_playback_speed,
      // Mirror what the database now holds, so the player's goal label is
      // right without a reload: the generated heard goal, and goal_set_at by
      // the trigger's rule — a speed change, or a BPM change on a song
      // without audio, confirms the goal; anything else leaves it as it was.
      goalEffectiveBpm: heardGoalTempo(goalToSave.goal_bpm, goalToSave.goal_playback_speed),
      // A song imported this session has no goal in memory to compare with
      // (the database filled it), so it is left unconfirmed until reloaded.
      goalSetAt:
        song.goalBpm != null &&
        (goalToSave.goal_playback_speed !== song.goalPlaybackSpeed ||
          (!hasAudio && goalToSave.goal_bpm !== song.goalBpm))
          ? new Date().toISOString()
          : song.goalSetAt ?? null,
    };

    if (onSongUpdate) {
      onSongUpdate(updatedSong);
    }

    // Apply settings immediately — player only; the library has no session.
    bpm?.set(bpmNum);
    timingWindowMs?.set(timingNum ?? DEFAULTS.timingWindowMs);
    chordMs?.set(chordNum ?? DEFAULTS.chordMs);
    measureWidth?.set(widthNum ?? DEFAULTS.measureWidth);
    playbackSpeed?.set(psNum);

    setSaving(false);
    onClose?.();
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4">
        <h3 className="text-lg font-medium text-dark mb-4">Edit Song</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Title
            </label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="Song title"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Artist
            </label>
            <input
              type="text"
              value={editArtist}
              onChange={(e) => setEditArtist(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
              placeholder="Artist name (optional)"
            />
          </div>

          <div className="flex gap-3">
            {!hasAudio && (
              <div className="flex-1">
                <label className="block text-sm font-medium text-foreground mb-1">
                  Default BPM
                </label>
                <input
                  type="number"
                  value={editBpm}
                  onChange={(e) => setEditBpm(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="68"
                  min={20}
                  max={300}
                />
              </div>
            )}
            {hasAudio && (
              <>
                <div className="flex-1">
                  <label className="flex items-center gap-2 text-sm font-medium text-foreground mb-1">
                    Playback Speed %
                    {!editShowBpm && (
                      <AudioWaveform
                        onClick={handleEditEnableBpm}
                        title="Edit audio sync"
                        className="w-4 h-4 text-muted hover:text-dark cursor-pointer"
                      />
                    )}
                  </label>
                  <input
                    type="number"
                    value={editPlaybackSpeed}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditPlaybackSpeed(v);
                      if (Number(v) !== DEFAULTS.playbackSpeed) setEditShowBpm(false);
                    }}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="100"
                    min={10}
                    max={200}
                  />
                </div>
                {editShowBpm && (
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-foreground mb-1">
                      Default BPM
                    </label>
                    <input
                      type="number"
                      value={editBpm}
                      onChange={(e) => setEditBpm(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                      placeholder="68"
                      min={20}
                      max={300}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="sam-edit-goal" className="block text-sm font-medium text-foreground mb-1">
                {hasAudio ? "Goal Speed %" : "Goal BPM"}
              </label>
              <input
                id="sam-edit-goal"
                type="number"
                value={editGoal}
                onChange={(e) => setEditGoal(e.target.value)}
                aria-invalid={goal.error ? "true" : "false"}
                aria-describedby={goal.error ? "sam-edit-goal-error" : undefined}
                className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent ${
                  goal.error ? "border-destructive" : "border-border"
                }`}
                min={1}
                step={1}
              />
              {goal.error && (
                <p id="sam-edit-goal-error" className="text-xs text-destructive mt-1">
                  {goal.error}
                </p>
              )}
            </div>
            {/* Keeps Goal Speed % the width of Playback Speed % when the
                Default BPM field sits beside it in the row above. */}
            {hasAudio && editShowBpm && <div className="flex-1" aria-hidden="true" />}
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Goal: {heardGoal ?? "—"} BPM. Your target for this piece. Separate from Default BPM, which is just the tempo it loads at.
          </p>
          <p className="text-xs text-muted-foreground -mt-2">Without an audio file, BPM controls how fast the sheet music scrolls. With an audio file, set Playback Speed to 100% then adjust BPM until the scroll matches the song — save once aligned. Use Playback Speed during practice to slow down or speed up without losing sync.</p>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Timing ±ms
              </label>
              <input
                type="number"
                value={editTimingWindow}
                onChange={(e) => setEditTimingWindow(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                placeholder="300"
                min={100}
                max={2000}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Chord ms
              </label>
              <input
                type="number"
                value={editChordMs}
                onChange={(e) => setEditChordMs(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                placeholder="80"
                min={10}
                max={500}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Measure width
              </label>
              <input
                type="number"
                value={editMeasureWidth}
                onChange={(e) => setEditMeasureWidth(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                placeholder="300"
                min={150}
                max={600}
                step={50}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">Leave blank to use app defaults (300ms / 80ms / 300px)</p>

          {hasImportedFingerings && (
            <>
              <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={editShowImported}
                  onChange={(e) => setEditShowImported(e.target.checked)}
                  className="w-4 h-4 accent-primary"
                />
                Show imported fingerings
              </label>
              <p className="text-xs text-muted-foreground -mt-3">Fingering numbers from the MusicXML source. Manual fingerings always show.</p>
            </>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-secondary min-h-[44px] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveEdit}
            disabled={saving || !!goal.error}
            className="flex-1 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// The player's entry point: the pencil beside the song title, opening the
// dialog above. Props are passed straight through.
export default function SongMetadataEditor(props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {props.songDbId && (
        <button
          onClick={() => setOpen(true)}
          className="p-1 text-muted-foreground hover:text-primary transition-colors"
          title="Edit song"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}
      {open && <SongEditDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
