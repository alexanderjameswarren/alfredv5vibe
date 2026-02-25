# Technical Spec: Sam Data Layer Normalization + Audio Sync

## Overview

Normalize Sam's monolithic JSONB blobs into queryable child tables, enabling MCP-powered lyric editing, practice analytics, and MP3 audio sync. Three major capabilities unlock from this work:

1. **Measure-level editing** — Claude can read/write individual measures via MCP (lyrics, offsets)
2. **Practice analytics** — Claude can analyze per-beat performance data via MCP
3. **Audio playback** — MP3 files synced to scrolling notation with per-measure timing

## Architecture

```
sam_songs (parent — existing table, modified)
│   + audio_file_path         text     — Supabase Storage path
│   + measures_compiled_at    timestamptz
│   + measures_edited_at      timestamptz
│
├── sam_song_measures (NEW — one row per measure)
│   id              uuid PK
│   song_id         uuid FK → sam_songs.id (CASCADE DELETE)
│   number          int      — 1-indexed measure number
│   rh              jsonb    — right hand voice array
│   lh              jsonb    — left hand voice array
│   time_signature  jsonb    — { beats, beatType }
│   audio_offset_ms int      — ms from audio start to this measure's downbeat (nullable)
│   created_at      timestamptz
│   updated_at      timestamptz
│   UNIQUE(song_id, number)
│
├── sam_sessions (existing — modified)
│   (no schema changes, events blob kept for backward compat)
│
└── sam_session_events (NEW — one row per beat event)
    id              uuid PK
    session_id      uuid FK → sam_sessions.id (CASCADE DELETE)
    song_id         uuid FK → sam_songs.id
    measure_id      uuid FK → sam_song_measures.id (nullable)
    measure_number  int      — denormalized
    beat            numeric  — 1, 1.5, 2, etc.
    result          text     — 'hit' | 'miss'
    played_notes    int[]    — MIDI values played
    expected_notes  int[]    — MIDI values expected
    timing_delta_ms int      — nullable (null on miss)
    loop_iteration  int
    created_at      timestamptz
```

### Supabase Storage

- Bucket: `sam-audio` (private, RLS by user_id)
- File naming: `{user_id}/{song_id}.mp3`
- Access: Signed URLs generated client-side via Supabase JS SDK

## Stale Check / Recompile Logic

When a song loads in the React app:

```
if (song.measures_edited_at > song.measures_compiled_at) {
  1. Fetch all rows from sam_song_measures WHERE song_id ORDER BY number
  2. Assemble into measures array (same shape as current blob)
  3. Write assembled array back to sam_songs.measures
  4. Update sam_songs.measures_compiled_at = NOW()
  5. Use the freshly compiled measures for rendering
} else {
  Use sam_songs.measures blob directly (fast path)
}
```

This can be a Supabase RPC function for atomicity, or client-side for simplicity. Start client-side.

## Song Import Flow (Updated)

Current: parseMusicXML() → save blob to sam_songs.measures → done

New:
1. parseMusicXML() → produces measures array (unchanged)
2. Save blob to sam_songs.measures (unchanged)
3. Fan out: INSERT each measure into sam_song_measures
4. Set measures_compiled_at = measures_edited_at = NOW()

This applies to both MusicXML imports and JSON paste imports.

## Session Recording Flow (Updated)

Current: Session ends → save events array as JSONB blob in sam_sessions.events

New:
1. Save events blob to sam_sessions.events (backward compat)
2. Fan out: INSERT each event into sam_session_events
3. Link measure_id by looking up sam_song_measures WHERE song_id AND number = event.measure

## MCP Tools Needed

### get_song_measures(song_id, from_measure?, to_measure?)
Returns measure rows with rh/lh JSON, time signature, audio offset. Paginated by measure range.

### update_song_measure(measure_id, { rh?, lh?, audio_offset_ms? })
Patches a single measure. Bumps updated_at on the row. Also bumps measures_edited_at on the parent sam_songs row (via trigger or app logic).

### get_session_events(session_id, from_measure?, to_measure?)
Returns beat-level events for a session, filterable by measure range.

### get_measure_stats(song_id, measure_from?, measure_to?)
Aggregation: hit rate, avg timing delta, miss count per measure across all sessions. This is the key analytics query.

## Audio Sync Architecture

### Upload Flow
1. User selects MP3 file via file input in SongLoader (or dedicated audio upload UI)
2. File uploads to Supabase Storage bucket `sam-audio` at path `{user_id}/{song_id}.mp3`
3. `sam_songs.audio_file_path` updated with the storage path

### Playback Flow
1. On song load, check if `audio_file_path` exists
2. If yes: check Cache API (`caches.open('sam-audio')`) for cached file
3. If not cached: fetch signed URL from Supabase Storage, cache the response
4. Create `<audio>` element (or Audio object) with the cached/fetched blob URL
5. Display audio controls (play/pause, seek bar, tempo slider)

### Scroll Sync
ScrollEngine gets a new mode: `syncSource: 'bpm' | 'audio'`

**BPM mode** (current): position = elapsed_time × scroll_speed (derived from BPM)

**Audio mode** (new):
1. On each animation frame, read `audioElement.currentTime`
2. Subtract the song's base audio offset (time from file start to measure 1 beat 1)
3. Use the per-measure `audio_offset_ms` map to determine current measure + beat position
4. Convert to pixel position for scroll
5. Audio element is source of truth — pause/seek/tempo changes automatically reflected

### Tempo Control
- `audioElement.playbackRate = 0.5` for half-speed practice
- `audioElement.preservesPitch = true` (modern browsers) keeps vocals natural
- Scroll engine doesn't need to know about tempo — it just follows currentTime

### Offset Calibration (Initial Approach)
1. User opens MP3 in Audacity (or similar)
2. Identifies timestamp of measure 1, beat 1
3. Enters offset in ms into Sam (settings or per-song config)
4. Stored as `audio_offset_ms` on measure 1 in sam_song_measures
5. Remaining measures calculated from BPM (for constant-tempo songs)
6. Future: "tap to sync" UI in Sam for easier calibration

## Files Affected

### New Files
- `src/services/audioPlayer.js` — Audio loading, caching, playback control
- `src/services/measureCompiler.js` — Stale check + recompile logic
- `src/components/AudioControls.jsx` — Play/pause, seek, tempo slider UI

### Modified Files
- `src/services/songParser.js` — No changes to parsing; fan-out logic added post-parse
- `src/components/SongLoader.jsx` — Audio upload UI, fan-out on import, recompile on load
- `src/components/ScrollEngine.jsx` — Audio sync mode alongside existing BPM mode
- `src/hooks/usePracticeSession.js` — Fan out events to sam_session_events on session end
- `src/components/SettingsBar.jsx` — Audio source toggle, tempo control

### Database
- SQL migration for new tables + columns (run manually in Supabase)
- RLS policies matching existing patterns
- Supabase Storage bucket creation (manual)

## Success Criteria

1. Importing a song via MusicXML creates both the blob AND individual measure rows
2. Editing a measure via MCP (e.g., adding lyrics) marks the song as stale
3. Opening a stale song recompiles from measure rows automatically
4. Practice session events are queryable per-measure via MCP
5. An uploaded MP3 plays in sync with scrolling notation
6. Cached MP3s load without re-fetching from Supabase
7. Tempo slider slows audio without pitch change
