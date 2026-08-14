// Read-only fetch of one song's full notation, by id.
//
// Extracted from SongLoader.handleLoadFromLibrary so a SECOND song can be
// loaded — the diff overlay needs a simplified song's parent, and Phase 5 wants
// the same thing — without duplicating the staleness check.
//
// That check is the reason this is a shared helper rather than a bare select.
// `sam_songs.measures` is a compiled artifact; the canonical per-measure data
// lives in `sam_song_measures`. If those rows were edited after the blob was
// last compiled, the blob is stale and a caller that skipped the check would
// render notation that is quietly out of date. A diff drawn against a stale
// parent would be wrong for a reason having nothing to do with the diff.
//
// Takes `supabase` as a parameter rather than importing the client, mirroring
// measureCompiler — which is reused server-side by a Node script with a
// service-role client.

import { isMeasuresStale, recompileMeasures } from "./measureCompiler";

/**
 * Map a `sam_songs` row to the in-memory song shape the renderers consume.
 * Kept separate from the fetch so the mapping has one definition.
 */
export function mapSongRow(row, measures) {
  return {
    title: row.title,
    artist: row.artist,
    defaultBpm: row.default_bpm,
    playbackSpeed: row.playback_speed ?? 100,
    defaultTimingWindowMs: row.default_timing_window_ms ?? null,
    defaultChordMs: row.default_chord_ms ?? null,
    defaultMeasureWidth: row.default_measure_width ?? null,
    audioFilePath: row.audio_file_path || null,
    showImportedFingerings: row.show_imported_fingerings ?? false,
    // Carried for the exporter, which must be able to reproduce the whole song
    // row. The `select("*")` already fetched these, so it costs no extra query.
    // `fifths` has no column; songExport recovers it from the label.
    key: row.key_signature ?? null,
    timeSignature: row.time_signature ?? null,
    sourceXmlPath: row.source_xml_path ?? null,
    songType: row.song_type ?? null,
    parentSongId: row.parent_song_id ?? null,
    difficultyTier: row.difficulty_tier ?? null,
    generationNotes: row.generation_notes ?? null,
    measures,
  };
}

/**
 * Fetch one song by id, recompiling its measures blob first if stale.
 *
 * Read-only: it never writes to the song row itself. `recompileMeasures` does
 * write the refreshed blob back, which is the existing self-healing behaviour
 * and is what keeps a later open cheap — not a side effect this helper adds.
 *
 * @param {string} id
 * @param {object} supabase - an authenticated client
 * @returns {Promise<{song: object, row: object}>}
 * @throws {Error} when the row is missing or unreadable
 */
export async function fetchSongById(id, supabase) {
  const { data, error } = await supabase
    .from("sam_songs")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load song ${id}: ${error?.message ?? "not found"}`);
  }

  let measures = data.measures;
  if (isMeasuresStale(data)) {
    try {
      console.log("[Sam] Measures stale — recompiling from rows");
      measures = await recompileMeasures(data.id, supabase);
    } catch (e) {
      // Non-fatal: the stored blob is out of date but still playable, and
      // failing the whole load would be worse than showing slightly old
      // notation. Matches the pre-extraction behaviour exactly.
      console.error("[Sam] Recompile failed, using existing blob:", e);
    }
  }

  return { song: mapSongRow(data, measures), row: data };
}
