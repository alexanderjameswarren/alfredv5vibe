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
