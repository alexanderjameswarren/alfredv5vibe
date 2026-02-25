# Progress: Sam Data Layer Normalization + Audio Sync

## Status: Not Started

---

## Phase 1: Schema Migration (Manual — Supabase Dashboard)

- [ ] Step 1.1: Create `sam_song_measures` table
- [ ] Step 1.2: Create `sam_session_events` table
- [ ] Step 1.3: Add new columns to `sam_songs` (`audio_file_path`, `measures_compiled_at`, `measures_edited_at`)
- [ ] Step 1.4: Create RLS policies on new tables
- [ ] Step 1.5: Create Supabase Storage bucket `sam-audio`
- [ ] Step 1.6: Verify schema — confirm tables visible and RLS working

## Phase 2: Measure Fan-Out on Import

- [ ] Step 2.1: Create `measureCompiler.js` service — fan-out (measures array → individual rows) and recompile (rows → blob) functions
- [ ] Step 2.2: Update `SongLoader.jsx` — after saving song blob, call fan-out to populate `sam_song_measures`
- [ ] Step 2.3: Verify — import a MusicXML song, confirm measure rows appear in Supabase

## Phase 3: Stale Check + Recompile

- [ ] Step 3.1: Add stale check to song load flow — compare `measures_edited_at` vs `measures_compiled_at`
- [ ] Step 3.2: Implement recompile — fetch measure rows, assemble blob, update `sam_songs.measures` + `measures_compiled_at`
- [ ] Step 3.3: Verify — manually update a measure row in Supabase, confirm app recompiles on next load

## Phase 4: Session Events Fan-Out

- [ ] Step 4.1: Update `usePracticeSession.js` — after saving events blob, fan out to `sam_session_events`
- [ ] Step 4.2: Link `measure_id` by looking up `sam_song_measures` for each event's measure number
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
_Space for notes during execution_

