import React, { useEffect, useRef, useState } from "react";
import { Download, Upload, RefreshCw, Wand2 } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { uploadAudio } from "../lib/audioPlayer";
import { recompileMeasures } from "../lib/measureCompiler";

// Right-hand utility cluster: Export, Audio upload, Refresh (recompile lyrics
// blob from rows), Auto-Match (assign syllables to RH notes), Change Song.
export default function AudioToolbar({
  song,
  songDbId,
  skipTiedNotes,
  onSongUpdate,
  onAudioUploaded,
  onLyricsChanged,
  onExport,
  onChangeSong,
}) {
  const [uploading, setUploading] = useState(false);
  const [hasLyrics, setHasLyrics] = useState(false);
  const [showAutoMatchConfirm, setShowAutoMatchConfirm] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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

  async function handleRefresh() {
    if (!songDbId || refreshing) return;
    setRefreshing(true);
    try {
      const newMeasures = await recompileMeasures(songDbId, supabase);
      if (onSongUpdate) onSongUpdate({ ...song, measures: newMeasures });
    } catch (err) {
      console.error("[Sam] Refresh failed:", err);
      alert("Refresh failed: " + err.message);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <>
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
        {songDbId && (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 text-sm text-foreground hover:text-primary min-h-[44px] px-2 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5${refreshing ? " animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        )}
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
