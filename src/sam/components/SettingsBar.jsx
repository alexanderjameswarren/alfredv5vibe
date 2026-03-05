import React, { useState, useRef, useEffect } from "react";
import { Play, Pause, RotateCcw, Square, Download, Pencil, Upload, Disc, Wand2 } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { uploadAudio } from "../lib/audioPlayer";
import { recompileMeasures } from "../lib/measureCompiler";

export default function SettingsBar({
  song, snippet,
  bpm, bpmInput, setBpm, setBpmInput,
  timingWindowMs, timingWindowMsInput, setTimingWindowMs, setTimingWindowMsInput,
  chordMs, chordMsInput, setChordMs, setChordMsInput,
  measureWidth, measureWidthInput, setMeasureWidth, setMeasureWidthInput,
  audioLeadInMs, audioLeadInMsInput, setAudioLeadInMs, setAudioLeadInMsInput,
  defaultBpm, defaultBpmInput, setDefaultBpm, setDefaultBpmInput,
  playbackState, songDbId,
  onPlay, onPause, onResume, onRestart, onStop,
  onChangeSong,
  onExport,
  midiConnected, midiDevice,
  pausedMeasure,
  onSongUpdate,
  onAudioUploaded,
  onFullSong,
  onLyricsChanged,
  skipTiedNotes,
}) {
  const isStopped = playbackState === "stopped";
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";

  const [editingSong, setEditingSong] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editBpm, setEditBpm] = useState("");
  const [editPlaybackBpm, setEditPlaybackBpm] = useState("");
  const [editLeadInMs, setEditLeadInMs] = useState("");
  const [editTimingWindow, setEditTimingWindow] = useState("");
  const [editChordMs, setEditChordMs] = useState("");
  const [editMeasureWidth, setEditMeasureWidth] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hasLyrics, setHasLyrics] = useState(false);
  const [showAutoMatchConfirm, setShowAutoMatchConfirm] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const audioInputRef = useRef(null);

  useEffect(() => {
    if (!songDbId) {
      setHasLyrics(false);
      return;
    }
    supabase
      .from("sam_song_lyrics")
      .select("*", { count: "exact", head: true })
      .eq("song_id", songDbId)
      .then(({ count }) => setHasLyrics((count || 0) > 0));
  }, [songDbId]);

  function handleEditClick() {
    setEditingSong(true);
    setEditTitle(song.title || "");
    setEditArtist(song.artist || "");
    setEditBpm(String(song.defaultBpm || bpm));
    setEditPlaybackBpm(String(song.playbackBpm ?? song.defaultBpm ?? bpm));
    setEditLeadInMs(String(song.audioLeadInMs ?? 0));
    setEditTimingWindow(song.defaultTimingWindowMs != null ? String(song.defaultTimingWindowMs) : "");
    setEditChordMs(song.defaultChordMs != null ? String(song.defaultChordMs) : "");
    setEditMeasureWidth(song.defaultMeasureWidth != null ? String(song.defaultMeasureWidth) : "");
  }

  function handleCancelEdit() {
    setEditingSong(false);
    setEditTitle("");
    setEditArtist("");
    setEditBpm("");
    setEditPlaybackBpm("");
    setEditLeadInMs("");
    setEditTimingWindow("");
    setEditChordMs("");
    setEditMeasureWidth("");
  }

  async function handleSaveEdit() {
    const bpmNum = Number(editBpm);
    const playbackBpmNum = Number(editPlaybackBpm) || bpmNum;
    if (!editTitle.trim() || !bpmNum || bpmNum <= 0) {
      alert("Please provide a valid title and BPM");
      return;
    }

    const leadInNum = Number(editLeadInMs) || 0;
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
          playback_bpm: playbackBpmNum,
          audio_lead_in_ms: leadInNum,
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
      playbackBpm: playbackBpmNum,
      audioLeadInMs: leadInNum,
      defaultTimingWindowMs: timingNum,
      defaultChordMs: chordNum,
      defaultMeasureWidth: widthNum,
    };

    if (onSongUpdate) {
      onSongUpdate(updatedSong);
    }

    // Apply settings immediately — use playback BPM as the active practice tempo
    if (playbackBpmNum !== bpm) {
      setBpm(playbackBpmNum);
      setBpmInput(String(playbackBpmNum));
    }
    const tw = timingNum ?? 300;
    setTimingWindowMs(tw);
    setTimingWindowMsInput(String(tw));
    const cm = chordNum ?? 80;
    setChordMs(cm);
    setChordMsInput(String(cm));
    const mw = widthNum ?? 300;
    setMeasureWidth(mw);
    setMeasureWidthInput(String(mw));
    setAudioLeadInMs(leadInNum);
    setAudioLeadInMsInput(String(leadInNum));
    setDefaultBpm(bpmNum);
    setDefaultBpmInput(String(bpmNum));

    setSaving(false);
    handleCancelEdit();
  }

  async function handleAudioUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !songDbId) return;
    e.target.value = ""; // Reset input

    setUploading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const path = await uploadAudio(songDbId, file, user.id, supabase, song?.audioFilePath);
      if (onAudioUploaded) onAudioUploaded(path);
    } catch (err) {
      console.error("[Sam] Audio upload failed:", err);
      alert("Audio upload failed: " + err.message);
    }
    setUploading(false);
  }

  async function handleAutoMatch() {
    if (!songDbId || !song?.measures) return;
    setShowAutoMatchConfirm(false);
    setAutoMatching(true);

    try {
      // Fetch all syllables ordered by word_order
      const { data: lyrics, error: lyricsError } = await supabase
        .from("sam_song_lyrics")
        .select("word_order, syllable")
        .eq("song_id", songDbId)
        .order("word_order", { ascending: true });

      if (lyricsError) throw new Error("Failed to fetch lyrics: " + lyricsError.message);
      if (!lyrics || lyrics.length === 0) {
        alert("No lyrics found for this song.");
        return;
      }

      // Walk measures, assign syllables to non-rest RH events
      const placements = [];
      let syllableIdx = 0;

      for (const measure of song.measures) {
        if (syllableIdx >= lyrics.length) break;
        const rh = measure.rh || [];
        for (let rhIdx = 0; rhIdx < rh.length; rhIdx++) {
          if (syllableIdx >= lyrics.length) break;
          const evt = rh[rhIdx];
          if (!evt.notes || evt.notes.length === 0) continue;
          // Skip tied continuation notes when checkbox is checked
          if (skipTiedNotes && evt.notes.every(n => n.tie === "end" || n.tie === "both")) continue;
          placements.push({
            word_order: lyrics[syllableIdx].word_order,
            measure_num: measure.number,
            rh_index: rhIdx,
          });
          syllableIdx++;
        }
      }

      // Check for leftover syllables
      if (syllableIdx < lyrics.length) {
        const remaining = lyrics.length - syllableIdx;
        alert(`${remaining} syllable${remaining === 1 ? "" : "s"} unplaced — the song has fewer RH notes than lyrics.`);
        setAutoMatching(false);
        return;
      }

      // Clear all existing placements
      const { error: clearError } = await supabase
        .from("sam_song_lyrics")
        .update({ measure_num: null, rh_index: null })
        .eq("song_id", songDbId);

      if (clearError) throw new Error("Failed to clear placements: " + clearError.message);

      // Write new placements
      for (const p of placements) {
        const { error: updateError } = await supabase
          .from("sam_song_lyrics")
          .update({ measure_num: p.measure_num, rh_index: p.rh_index })
          .eq("song_id", songDbId)
          .eq("word_order", p.word_order);

        if (updateError) throw new Error("Failed to save placement: " + updateError.message);
      }

      // Recompile so lyrics appear in the measures blob
      const newMeasures = await recompileMeasures(songDbId, supabase);
      if (onSongUpdate) onSongUpdate({ ...song, measures: newMeasures });

      // Refresh lyric placements in parent state
      if (onLyricsChanged) {
        const freshPlacements = lyrics.map((l, i) => ({
          word_order: l.word_order,
          syllable: l.syllable,
          measure_num: placements[i].measure_num,
          rh_index: placements[i].rh_index,
        }));
        onLyricsChanged(freshPlacements);
      }

      console.log(`[Sam] Auto-match complete: ${placements.length} syllables placed.`);
    } catch (err) {
      console.error("[Sam] Auto-match failed:", err);
      alert("Auto-match failed: " + err.message);
    } finally {
      setAutoMatching(false);
    }
  }

  return (
    <>
      {/* Top row: playback controls (left) + utility buttons (right) */}
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
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

          {/* Stop button — visible when paused, returns to initial state */}
          {isPaused && (
            <button
              onClick={onStop}
              className="flex items-center gap-1.5 px-4 py-2 rounded min-h-[44px] font-medium text-sm transition-colors bg-secondary hover:bg-secondary text-foreground border border-border"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
          )}

          {/* Full Song button — visible only when a snippet is selected */}
          {snippet && (
            <button
              onClick={onFullSong}
              className="flex items-center gap-1.5 px-3 py-2 rounded min-h-[44px] text-sm font-medium transition-colors border border-border text-muted-foreground hover:text-dark"
            >
              <Disc className="w-4 h-4" />
              Full Song
            </button>
          )}

          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-dark">
              {song.title || "Untitled"}
              <span className="text-muted-foreground font-normal">
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

        {/* Utility buttons — always visible */}
        <div className="flex items-center gap-2">
          <button
            onClick={onExport}
            className="flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          {songDbId && (
            <button
              onClick={() => audioInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2 disabled:opacity-50"
            >
              <Upload className="w-3.5 h-3.5" />
              {uploading ? "Uploading..." : "Audio"}
            </button>
          )}
          <input
            ref={audioInputRef}
            type="file"
            accept=".mp3,audio/mpeg"
            onChange={handleAudioUpload}
            className="hidden"
          />
          {songDbId && hasLyrics && (
            <button
              onClick={() => setShowAutoMatchConfirm(true)}
              disabled={autoMatching}
              className="flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2 disabled:opacity-50"
            >
              <Wand2 className="w-3.5 h-3.5" />
              {autoMatching ? "Matching..." : "Auto-Match"}
            </button>
          )}
          <button
            onClick={onChangeSong}
            className="text-sm text-foreground hover:text-primary min-h-[44px] px-2"
          >
            Change song
          </button>
        </div>
      </div>

      {/* Settings row — hidden during play */}
      {!isPlaying && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <label className="text-sm text-foreground">
            BPM:{" "}
            <input
              type="number"
              value={bpmInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setBpmInput(e.target.value)}
              onBlur={() => {
                const n = Number(bpmInput);
                if (!n || n <= 0) { setBpm(68); setBpmInput("68"); }
                else { setBpm(n); setBpmInput(String(n)); }
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
              onChange={(e) => setTimingWindowMsInput(e.target.value)}
              onBlur={() => {
                const n = Number(timingWindowMsInput);
                if (!n || n < 100) { setTimingWindowMs(300); setTimingWindowMsInput("300"); }
                else { setTimingWindowMs(n); setTimingWindowMsInput(String(n)); }
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
              onChange={(e) => setChordMsInput(e.target.value)}
              onBlur={() => {
                const n = Number(chordMsInput);
                if (!n || n <= 0) { setChordMs(80); setChordMsInput("80"); }
                else { setChordMs(n); setChordMsInput(String(n)); }
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
              onChange={(e) => setMeasureWidthInput(e.target.value)}
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
          <label className="text-sm text-foreground">
            Lead-In ms:{" "}
            <input
              type="number"
              value={audioLeadInMsInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setAudioLeadInMsInput(e.target.value)}
              onBlur={() => {
                const n = Number(audioLeadInMsInput);
                if (isNaN(n)) { setAudioLeadInMs(0); setAudioLeadInMsInput("0"); }
                else { setAudioLeadInMs(n); setAudioLeadInMsInput(String(n)); }
              }}
              className="w-20 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
            />
          </label>
          <label className="text-sm text-foreground">
            Default BPM:{" "}
            <input
              type="number"
              value={defaultBpmInput}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setDefaultBpmInput(e.target.value)}
              onBlur={() => {
                const n = Number(defaultBpmInput);
                if (!n || n <= 0) { setDefaultBpm(68); setDefaultBpmInput("68"); }
                else { setDefaultBpm(n); setDefaultBpmInput(String(n)); }
              }}
              className="w-16 px-2 py-1 border border-border rounded text-sm min-h-[44px]"
              min={20} max={300}
            />
          </label>
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

              <div className="grid grid-cols-2 gap-3">
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
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">
                    Playback BPM
                  </label>
                  <input
                    type="number"
                    value={editPlaybackBpm}
                    onChange={(e) => setEditPlaybackBpm(e.target.value)}
                    className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                    placeholder="68"
                    min={20}
                    max={300}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">Default = recording tempo. Playback = practice tempo.</p>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1">
                  Audio Lead-In (ms)
                </label>
                <input
                  type="number"
                  value={editLeadInMs}
                  onChange={(e) => setEditLeadInMs(e.target.value)}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground mt-1">Milliseconds from audio start to measure 1, beat 1.</p>
              </div>

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

      {/* Auto-Match Lyrics Confirmation Modal */}
      {showAutoMatchConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-medium text-dark mb-3">Auto-Match Lyrics</h3>
            <p className="text-sm text-foreground mb-6">
              This will overwrite all existing lyric placements by assigning syllables
              sequentially to right-hand notes. Continue?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowAutoMatchConfirm(false)}
                className="flex-1 px-4 py-2 border border-border rounded-lg text-sm font-medium text-foreground hover:bg-secondary min-h-[44px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAutoMatch}
                className="flex-1 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium min-h-[44px] transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
