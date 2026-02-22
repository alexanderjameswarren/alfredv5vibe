# Sam — Build Plan

## How To Use This Document

This is the implementation roadmap for building Sam within the Alfred project. Each step is atomic and testable. Complete them in order — each step builds on the previous one.

**Before each step:** Read the relevant sections of `sam-tech-spec.md` (architecture & components) and `sam-midi-guide.md` (patterns & gotchas).

**After each step:** Verify the acceptance criteria before moving on.

---

## Phase 1: Foundation

### Step 1 — Route & Shell
**Build:** Create the `/sam` route in Alfred. Create `SamPlayer.jsx` as an empty page component. Add a "Sam" link in Alfred's navigation.

**Accept when:**
- Clicking "Sam" in Alfred's nav navigates to `/sam`
- Page renders "Sam — Piano Practice" placeholder text
- Back navigation returns to Alfred
- Shares Alfred's auth (if not logged in, redirected to login)

---

### Step 2 — Supabase Tables
**Build:** Run the SQL migrations from `sam-tech-spec.md` Section 2. Create `sam_songs`, `sam_snippets`, `sam_sessions` tables with RLS policies.

**Accept when:**
- All three tables exist in Supabase
- RLS is enabled — queries without auth return nothing
- Authenticated user can insert and select their own rows
- `measures` column accepts valid JSONB

---

### Step 3 — VexFlow Loading
**Build:** Add the VexFlow 4.2.2 CDN script tag to the HTML head. Create `vexflowHelpers.js` with the MIDI↔VexFlow conversion functions. Verify VexFlow loads.

**Accept when:**
- `window.Vex.Flow` is available in the browser console
- `midiToVexKey(69)` returns `"a/4"`
- `midiAccidental(73)` returns `"#"`
- `midiToClef(59)` returns `"bass"`, `midiToClef(60)` returns `"treble"`

**Critical:** Use EXACTLY `https://cdn.jsdelivr.net/npm/vexflow@4.2.2/build/cjs/vexflow.js`. See gotcha #5–#8 in midi guide.

---

## Phase 2: Score Rendering

### Step 4 — ScoreRenderer (static)
**Build:** Create `ScoreRenderer.jsx`. Takes an array of measures and renders a VexFlow grand staff SVG. Hardcode the `someone-like-you.json` data for testing.

