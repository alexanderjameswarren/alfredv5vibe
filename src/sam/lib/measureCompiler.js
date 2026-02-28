// Measure fan-out and recompile service
// Syncs between sam_songs.measures blob and sam_song_measures rows

/**
 * Fan out a measures array into individual sam_song_measures rows.
 * Idempotent — deletes existing rows for the song first.
 *
 * @param {string} songId - UUID of the song
 * @param {Array} measuresArray - The measures array from the song blob
 * @param {object} supabase - Supabase client
 */
export async function fanOutMeasures(songId, measuresArray, supabase) {
  // Delete existing rows (idempotent re-import)
  const { error: deleteError } = await supabase
    .from("sam_song_measures")
    .delete()
    .eq("song_id", songId);

  if (deleteError) {
    console.error("[Sam] Failed to delete existing measure rows:", deleteError);
    throw deleteError;
  }

  // Build rows — one per measure, 1-indexed
  const rows = measuresArray.map((m, i) => ({
    song_id: songId,
    number: i + 1,
    rh: m.rh || null,
    lh: m.lh || null,
    time_signature: m.timeSignature
      ? { beats: m.timeSignature.beats, beatType: m.timeSignature.beatType }
      : null,
    ...(m.audioOffsetMs != null ? { audio_offset_ms: m.audioOffsetMs } : {}),
  }));

  // Insert in batches of 500 to avoid payload limits
  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase
      .from("sam_song_measures")
      .insert(batch);

    if (insertError) {
      console.error("[Sam] Failed to insert measure rows:", insertError);
      throw insertError;
    }
  }

  // Set both timestamps to NOW() on the parent song
  const { error: updateError } = await supabase
    .from("sam_songs")
    .update({
      measures_compiled_at: new Date().toISOString(),
      measures_edited_at: new Date().toISOString(),
    })
    .eq("id", songId);

  if (updateError) {
    console.error("[Sam] Failed to update song timestamps:", updateError);
    throw updateError;
  }

  console.log(`[Sam] Fan-out complete: ${rows.length} measures for song ${songId}`);
}

/**
 * Recompile measures from individual rows back into the blob format.
 * Fetches sam_song_measures rows, assembles array, writes back to sam_songs.measures.
 *
 * @param {string} songId - UUID of the song
 * @param {object} supabase - Supabase client
 * @returns {Array} The assembled measures array
 */
export async function recompileMeasures(songId, supabase) {
  const { data: rows, error: fetchError } = await supabase
    .from("sam_song_measures")
    .select("number, rh, lh, time_signature, audio_offset_ms")
    .eq("song_id", songId)
    .order("number", { ascending: true });

  if (fetchError) {
    console.error("[Sam] Failed to fetch measure rows:", fetchError);
    throw fetchError;
  }

  // Assemble into the measures array format
  const measures = rows.map((row) => ({
    number: row.number,
    rh: row.rh || [],
    lh: row.lh || [],
    timeSignature: row.time_signature
      ? { beats: row.time_signature.beats, beatType: row.time_signature.beatType }
      : undefined,
    ...(row.audio_offset_ms != null ? { audioOffsetMs: row.audio_offset_ms } : {}),
  }));

  // Write back to sam_songs.measures and update compiled timestamp
  const { error: updateError } = await supabase
    .from("sam_songs")
    .update({
      measures,
      measures_compiled_at: new Date().toISOString(),
    })
    .eq("id", songId);

  if (updateError) {
    console.error("[Sam] Failed to write recompiled measures:", updateError);
    throw updateError;
  }

  console.log(`[Sam] Recompile complete: ${measures.length} measures for song ${songId}`);
  return measures;
}

/**
 * Check if a song's measure rows have been edited since last compile.
 * Returns true if the blob is stale and needs recompiling.
 *
 * @param {object} song - Song row with measures_edited_at and measures_compiled_at
 * @returns {boolean}
 */
export function isMeasuresStale(song) {
  // Both null = fresh import, not stale
  if (!song.measures_edited_at && !song.measures_compiled_at) return false;
  // edited_at set but compiled_at not = definitely stale
  if (song.measures_edited_at && !song.measures_compiled_at) return true;
  // Compare timestamps
  return new Date(song.measures_edited_at) > new Date(song.measures_compiled_at);
}
