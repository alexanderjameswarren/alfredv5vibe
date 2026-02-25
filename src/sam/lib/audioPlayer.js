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
  const cacheKey = `/sam-audio-cache/${songId}`;

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
 *
 * @param {string} songId - UUID of the song
 * @param {File} file - The MP3 file to upload
 * @param {string} userId - UUID of the current user
 * @param {object} supabase - Supabase client
 * @returns {Promise<string>} The storage path
 */
export async function uploadAudio(songId, file, userId, supabase) {
  const storagePath = `${userId}/${songId}.mp3`;

  const { error: uploadError } = await supabase.storage
    .from("sam-audio")
    .upload(storagePath, file, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Upload failed: ${uploadError.message}`);
  }

  // Update song record with the storage path
  const { error: updateError } = await supabase
    .from("sam_songs")
    .update({ audio_file_path: storagePath })
    .eq("id", songId);

  if (updateError) {
    throw new Error(`Failed to update song audio path: ${updateError.message}`);
  }

  // Invalidate any cached version so next load picks up the new file
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(`/sam-audio-cache/${songId}`);
  } catch (e) {
    // Cache API not available — no-op
  }

  console.log("[Sam] Audio uploaded:", storagePath);
  return storagePath;
}
