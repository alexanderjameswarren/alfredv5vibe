import React, { useRef, useState } from "react";
import { Download, Upload, RefreshCw, Wand2 } from "lucide-react";
import { supabase } from "../../supabaseClient";
import { uploadAudio } from "../lib/audioPlayer";
import { recompileMeasures } from "../lib/measureCompiler";
import { matchSyllablesToNotes } from "../lib/lyricsAutoMatch";
import { UI } from "./uiStyles";

// One look for every button in the drawer's Tools grid: same height, size,
// weight and colour; toggles differ only by the on fill. Never wraps.
export const toolButton = (isOn = false) =>
  `flex items-center gap-2 px-3 min-h-[44px] w-full text-sm whitespace-nowrap disabled:opacity-50 ${UI.toggle(isOn)}`;

// Utility actions, placed in the More drawer by `keys`: Export, Audio upload,
// Refresh (recompile lyrics blob from rows), Auto-Match (assign syllables to RH
// notes).
//
// "Change song" used to sit here too. The back arrow at the far left of the
// transport row now goes to the song library, so the link was a second control
// doing the identical thing, and it went.
export default function AudioToolbar({
  song,
  songDbId,
  skipTiedNotes,
  onSongUpdate,
  onAudioUploaded,
  onLyricsChanged,
  onExport,
  // From the player's lyric state, so it follows a Lyrics save or delete.
  hasLyrics = false,
  // Which actions to show, in this order, as labelled buttons in the More
  // drawer — e.g. ["automatch", "audio"] in its Audio section.
  keys = ["export", "audio", "refresh", "automatch"],
}) {
  const [uploading, setUploading] = useState(false);
  const [showAutoMatchConfirm, setShowAutoMatchConfirm] = useState(false);
  const [autoMatching, setAutoMatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const audioInputRef = useRef(null);

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

      const { placements, unplaced: remaining } = matchSyllablesToNotes(song.measures, lyrics, { skipTiedNotes });

      if (remaining > 0) {
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

  // The utility actions as data, so the wide row and the narrow overflow menu
  // are two renderings of one list rather than two lists that drift apart —
  // the same reasoning that merged Alfred's desktop tabs and mobile drawer
  // into one NAV_ITEMS array.
  const actions = [
    {
      key: "export",
      label: "Export",
      icon: <Download className="w-4 h-4 flex-shrink-0" />,
      onClick: onExport,
      disabled: false,
      show: true,
    },
    {
      key: "audio",
      label: uploading ? "Uploading..." : "Audio",
      icon: <Upload className="w-4 h-4 flex-shrink-0" />,
      onClick: () => audioInputRef.current?.click(),
      disabled: uploading,
      show: !!songDbId,
    },
    {
      key: "refresh",
      label: refreshing ? "Refreshing..." : "Refresh",
      icon: <RefreshCw className={`w-4 h-4 flex-shrink-0${refreshing ? " animate-spin" : ""}`} />,
      onClick: handleRefresh,
      disabled: refreshing,
      show: !!songDbId,
    },
    {
      key: "automatch",
      label: autoMatching ? "Matching..." : "Auto-Match",
      icon: <Wand2 className="w-4 h-4 flex-shrink-0" />,
      onClick: () => setShowAutoMatchConfirm(true),
      disabled: autoMatching,
      show: !!songDbId && hasLyrics,
    },
  ]
    .filter((a) => a.show && keys.includes(a.key))
    .sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));

  return (
    <>
      {/* Labelled buttons, always: the drawer has the room the old title row
          did not, so there is no icon-only or overflow tier any more. */}
      {actions.map((a) => (
        <button
          key={a.key}
          onClick={a.onClick}
          disabled={a.disabled}
          title={a.label}
          className={toolButton()}
        >
          {a.icon}
          {a.label}
        </button>
      ))}

      {keys.includes("audio") && (
        <input
          ref={audioInputRef}
          type="file"
          accept=".mp3,audio/mpeg"
          onChange={handleAudioUpload}
          className="hidden"
        />
      )}

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
                className={`flex-1 px-4 py-2 text-sm font-medium min-h-[44px] ${UI.outline}`}
              >
                Cancel
              </button>
              <button
                onClick={handleAutoMatch}
                className={`flex-1 px-4 py-2 bg-primary text-white text-sm font-medium min-h-[44px] ${UI.radius} ${UI.press}`}
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
