// Data layer for imported lyrics (sam_song_lyrics).
//
// Mirrors fingeringsApi.importMusicxmlFingerings: a whole-song replace used by
// the import path, kept separate from useLyricEditor's incremental placement
// upserts. Rows are written in the table's own shape — {word_order, syllable,
// measure_num, rh_index} — because word_order is the stable identity of a
// syllable (unique per song) and must survive an export/import round trip
// verbatim. An unplaced syllable keeps measure_num/rh_index null.
//
// Frontend-only module, so it imports the shared authenticated client directly
// — same rationale as fingeringsApi.js.
import { supabase } from "../../supabaseClient";
import { recompileMeasures } from "./measureCompiler";
import { loadSplitter, splitLyrics } from "./lyricsSplit";
import { matchSyllablesToNotes } from "./lyricsAutoMatch";

/**
 * Replace every lyric row for a song. Used by the JSON import path, which
 * always targets a freshly inserted song (nothing to clobber); the delete is
 * there so a re-run is idempotent rather than a unique-constraint violation.
 *
 * @param {string} songId
 * @param {Array<{word_order:number, syllable:string, measure_num:?number, rh_index:?number}>} lyrics
 * @returns {Promise<number>} rows written
 */
export async function importLyrics(songId, lyrics) {
  const { error: delErr } = await supabase
    .from("sam_song_lyrics")
    .delete()
    .eq("song_id", songId);
  if (delErr) throw new Error("Failed to clear lyrics: " + delErr.message);

  if (!lyrics || lyrics.length === 0) return 0;

  const rows = lyrics.map((l) => ({
    song_id: songId,
    word_order: l.word_order,
    syllable: l.syllable,
    measure_num: l.measure_num ?? null,
    rh_index: l.rh_index ?? null,
  }));

  // Batched for the same reason fanOutMeasures batches: a lyric-heavy song
  // runs to several hundred rows (Someone Like You is 371) and one oversized
  // payload is the failure mode we already know about.
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error: insErr } = await supabase
      .from("sam_song_lyrics")
      .insert(rows.slice(i, i + BATCH_SIZE));
    if (insErr) throw new Error("Failed to write lyrics: " + insErr.message);
  }
  return rows.length;
}

/**
 * The Lyrics sheet's save: split pasted text, Auto-Match it onto `measures`
 * (tied continuations skipped), replace every row, recompile the blob.
 * Syllables past the last note are stored unplaced.
 *
 * @returns {Promise<{lyrics:Array, measures:Array, unplaced:number}>}
 */
export async function saveSongLyrics(songId, text, measures) {
  const syllables = splitLyrics(text, await loadSplitter());
  if (syllables.length === 0) throw new Error("No lyrics to save.");
  const lyrics = syllables.map((syllable, i) => ({ word_order: i + 1, syllable }));
  const { placements, unplaced } = matchSyllablesToNotes(measures, lyrics, { skipTiedNotes: true });
  placements.forEach((p, i) => {
    lyrics[i].measure_num = p.measure_num;
    lyrics[i].rh_index = p.rh_index;
  });
  const placed = lyrics.map((l) => ({ measure_num: null, rh_index: null, ...l }));
  await importLyrics(songId, placed);
  return { lyrics: placed, measures: await recompileMeasures(songId, supabase), unplaced };
}

/** Remove every lyric row for a song and recompile, returning the new measures. */
export async function deleteSongLyrics(songId) {
  await importLyrics(songId, []);
  return recompileMeasures(songId, supabase);
}
