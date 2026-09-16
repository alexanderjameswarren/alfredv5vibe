// Audio loading, caching, and upload service for Sam
// Uses Supabase Storage (sam-audio bucket) + Cache API for offline support

const CACHE_NAME = "sam-audio";

/**
 * Load audio for a song. Checks Cache API first, falls back to Supabase Storage signed URL.
 * Returns an Audio element ready for playback.
 *
 * @param {string} songId - UUID of the song
 * @param {string} audioFilePath - Supabase Storage path (e.g., "{userId}/{songId}.mp3")
 * @param {object} supabase - Supabase client
 * @returns {Promise<HTMLAudioElement>}
 */
export async function loadAudio(songId, audioFilePath, supabase) {
  const cacheKey = `/sam-audio-cache/${audioFilePath}`;

  // Try Cache API first
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(cacheKey);
    if (cached) {
      console.log("[Sam] Audio loaded from cache:", songId);
      const blob = await cached.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      return audio;
    }
  } catch (e) {
    // Cache API not available (e.g., non-secure context) — fall through
    console.warn("[Sam] Cache API unavailable:", e.message);
  }

  // Fetch from Supabase Storage via signed URL
  const { data, error } = await supabase.storage
    .from("sam-audio")
    .createSignedUrl(audioFilePath, 3600); // 1 hour expiry

  if (error || !data?.signedUrl) {
    throw new Error(`Failed to get signed URL: ${error?.message || "no URL returned"}`);
  }

  const response = await fetch(data.signedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio: ${response.status}`);
  }

  // Cache the response for next time
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response.clone());
    console.log("[Sam] Audio cached:", songId);
  } catch (e) {
    console.warn("[Sam] Failed to cache audio:", e.message);
  }

  const blob = await response.blob();
  const audio = new Audio(URL.createObjectURL(blob));
  console.log("[Sam] Audio loaded from Supabase Storage:", songId);
  return audio;
}

/**
 * Upload an MP3 file to Supabase Storage and update the song's audio_file_path.
 * Also the replace path: pass the current path as `oldAudioPath`.
 *
 * A failure at any step leaves the song exactly as it was. The old file is
 * deleted only AFTER the song row points at the new one — deleting it first
 * (as this used to) meant a failed upload left the song pointing at a file
 * that no longer existed. Only `audio_file_path` is written; tempo, playback
 * speed and the goal are never touched here.
 *
 * @param {string} songId - UUID of the song
 * @param {File} file - The MP3 file to upload
 * @param {string} userId - UUID of the current user
 * @param {object} supabase - Supabase client
 * @param {string|null} [oldAudioPath] - the song's current audio path, if any
 * @returns {Promise<string>} The storage path
 */
export async function uploadAudio(songId, file, userId, supabase, oldAudioPath = null) {
  const ts = Date.now();
  const storagePath = `${userId}/${songId}-${ts}.mp3`;

  const { error: uploadError } = await supabase.storage
    .from("sam-audio")
    .upload(storagePath, file, {
      contentType: "audio/mpeg",
    });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  // Point the song at the new file.
  const { error: updateError } = await supabase
    .from("sam_songs")
    .update({ audio_file_path: storagePath })
    .eq("id", songId);

  if (updateError) {
    // The song still points at the old file, which is untouched. Drop the
    // new upload so it isn't orphaned; best effort — the error that matters
    // is the one thrown below.
    try {
      await supabase.storage.from("sam-audio").remove([storagePath]);
    } catch (e) {
      console.error("[Sam] Could not remove the unused upload:", e);
    }
    throw new Error(`Failed to update song audio path: ${updateError.message}`);
  }

  // Only now is the old file unreferenced. Removing it is housekeeping: if it
  // fails, the upload has still succeeded, so log rather than throw.
  if (oldAudioPath && oldAudioPath !== storagePath) {
    try {
      const { error: removeError } = await supabase.storage
        .from("sam-audio")
        .remove([oldAudioPath]);
      if (removeError) throw removeError;
    } catch (e) {
      console.error("[Sam] Could not remove the replaced audio file:", e);
    }
  }

  // Invalidate old cached version
  if (oldAudioPath) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(`/sam-audio-cache/${oldAudioPath}`);
    } catch (e) {
      // Cache API not available — no-op
    }
  }

  console.log("[Sam] Audio uploaded:", storagePath);
  return storagePath;
}
