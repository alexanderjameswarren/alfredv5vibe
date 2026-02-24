import React, { useState } from "react";
import { Play, Pause, RotateCcw, Download, Pencil } from "lucide-react";
import { supabase } from "../../supabaseClient";

export default function SettingsBar({
  song, snippet,
  bpm, bpmInput, setBpm, setBpmInput,
  timingWindowMs, timingWindowMsInput, setTimingWindowMs, setTimingWindowMsInput,
  chordMs, chordMsInput, setChordMs, setChordMsInput,
  measureWidth, measureWidthInput, setMeasureWidth, setMeasureWidthInput,
  playbackState, songDbId,
  onPlay, onPause, onResume, onRestart,
  onChangeSong,
  onExport,
  midiConnected, midiDevice,
  pausedMeasure,
  onSongUpdate,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  const [editingSong, setEditingSong] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editBpm, setEditBpm] = useState("");
  const [saving, setSaving] = useState(false);

  function handleEditClick() {
    setEditingSong(true);
    setEditTitle(song.title || "");
    setEditArtist(song.artist || "");
    setEditBpm(String(song.defaultBpm || bpm));
  }

  function handleCancelEdit() {
    setEditingSong(false);
    setEditTitle("");
    setEditArtist("");
    setEditBpm("");
  }

  async function handleSaveEdit() {
    const bpmNum = Number(editBpm);
    if (!editTitle.trim() || !bpmNum || bpmNum <= 0) {
      alert("Please provide a valid title and BPM");
      return;
    }

    setSaving(true);

    // Update Supabase if we have a songDbId
    if (songDbId) {
      const { error: dbError } = await supabase
        .from("sam_songs")
        .update({
          title: editTitle.trim(),
          artist: editArtist.trim() || null,
          default_bpm: bpmNum,
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
    };

    if (onSongUpdate) {
      onSongUpdate(updatedSong);
    }

    // Update BPM if changed
    if (bpmNum !== bpm) {
      setBpm(bpmNum);
      setBpmInput(String(bpmNum));
    }

    setSaving(false);
    handleCancelEdit();
  }

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
                ? "bg-secondary text-muted-foreground cursor-not-allowed"
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

        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-dark">
            {song.title || "Untitled"}
            <span className="text-muted-foregroundfont-normal">
              {snippet
                ? ` (${snippet.title || `m.${snippet.startMeasure}–${snippet.endMeasure}`} · ${bpm} BPM${snippet.restMeasures > 0 ? ` · ${snippet.restMeasures} rest` : ""})`
                : ` (full song · ${bpm} BPM)`}
              {isPaused && pausedMeasure != null && ` — paused at m.${pausedMeasure}`}
            </span>
            {song.artist && (
              <span className="text-muted-foreground"> — {song.artist}</span>
            )}
          </h2>
          {songDbId && (
            <button
              onClick={handleEditClick}
              className="p-1 text-muted-foreground hover:text-primary transition-colors"
              title="Edit song"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* MIDI status — always visible */}
        <span className="text-sm text-muted-foreground">
          MIDI:{" "}
          {midiConnected ? (
            <strong className="text-success">{midiDevice}</strong>
          ) : (
            <span className="text-warning">Waiting...</span>
          )}
        </span>
      </div>

      {/* Tunable inputs — hidden during play */}
      {!isPlaying && (
        <div className="flex items-center gap-3">
          <label className="text-sm text-foreground">
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
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={20} max={300}
            />
          </label>
          <label className="text-sm text-foreground">
            Timing ±ms:{" "}
            <input
              type="number"
              value={timingWindowMsInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => {
                setTimingWindowMsInput(e.target.value);
                const n = Number(e.target.value);
                if (n >= 100) setTimingWindowMs(n);
              }}
              onBlur={() => {
                const n = Number(timingWindowMsInput);
                if (!n || n < 100) { setTimingWindowMs(300); setTimingWindowMsInput("300"); }
                else setTimingWindowMsInput(String(n));
              }}
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={100} max={2000}
            />
          </label>
          <label className="text-sm text-foreground">
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
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={10} max={500}
            />
          </label>
          <label className="text-sm text-foreground">
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
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={150} max={600} step={50}
            />
          </label>
          <button
            onClick={onExport}
            className="flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button
            onClick={onChangeSong}
            className="text-sm text-foreground hover:text-primary min-h-[44px] px-2"
          >
            Change song
          </button>
        </div>
      )}

      {/* Edit Modal */}
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

              <div>
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
    </div>
  );
}
