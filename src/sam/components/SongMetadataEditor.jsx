import React, { useState } from "react";
import { Pencil, AudioWaveform } from "lucide-react";
import { supabase } from "../../supabaseClient";

// Renders the pencil trigger button + the song-edit modal. Owns all
// modal-local form state. On save, writes to sam_songs and applies the new
// values to the live `useNumericInput` hooks via `.set()` so the user's
// session reflects the new defaults immediately.
export default function SongMetadataEditor({
  song,
  songDbId,
  bpm,
  timingWindowMs,
  chordMs,
  measureWidth,
  playbackSpeed,
  onSongUpdate,
}) {
  const [editingSong, setEditingSong] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editBpm, setEditBpm] = useState("");
  const [editPlaybackSpeed, setEditPlaybackSpeed] = useState("");
  const [editTimingWindow, setEditTimingWindow] = useState("");
  const [editChordMs, setEditChordMs] = useState("");
  const [editMeasureWidth, setEditMeasureWidth] = useState("");
  const [editShowBpm, setEditShowBpm] = useState(false);
  const [saving, setSaving] = useState(false);

  const hasAudio = !!song?.audioFilePath;

  function handleEditClick() {
    setEditingSong(true);
    setEditTitle(song.title || "");
    setEditArtist(song.artist || "");
    setEditBpm(String(song.defaultBpm || bpm.value));
    setEditPlaybackSpeed(String(song.playbackSpeed ?? playbackSpeed.value));
    setEditTimingWindow(song.defaultTimingWindowMs != null ? String(song.defaultTimingWindowMs) : "");
    setEditChordMs(song.defaultChordMs != null ? String(song.defaultChordMs) : "");
    setEditMeasureWidth(song.defaultMeasureWidth != null ? String(song.defaultMeasureWidth) : "");
    setEditShowBpm(false);
  }

  function handleEditEnableBpm() {
    setEditPlaybackSpeed("100");
    setEditShowBpm(true);
  }

  function handleCancelEdit() {
    setEditingSong(false);
    setEditTitle("");
    setEditArtist("");
    setEditBpm("");
    setEditPlaybackSpeed("");
    setEditTimingWindow("");
    setEditChordMs("");
    setEditMeasureWidth("");
  }

  async function handleSaveEdit() {
    const bpmNum = Number(editBpm);
    const psNum = Number(editPlaybackSpeed) || 100;
    if (!editTitle.trim() || !bpmNum || bpmNum <= 0) {
      alert("Please provide a valid title and BPM");
      return;
    }

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
    };

    if (onSongUpdate) {
      onSongUpdate(updatedSong);
    }

    // Apply settings immediately
    bpm.set(bpmNum);
    timingWindowMs.set(timingNum ?? 300);
    chordMs.set(chordNum ?? 80);
    measureWidth.set(widthNum ?? 300);
    playbackSpeed.set(psNum);

    setSaving(false);
    handleCancelEdit();
  }

  return (
    <>
      {songDbId && (
        <button
          onClick={handleEditClick}
          className="p-1 text-muted-foreground hover:text-primary transition-colors"
          title="Edit song"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      )}

      {editingSong && (
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
                          if (Number(v) !== 100) setEditShowBpm(false);
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
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCancelEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-secondary min-h-[44px] disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="flex-1 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
