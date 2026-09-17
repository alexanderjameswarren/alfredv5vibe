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
    // Goal tempo — separate from defaultBpm, which drifts whenever practice
    // tempo is saved. Carried so the exporter can round-trip it.
    goalBpm: row.goal_bpm ?? null,
    goalPlaybackSpeed: row.goal_playback_speed ?? null,
    // The heard goal (generated column) and when it was confirmed. A null
    // goalSetAt means the goal is a placeholder: the player shows no goal label.
    goalEffectiveBpm: row.goal_effective_bpm ?? null,
    goalSetAt: row.goal_set_at ?? null,
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

// Everything the Edit Song dialog reads, and nothing heavy — never `measures`.
// mapSongRow tolerates the columns it is not given (they map to null).
export const SONG_EDIT_COLUMNS =
  "id, title, artist, default_bpm, playback_speed, goal_bpm, goal_playback_speed, " +
  "goal_effective_bpm, goal_set_at, " +
  "default_timing_window_ms, default_chord_ms, default_measure_width, " +
  "audio_file_path, show_imported_fingerings";

/**
 * Load what the Edit Song dialog needs for a song that is NOT open in the
 * player (the library's pencil). Returns the same in-memory shape the player
 * holds, so the dialog behaves identically in both places:
 *
 *   song                   mapSongRow shape without measures; audio is
 *                          detected from audio_file_path exactly as the player
 *                          does (`song.audioFilePath`)
 *   hasImportedFingerings  whether any musicxml fingering row exists — the
 *                          player's useFingeringEditor `hasImported`, which
 *                          gates the "Show imported fingerings" checkbox
 *
 * @param {string} id
 * @param {object} supabase - an authenticated client
 * @returns {Promise<{song: object, hasImportedFingerings: boolean}>}
 * @throws {Error} when the song row cannot be read
 */
export async function fetchSongForEdit(id, supabase) {
  const [songRes, fingerRes] = await Promise.all([
    supabase.from("sam_songs").select(SONG_EDIT_COLUMNS).eq("id", id).single(),
    supabase
      .from("sam_song_fingerings")
      .select("song_id", { count: "exact", head: true })
      .eq("song_id", id)
      .eq("source", "musicxml"),
  ]);

  if (songRes.error || !songRes.data) {
    throw new Error(`Failed to load song ${id}: ${songRes.error?.message ?? "not found"}`);
  }
  if (fingerRes.error) {
    // Only decides whether one checkbox is shown; not worth failing the edit.
    console.error("[Sam] Imported-fingering check failed:", fingerRes.error);
  }

  return {
    song: mapSongRow(songRes.data, undefined),
    hasImportedFingerings: (fingerRes.count ?? 0) > 0,
  };
}