**Accept when:**
- Grand staff renders: treble + bass clefs with brace connector
- Time signature (4/4) and clef display on first measure
- Notes appear at correct staff positions
- Accidentals (C#, G#, F#) render correctly
- Chords (multiple noteheads stacked) render correctly
- Rests (beats with empty lh/rh) render as quarter rests
- Beams connect consecutive 8th/16th notes (no duplicate flags)
- SVG is wide enough for all measures

**Critical:** Create `Beam` objects BEFORE `voice.draw()`. See gotcha #15–#16. Attach SVG to DOM temporarily for `getBBox()`. See gotcha #14.

---

### Step 5 — ScoreRenderer (beat positions)
**Build:** After rendering, extract each beat's x-position and collect SVG path elements for recoloring.

**Accept when:**
- `beatEvents[]` array has one entry per beat across all measures
- Each entry has: `xPx` (center x position), `allMidi[]` (expected notes), `meas`, `beat`, `svgEls[]`
- Calling `colorBeatEls(beat, '#16a34a')` turns that beat's noteheads green
- Calling with `'#dc2626'` turns them red

---

### Step 6 — SongLoader
**Build:** Create `SongLoader.jsx` with drag-and-drop zone and file picker. Parse JSON, validate, pass to SamPlayer state.

**Accept when:**
- Drop zone visible when no song loaded
- Dropping a `.json` file loads and parses it
- Clicking the zone opens file picker
- Invalid JSON shows error message
- Valid JSON: song title displays, BPM updates from `defaultBpm`, drop zone hides
- Song saves to `sam_songs` in Supabase

---

## Phase 3: Scrolling

### Step 7 — ScrollEngine (basic)
**Build:** Create `ScrollEngine.jsx` / `useScroll.js`. Renders SVG with `translateX` animation. Target line at 15% from left.

**Accept when:**
- Score scrolls smoothly left at BPM-derived speed
- Target line (blue, 2px, full height) fixed at 15% from left
- Target zone (subtle blue tint) behind the line
- Scroll speed changes when BPM input changes (after restart)
- Frame rate is smooth 60fps (no jank)

---

### Step 8 — ScrollEngine (looping)
**Build:** Render 3 copies of the score. Detect when second copy crosses target line and teleport origin.

**Accept when:**
- Score loops seamlessly — no visual jump or gap
- Loop counter increments in stats bar
- Works for songs of any length (1 measure through 100+)
- No memory leak (old SVG elements cleaned up)

---

### Step 9 — ScrollEngine (miss detection)
**Build:** Forward-scan `beatEvents[]` in the frame loop. Mark beats as missed when they pass the timing window.

**Accept when:**
- Beats that scroll past the target line without input turn red
- Miss counter increments
- Only beats with notes (`allMidi.length > 0`) are counted as misses
- Rest beats are skipped silently

---

## Phase 4: MIDI Input

### Step 10 — useMIDI Hook
**Build:** Create `useMIDI.js` hook. Web MIDI connection, device polling, message filtering.

**Accept when:**
- MIDI status shows "Waiting for MIDI..." when no device connected
- Status shows device name (green) when connected
- Status updates within 3 seconds of plugging in a device
- Virtual ports (Midi Through) are filtered out
- Last-note display updates on every keypress

---

### Step 11 — Chord Buffering
**Build:** Add chord input buffering to useMIDI. Buffer notes for `chordGroupMs`, then flush as a single chord.

**Accept when:**
- Single note press → fires after 80ms with `[midiNumber]`
- Chord (4 notes within 80ms) → fires once with `[all4Numbers]` sorted
- Duplicate notes in buffer are deduplicated
- Changing chord group ms input changes the buffer window

---

### Step 12 — Note Matching
**Build:** Create `noteMatching.js`. Wire chord flush → match against closest pending beat → color + record.

**Accept when:**
- Playing correct chord near target line: beat turns green, hit counter increments
- Playing subset of chord: beat turns amber, shows "partial"
- Playing wrong notes: beat turns red, miss counter increments
- Playing with no nearby pending beat: no crash, flash shows "♪ note name"
- Timing delta displays (positive = late, negative = early)

---

## Phase 5: Practice Tracking

### Step 13 — usePracticeSession Hook
**Build:** Create the session tracking hook. Start/end sessions, accumulate events, compute stats.

**Accept when:**
- Press Play → new row appears in `sam_sessions` with `started_at` and settings
- Each hit/miss/partial creates an event object in memory
- Running stats (hits, misses, accuracy, avg timing) update in real-time
- Press Stop → `sam_sessions` row updated with `ended_at`, `summary`, `events`
- Events JSONB contains correct data for every beat

---

### Step 14 — StatsBar & SettingsBar
**Build:** Create the stats and settings bar components.

**Accept when:**
- StatsBar shows: last note, loop count, current measure, hits (green), misses (red), accuracy %, avg timing
- SettingsBar shows: BPM input, Window input, Chord input, Play/Stop button, song title, MIDI status
- All inputs are touch-friendly (44px+ tap targets)
- Play mode: SettingsBar collapses to minimal, StatsBar stays
- Pause mode: full SettingsBar visible

---

## Phase 6: Snippets

### Step 15 — SnippetPanel (create)
**Build:** Create `SnippetPanel.jsx`. Allow selecting a measure range and saving as a snippet.

**Accept when:**
- Panel is collapsible (tap to show/hide)
- User can set start and end measure
- Rest measures control (+/- buttons, default 0)
- Save button prompts for title, saves to `sam_snippets`
- Snippet includes current BPM/window/chord settings

---

### Step 16 — SnippetPanel (load & play)
**Build:** List saved snippets, tap to load, play only the snippet range.

**Accept when:**
- Saved snippets for current song listed in panel
- Tap snippet → loads its measure range and settings
- Play → scrolls only the snippet's measures (not full song)
- Loop respects rest measures setting
- "Full Song" option clears snippet selection

---

## Phase 7: Polish

### Step 17 — Touch Gestures
**Build:** Tap-to-pause on score area. Swipe-to-scrub when paused.

**Accept when:**
- Single tap on score area during play → pauses
- Single tap on score area when paused → resumes
- Swipe left/right when paused → scrubs through measures
- Works on tablet with touch input

---

### Step 18 — Song Library
**Build:** Show a list of previously loaded songs. Tap to select, then play.

**Accept when:**
- Song library shows all songs from `sam_songs` for this user
- Most recently played songs appear first
- Tap song → loads it and enters pause mode
- Option to delete a song

---

### Step 19 — Session History
**Build:** Simple view of past practice sessions with summary stats.

**Accept when:**
- List of sessions for current song/snippet
- Each shows: date, duration, accuracy, avg timing, loop count
- Sorted by most recent first
- Tap to see full stats breakdown

---

## Phase 8: MusicXML Import

### Step 20 — MusicXML Parser
**Build:** Add `parseMusicXML()` to `songParser.js`. Parse MusicXML into Sam's internal JSON format.

**Accept when:**
- Dropping a `.musicxml` file loads and renders correctly
- Notes, rests, durations, accidentals, key signatures parse correctly
- Multi-voice measures (LH + RH) split to treble/bass correctly
- Chords (simultaneous notes) parse as grouped beats
- Tested with at least 3 different MusicXML files from MuseScore

---

## Future Steps (not yet specified)

- **Step 21: Data model migration** — Update all components and parsers to prefer the voice format (`lh[]/rh[]` per measure) over the legacy beats format. The player already accepts both, but new code (MusicXML parser, song editor, MCP export) should produce voice format only. Update `sam-tech-spec.md` songParser section accordingly.
- **Tempo ramping** — adjustable BPM during practice
- **Offline/PWA** — service worker + bundled VexFlow
- **MCP integration** — expose Sam data as Claude tools (per Alfred Phase 7.1)
- **Practice analysis dashboard** — Claude-generated insights from session data
- **Multi-device sync** — practice on tablet, review on desktop

---

## Quick Reference: What To Read Before Each Step

| Step | Read from tech spec | Read from midi guide |
|------|--------------------|--------------------|
| 1–2 | §1 Project Structure, §2 Schema | — |
| 3 | §1 VexFlow Loading | Gotchas #5–#9 |
| 4–5 | §3 ScoreRenderer | VexFlow Quick Reference (all), Gotchas #10–#21 |
| 6 | §3 SongLoader | — |
| 7–9 | §3 ScrollEngine | Gotcha #13 (scrolling architecture) |
| 10–12 | §3 MIDIInput, §4 noteMatching | Gotchas #1–#4, MIDI Number Reference |
| 13–14 | §3 PracticeTracker/Stats/Settings | — |
| 15–16 | §3 SnippetPanel | — |
| 17 | §7 Touch Considerations | — |
| 18–19 | §2 Schema (queries) | — |
| 20 | §3 SongLoader (Phase 2) | — |
