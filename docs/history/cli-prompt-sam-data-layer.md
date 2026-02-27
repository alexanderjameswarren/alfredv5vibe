# Project Context

We're normalizing Sam's data layer — Sam is a React piano practice app with Supabase backend. Three new capabilities: measure-level editing via MCP, practice analytics, and MP3 audio sync with scrolling notation.

The Supabase schema migration has already been run. The new tables (`sam_song_measures`, `sam_session_events`) and new columns on `sam_songs` (`audio_file_path`, `measures_compiled_at`, `measures_edited_at`) exist. A `sam-audio` storage bucket exists. Triggers auto-update `updated_at` on measure rows and bump `measures_edited_at` on the parent song.

# Reference Documents

- Technical spec: docs/technical-spec-sam-data-layer.md
- Progress tracking: docs/progress-sam-data-layer.md

# Your Task

1. Read the technical specification to understand the full architecture
2. Review the progress tracking file — Phase 1 (SQL) is complete
3. Execute the first incomplete step (Phase 2, Step 2.1)
4. After completing each step, update the progress file
5. Provide clear verification instructions for the human
6. Wait for verification before proceeding to the next step

# Key Implementation Details

## Phase 2: Measure Fan-Out

Create `src/services/measureCompiler.js` with two core functions:

**fanOutMeasures(songId, measuresArray, supabase)**
- Deletes existing rows for this song_id (idempotent re-import)
- Inserts one row per measure into sam_song_measures
- Each row gets: song_id, number (1-indexed), rh, lh, time_signature (from the measure's timeSignature object)
- Sets measures_compiled_at and measures_edited_at to NOW() on sam_songs

**recompileMeasures(songId, supabase)**
- Fetches all sam_song_measures rows for this song_id, ordered by number
- Assembles into the measures array format: [{ number, rh, lh, timeSignature: { beats, beatType } }]
- Writes back to sam_songs.measures
- Updates measures_compiled_at to NOW()
- Returns the assembled measures array

**isMeasuresStale(song)** — simple check:
- Returns true if measures_edited_at > measures_compiled_at
- Returns false otherwise (including if both are null — fresh import)

Then update SongLoader.jsx: after a successful song save (both MusicXML import and JSON paste paths), call fanOutMeasures().

## Phase 3: Stale Check

In whatever component loads a song for playback, add:
```
if (isMeasuresStale(song)) {
  const measures = await recompileMeasures(song.id, supabase);
  // use recompiled measures
} else {
  // use song.measures as-is
}
```

## Phase 4: Session Events Fan-Out

In usePracticeSession.js, after saving the session with events blob, also insert into sam_session_events. For each event object:
- session_id: the just-created session ID
- song_id: from the current song
- measure_number: event.measure
- beat: event.beat
- result: event.result
- played_notes: event.playedNotes
- expected_notes: event.expectedNotes
- timing_delta_ms: event.timingDeltaMs (null for misses)
- loop_iteration: event.loopIteration
- measure_id: look up from sam_song_measures WHERE song_id AND number = event.measure (can batch this — fetch all measure IDs for the song once, then map)

## Phase 5: MCP Tools

Skip this phase during CLI work — MCP tools will be built separately as Supabase edge functions or MCP server updates. Just note it as blocked/deferred in the progress file.

## Phase 6: Audio Upload + Caching

Create `src/services/audioPlayer.js`:
- `loadAudio(songId, audioFilePath, supabase)` — checks Cache API first, falls back to Supabase Storage signed URL, caches on fetch
- `uploadAudio(songId, file, userId, supabase)` — uploads to `sam-audio/{userId}/{songId}.mp3`, updates sam_songs.audio_file_path
- Returns an Audio element ready for playback

Create `src/components/AudioControls.jsx`:
- Play/pause button
- Seek bar (range input bound to audio.currentTime / audio.duration)
- Tempo slider (0.5x to 1.5x) — sets audio.playbackRate, audio.preservesPitch = true
- Only renders if the song has an audio_file_path

Add audio upload file input to SongLoader or a dedicated area.

## Phase 7: Audio Scroll Sync

ScrollEngine.jsx modifications:
- Accept optional `audioElement` prop
- New sync mode: if audioElement is playing, derive scroll position from audioElement.currentTime instead of internal BPM clock
- Build a time map: for each measure, calculate its audio start time from either audio_offset_ms (if set) or BPM-based calculation from measure 1's offset
- In the animation loop: currentTime → find current measure + fractional beat → convert to pixel offset
- When audio pauses, scroll pauses. When audio seeks, scroll jumps.
- BPM mode still works as fallback when no audio is loaded

# Verification Pattern

After each step, ask me to:
- Open the app in browser
- Perform specific actions (import a song, play a session, upload audio)
- Check Supabase tables for expected data
- Confirm expected behavior in the UI

Only proceed to the next step after I confirm verification is successful.

# Important

- Update the progress file after each step
- Add notes about any decisions or issues encountered
- If you need to see a file's current state, ask me or read it
- The app uses Vite for dev server
- Supabase client is already configured in the app
- Don't modify songParser.js — it's working correctly
- Don't modify ScoreRenderer.jsx or ScrollEngine.jsx rendering logic — only add audio sync alongside existing behavior
- Stop and ask if anything is unclear
