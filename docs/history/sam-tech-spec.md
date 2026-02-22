# Sam — Technical Specification

## Overview

Sam is a piano practice app that lives as a route within the Alfred project. It renders sheet music using VexFlow, captures MIDI input from a connected keyboard, scrolls notation in real-time, and tracks practice accuracy at the note level. Sam shares Alfred's Vercel hosting, Supabase backend, and authentication.

This document is the single source of truth for building Sam. It covers where Sam fits in Alfred's architecture, the database schema, every component's specification, and the validated technical patterns to use.

---

## 1. Project Structure

Sam lives within Alfred's existing Next.js / React project:

```
alfred/
├── src/
│   ├── Alfred.jsx                    # Existing Alfred app
│   ├── supabaseClient.js             # Shared — Sam uses this same client
│   ├── sam/
│   │   ├── SamPlayer.jsx             # Top-level page component
│   │   ├── components/
│   │   │   ├── ScoreRenderer.jsx     # VexFlow rendering engine
│   │   │   ├── ScrollEngine.jsx      # rAF scroll loop + target line
│   │   │   ├── MIDIInput.jsx         # Web MIDI connection + chord buffering
│   │   │   ├── PracticeTracker.jsx   # Hit/miss/timing tracking + flush to DB
│   │   │   ├── SongLoader.jsx        # Drag-and-drop JSON + future MusicXML
│   │   │   ├── SnippetPanel.jsx      # Create/edit/select loop regions
│   │   │   ├── StatsBar.jsx          # Hits, misses, accuracy, timing display
│   │   │   └── SettingsBar.jsx       # BPM, window, chord grouping controls
│   │   ├── lib/
│   │   │   ├── vexflowHelpers.js     # MIDI↔VexFlow conversion, beam grouping
│   │   │   ├── noteMatching.js       # Chord comparison logic (hit/partial/miss)
│   │   │   └── songParser.js         # JSON→internal format, future MusicXML
│   │   └── hooks/
│   │       ├── useMIDI.js            # Web MIDI hook (connect, poll, messages)
│   │       ├── useScroll.js          # rAF scroll state hook
│   │       └── usePracticeSession.js # Session state, event accumulation
```

### Routing

Alfred's router gets a `/sam` route that renders `SamPlayer`. From Alfred's nav, a "Sam" link navigates to this route. Sam is a full-page view — it takes over the viewport (the piano practice UI needs all available screen space).

### VexFlow Loading

VexFlow 4.2.2 loads via CDN in the HTML `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/vexflow@4.2.2/build/cjs/vexflow.js"></script>
```

This exposes `Vex.Flow` as a global. Sam's components access it via `window.Vex.Flow`. Do NOT use npm `import` for VexFlow — the 4.2.2 CJS build is designed for script-tag loading and bundles fonts internally. See the MIDI Guide gotchas for why this specific version and approach matters.

### Shared Infrastructure

Sam uses Alfred's existing:
- `supabaseClient.js` — same Supabase instance and connection
- Authentication — same user session, same RLS policies
- Vercel deployment — Sam deploys as part of Alfred, no separate hosting
- Tailwind CSS — Sam uses the same Tailwind config as Alfred

---

## 2. Supabase Schema

All Sam tables live in the same Supabase project as Alfred. Table names are prefixed with `sam_` to avoid collisions.

### sam_songs

```sql
CREATE TABLE sam_songs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  title TEXT NOT NULL,
  artist TEXT,
  source TEXT,                           -- 'manual', 'musicxml', 'json_import'
  source_file TEXT,                      -- original filename
  key_signature TEXT,                    -- 'A major', 'C minor', etc.
  time_signature TEXT DEFAULT '4/4',
  default_bpm INTEGER DEFAULT 68,
  measures JSONB NOT NULL,               -- full notation data (array of measures)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: users can only see their own songs
ALTER TABLE sam_songs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own songs" ON sam_songs
  FOR ALL USING (auth.uid() = user_id);
```

The `measures` column stores the full notation as JSONB — same structure as our data model spec. This is a deliberate choice: songs are read-heavy and write-once (imported, then practiced). Storing as JSONB avoids complex join queries when loading a song for rendering. A 100-measure song is ~50KB of JSON, well within Postgres JSONB limits.

### sam_snippets

```sql
CREATE TABLE sam_snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  song_id UUID REFERENCES sam_songs(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL,
  start_measure INTEGER NOT NULL,
  end_measure INTEGER NOT NULL,
  rest_measures INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',           -- {bpm, timingWindowMs, chordGroupMs, targetLinePosition}
  tags TEXT[] DEFAULT '{}',
  notes TEXT,                            -- user's free-form practice notes
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sam_snippets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own snippets" ON sam_snippets
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_snippets_song ON sam_snippets(song_id);
```

