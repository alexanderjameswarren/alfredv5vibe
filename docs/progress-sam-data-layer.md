# Progress: Sam Data Layer Normalization + Audio Sync

## Status: In Progress — Phase 4

---

## Phase 1: Schema Migration (Manual — Supabase Dashboard) ✅

- [x] Step 1.1: Create `sam_song_measures` table
- [x] Step 1.2: Create `sam_session_events` table
- [x] Step 1.3: Add new columns to `sam_songs` (`audio_file_path`, `measures_compiled_at`, `measures_edited_at`)
- [x] Step 1.4: Create RLS policies on new tables
- [x] Step 1.5: Create Supabase Storage bucket `sam-audio`
- [x] Step 1.6: Verify schema — confirm tables visible and RLS working

## Phase 2: Measure Fan-Out on Import

- [x] Step 2.1: Create `measureCompiler.js` service — fan-out (measures array → individual rows) and recompile (rows → blob) functions
- [x] Step 2.2: Update `SongLoader.jsx` — after saving song blob, call fan-out to populate `sam_song_measures`
- [x] Step 2.3: Verify — import a MusicXML song, confirm measure rows appear in Supabase

## Phase 3: Stale Check + Recompile

- [x] Step 3.1: Add stale check to song load flow — compare `measures_edited_at` vs `measures_compiled_at`
- [x] Step 3.2: Implement recompile — fetch measure rows, assemble blob, update `sam_songs.measures` + `measures_compiled_at`
- [x] Step 3.3: Verify — manually update a measure row in Supabase, confirm app recompiles on next load

## Phase 4: Session Events Fan-Out

- [x] Step 4.1: Update `usePracticeSession.js` — after saving events blob, fan out to `sam_session_events`
- [x] Step 4.2: Link `measure_id` by looking up `sam_song_measures` for each event's measure number
- [ ] Step 4.3: Verify — play a session, confirm event rows appear in Supabase with correct measure links

## Phase 5: MCP Tools (Supabase Edge Functions or MCP Server Updates)

- [ ] Step 5.1: `get_song_measures(song_id, from_measure?, to_measure?)`
- [ ] Step 5.2: `update_song_measure(measure_id, patches)` — with trigger/logic to bump `measures_edited_at`
- [ ] Step 5.3: `get_session_events(session_id, from_measure?, to_measure?)`
- [ ] Step 5.4: `get_measure_stats(song_id, measure_range?)` — aggregated hit rate + timing
- [ ] Step 5.5: Verify — test all tools from Claude.ai conversation

## Phase 6: Audio Upload + Caching

- [ ] Step 6.1: Create `audioPlayer.js` service — load from Supabase Storage, Cache API integration
- [ ] Step 6.2: Add audio upload UI to `SongLoader.jsx` — file input, upload to `sam-audio` bucket, save path
- [ ] Step 6.3: Add `AudioControls.jsx` — play/pause, seek bar, tempo slider
- [ ] Step 6.4: Verify — upload an MP3, confirm it plays back, confirm caching works (reload page, check network tab)

## Phase 7: Audio Scroll Sync

- [ ] Step 7.1: Add audio sync mode to `ScrollEngine.jsx` — derive position from `audioElement.currentTime`
- [ ] Step 7.2: Build measure-to-time map from `audio_offset_ms` values (or calculate from BPM for constant-tempo songs)
- [ ] Step 7.3: Implement tempo control — `playbackRate` + `preservesPitch`
- [ ] Step 7.4: Verify — play Someone Like You with MP3, confirm notation scrolls in sync
- [ ] Step 7.5: Test tempo at 0.5x — confirm pitch preserved, scroll stays synced

---

## Notes

- Phase 1 completed manually via Supabase Dashboard (confirmed by user)
- Step 2.1: Created `src/sam/lib/measureCompiler.js` (not `src/services/` — follows existing project convention where Sam lib files live in `src/sam/lib/`)
  - `fanOutMeasures(songId, measuresArray, supabase)` — deletes + re-inserts, batched at 500 rows
  - `recompileMeasures(songId, supabase)` — fetches rows → assembles blob → writes back
  - `isMeasuresStale(song)` — compares `measures_edited_at` vs `measures_compiled_at`
  - Supabase client passed as argument (not imported) for consistency with how SongLoader uses it
- Step 2.2: Wired `fanOutMeasures` into both SongLoader save paths (file import + paste). Runs after successful Supabase insert, using the returned song ID. Errors are caught and logged but don't block the UI.
- Steps 3.1 + 3.2: Combined into one edit in `handleLoadFromLibrary`. The functions already existed in measureCompiler.js from Step 2.1. Added stale check before constructing the song object — if stale, recompiles from rows; on failure, falls back to existing blob.
- Steps 4.1 + 4.2: Combined in `usePracticeSession.js`. Added `songIdRef` to track songId across startSession→endSession lifecycle. After session blob saves, fetches all measure IDs for the song in one query, builds a number→id map, then inserts event rows in batches of 500. measure_id is nullable (graceful if measure rows don't exist yet).