### sam_sessions

```sql
CREATE TABLE sam_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  song_id UUID REFERENCES sam_songs(id) NOT NULL,
  snippet_id UUID REFERENCES sam_snippets(id),  -- null if practicing full song
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  settings JSONB DEFAULT '{}',           -- snapshot of BPM, window, chord group at time of session
  summary JSONB DEFAULT '{}',            -- {totalBeats, hits, misses, partials, accuracyPercent, avgTimingDeltaMs, loopCount}
  events JSONB DEFAULT '[]',             -- array of per-beat event objects
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sam_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own sessions" ON sam_sessions
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_sessions_song ON sam_sessions(song_id);
CREATE INDEX idx_sessions_snippet ON sam_sessions(snippet_id);
CREATE INDEX idx_sessions_started ON sam_sessions(started_at DESC);
```

The `events` JSONB array stores every note event for the session. A 15-minute session at 72 BPM produces ~1,080 beat events. Each event is ~200 bytes, so a session is ~200KB. This is fine for Supabase's free tier (500MB total). If storage becomes a concern, older sessions can be compacted to summary-only.

### Event Object Structure (within sessions.events JSONB)

```json
{
  "loopIteration": 1,
  "measure": 5,
  "beat": 3,
  "expectedNotes": [50, 66, 69, 74],
  "playedNotes": [50, 66, 69, 74],
  "result": "hit",
  "timingDeltaMs": -12,
  "velocity": [72, 65, 68, 70]
}
```

Fields: `result` is one of `"hit"`, `"miss"`, `"partial"`, `"wrong_note"`. `timingDeltaMs` is negative=early, positive=late, null=not played. `velocity` array matches `playedNotes` order.

---

## 3. Component Specifications

### SamPlayer (top-level)

**Role:** Page-level container. Manages app state, coordinates child components, handles routing.

**State:**
- `song` — loaded song data (null until file dropped)
- `snippet` — active snippet (null = full song)
- `playing` — boolean
- `sessionId` — current practice session UUID

**Responsibilities:**
- Renders the layout: SettingsBar (top), score area (center), StatsBar (bottom)
- Shows SongLoader when no song is loaded
- Shows SnippetPanel when paused
- Passes song data down to ScoreRenderer
- Coordinates play/pause between ScrollEngine and MIDIInput
- Creates/closes sessions in Supabase via PracticeTracker

**Supabase queries:**
- `sam_songs.select('*').order('updated_at', {ascending: false})` — song library on load
- `sam_songs.insert(songData)` — when a new song is imported
- `sam_snippets.select('*').eq('song_id', songId)` — snippets for current song

---

### ScoreRenderer

**Role:** Takes song/snippet data and produces a VexFlow SVG with beat position metadata.

**Input props:**
- `measures` — array of measure objects (from song JSON, filtered by snippet range)
- `copies` — number of times to repeat for looping (typically 3)

**Output (via ref or callback):**
- `svgElement` — the rendered SVG DOM node
- `beatEvents[]` — array of `{globalIdx, meas, beat, allMidi[], xPx, state, svgEls[]}`
- `measPositions[]` — array of `{xStart, xEnd, measNum}`
- `totalWidth` — total SVG width in pixels

**Internal logic:**
1. Convert song JSON measures → VexFlow note objects using `vexflowHelpers.js`
2. For each measure: create treble + bass staves, build voices, create beams
3. Create beams BEFORE calling `voice.draw()` (suppresses flags)
4. After drawing, attach SVG to DOM temporarily for `getBBox()` queries
5. Collect each beat's x-position and SVG path elements for hit coloring
6. Detach from DOM and return

**Constants:**
- `BEAT_PX = 150` — pixels per beat
- `TREBLE_Y = 10`, `BASS_Y = 140`, `STAFF_H = 280`
- First measure gets extra width (+80px) for clef + time signature

**Critical patterns:** See VexFlow Patterns Reference (sam-midi-guide.md) for beaming, accidentals, dotted notes, off-screen getBBox, etc.

---

### ScrollEngine

**Role:** Manages the `requestAnimationFrame` loop that scrolls the SVG and detects misses.

**Input props:**
- `svgElement` — from ScoreRenderer
- `beatEvents[]` — from ScoreRenderer (mutated in-place for state changes)
- `measPositions[]` — for current-measure tracking
- `bpm`, `windowMs` — from settings
- `onBeatMiss(beatEvent)` — callback when a beat passes the window unpressed
- `onMeasureChange(measNum)` — callback for UI display
- `onLoopExtend()` — callback when score needs to be re-rendered (all beats exhausted)

**State:**
- `scrollStartT` — `performance.now()` when scroll began
- `originPx` — scroll offset at `scrollStartT`
- `scrollPxPerMs` — derived from `BEAT_PX / (60000 / bpm)`
- `nextCheck` — index into beatEvents for forward scanning

**Scrolling model:**
```
scrollOffset(t) = originPx + (t - scrollStartT) * scrollPxPerMs
screenX(beat) = beat.xPx - scrollOffset
```
Target line is at `screenWidth * 0.15` from left edge.

**Seamless looping:**
ScoreRenderer produces 3 copies of the measures. When the second copy's start position crosses the target line, teleport `originPx` forward by one copy's width. Visually identical content — user sees no jump.

**Miss detection:**
Each frame, scan forward from `nextCheck`. If a pending beat's screen position has passed `targetX + windowMs * scrollPxPerMs`, mark it as missed.

---

### MIDIInput

**Role:** Web MIDI connection management and chord input buffering.

**Hook API (`useMIDI`):**
```javascript
const { connected, deviceName, lastNote } = useMIDI({
  onChord: (midiNumbers[]) => void,  // fired after chord buffer flushes
  chordGroupMs: 80                    // configurable buffer window
});
```

**Connection logic:**
1. `navigator.requestMIDIAccess({ sysex: false })`
2. Filter out virtual ports (name contains "midi through" or "thru")
3. Bind `onmidimessage` to all real connected inputs
4. Poll every 3 seconds with `setInterval` + rebind (ChromeOS onstatechange workaround)
5. Also listen to `onstatechange` for hot-plug

**Message filtering:**
- Only process `status & 0xF0 === 0x90` (Note On) with `velocity > 0`
- Ignore system messages (`status >= 0xF0`)

**Chord buffering:**
- On note arrival: push MIDI number to `inputBuffer[]`, reset/set `setTimeout(flushChord, chordGroupMs)`
- On timeout: deduplicate buffer, sort ascending, fire `onChord(sorted)`
- This groups notes played within 80ms into a single chord gesture

---

### PracticeTracker

**Role:** Accumulates hit/miss/timing events during a session and flushes to Supabase.

**Hook API (`usePracticeSession`):**
```javascript
const { startSession, endSession, recordEvent, stats } = usePracticeSession({
  songId, snippetId, settings
});
```

**Behavior:**
- `startSession()`: Creates a row in `sam_sessions` with `started_at` and settings snapshot
- `recordEvent(beatEvent, played, timingDelta)`: Pushes to in-memory events array, updates running stats
- `endSession()`: Computes summary, updates `sam_sessions` row with `ended_at`, `duration_seconds`, `summary`, `events`

**Stats (computed in real-time):**
- `hits`, `misses`, `partials`, `totalBeats`
- `accuracyPercent` = hits / (hits + misses) * 100
- `avgTimingDeltaMs` = average of all timing deltas

**Flush strategy:** Events accumulate in memory during play. On pause or stop, flush the full events array to Supabase in one `update()` call. This avoids per-beat database writes during real-time play.

---

### SongLoader

**Role:** File input for loading songs via drag-and-drop or file picker.

**Supported formats (MVP):**
- `.json` — Sam internal format (parsed directly)

**Supported formats (Phase 2):**
- `.musicxml` / `.xml` — MusicXML (parsed via `songParser.js`)
- `.mxl` — Compressed MusicXML (unzip first, then parse)

**UI:**
- Drop zone with "Drop a .json song file here" + click-to-browse
- Shown when no song is loaded
- On successful load: hides drop zone, displays song title, sets BPM from song default

**Parse pipeline:**
1. Read file as text
2. Detect format by extension
3. Parse to internal song JSON structure
4. Validate: must have `measures[]` with at least one measure, each measure must have `beats[]`
5. Save to `sam_songs` in Supabase
6. Pass to SamPlayer state

---

### SnippetPanel

**Role:** Create, select, and manage loop regions within a song.

**UI (visible when paused):**
- Collapsible section (tap "✂ Snippet" to expand/collapse)
- Current loop range display: "Measures 5–8"
- Rest measures control: +/- buttons, default 0
- Save snippet button (💾) — prompts for title, saves to `sam_snippets`
- List of saved snippets for this song — tap to load
- "Full Song" option to clear snippet and play everything

**Snippet settings:**
Each snippet stores its own `bpm`, `timingWindowMs`, `chordGroupMs`. When a snippet is selected, these override the global settings.

---

### StatsBar

**Role:** Bottom bar displaying real-time practice statistics.

**Displays:**
- Last note played (MIDI name)
- Current loop number
- Current measure
- Hits (green), Misses (red)
- Accuracy percentage
- Average timing delta

---

### SettingsBar

**Role:** Top bar with playback controls and tunable parameters.

**Controls:**
- BPM input (number, default from song)
- Timing window input (ms, default 150)
- Chord grouping input (ms, default 80)
- Play/Stop button
- Clear button
- Song title display
- MIDI status indicator (green=connected, yellow=waiting)

---

## 4. Library Modules

### vexflowHelpers.js

Pure functions for MIDI↔VexFlow conversion:

```javascript
// MIDI number → VexFlow key: 69 → "a/4"
midiToVexKey(midi)

// MIDI number → accidental: 73 → "#", 60 → null
midiAccidental(midi)

// MIDI number → display name: 69 → "A4"
midiDisplayName(midi)

// MIDI number → clef: 59 → "bass", 60 → "treble"
midiToClef(midi)

// Group consecutive 8th/16th notes for beaming
getBeamGroups(vexNotes[]) → groups[][]

// Build a VexFlow voice from note data
buildVoice(clef, noteList[]) → {notes: StaveNote[], ties: []}
```

### noteMatching.js

Chord comparison logic:

```javascript
// Compare played notes to expected
matchChord(played[], expected[]) → {
  result: 'hit' | 'miss' | 'partial' | 'wrong_note',
  missingNotes: [],
  extraNotes: []
}
```

- **hit**: `played` exactly matches `expected` (order-independent)
- **partial**: all `played` notes are in `expected`, but some expected notes are missing
- **wrong_note**: right count but wrong pitches
- **miss**: no match found within timing window

### songParser.js

Converts between formats:

```javascript
// Parse our internal JSON format
parseSamJSON(jsonString) → songObject

// Convert song measures to VexFlow render format
songToRenderMeasures(song) → [{treble, bass, beatData}]

// Future: Parse MusicXML
parseMusicXML(xmlString) → songObject
```

---

## 5. UI Modes

### Play Mode (playing === true)
- Score area takes full height
- SettingsBar: only BPM badge, MIDI status, Stop button visible
- Target line and target zone visible
- StatsBar visible with real-time updates
- SnippetPanel hidden
- Tap anywhere on score area → pause

### Pause Mode (playing === false, song loaded)
- Score area shows static notation (no scrolling)
- Full SettingsBar with all controls
- SnippetPanel visible (collapsible)
- StatsBar shows session totals
- Play button prominent at bottom center or in SettingsBar

### Load Mode (song === null)
- SongLoader drop zone fills score area
- SettingsBar shows minimal controls
- StatsBar shows placeholder dashes

---

## 6. Data Flow

### Song Load Flow
```
User drops .json file
  → SongLoader reads file
  → songParser.parseSamJSON() validates and parses
  → SamPlayer stores in state + saves to sam_songs
  → ScoreRenderer receives measures, renders SVG
  → UI enters Pause Mode
```

### Play Flow
```
User presses Play
  → PracticeTracker.startSession() creates DB row
  → ScoreRenderer renders 3 copies of measures (or snippet range)
  → ScrollEngine starts rAF loop
  → MIDIInput begins capturing notes
  → Each chord flush → noteMatching.matchChord() → colorBeatEls() + recordEvent()
  → ScrollEngine detects misses → onBeatMiss → recordEvent()
  → On loop extend → ScoreRenderer re-renders, ScrollEngine teleports
```

### Stop Flow
```
User presses Stop (or taps score)
  → ScrollEngine stops rAF
  → MIDIInput flushes any pending buffer
  → PracticeTracker.endSession() computes summary, updates DB
  → UI enters Pause Mode with session stats displayed
```

---

## 7. Touch & Tablet Considerations

Sam is designed for a tablet sitting on a piano music stand. All interactive elements must be touch-friendly:

- All buttons: minimum 44px tap target
- BPM/Window/Chord inputs: +/- stepper buttons (not just number inputs)
- Single tap on score area: pause/play toggle
- Swipe left/right on score (when paused): scrub through measures
- All controls reachable by thumbs in landscape orientation
- No hover-dependent interactions

---

## 8. Future: MCP Integration

When Alfred's MCP integration (Phase 7.1) is built, Sam exposes these tools:

- `sam_get_practice_stats(song_id, snippet_id?, date_range?)` — returns aggregated practice data
- `sam_get_session_events(session_id)` — returns full event log for analysis
- `sam_search_songs(query)` — search song library by title/artist
- `sam_get_trouble_spots(song_id, threshold?)` — returns measures with accuracy below threshold

This enables: "Claude, look at my Someone Like You sessions this week and tell me what to focus on today."

---

## 9. Dependencies

| Package | Version | Purpose | Load Method |
|---------|---------|---------|-------------|
| VexFlow | 4.2.2 | Music notation rendering | CDN script tag |
| React | (Alfred's) | UI framework | npm (shared) |
| Supabase JS | (Alfred's) | Database client | npm (shared) |
| Tailwind CSS | (Alfred's) | Styling | npm (shared) |

No additional npm packages needed for Sam MVP. VexFlow MUST be loaded via CDN script tag, not npm import.
