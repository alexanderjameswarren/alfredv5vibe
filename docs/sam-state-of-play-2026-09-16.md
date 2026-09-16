# SAM — state of play, 2026-09-16

Research-only findings from two read-only investigations of the `alfred-v5` repo
(branch `main`, HEAD `de0cb95` "SAM passes", working tree clean):

- **Part A** — what exists today for a "daily practice plan" feature (sam_passes,
  accuracy, pass counter UI, Sam tab layout, tempo, "today", MCP tools).
- **Part B** — context refresh before porting the difficulty analyzer to Supabase
  (repo state, full code, the tempo-convention question, measure write paths,
  platform rules, snippets, open issues, schema warnings).

Nothing was changed while gathering this. Evidence came from the code, from
read-only Alfred MCP calls (`get_database_schema`, `get_sam_songs`,
`get_sam_snippets`, `get_sam_song_measures`, `get_sam_sessions`,
`get_sam_passes`, `get_platform_contract`), and from running the analyzer and
the validator with output to stdout/scratch only.

File references are `path:line` relative to the repo root.

## Headline findings

1. **Tempo convention is consistent.** SAM's tempo box, the analyzer's `--bpm`,
   `sam_passes.bpm` and the export doc all mean **quarter notes per minute**.
   Pastorale (6/8, `default_bpm` 65) plays at quarter = 65. Proven by code and by
   session durations. No 1.5× correction is needed. (B3)
2. **`get_sam_passes` returns `[]` for the whole table**, although SQL confirmed
   rows on 2026-09-14 and Pastorale had full-song sessions on 09-15/09-16 that
   should have credited passes. Undiagnosed. (B8)
3. **No trigger stamps `measures_edited_at`** as far as can be seen; every
   notation writer stamps it in app code. Unverified — SQL to confirm is in B4.
4. **Phase 6 M2 is built** (ghost layer, opacity, per-hand toggles); only human
   verification is outstanding. **Phase 2 went past M7.** (B1)
5. **Snippets use played measure numbers** (`sam_song_measures.number`), not
   `source_measure`. (B6)

---

# Part A — Daily practice plan: what exists today

## A1. The `sam_passes` table

Live schema (from `get_database_schema`). The table is not in
`supabase/migrations/`; it was created from `docs/2026-09-14-sam-passes.sql`,
then altered by `docs/migrations/2026-09-16-sam-passes-playback-speed.sql` and
`docs/migrations/2026-09-16-sam-passes-accuracy.sql`, with comments reworded by
`docs/migrations/2026-09-16b-sam-passes-comment-wording.sql`.

| column | type | null | default / notes |
|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` |
| user_id | uuid | no | `auth.uid()` |
| song_id | uuid | **no** | FK → sam_songs, ON DELETE CASCADE |
| snippet_id | uuid | yes | FK → sam_snippets, **no ON DELETE** (the original SQL file says cascade; the live table does not) |
| session_id | uuid | yes | FK → sam_sessions, ON DELETE SET NULL |
| bpm | integer | yes | |
| completed_at | timestamptz | no | `now()` |
| created_at | timestamptz | no | `now()` |
| playback_speed | integer | yes | |
| effective_bpm | integer | yes | generated: `round(bpm * playback_speed / 100.0)` |
| hits | integer | yes | |
| misses | integer | yes | |
| notes_played | integer | yes | |
| hand_mode | text | yes | `both` / `lh` / `rh` (no CHECK constraint) |
| accuracy_percent | integer | yes | generated: NULL if `notes_played` is 0 or `hits+misses` is 0, else `round(hits*100/(hits+misses))` |

- Indexes: `(song_id, completed_at desc)`, `(snippet_id, completed_at desc)`,
  `(song_id, effective_bpm)`, `(song_id, notes_played)`.
- RLS: `user_id = auth.uid()` for all commands. Registered with the platform as
  `policy_mode: owner`, audited.
- `playback_speed` began recording ~07:01 PT on 2026-09-16; `hits`, `misses`,
  `notes_played`, `hand_mode` ~07:28 PT. Earlier rows are NULL in those columns.

**The only writer** is `recordPass` in `src/sam/lib/useSamPasses.js:80-117`:

```js
const row = {
  song_id: songId,
  snippet_id: snippet?.dbId || null,
  session_id: sessionId || null,
  bpm: Number.isFinite(bpm) ? Math.round(bpm) : null,
  playback_speed: Number.isFinite(playbackSpeed) ? Math.round(playbackSpeed) : 100,
  hand_mode: handMode || "both",
  hits: playthrough?.hits ?? 0,
  misses: playthrough?.misses ?? 0,
  notes_played: playthrough?.notesPlayed ?? 0,
  completed_at: new Date().toISOString(),
};
supabase.from("sam_passes").insert(row)
```

- **Recorded:** `song_id`, `snippet_id`, `session_id`, `bpm`, `playback_speed`,
  `hand_mode`, `hits`, `misses`, `notes_played`, `completed_at`. Postgres fills
  `id`, `user_id`, `created_at` and generates `effective_bpm`,
  `accuracy_percent`.
- **Not recorded:** partials, timing deltas, a pass start time.
- **Where the values come from:** `creditPass` in `src/sam/SamPlayer.jsx:506-519`.
  `bpm` and `playbackSpeed` are read at the finish line through
  `passContextRef`; `handMode` is `snippet?.handMode || "both"`; counts come
  from `getCurrentPlaythrough()`.
- **When it fires:** looped playback → `handleLoopCount` when
  `n > 0 && n !== lastLoopCountRef` (`SamPlayer.jsx:534-548`); non-looping
  whole-song playback → `handleRangeEnded` (`SamPlayer.jsx:560-563`). Only if
  the pass is armed: Play/Restart arm; Stop, full stop, snippet change and
  closing the song disarm; Pause leaves it armed.
- **When nothing is written:** `songId` is null, or the loaded range is an
  unsaved snippet (no `dbId`).

## A2. Accuracy

Computed live in `src/sam/lib/usePracticeSession.js`:

- **Formula:** `accuracyOf(c)` = `round(hits / (hits + misses) * 100)`, or **0**
  when `hits + misses` is 0 (lines 31-34). Partials are excluded from the ratio.
- **Counting:** `recordEvent` (lines 162-204) updates session-wide and
  per-playthrough counters. `"hit"` → hits, `"partial"` → partials, anything
  else (`"miss"`/`"wrong"`) → misses. `notesPlayed += played?.length || 0`.
- **Event sources:** MIDI matches call `recordEvent` from `handleChord`
  (`SamPlayer.jsx:391-472`). Time-based misses come from ScrollEngine —
  `elapsed > evt.targetTimeMs + timingWindowMs`
  (`src/sam/components/ScrollEngine.jsx:700-714`) → `onBeatMiss` →
  `recordEvent({ played: [], result: "miss" })`. MIDI is not consulted.

**Where it is saved:**

- `sam_passes`: `hits`, `misses`, `notes_played`, generated `accuracy_percent`.
- `sam_sessions.summary` (jsonb), built by `buildSummary` (lines 248-294):
  `totalBeats`, `hits`, `misses`, `partials`, `accuracyPercent`,
  `avgTimingDeltaMs`, `loopCount`, `playthroughs[]` (each `loop`, `hits`,
  `misses`, `partials`, `totalBeats`, `accuracyPercent`),
  `bestPlaythroughAccuracyPercent`, `tempo {start,end,min,max}`,
  `midi {atStart, everConnected}`.
- `sam_session_events`: one row per beat, fanned out after the session ends.

**Playing zero notes:**

- Pass row: `hits: 0`, `misses: N` (every scoreable beat), `notes_played: 0` →
  `accuracy_percent` **NULL**.
- Session summary: `accuracyPercent: 0` (not null); on-screen "Session
  Accuracy" shows 0%.
- A range with no scoreable beats gives `hits: 0, misses: 0` → NULL again.

## A3. Pass counter UI

- **Data hook:** `src/sam/lib/usePassCounts.js`, called at `SamPlayer.jsx:143-148`.
  - Song total: `sam_passes` where `song_id = songId` and `snippet_id IS NULL`,
    head count.
  - Song today: same filter plus `completed_at >= now - 48h`, then filtered in
    the client with `ptDateKey`.
  - Snippet today: `song_id` + `snippet_id` + the same 48h / `ptDateKey` filter.
  - Live updates: `countPass` (passed to `useSamPasses` as `onPassRecorded`)
    increments after each successful insert.
- **While playing:** `FocusedPlaybackBar.jsx` → `LiveSessionCounter.jsx` shows
  "Completed Passes: {passesToday}" (`rangeTodayCount`).
- **Paused/stopped:** `StatsBar.jsx` → `PracticeFigures.jsx` shows "This song —
  Passes X today · Y all time" (whole-song passes only).
- **Per snippet row:** `SnippetPanel.jsx` `SnippetRowFigures`, fed by
  `useSnippetPracticeSummary.js` (all `sam_passes` rows for the song with a
  snippet, plus ended `sam_sessions` with a snippet; fetches only while the
  panel is open).

## A4. The Sam tab

- Top-level component: `src/sam/SamPlayer.jsx`. `src/Alfred.jsx:5208-5213`
  renders `<SamPlayer onBack=…/>` in place of the whole Alfred shell when
  `view === "sam"`. Routes: `/sam`, `/sam/stats`, `/sam/songs/:id`.

**No song open (`/sam`):** `BackButton`, then `SongLoader.jsx` (render at lines
738-800), top to bottom:

1. `PracticeWeekSnapshot` — 7-day minutes strip; tap opens `StatsPage` (still a
   placeholder).
2. `ContinueSection` — recent song families.
3. Error banner when present.
4. `BrowseTabs` — Recent / All songs / Drills + Add.
5. `FamilySheet`, `AddImportSheet` — overlays.
6. Import-warning dialog.

**Song open, stopped or paused:**

1. `SettingsBar` — `TransportControls`, `SongMetadataEditor`, `AudioToolbar`,
   `NumericSettings` (BPM, speed %, repeat, tuning, metronome, score playback,
   "Practiced today").
2. `AudioControls`, plus mute checkbox and ms counter for audio songs.
3. `StatsBar`.
4. `SnippetPanel` (collapsible; score-tool buttons on its toggle row).
5. When stopped: `FingeringBar` row and ghost-overlay controls (when those modes
   are on), then `ScoreRenderer`, then the lyric save row.

**Song open, playing:** `FocusedPlaybackBar`, then `ScrollEngine`.

## A5. How tempo is set on load

- **State:** `bpm` and `playbackSpeed` are `useNumericInput` values in SamPlayer
  (`SamPlayer.jsx:80`, `:113`). Defaults from `src/sam/lib/samConstants.js`:
  bpm 68, playbackSpeed 100.
- **Loading a song:** `handleSongLoaded` (`SamPlayer.jsx:576-602`) calls
  `bpm.reset(loadedSong.defaultBpm || DEFAULTS.bpm)` and
  `playbackSpeed.reset(loadedSong.playbackSpeed ?? DEFAULTS.playbackSpeed)`,
  mapped from `sam_songs.default_bpm` / `sam_songs.playback_speed` in
  `mapSongRow` (`src/sam/lib/songLoad.js`).
- **Loading a snippet: tempo does not change.** `handleLoadSnippet`
  (`SnippetPanel.jsx:212-229`) sets only start/end, rest measures, `handMode`
  (from `settings.handMode`), `dbId`, `title`. The `sam_snippets.settings`
  column comment says it holds bpm/timing-window overrides, but current code
  only reads/writes `settings.handMode` (`src/sam/lib/snippetsApi.js:168`).
  Old snippets (Feb–Jul) do carry `settings.bpm`, which is ignored.
- **Saving tempo:** "Save" in `NumericSettings.jsx:98-120` writes `default_bpm`
  and `playback_speed` to `sam_songs`. For audio songs the BPM field is hidden
  by default and only speed % shows; `handleEnableBpmEdit` resets speed to 100
  when BPM editing is revealed.

## A6. "Today"

Everything uses `ptDateKey` in `src/sam/lib/practiceTimeFormat.js`, hardcoded to
**America/Los_Angeles** (ignores browser timezone).

| Where | What it groups |
|---|---|
| `usePracticeStats.js` | 7-day minutes, today's minutes, per-song minutes today — by `started_at` |
| `usePassCounts.js` | Passes today — by `completed_at` |
| `useSnippetPracticeSummary.js` | Snippet passes and minutes today |
| `samFormat.js` | "today" / "yesterday" labels |

- Nothing in the database groups by day.
- MCP `date_from` / `date_to` are passed straight to `gte`/`lte` on the
  timestamp — no Pacific-time conversion.

## A7. MCP tools touching passes and sessions

Registered in `supabase/functions/mcp/index.ts`, handlers in
`supabase/functions/_shared/alfred-tools/tool-handlers.ts`. Both tier 1 (read).
Limit via `clampLimit`: default 20, cap 50.

- **`get_sam_sessions`** — params `song_id`, `snippet_id`, `date_from`,
  `date_to` (string), `limit` (number). Returns `id, song_id, snippet_id,
  started_at, ended_at, settings, summary` + `song_title`, `song_artist`,
  `snippet_title`, newest first. Returns a plain array (no envelope).
- **`get_sam_passes`** — params `song_id`, `snippet_id`, `date_from`, `date_to`
  (string); `whole_song_only`, `exclude_zero_note`, `only_zero_note` (boolean);
  `limit`. Returns every column except `user_id`/`created_at`, plus
  `song_title`, `song_artist`, `range_title` ("Whole song" when `snippet_id` is
  null), newest first, wrapped with `limit_applied` / `truncated`.

No MCP tool writes `sam_passes` or `sam_sessions`.

## A8. What makes a per-day checklist awkward

- **Ids:** `song_id` is NOT NULL, so every pass has a song. `snippet_id` NULL
  always means "whole song", never "unknown". Passes on unsaved ranges or
  before the song has an id are dropped, not written.
- **Item identity:** a snippet is start + end + rest measures + `handMode`
  (`snippetsApi.js:44-60`). Same bars RH-only is a different `snippet_id`. A
  saved m1–end snippet is not a whole-song pass. Whole-song passes never count
  toward snippets and vice versa.
- **Snippet deletes** fail when passes exist (no ON DELETE on `snippet_id`);
  archiving is the app's path.
- **Two tempo fields:** `bpm` = the tempo box; `effective_bpm` = what was heard.
  Speed is only adjustable on audio songs (others write 100). Pre-07:01-PT-09-16
  rows have NULL speed → NULL `effective_bpm`. Both are finish-line values; no
  starting tempo is recorded.
- **No per-snippet tempo.** A per-item target tempo has nowhere to come from
  today.
- **Accuracy has three states:** real value; NULL because nothing was played;
  NULL because never recorded. A minimum-accuracy rule must decide on NULL.
- **`notes_played` is narrower than its comment says.** It counts only notes on
  scored chords. Chords with no nearby beat (`result: "none"`) and all-wrong
  chords (left pending, later timed out as misses with `played: []`) are not
  counted. A pass of only wrong notes reads `notes_played: 0` → NULL accuracy,
  not 0%.
- **Pause/resume splits a pass.** Pause calls `endSession`; Resume starts a new
  `sam_sessions` row and resets the playthrough counters. The pass stays armed,
  but its hits/misses/notes cover only the part after the last resume, and its
  `session_id` is the newer session.
- **Partials differ by place.** `handleChord` adds partials to on-screen Hits
  (`SamPlayer.jsx:448-452`); `accuracyOf` and the pass row exclude them.
- **Empty input:** session accuracy reads 0, pass accuracy reads NULL. Only
  `summary.midi.everConnected` says whether a session's number means anything.
- **Timezone:** "today" is Pacific in the client; server-side or MCP day
  boundaries need the same conversion.
- **Loop-count reset:** a mid-play setting change restarts ScrollEngine's loop
  counter at 0 (1, 2, 3, 0, 1). `lastLoopCountRef` keeps pass counting correct.
- **Fetching:** `usePassCounts` fetches only 48h for the one open song/snippet.
  No query today returns all of today's passes across songs.
- **See B8:** `get_sam_passes` currently returns nothing at all.

---

# Part B — Difficulty analyzer: context refresh before the Supabase port

## B1. Where we stopped

### Branches and working tree

- `main` = `origin/main` at `de0cb95`. Clean; no untracked or uncommitted files.
- `phase-2-simplifier` (`6c9fcc9`, 2026-08-14) is **fully merged** (ancestor of
  main; main is 122 commits ahead). Safe to delete.
- No stashes, no other worktrees.

### Phase 2 (simplifier)

- Code complete through M7; M1–M6 ticked in
  `docs/history/progress-sam-simplifier.md`.
- M7's human boxes are unticked ("imports it", "plays it", "verdict"). Status
  line: "M7 handed over — awaiting the human verdict".
- The database suggests the import happened: `f6db4cdc` "Someone Like You
  (melody only · quarter chords)", `json_import`, 2026-08-14, carries the
  parent's `source_xml_path`, has snippets from 08-17/08-18.
- Work went past M7: `38e2ac8` (08-17) added plans + exports for The
  Entertainer (eighth and quarter), Say It Ain't So and The Scientist, plus
  `regression.js` / `report.js` changes.

### Phase 6 (diff overlay)

**M2 is built** (`e3e23a1`, "Phase 6 M2: full ghost layer, both hands", 08-14).

- Ghost layer: whole song, both hands, isolated `<g>`, bare noteheads, halo for
  coincident notes.
- Opacity control: range slider 0.05–1, default 0.28 (`ghostOpacity`,
  `SamPlayer.jsx:70`; control at `SamPlayer.jsx:1247-1261`).
- Per-hand toggles: Both / RH / LH (`ghostHands`).
- Mode toggle: "Diff" button, shown only when `parentSong` exists.
- Still open: M2's human screenshots and verdict; M3 annotations and M4
  two-voice not started. Doc status: "M2 built, awaiting screenshots"
  (`docs/history/progress-diff-overlay.md`).

### Other changes since 2026-08-17

| Area | Change |
|---|---|
| SAM, 08-27 | Duplicate-note work (`7051a81`): parser dedupe, browser-console repair script `scripts/sam-repair-duplicates.js`, vendor copies synced |
| SAM, 09-10 → 09-16 | Whole-song repeat, rest default 0, playthrough accuracy, pass counter (`sam_passes`, 09-14), session tempo/MIDI metadata, pass `playback_speed`/accuracy columns (09-16), UI tidy-ups |
| SAM data | New songs: Clementi, Minuet in G, Autumn Leaves, three MCP-authored Autumn Leaves drills. Pastorale tempo now 65 (`updated_at` 09-16) |
| Non-SAM | Notifications (a lot), DJ, Ken, search, tags project, collections history |
| Docs, 09-14 | `a783a4e` moved project docs into `docs/history/`, including the unfinished Phase 2/6 progress files and `song-export-format.md` (the export doc has since been moved back to `docs/`; see B8) |

## B2. Current code

### tools/sam-tools/lib/analyze.js (full)

```js
// Song difficulty analysis — pure, read-only.
//
// Reads an exported song document (docs/song-export-format.md) and produces a
// per-measure digest plus whole-song structure findings. No I/O, no database,
// no mutation of the input.
//
// Two rules this file exists to respect:
//
//   1. Beat position is IMPLIED, never stored. A voice event knows its
//      duration, not its onset; onsets come from walking the array and
//      accumulating. Every accumulation goes through durations.js so tuplets
//      scale correctly — `duration` is the DISPLAY token, and a triplet eighth
//      stored as "8" sounds for a third of a beat, not half.
//
//   2. Key comes from `fifths`, never from the `key` label. The label is
//      derived through a major-only table, so a piece in A minor reports
//      "C major". See the format spec §6.
//
// Deliberately NOT implemented: hand independence. The old spec called for it;
// it scored a known-easy piece at 75% and a known-hard one at 15% — backwards
// from how they actually play. Do not re-add it without a metric that survives
// that test.

import { measureBeats, sumEvents } from "./durations.js";

// A measure is flagged when it EXCEEDS any threshold. Single source so nothing
// drifts into a scattered literal.
//
// CALIBRATED (Phase 1.5) against four real pieces at the player's working
// tempos, not against a general notion of difficulty:
//
//   La Candeur @60, Arabesque @60, Pastorale @60 — each learned in about a
//   week. These define the comfortable band.
//   Someone Like You @67 — six months to get through 20 measures.
//
// The lines sit just above the hardest thing in the comfortable band, so a
// flag means "at or past the edge of what I can currently sight-learn", NOT
// "hard in general". Re-tune only against real pieces with a known learning
// cost; a threshold justified by theory rather than by a piece someone
// actually sat down and learned is worthless here.
//
// A SMALL NUMBER OF FLAGS ON THE EASY PIECES IS CORRECT. Zero flags would mean
// the line sits above everything the player has ever played, which makes the
// tool useless for pointing at individual measures. Do not tune toward zero.
//
// rhStretch is a deliberate BACKSTOP, not a working rule — rhStack is what
// discriminates. On the calibration corpus the two fired on identical
// measures, i.e. they were one rule counted twice; rhStretch is now parked
// high enough to catch only a genuinely unreasonable reach.
export const THRESHOLDS = {
  notesPerSecond: 5,
  lhNotesPerBeat: 3,
  rhStack: 2,
  rhStretch: 9,
  rhythmVariety: 3,
};

// Short codes used in the flags column, paired with the metric they gate.
const FLAG_SPECS = [
  { code: "NS", metric: "notesPerSecond", limit: THRESHOLDS.notesPerSecond },
  { code: "LH", metric: "lhNotesPerBeat", limit: THRESHOLDS.lhNotesPerBeat },
  { code: "STK", metric: "rhStack", limit: THRESHOLDS.rhStack },
  { code: "STR", metric: "rhStretch", limit: THRESHOLDS.rhStretch },
  { code: "VAR", metric: "rhythmVariety", limit: THRESHOLDS.rhythmVariety },
];

const isRest = (e) => !e || !Array.isArray(e.notes) || e.notes.length === 0;
const midis = (e) => e.notes.map((n) => n.midi);
const topOf = (e) => Math.max(...midis(e));
const bottomOf = (e) => Math.min(...midis(e));

/** Sounded beats for one event — tuplet-scaled. Never reads `duration` raw. */
const eventBeats = (e) => sumEvents([e]) ?? 0;

/**
 * Walk one hand, accumulating onsets. Returns every sounding event with the
 * beat it starts on, plus the rests skipped along the way.
 */
function withOnsets(events) {
  const out = [];
  let beat = 0;
  (events || []).forEach((e, index) => {
    out.push({ event: e, index, onset: beat, rest: isRest(e) });
    beat += eventBeats(e);
  });
  return out;
}

/** Diatonic pitch classes for a key signature, or null when unknown. */
export function scalePitchClasses(fifths) {
  if (!Number.isInteger(fifths)) return null;
  // A key and its relative minor share a collection, so the (unreliable) mode
  // is irrelevant — derive from the major tonic and be done.
  const tonic = (((7 * fifths) % 12) + 12) % 12;
  return new Set([0, 2, 4, 5, 7, 9, 11].map((i) => (tonic + i) % 12));
}

function handMetrics(events, hand) {
  const walked = withOnsets(events).filter((w) => !w.rest);
  let stack = 0;
  let stretch = 0;
  let jump = 0;
  let prev = null;

  for (const { event } of walked) {
    stack = Math.max(stack, event.notes.length);
    stretch = Math.max(stretch, topOf(event) - bottomOf(event));
    // Melodic motion is tracked on the voice a listener follows: the top of
    // the RH, the bottom of the LH. Rests do not break the chain.
    const line = hand === "rh" ? topOf(event) : bottomOf(event);
    if (prev !== null) jump = Math.max(jump, Math.abs(line - prev));
    prev = line;
  }

  return { onsets: walked.length, stack, stretch, jump };
}

function analyzeMeasure(measure, index, { bpm, scale }) {
  const beats = measureBeats(measure.timeSignature) ?? 0;
  const seconds = beats > 0 ? (beats * 60) / bpm : 0;

  const rh = handMetrics(measure.rh, "rh");
  const lh = handMetrics(measure.lh, "lh");

  // Distinct duration tokens PER HAND, reported as the max of the two.
  //
  // Pooling both hands was wrong. Quantizing an LH of sixteen 16ths down to
  // four quarters genuinely reduces rhythmic complexity, but the pooled count
  // RISES if `q` is a token that bar did not already contain — so the metric
  // punished the transform for simplifying. What a player actually deals with
  // is the vocabulary in one hand at a time: four LH quarters against eight RH
  // eighths is two values per hand, not two pooled.
  const varietyOf = (events) => {
    const t = new Set();
    for (const e of events || []) if (e?.duration) t.add(e.duration);
    return t.size;
  };

  // Accidentals: note occurrences outside the key, not distinct classes — six
  // chromatic notes are harder than one repeated six times.
  let accidentals = null;
  if (scale) {
    accidentals = 0;
    for (const e of [...(measure.rh || []), ...(measure.lh || [])]) {
      if (isRest(e)) continue;
      for (const n of e.notes) {
        if (!scale.has(((n.midi % 12) + 12) % 12)) accidentals++;
      }
    }
  }

  const m = {
    number: measure.number ?? index + 1,
    sourceMeasure: measure.sourceMeasure ?? null,
    beats,
    seconds,
    notesPerSecond: seconds > 0 ? (rh.onsets + lh.onsets) / seconds : 0,
    rhNotesPerBeat: beats > 0 ? rh.onsets / beats : 0,
    lhNotesPerBeat: beats > 0 ? lh.onsets / beats : 0,
    rhStack: rh.stack,
    lhStack: lh.stack,
    rhStretch: rh.stretch,
    lhStretch: lh.stretch,
    rhJump: rh.jump,
    lhJump: lh.jump,
    rhythmVariety: Math.max(varietyOf(measure.rh), varietyOf(measure.lh)),
    accidentals,
  };
  m.flags = FLAG_SPECS.filter((f) => m[f.metric] > f.limit).map((f) => f.code);
  return m;
}

// --- whole-song structure -------------------------------------------------

/**
 * Printed-number discontinuity marks a seam. Playback order is flattened, so a
 * repeat is written out; when `sourceMeasure` jumps, the score went somewhere
 * else (repeat, volta, D.S., coda). Returns a Set of measure indices that START
 * a seam. Empty when the document carries no printed numbers to compare.
 */
export function findSeams(measures) {
  const seams = new Set();
  const num = (m) => {
    const raw = m?.sourceMeasure;
    if (raw == null) return null;
    const parsed = parseInt(String(raw), 10);
    return Number.isNaN(parsed) ? null : parsed;
  };
  for (let i = 1; i < measures.length; i++) {
    const prev = num(measures[i - 1]);
    const cur = num(measures[i]);
    if (prev == null || cur == null) continue;
    if (cur !== prev + 1) seams.add(i);
  }
  return seams;
}

/**
 * Tie chains per hand. A chain opens on `start`/`both` and closes on
 * `end`/`both`, matched by pitch within the same hand.
 *
 * An unmatched END is not automatically corruption: at a seam the note it
 * continued from lives in a measure the flattening skipped. Those are labelled
 * `seam`; the rest are `orphan`.
 */
export function analyzeTies(measures, seams) {
  const crossings = [];
  const unmatchedEnds = [];
  const unclosedStarts = [];

  for (const hand of ["rh", "lh"]) {
    const open = new Map(); // midi -> {measureIndex}
    measures.forEach((measure, mi) => {
      (measure[hand] || []).forEach((e, ei) => {
        if (isRest(e)) return;
        for (const n of e.notes) {
          const tie = n.tie;
          if (tie === "end" || tie === "both") {
            const started = open.get(n.midi);
            if (started === undefined) {
              const atSeam = seams.has(mi);
              unmatchedEnds.push({
                hand, measure: measure.number ?? mi + 1, eventIndex: ei,
                midi: n.midi, kind: atSeam ? "seam" : "orphan",
              });
            } else {
              if (started.measureIndex !== mi) {
                crossings.push({
                  hand, midi: n.midi,
                  from: measures[started.measureIndex].number ?? started.measureIndex + 1,
                  to: measure.number ?? mi + 1,
                });
              }
              open.delete(n.midi);
            }
          }
          if (tie === "start" || tie === "both") {
            open.set(n.midi, { measureIndex: mi });
          }
        }
      });
    });
    for (const [midi, started] of open) {
      unclosedStarts.push({
        hand, midi,
        measure: measures[started.measureIndex].number ?? started.measureIndex + 1,
      });
    }
  }
  return { crossings, unmatchedEnds, unclosedStarts };
}

/** Runs of consecutive tuplet events within one hand of one measure. */
function analyzeTuplets(measures) {
  const groups = [];
  measures.forEach((measure, mi) => {
    for (const hand of ["rh", "lh"]) {
      const walked = withOnsets(measure[hand]);
      let run = null;
      for (const w of walked) {
        const t = w.event?.tuplet;
        if (t) {
          if (!run) {
            run = {
              hand, measure: measure.number ?? mi + 1, startBeat: w.onset,
              actual: t.actual, normal: t.normal, length: 0,
            };
          }
          run.length++;
        } else if (run) {
          groups.push(run);
          run = null;
        }
      }
      if (run) groups.push(run);
    }
  });
  return groups;
}

/**
 * Melody blips — voice-merge artefacts. The RH top note is normally the tune;
 * where a merged inner voice briefly sits above it, the top line dips sharply
 * and returns. Flag them so a simplifier can avoid treating the dip as melody.
 * Detection only; never repaired.
 */
const BLIP_DROP_SEMITONES = 5;

export function analyzeMelodyBlips(measures) {
  // One continuous RH stream — a blip can straddle a barline.
  const stream = [];
  measures.forEach((measure, mi) => {
    (measure.rh || []).forEach((e, ei) => {
      if (isRest(e)) return;
      stream.push({ top: topOf(e), measure: measure.number ?? mi + 1, eventIndex: ei });
    });
  });

  const blips = [];
  for (let i = 1; i < stream.length - 1; i++) {
    const drop = Math.min(stream[i - 1].top, stream[i + 1].top) - stream[i].top;
    if (drop >= BLIP_DROP_SEMITONES) {
      blips.push({
        measure: stream[i].measure, eventIndex: stream[i].eventIndex,
        top: stream[i].top, drop,
      });
    }
  }
  return blips;
}

// --- summary --------------------------------------------------------------

/** Linear-interpolated quantile over an unsorted numeric array. */
export function quantile(values, p) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const pos = (v.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

export const SUMMARY_METRICS = [
  ["notes/sec", "notesPerSecond"],
  ["LH notes/beat", "lhNotesPerBeat"],
  ["RH notes/beat", "rhNotesPerBeat"],
  ["RH stack", "rhStack"],
  ["LH stack", "lhStack"],
  ["RH stretch", "rhStretch"],
  ["LH stretch", "lhStretch"],
  ["RH jump", "rhJump"],
  ["LH jump", "lhJump"],
  ["rhythm variety", "rhythmVariety"],
  ["accidentals", "accidentals"],
];

/**
 * @param {object} doc - parsed export document
 * @param {{bpm: number}} opts - target tempo in quarter notes per minute
 */
export function analyzeSong(doc, { bpm }) {
  if (!doc || !Array.isArray(doc.measures)) {
    throw new Error("Not a SAM export document: no `measures` array.");
  }
  if (!(bpm > 0)) throw new Error("A positive --bpm is required.");

  const scale = scalePitchClasses(doc.fifths);
  const measures = doc.measures.map((m, i) => analyzeMeasure(m, i, { bpm, scale }));
  const seams = findSeams(doc.measures);

  const summary = {};
  for (const [, key] of SUMMARY_METRICS) {
    const values = measures.map((m) => m[key]).filter((x) => x != null);
    summary[key] = {
      median: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      max: values.length ? Math.max(...values) : null,
    };
  }

  return {
    title: doc.title ?? "(untitled)",
    artist: doc.artist ?? null,
    key: doc.key ?? null,
    fifths: Number.isInteger(doc.fifths) ? doc.fifths : null,
    bpm,
    measureCount: measures.length,
    measures,
    summary,
    flagged: measures.filter((m) => m.flags.length > 0).map((m) => m.number),
    seams: [...seams].map((i) => doc.measures[i]?.number ?? i + 1),
    ties: analyzeTies(doc.measures, seams),
    tuplets: analyzeTuplets(doc.measures),
    blips: analyzeMelodyBlips(doc.measures),
  };
}
```

### tools/sam-tools/lib/durations.js (full)

```js
// Duration vocabulary — the single source of truth for token <-> beats.
// Beats are in quarter-note units.

const BASE = {
  w: 4, h: 2, q: 1, 8: 0.5, 16: 0.25, 32: 0.125, 64: 0.0625,
};

/**
 * Parse a VexFlow-style duration token into beats.
 * Dots are a 'd' suffix, repeatable: "q" = 1, "qd" = 1.5, "qdd" = 1.75.
 * Returns null for tokens outside the vocabulary.
 */
export function tokenToBeats(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  let dots = 0;
  let base = token;
  while (base.endsWith("d")) {
    dots += 1;
    base = base.slice(0, -1);
  }
  const b = BASE[base];
  if (b === undefined) return null;
  // Each dot adds half of the previous increment: b * (2 - 2^-dots)
  let total = b;
  let add = b;
  for (let i = 0; i < dots; i++) {
    add /= 2;
    total += add;
  }
  return total;
}

/** Every representable token, ascending by beats. */
export const ALL_TOKENS = (() => {
  const out = [];
  for (const base of Object.keys(BASE)) {
    for (const dots of ["", "d", "dd"]) out.push(base + dots);
  }
  return out.sort((a, b) => tokenToBeats(a) - tokenToBeats(b));
})();

/** Exact single-token match for a beat value, or null. */
export function beatsToToken(beats) {
  for (const t of ALL_TOKENS) {
    if (Math.abs(tokenToBeats(t) - beats) < 1e-9) return t;
  }
  return null;
}

/**
 * Decompose a beat value into a minimal sequence of representable tokens
 * (largest-first, greedy). Returns null if it cannot be expressed exactly —
 * which for the standard vocabulary only happens below a 64th.
 */
export function beatsToTokens(beats) {
  const out = [];
  let remaining = beats;
  const desc = [...ALL_TOKENS].reverse();
  let guard = 0;
  while (remaining > 1e-9 && guard++ < 64) {
    const t = desc.find((tok) => tokenToBeats(tok) <= remaining + 1e-9);
    if (!t) return null;
    out.push(t);
    remaining -= tokenToBeats(t);
  }
  return remaining > 1e-9 ? null : out;
}

/** Measure length in quarter-note beats for a {beats, beatType} signature. */
export function measureBeats(timeSignature) {
  if (!timeSignature) return null;
  const { beats, beatType } = timeSignature;
  if (!beats || !beatType) return null;
  return (beats * 4) / beatType;
}

/**
 * Sum an array of SAM voice events ({duration, tuplet?}) in beats.
 * Returns null if any token is unknown.
 *
 * Tuplet-aware: MusicXML <duration> is already sounded (tuplet-scaled) time,
 * but the SAM vocabulary can't represent 1/3-of-a-beat exactly, so the parser
 * stores the DISPLAY token ("8" for a triplet-eighth) plus a tuplet marker
 * `{actual, normal}`. Sounded beats for such an event = tokenToBeats * normal /
 * actual. Per spec §4.2: "Beat math multiplies by `normal/actual`."
 * A caller doing beat math should not have to re-implement this.
 */
export function sumEvents(events) {
  let total = 0;
  for (const e of events || []) {
    const b = tokenToBeats(e.duration);
    if (b === null) return null;
    total += e.tuplet ? (b * e.tuplet.normal) / e.tuplet.actual : b;
  }
  return total;
}

export const isKnownToken = (t) => tokenToBeats(t) !== null;
```

### tools/sam-tools/bin/analyze.js (full)

```js
#!/usr/bin/env node
//
// Read-only difficulty digest for an exported SAM song.
//
//   npm run analyze -- path/to/song.json --bpm 60
//   node bin/analyze.js path/to/song.json --bpm 60
//
// Reads one file, prints plain text to stdout, writes nothing and touches no
// network or database. Output is sized to be pasted into a conversation: one
// line per measure, ~100 lines for an 82-measure song.

import fs from "node:fs";
import path from "node:path";
import { analyzeSong, THRESHOLDS } from "../lib/analyze.js";

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node bin/analyze.js <song.json> --bpm <n>\n\n" +
      "  --bpm is REQUIRED and is quarter notes per minute. It is deliberately\n" +
      "  not read from the document: stored tempos are unreliable (see\n" +
      "  docs/song-export-format.md §7)."
  );
  process.exit(1);
}

const args = process.argv.slice(2);
let file = null;
let bpm = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--bpm") bpm = Number(args[++i]);
  else if (args[i].startsWith("--")) usage(`unknown option ${args[i]}`);
  else if (file === null) file = args[i];
  else usage("more than one input file");
}
if (!file) usage("no input file");
if (!(bpm > 0)) usage("--bpm <n> is required");
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

let doc;
try {
  doc = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  usage(`could not parse JSON: ${e.message}`);
}

let r;
try {
  r = analyzeSong(doc, { bpm });
} catch (e) {
  usage(e.message);
}

// --- formatting -----------------------------------------------------------

const n1 = (x) => (x == null ? "-" : x.toFixed(1));
const n2 = (x) => (x == null ? "-" : x.toFixed(2));
const int = (x) => (x == null ? "-" : String(x));
const pad = (s, w) => String(s).padStart(w);

const keyLabel = r.fifths == null
  ? `${r.key ?? "unknown key"} (fifths unknown)`
  : `${r.key ?? "?"} (fifths ${r.fifths})`;

console.log(`SAM difficulty digest — "${r.title}"${r.artist ? ` — ${r.artist}` : ""}`);
console.log(`  ${path.basename(file)} · ${r.measureCount} measures · ${keyLabel}`);
console.log(`  target tempo ${r.bpm} BPM (quarter = ${r.bpm}); document defaultBpm ignored by design`);
console.log(
  `  flag if  n/s>${THRESHOLDS.notesPerSecond}  LH/b>${THRESHOLDS.lhNotesPerBeat}  ` +
    `RHstk>${THRESHOLDS.rhStack}  RHstr>${THRESHOLDS.rhStretch}  var>${THRESHOLDS.rhythmVariety}`
);
// One width table drives the header, the measure rows and the summary rows, so
// the three can never drift out of alignment.
const COLS = [
  ["meas", 4], ["n/s", 6], ["LH/b", 6], ["RH/b", 6],
  ["stkRL", 7], ["strRL", 9], ["jmpRL", 9], ["var", 5], ["acc", 5],
];
const row = (cells) =>
  cells.map((c, i) => pad(c, COLS[i][1])).join("").trimEnd();

console.log("");
console.log(row(COLS.map(([label]) => label)) + "  flags");

for (const m of r.measures) {
  const line =
    row([
      m.number,
      n1(m.notesPerSecond),
      n2(m.lhNotesPerBeat),
      n2(m.rhNotesPerBeat),
      `${m.rhStack}/${m.lhStack}`,
      `${m.rhStretch}/${m.lhStretch}`,
      `${m.rhJump}/${m.lhJump}`,
      m.rhythmVariety,
      int(m.accidentals),
    ]) + (m.flags.length ? "  " + m.flags.join(",") : "");
  console.log(line.trimEnd());
}

// Summary mirrors the measure columns so the eye can compare a row above with
// a row below without re-reading a second layout.
console.log("");
console.log(row(COLS.map(([label]) => label)));
// Drop a trailing .0 so the paired columns stay narrow enough to align.
const cmp = (x) => (x == null ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));
for (const [label, stat] of [["med", "median"], ["p90", "p90"], ["max", "max"]]) {
  const v = (key) => r.summary[key][stat];
  const pair = (a, b) => `${cmp(v(a))}/${cmp(v(b))}`;
  console.log(
    row([
      label,
      n1(v("notesPerSecond")),
      n2(v("lhNotesPerBeat")),
      n2(v("rhNotesPerBeat")),
      pair("rhStack", "lhStack"),
      pair("rhStretch", "lhStretch"),
      pair("rhJump", "lhJump"),
      cmp(v("rhythmVariety")),
      cmp(v("accidentals")),
    ])
  );
}

console.log("");
const pct = r.measureCount ? Math.round((r.flagged.length / r.measureCount) * 100) : 0;
const shown = r.flagged.slice(0, 24);
console.log(
  `flagged ${r.flagged.length}/${r.measureCount} (${pct}%)` +
    (r.flagged.length
      ? ` — m${shown.join(", m")}${r.flagged.length > shown.length ? `, +${r.flagged.length - shown.length} more` : ""}`
      : "")
);

const { crossings, unmatchedEnds, unclosedStarts } = r.ties;
const seamEnds = unmatchedEnds.filter((t) => t.kind === "seam");
const orphanEnds = unmatchedEnds.filter((t) => t.kind === "orphan");
console.log(
  `ties crossing barline: ${crossings.length} · unmatched ends: ${unmatchedEnds.length} ` +
    `(${seamEnds.length} at seam, ${orphanEnds.length} orphan) · unclosed starts: ${unclosedStarts.length}`
);
if (orphanEnds.length) {
  const o = orphanEnds.slice(0, 8).map((t) => `${t.hand} m${t.measure}`);
  console.log(`  orphan ends: ${o.join(", ")}${orphanEnds.length > 8 ? ", …" : ""}`);
}

const tupletMeasures = [...new Set(r.tuplets.map((t) => t.measure))];
console.log(
  `tuplet groups: ${r.tuplets.length} across ${tupletMeasures.length} measure(s)` +
    (r.tuplets.length
      ? ` — ${r.tuplets.slice(0, 6).map((t) => `${t.hand} m${t.measure}@b${t.startBeat.toFixed(2)} ×${t.length} (${t.actual}:${t.normal})`).join(", ")}${r.tuplets.length > 6 ? ", …" : ""}`
      : "")
);
console.log(
  `melody blips: ${r.blips.length}` +
    (r.blips.length
      ? ` — ${r.blips.slice(0, 8).map((b) => `m${b.measure}[${b.eventIndex}] -${b.drop}st`).join(", ")}${r.blips.length > 8 ? ", …" : ""}`
      : "")
);
console.log(`seams (printed-number jumps): ${r.seams.length ? "m" + r.seams.join(", m") : "none"}`);
```

### docs/song-export-format.md (full)

Note: this is the text as it stood on 2026-09-16, before the goal-tempo fields were added. The file was briefly under `docs/history/` and has been moved back to `docs/` (see B8).

````markdown
# SAM song export format

The JSON produced by the Export button in SAM (`buildSongExport` in
[`src/sam/lib/songExport.js`](../src/sam/lib/songExport.js)) and consumed by the
JSON import path (`commitImport` in
[`src/sam/components/SongLoader.jsx`](../src/sam/components/SongLoader.jsx)).

It is intended to be a **complete representation of a song** — everything needed
to reconstruct it exactly, with nothing left only in the database. Anything
missing here is silently lost on every generated version.

Structure is enforced by [`sam-drill-format.schema.json`](../sam-drill-format.schema.json)
at the repo root, which is the machine-readable authority; this document
explains it and records the conventions the schema cannot express.

**Version 2** — `formatVersion: 2`. Version 1 is the original unversioned export
carrying only `title`, `artist`, `defaultBpm`, `measures`; a document with no
`formatVersion` key is v1 and still imports.

---

## 1. Null conventions — read this before anything else

The format is **not** uniformly "null for absent". There are two conventions and
they apply at different levels:

| Level | Convention |
|---|---|
| **Song-level scalars** | Always present. A song without the value emits `null`, never omits the key. |
| **`lyrics` / `fingerings`** | Always present. A song with none emits `[]` — zero rows is a fact, not an absent field. |
| **`measures[].audioOffsetMs`** | Always present, `null` included. Deliberately forced, because the stored blob omits it when null. |
| **Other measure keys** (`chord`, `section`, `sourceMeasure`) | **Absent when the song has no value**, following the stored blob's convention. Do not distinguish "absent" from "null" for these — treat a missing key as null. |

The asymmetry is real and load-bearing: `audioOffsetMs` is forced present so a
reader can tell "this measure has no offset" from "this exporter was too old to
know about offsets". The other measure keys were left on the blob convention
because changing them would have reshaped existing data.

A consumer should read every measure-level optional as `m.chord ?? null`.

---

## 2. Song level

| Field | Type | Notes |
|---|---|---|
| `formatVersion` | `integer` | `2`. Absent ⇒ v1. |
| `title` | `string` | Required, non-empty. |
| `artist` | `string \| null` | |
| `defaultBpm` | `number` | Quarter-note BPM. Always present from the Export button (falls back to the live transport BPM). **Unreliable as a performance tempo** — see §7. |
| `key` | `string \| null` | Display label, e.g. `"A major"`. **The mode is not trustworthy** — see §6. |
| `fifths` | `integer \| null` | MusicXML `<fifths>`, −7…7. The authoritative key signature. |
| `timeSignature` | `string \| null` | Song-level default, `"N/M"`. Per-measure `timeSignature` overrides it. |
| `sourceXmlPath` | `string \| null` | Path in the `sam-scores` Storage bucket. Exported and inherited on import, but only a MusicXML upload creates one. |
| `songType` | `"original" \| "simplified" \| "drill" \| null` | `null` means `original`. |
| `parentSongId` | `uuid string \| null` | Required when `songType` is `simplified`. |
| `difficultyTier` | `integer 1..9 \| null` | Only meaningful for `simplified`; DB constraint forces null otherwise. |
| `generationNotes` | `object \| null` | Free-form receipt. Never source for a build step. |
| `lyrics` | `Lyric[]` | See §4. |
| `fingerings` | `Fingering[]` | See §5. |
| `measures` | `Measure[]` | At least one. See §3. |

---

## 3. Measure

| Field | Type | Notes |
|---|---|---|
| `number` | `integer \| null` | 1-based position in `measures`. |
| `timeSignature` | `TimeSignature` | **Required.** |
| `rh`, `lh` | `VoiceEvent[]` | Required. `[]` is a legitimately silent hand. |
| `audioOffsetMs` | `number \| null` | Always present. Milliseconds into the backing track where this measure begins. |
| `chord` | `string` | Absent when none. Chord symbol, e.g. `"C#m/G#"`. |
| `section` | `string` | Absent when none. |
| `sourceMeasure` | `string` | Absent when none. The **printed** measure number from the source `<measure number>` attribute. TEXT, not a number: MuseScore emits `X1`…`X4` for ending brackets and other editions use `12a`/`12b`. |

`sourceMeasure` is how you detect structure. Playback order is *flattened* — a
repeat is written out — so a **discontinuity in `sourceMeasure` marks a seam**
(a repeat jump, volta, D.S. or coda). La Candeur is 38 measures flattened from
23 printed.

### TimeSignature

| Field | Type | Notes |
|---|---|---|
| `beats` | `integer ≥ 1` | |
| `beatType` | `1 \| 2 \| 4 \| 8 \| 16 \| 32` | |
| `symbol` | `"common" \| "cut"` | Absent when the signature is printed as numerals. Purely presentational — `4/4` and `common` sound identical. |

Measure length in quarter-note beats is `(beats * 4) / beatType`. Use
`measureBeats()` from `durations.js`; do not recompute it.

### VoiceEvent

One rhythmic position in one hand. **Simultaneity is the `notes` array, not
separate events.**

| Field | Type | Notes |
|---|---|---|
| `duration` | `string` | VexFlow token: `w h q 8 16 32` plus one `d` per augmentation dot (`qd`, `8d`, `qdd`). |
| `notes` | `Note[]` | Simultaneous pitches. **`[]` means a rest.** |
| `tuplet` | `{actual, normal, position?}` | Absent for normal events. See below. |

`lyric` **must not appear** on a voice event. The schema rejects it, and
`recompileMeasures` strips inline lyrics and re-injects them from
`sam_song_lyrics`, so an authored one would vanish on first recompile. Lyrics
live at the top level (§4).

**Duration is the DISPLAY token, not sounded time.** For a tuplet event, sounded
beats = `tokenToBeats(duration) * tuplet.normal / tuplet.actual` — a triplet
eighth is stored as `"8"` with `{actual: 3, normal: 2}` and sounds for ⅓ beat.
`sumEvents()` in `durations.js` already does this; any beat math must go through
it rather than reading `duration` directly.

`tuplet.position` (`start`/`middle`/`end`) is **optional and normally absent**.
Spec §3.3 keeps storage token-based — position is implied by a run of
consecutive tuplet events. Do not require it.

Known gap: `durations.js` understands `64`, but the schema's duration pattern
does not include it. A 64th note would fail validation.

### Note

| Field | Type | Notes |
|---|---|---|
| `midi` | `integer 0..127` | `(octave + 1) × 12 + step + alter`. C4 = 60. |
| `name` | `string` | Display spelling: `A4`, `Bb4`, `F#3`, `C-1`. |
| `tie` | `"start" \| "end" \| "both"` | Absent when untied. |

`midi` and `name` **must agree**; disagreement is a hard validation error.
`name` carries the enharmonic spelling `midi` cannot (`F#` vs `Gb`).

A tie chain may cross a measure boundary. An unmatched `end` is not necessarily
corruption — at a seam (§3) the note it continued from was in a measure the
flattening skipped.

---

## 4. Lyric

Rows of `sam_song_lyrics`, in the table's own snake_case shape.

| Field | Type | Notes |
|---|---|---|
| `word_order` | `integer` | Global syllable sequence, unique per song. **The stable identity of a syllable — carry it verbatim.** |
| `syllable` | `string` | Trailing `-` marks a word continuation. |
| `measure_num` | `integer \| null` | `null` = not yet placed. |
| `rh_index` | `integer \| null` | Index into that measure's `rh`. |

Unplaced syllables are included deliberately: they are real rows, and dropping
them would lose typed-but-unplaced work on every round trip.

Two syllables may share one `(measure_num, rh_index)`; the lyric editor permits
it and real data contains it.

---

## 5. Fingering

Rows of `sam_song_fingerings`, camelCase (this one mirrors the parser's shape,
not the table's).

| Field | Type | Notes |
|---|---|---|
| `measureNum` | `integer ≥ 1` | |
| `rhIndex` | `integer ≥ 0` | Index into that measure's `rh`. |
| `noteIndex` | `integer ≥ 0` | Which notehead in a chord, low to high. Defaults to 0. |
| `finger` | `integer 1..5` | 1 = thumb. |
| `source` | `"manual" \| "musicxml"` | Defaults to `musicxml` when absent. |

Right hand only. One coordinate may carry **both** a `manual` and a `musicxml`
row; manual wins at render, and clearing it re-reveals the imported one.

---

## 6. Key signature — use `fifths`, never `key`

`key` is a display label derived through a **major-only** table
(`KEY_NAMES` in `songParser.js`), so every song reports some `X major`
regardless of its actual mode. A piece in A minor has `fifths: 0` and is
labelled `"C major"`.

`fifths` is the real signature. To get the diatonic pitch-class set, the mode
does not matter — a key and its relative minor share the collection:

```js
const tonicPc = ((7 * fifths) % 12 + 12) % 12;          // major tonic
const scale = [0, 2, 4, 5, 7, 9, 11].map((i) => (tonicPc + i) % 12);
```

`fifths` may be `null` on documents whose label was hand-entered and could not
be inverted without guessing. Handle that rather than defaulting to 0.

---

## 7. Tempo — `defaultBpm` is not a performance tempo

Do not derive timing from `defaultBpm`. Stored tempos are unreliable: one 6/8
song stores `25`, which could mean two things a factor of five apart depending
on whether it counts dotted quarters or eighths, and the player generally works
below printed marks anyway.

Tools that need a tempo must **take one explicitly**. `tools/sam-tools`'
analyzer requires `--bpm` and prints the value it used.

BPM throughout SAM means **quarter notes per minute**, matching the
quarter-note beat unit used by `durations.js`.

---

## 8. Invariants across the version ladder

A simplified variant is a *different arrangement of the same piece*. These must
match its parent exactly, or the variant is no longer the same song and audio
sync, lyric placement and practice history stop lining up:

- **Measure count.**
- **Per-measure `timeSignature`** — including `symbol`.
- **`audioOffsetMs` on every measure**, nulls included. These are hand-aligned
  against a recording; regenerating them is not possible.
- **`sourceMeasure`** — the link back to the engraved score.

Free to change: pitches, durations, `notes` contents, `chord`, fingerings, and
anything derived from them.

`lyrics` need care rather than preservation: `word_order` and `syllable` must
survive verbatim, but `measure_num`/`rh_index` point at RH event indices that a
simplification will renumber. A variant that rewrites RH must re-place its
syllables or leave them unplaced — it must not silently point them at the wrong
notes.

---

## 9. What is NOT in the export

Not currently round-tripped; anything relying on these must read the database:

- `playback_speed`, `default_timing_window_ms`, `default_chord_ms`,
  `default_measure_width` — per-song practice settings.
- `audio_file_path` — the backing track. `audioOffsetMs` values survive but the
  track they reference does not.
- `show_imported_fingerings`, `archived`, `created_at`/`updated_at`.
- Practice history: `sam_sessions`, `sam_session_events`, `sam_snippets`.

`sourceXmlPath` is exported and written on import, but the import cannot create
the underlying Storage object — a copy inherits a path to its parent's document.
````

### tools/sam-tools/lib/simplify.js — the measure loop

Settings resolution lives in `plan.js` (next section); `simplify.js` only calls
`plan.settingsFor(number)`.

```js
export function simplifyMeasures(doc, plan) {
  const measures = [];
  const untouched = [];
  // Spec §7: two counters, deliberately separate. Only `unable` gates the
  // confirmation threshold — a density-floor refusal is the tool working, not
  // something for a human to approve.
  const unable = [];
  const unneeded = [];
  const notes = [];

  doc.measures.forEach((m, i) => {
    const number = m.number ?? i + 1;
    const settings = plan.settingsFor(number);
    const out = structuredClone(m);

    // `settings: null` means leave this measure at original difficulty.
    if (settings === null) {
      measures.push(out);
      untouched.push(number);
      return;
    }

    if (lhActive(settings)) {
      const r = quantizeHand(out.lh || [], settings, out.timeSignature);
      if (r.changed) {
        out.lh = r.events;
      } else if (r.reason) {
        // Skip-and-flag (§7): the measure stays at original difficulty and the
        // reason is recorded. Never a silent skip, never a failed run.
        const bucket = r.kind === "unneeded" ? unneeded : unable;
        bucket.push({ measure: number, hand: "lh", code: r.code, reason: r.reason });
      }
      if (r.note) notes.push({ measure: number, hand: "lh", ...r.note });
    }

    measures.push(out);
  });

  // RH thinning, song-level, writing into the clones built above.
  const rh = thinRightHand(measures, (n) => plan.settingsFor(n));

  return {
    measures,
    untouched,
    unable,
    unneeded,
    notes,
    strippedTies: rh.strippedTies,
    retainedForTies: rh.retainedForTies,
    // Reported, never corrected (§4.4, §8.1). Measured on the INPUT, because
    // that is where they can be heard and checked against the printed score.
    melodyBlips: analyzeMelodyBlips(doc.measures),
  };
}
```

### tools/sam-tools/lib/plan.js — settings resolution (lines 44–79, 302–337)

```js
/** The settings vocabulary, in spec order. */
export const SETTING_KEYS = ["lhGrid", "lhFill", "lhCap", "lhKeep", "rhStack"];

/** Which gating setting each modifier hangs off. Gating settings map to null. */
export const SETTING_PARENT = Object.freeze({
  lhGrid: null,
  rhStack: null,
  lhFill: "lhGrid",
  lhCap: "lhGrid",
  lhKeep: "lhGrid",
});

/** Spec §4 defaults. Gating settings default to their OFF value. */
export const SETTING_DEFAULTS = Object.freeze({
  lhGrid: "none",
  lhFill: "onset",
  lhCap: 2,
  lhKeep: "root-third",
  rhStack: "all",
});

/** The OFF value of each gating setting — the value that means "do nothing". */
export const GATING_OFF = Object.freeze({ lhGrid: "none", rhStack: "all" });

export function effectiveSettings(partial = {}) {
  return { ...SETTING_DEFAULTS, ...partial };
}

export const lhActive = (s) => !!s && s.lhGrid !== GATING_OFF.lhGrid;
export const rhActive = (s) => !!s && s.rhStack !== GATING_OFF.rhStack;

// ...inside loadPlan(planOrPath, { measureCount }):
  const defaultSettings = { ...plan.default };

  // Per-measure resolution. `null` means untouched; otherwise the range's
  // partial settings override the plan default key by key, and the result is
  // filled out to the full vocabulary (gating settings default to OFF).
  const perMeasure = new Array(measureCount + 1).fill(undefined);
  for (let m = 1; m <= measureCount; m++) perMeasure[m] = effectiveSettings(defaultSettings);
  for (const r of ranges) {
    for (const m of r.measures) {
      perMeasure[m] =
        r.settings === null
          ? null
          : effectiveSettings({ ...defaultSettings, ...r.settings });
    }
  }
  // ...
    settingsFor(measure) {
      if (!Number.isInteger(measure) || measure < 1 || measure > measureCount) {
        throw new PlanError(
          `measure ${measure} is outside the song (1..${measureCount})`
        );
      }
      return perMeasure[measure];
    },
```

Plan ranges are range-checked against **played** numbers (`1..measureCount`,
per the doc comment at `plan.js:215`); overlapping ranges are rejected.

### tools/sam-tools/lib/report.js — statusCounts and buildRunReport

```js
export function statusCounts(resolved = []) {
  const counts = { transformed: 0, untouched: 0, unneeded: 0, unable: 0, total: resolved.length };
  for (const r of resolved) {
    if (r.status in counts) counts[r.status]++;
  }
  return counts;
}

export function buildRunReport({ plan, analyzerTempo, result, input, output }) {
  return {
    reportVersion: 1,
    plan: plan.raw,
    analyzerTempo,
    // §7's two counters. Only `unable` gates confirmation; `unneeded` records a
    // guard that correctly declined and is never a reason to stop.
    unable: result.unable,
    unneeded: result.unneeded,
    untouched: result.untouched,
    // One entry per measure: effective settings + what actually happened.
    resolvedSettings: resolvedSettings({ plan, result, input, output }),
    // §5.1: a mixed tie chain keeps the note and loses the marker.
    strippedTies: result.strippedTies,
    retainedForTies: result.retainedForTies,
    transformNotes: result.notes,
    // §8.1 advisories — reported, never acted on.
    melodyBlips: result.melodyBlips,
    shortUntouchedRuns: shortUntouchedRuns(result.untouched),
    repeatedRanges: repeatedRanges(input.measures, plan.ranges),
    metrics: {
      before: metricsBlock(input, analyzerTempo),
      after: metricsBlock(output, analyzerTempo),
    },
  };
}
```

- `metricsBlock(doc, bpm)` calls `analyzeSong` at `analyzerTempo` and returns
  `measureCount`, `flaggedCount`, `flagged`, `summary`.
- `resolvedSettings` gives each measure one status — `untouched` (plan said
  null), `unable` (a transform refused), `transformed` (output
  `JSON.stringify` differs from input), otherwise `unneeded`.

## B3. Tempo convention — quarter = 65 (the blocking question)

### Playback clock

`src/sam/components/ScrollEngine.jsx:163-170` — one "beat" is `60000 / bpm` ms,
and pixels per beat are measure width divided by the measure's length in
**quarters**:

```js
const msPerBeat = 60000 / bpm;
const firstDurationQ = getMeasDurationQ(measures[0]);
const firstMeasWidth = getMeasureWidth(measures[0].timeSignature, false, measureWidth) * SCORE_SCALE;
const pxPerBeat = firstMeasWidth / firstDurationQ;
const pxPerMs = pxPerBeat / msPerBeat;
```

`getMeasDurationQ`, `src/sam/lib/measureUtils.js:6-19`:

```js
/**
 * Calculate measure duration in quarter-note equivalents.
 * e.g., 4/4 → 4, 3/4 → 3, 6/8 → 3, 7/8 → 3.5, 5/4 → 5
 */
export function measureDurationQ(timeSig) {
  if (!timeSig) return 4;
  return (timeSig.beats / timeSig.beatType) * 4;
}
```

- Beat positions (`beatPos`) in `src/sam/lib/scoreRender.js:566-574` are "in
  quarter-note beats".
- The synth (`durationMs: n.durationBeats * msPerBeat`, via `noteTimeline` /
  `getEventBeats`) uses the same unit, as does audio sync
  (`src/sam/lib/useAudioSync.js:48, 63, 170`).

### Metronome

`ScrollEngine.jsx:411-413` and `:616-632` — the click interval is one quarter:

```js
// First tick = approachMs % msPerBeat (so ticks land on quarter-note boundaries).
const metroStartMs = approachMs % msPerBeat;
...
let subdivisionMs = msPerBeat; // Default to beat (quarter note)
if (metronome === "halfbeat") {
  subdivisionMs = msPerBeat / 2; // Eighth note
} else if (metronome === "quarterbeat") {
  subdivisionMs = msPerBeat / 4; // Sixteenth note
}
```

No dotted-quarter option exists. In 6/8, "beat" mode clicks three times per bar
(eighths 1, 3, 5), which crosses the meter's 2-pulse feel.

### Import

The parser takes `<sound tempo>` verbatim (`src/sam/lib/songParser.js:799-802`);
MusicXML defines that attribute as quarter notes per minute. The Pastorale
fixture has **no** `<sound tempo>` and no `<metronome>`, so it imported at the
default 68 — the 65 was set by hand (`sam_songs.updated_at` 2026-09-16 13:09 UTC).

### Session durations confirm it

Pastorale: 37 played measures, all 6/8 = 3 quarters per bar.

| Session | bpm | Actual | If quarter = bpm | If dotted-quarter = bpm |
|---|---|---|---|---|
| 09-16 03:42:10.949 → 03:43:55.477 | 65 | **104.5 s** | 102.5 s | 68.3 s |
| 09-14 14:39:04.173 → 14:41:07.685 | 55 | **123.5 s** | 121.1 s | 80.7 s |

Overhead is 2.07 s at 65 and 2.42 s at 55 — about 2.2 quarters at both tempos,
which fits a lead-in measured in beats.

### Conclusion

- Tempo box, analyzer `--bpm`, `sam_passes.bpm`, and export doc §7 all mean
  quarter notes per minute. No factor-of-1.5 error exists between them.
- Compound-time songs in the library: Pastorale (6/8, 65) and Für Elise
  (3/8, 72). No song stores 25 any more (export doc §7's example is stale).
- Example: Pastorale m1 (six eighths) at quarter = 65 → bar = 2.77 s →
  2.17 notes/s. Under a dotted-quarter reading it would be 1.85 s → 3.25 n/s.
- Residual risk: if you think of Pastorale's 65 as a dotted-quarter pulse, the
  app disagrees. The calibration "Pastorale @60" was quarter = 60 if it came
  from the tempo box.
- Recent Pastorale sessions ran at bpm 60 (09-09), 55 (09-10 → 09-14), 65
  (09-15 → 09-16), all at playback speed 100.

## B4. Write paths to `sam_song_measures`

| Path | What it writes | Stamps on `sam_songs` |
|---|---|---|
| `commitImport` → `fanOutMeasures` (`src/sam/lib/measureCompiler.js:12-83`). The simplifier's output enters the DB this way, via the JSON import UI. | **Deletes every row for the song and reinserts**, so row ids change on every import. Then `recompileMeasures` if the song has lyrics. | `measures_compiled_at` and `measures_edited_at` both = now (two separate `new Date()` calls) |
| `append_sam_measures`, MCP tier 3 (`supabase/functions/_shared/tools/sam-authoring.ts:245-340`) | Inserts rows numbered from `max(number)+1`. Drops `timeSignature.symbol`; never writes `source_measure`. | `measures_edited_at` only |
| `update_sam_song_measures`, MCP tier 2 (`updateSamSongMeasures` in `tool-handlers.ts`) | `chord`, `section`, `audio_offset_ms` only — notation untouched. Sets row `updated_at` by hand. | **Nothing**, despite its "Recompilation triggered" message |
| `recompileMeasures` (`measureCompiler.js:93-186`) | **Never writes rows.** Rebuilds the `sam_songs.measures` blob from rows (strips/re-injects lyrics; `rh`/`lh` verbatim), so blob notation always equals rows. Called by lyric save, lyric auto-match, Refresh, import-with-lyrics, stale-on-open. | `measures_compiled_at` only |
| Simplifier (`tools/sam-tools/bin/simplify.js`) | JSON files on disk only (`fs.writeFileSync` at lines 269, 273). No DB access. | n/a |
| `scripts/sam-repair-duplicates.js` (browser console) | PATCHes `rh`/`lh` on rows. | `measures_edited_at` = now, `measures_compiled_at` = null |
| `scripts/backfill-measures.mjs` | One-off inserts for songs with zero rows. | Both = now |
| Song delete | Rows removed by `ON DELETE CASCADE`. | n/a |

**Not a row write, but a live bug:** `SamPlayer.handleAudioOffsetChange`
(`src/sam/SamPlayer.jsx:676-698`) writes audio offsets to the **blob only** —
never the rows, never `measures_edited_at`. The next recompile rebuilds the blob
from rows and reverts those offsets.

### Triggers — none visible; evidence points to none

- `get_database_schema` doesn't expose triggers, and no SQL in the repo creates
  one on these tables.
- One old prompt (`docs/history/cli-prompt-sam-data-layer.md:5`) *claims*
  triggers bump `updated_at` and `measures_edited_at`.
- Against that: the drills-and-lineage verification appended two measures and
  saw one `INSERT sam_song_measures` audit row per measure but **only one**
  `UPDATE sam_songs` (the tool's explicit one)
  (`docs/history/progress-sam-drills-and-lineage.md:123`). A parent-bump trigger
  on insert would have added more.
- The MCP handlers set `updated_at` by hand, suggesting no `updated_at` trigger
  either.

To settle it (SQL editor, read-only):

```sql
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relname in ('sam_songs','sam_song_measures') and not t.tgisinternal;
```

Expect the platform audit triggers. Anything else is news.

### `sam_song_measures` live schema (for reference)

`id` uuid PK · `song_id` uuid NOT NULL (FK sam_songs, ON DELETE CASCADE) ·
`number` int NOT NULL · `rh` jsonb NOT NULL default `[]` · `lh` jsonb NOT NULL
default `[]` · `time_signature` jsonb NOT NULL default `{"beats":4,"beatType":4}`
· `audio_offset_ms` int · `created_at`, `updated_at` timestamptz default now() ·
`chord` text · `section` text · `lyrics_text` text · `source_measure` text
(null = same as `number`). UNIQUE `(song_id, number)`. RLS via parent song
(`exists (select 1 from sam_songs where id = song_id and user_id = auth.uid())`).
Registered `policy_mode: none`, audited.

## B5. Patterns to reuse

### Staleness check (`src/sam/lib/measureCompiler.js:195-202`)

```js
export function isMeasuresStale(song) {
  // Both null = fresh import, not stale
  if (!song.measures_edited_at && !song.measures_compiled_at) return false;
  // edited_at set but compiled_at not = definitely stale
  if (song.measures_edited_at && !song.measures_compiled_at) return true;
  // Compare timestamps
  return new Date(song.measures_edited_at) > new Date(song.measures_compiled_at);
}
```

- Runs only in the client, on song open (`fetchSongById`,
  `src/sam/lib/songLoad.js:73`).
- Relies on every notation writer stamping `measures_edited_at`. All do today
  (B4), but it's an app-side convention, not DB-enforced.
- Timestamps are client clocks.

### New table — platform contract (live, currently CONFORMANT, 37 tables)

- End the migration with:
  ```sql
  select platform.register_table(
    'public.my_table',
    p_policy_mode => 'owner',  -- 'none' when there is no user_id column
    p_audited     => true,     -- false ONLY for high-volume append-only telemetry
    p_exempt      => false,
    p_notes       => 'App: what this table is'
  );
  ```
  Schema-qualify the name; use the `p_`-prefixed params. This enables RLS,
  creates the owner policy, issues grants, strips anon, attaches the audit
  trigger, records the table in the registry.
- `'owner'` → `user_id = auth.uid()` policy (type-aware). `'none'` for custom
  RLS or for child tables that reach ownership through a parent — then write the
  parent-scoped policy yourself, mirroring `sam_song_lyrics` /
  `sam_song_measures`.
- Add column comments (conformance checks them).
- Finish with `select platform.check_conformance();` (or
  `select public.platform_check_conformance();`) and expect `CONFORMANT`.
  Details: `select * from platform.conformance_failures;`.
- Registry and audit-log table names are schema-qualified (`public.x`).

### New tier-1 read tool

- `defineTool({ name: "get_…", tier: 1, handler })`; DB only via `ctx.db`; no
  Supabase import in the tool file.
- `clampLimit` (default 20, cap 50) with handler/zod param parity.
- Push every filter into the query before the limit; keep heavy jsonb out of
  list reads.
- Return `envelope(rows, { limit_applied, truncated })`; the wrapper emits bare
  data (and a truncation note when `truncated`).
- Operational errors must not use do-not-retry wording (reserved for guardrail
  denials).
- Register in `supabase/functions/mcp/index.ts`; deploy with
  `npx supabase functions deploy mcp --no-verify-jwt`.
- Tiers: 1 = reads / append-only / own progress (no gate); 2 = updates to
  existing rows (audited, reversible); 3 = destructive or semantically
  significant (needs `confirmed: true`).
- The `mcp-platform` skill's `register_table` example (`audited =>`,
  `exempt =>`, unqualified name) is **out of date** versus the live contract.

### Can an Edge Function import `tools/sam-tools/lib/durations.js`? No — vendor it

- Deploy bundles only `supabase/functions/**`, established when the authoring
  tools were built (`docs/history/progress-sam-drills-and-lineage.md:117`). The
  `mcp` import map (`supabase/functions/mcp/deno.json`) has no path out.
- Precedent: `supabase/functions/_shared/durations.ts` — a TS port with `BASE`,
  `tokenToBeats`, `sumEvents`, **but no `measureBeats`**. Kept honest by a
  parity test (`src/sam/lib/durations.test.js:256+`) that compares only the
  `BASE` map.
- Three JS copies exist:
  - `tools/sam-tools/lib/durations.js` — the original; `analyze.js` imports it.
  - `src/sam/lib/durations.js` — superset (adds timeline helpers); header says
    "Ported from tools/…".
  - `tools/sam-tools/vendor/durations.js` — byte-identical copy of the `src`
    one via `npm run sync`.
- `lib/` and `src/` are behaviourally identical today (one uses `find`, the
  other a `for` loop), but **no test ties `lib/durations.js` to anything**.
- `analyze.js` itself would also need porting, since it imports
  `./durations.js`.

## B6. Snippets use played measure numbers

- **Code:** `SamPlayer.activeMeasures` slices the compiled blob by array
  position — `song.measures.slice(snippet.startMeasure - 1, snippet.endMeasure)`
  (`src/sam/SamPlayer.jsx:228-230`). Blob order is row `number` order, and
  `fanOutMeasures` writes `number: i + 1`. `SnippetPanel` clamps End to
  `totalMeasures = song.measures.length` (`SnippetPanel.jsx:189-196`).
  `source_measure` is never consulted. Simplifier plans also use played numbers.
- **Data:** Pastorale has 37 played measures from 29 printed. Played m11–18
  replay printed 3–10; from m19 on, played = printed + 8. Live snippet
  `a79e8d8e` is "Measures 30-37" — printed 37 doesn't exist, so it can only be
  played numbers (printed 22–29).
- Pastorale snippets (all both-hands): 18-19, 18-20, 19-19, 23-26, 30-31,
  30-34, 30-37, 31-34 (rest 1).

**Oddities:**

- **`end_measure = 0`:** snippet `2695d3cf-a438-4ad4-92c9-f26b57f5a034`, song `4e3b2eb0-6169-42e9-aca6-6a7343f2cf71`
  (an archived "Someone Like You (Arpeggios - Accompaniment Only)"). Title says
  "Measures 27–34", `start_measure` 27, `rest_measures` 1, `settings.bpm` 68,
  created 2026-04-09 — predates the current panel's clamping.
- `sam_snippets` has **no CHECK constraints** (start ≥ 1, end ≥ start) and no
  link to measure rows.
- Many live snippets belong to **archived or old songs** — `get_sam_snippets`
  filters archived snippets, not archived songs (e.g. song "d" has a
  1–160 RH snippet).
- Pre-July snippets carry `settings.bpm`, `windowMs`, `chordGroupMs`, which
  current code ignores. Snippets without `handMode` read as "both".
- `sam_snippets.settings` column comment still says it holds bpm/timing-window
  overrides.

## B7. Known issues — current state

| Issue | State |
|---|---|
| `baseline-report.json` stale | **Confirmed, badly.** Last committed 08-05 (`f85453a`); parser changed 08-06, 08-09, 08-27. Vendor copies are in sync with `src/`. Running `validate` now: almost every class drops to 0 — Moonlight `tuplet_scaling` 88→0, `voice_collision` 68→0, `notes_unsorted` 60→0; Say It Ain't So `voice_collision` 11→0, `grace_dropped` 7→0; Pastorale `voice_collision` 5→0, `grace_dropped` 7→0, `unflattened_repeat` 1→0; Someone Like You `tuplet_scaling` 4→0, `voice_collision` 9→0. A **new class `volta_seam_tie`** appears (Entertainer 3, Someone Like You 1). Re-baselining (`npm run baseline`) was not run. |
| `recurrence.manual-check.js` tests an inline copy | **Still true, and documented in the file's own header** (`src/utils/recurrence.manual-check.js`: "operates on an INLINE COPY … proves nothing about the shipped module"). Note: this is Alfred's recurrence code, not SAM. |
| `analyzeTies` keyed on midi alone | **No comment was added** (`analyze.js` line with `const open = new Map(); // midi -> {measureIndex}`). Reproduced on Say It Ain't So rh m70: event 1 holds `F4 ~start` and `F4 ~end`; the start is processed first and overwrites the open chain, the end closes it, and event 2's `F4 ~both` becomes an orphan. **Second effect:** a `start` on an already-open midi silently replaces the earlier chain, so earlier unclosed starts are never reported. |
| `lhCap`/`lhKeep` skipped when the density floor declines | **Confirmed.** `applyCap` runs only inside `quantizeHand`'s cell loop; when `out.length >= events.length` it returns the original `events` uncapped (`tools/sam-tools/lib/lhGrid.js:199-207`). `lhCap`/`lhKeep` also only apply when `lhGrid` is on (`SETTING_PARENT`). |
| The Entertainer: 3 unclosed tie starts at rh m151 | **Explained — a volta seam, not a new bug.** Played m151 is printed m87; it ends with `E4 G4 C5 ~start`, and m152 is printed **X4** (second ending) whose chord has no tie end. `validate.js` already reports exactly these pitches (64/67/72) as `volta_seam_tie`, "source-authoring choice, not a parser defect". The analyzer can't see it as a seam because `findSeams` does `parseInt("X4")` → NaN and skips the pair. The earlier printed m35→X2 chains are swallowed by the overwrite effect above. |

Analyzer runs at `--bpm 60` for reference (committed JSON exports from 08-17):

- The Entertainer: 152 measures, flagged 119 (78%); 16 ties crossing barlines;
  0 unmatched ends; 3 unclosed starts (rh m151, midi 64/67/72); 24 melody
  blips; seams m21, m53, m101, m137.
- Say It Ain't So: 160 measures, flagged 74 (46%); 67 crossings; 1 orphan end
  (rh m70, midi 65); 6 blips; no seams.
- The Scientist: no unclosed starts, no orphans.

## B8. Things that are different from what you remembered

- **Doc path.** `a783a4e` (09-14) moved `docs/song-export-format.md` into
  `docs/history/`, breaking its `../src/…` links and the path references in
  `tools/sam-tools`. **Resolved 09-16:** it has been moved back to
  `docs/song-export-format.md`, so those references are correct again. The
  unfinished Phase 2 and Phase 6 progress files are still in `docs/history/`.
- **Phase 6 M2 is built**, including opacity and per-hand toggles; only human
  verification is outstanding.
- **Phase 2 went past M7** (Entertainer, Say It Ain't So, Scientist plans,
  08-17), and the M7 output appears to be imported (`f6db4cdc`). The progress
  doc wasn't updated.
- **Settings resolution** lives in `plan.js`, not `simplify.js`.
- **Entertainer m151** is a volta-seam tie the validator already classifies.
- **Committed JSON exports are older than the data.** `entertainer.json`,
  `sayitaintso.json`, `scientist.json` (08-17) predate the 08-27 duplicate-note
  work, so they may not match the database now.
- **`get_sam_passes` returns `[]` for the whole table** (and for Pastorale
  specifically).
  - `docs/progress-pass-counter.md:639` records rows confirmed by SQL on 09-14.
  - Pastorale had full-song, unlooped sessions on 09-15 and 09-16 (213 beats
    each) that should have credited passes.
  - `get_sam_sessions` works with the same token.
  - Undiagnosed. To check whether rows exist:
    ```sql
    select count(*), count(distinct user_id), min(completed_at), max(completed_at)
    from public.sam_passes;
    ```

## B9. Flags before committing to a per-measure difficulty schema

1. **Store tempo-independent facts, not `notesPerSecond` or flags.**
   n/s = `onsets / (beats × 60 / bpm)` — linear in bpm and trivial at read time;
   the NS flag flips with tempo. Store per-hand onsets, `beats`, stack, stretch,
   jump, rhythm variety, accidentals. Derive n/s and flags against whatever tempo
   applies — prefer `sam_passes.effective_bpm` over `bpm`. Record a
   thresholds/metrics version if flags are stored at all.
2. **Key scores on `(song_id, number)`, never on a measure row `id`.**
   `fanOutMeasures` deletes and reinserts every row on import, so an FK to rows
   with cascade would silently wipe scores. `number` is also what snippets and
   plans use.
3. **Invalidation that mirrors `isMeasuresStale`.** Hang it off
   `sam_songs.measures_edited_at`. Better: store *the `measures_edited_at`
   value the score was computed from* and compare for equality, avoiding a
   comparison of two client clocks. No notation writer skips the stamp today
   (the two non-stamping paths — blob-only audio offsets and
   `update_sam_song_measures` — don't change notation). Run the trigger query
   in B4 first.
4. **Repeated measures.** Flattening duplicates printed bars (Pastorale m3–10 =
   m11–18). Per-played-measure scores are right for snippets; a whole-song
   aggregate needs a decision on whether repeats count twice. Seams with
   non-numeric labels (`X1`–`X4`) are invisible to `findSeams`.
5. **Porting the analyzer.** Add `measureBeats` to
   `supabase/functions/_shared/durations.ts`, port `analyze.js`, and extend the
   parity test to cover all three JS copies (not just `BASE`). Fix or document
   the midi-only tie keying before any tie stats reach the database.
6. **Data hygiene the practice plan will hit:** the `end_measure = 0` snippet;
   no range constraints on `sam_snippets`; snippets on archived songs; the
   empty `sam_passes` read.
7. **Compound meter UX.** Numbers are consistent, but the metronome clicks
   quarters in 6/8 and there's no dotted-quarter display. If the plan shows
   target tempos for compound-time pieces, say which note gets the beat.

## Appendix — read-only SQL to run

```sql
-- 1. Any non-audit triggers on the measure tables?
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relname in ('sam_songs','sam_song_measures') and not t.tgisinternal;

-- 2. Do sam_passes rows exist, and for whom?
select count(*), count(distinct user_id), min(completed_at), max(completed_at)
from public.sam_passes;

-- 3. Snippets with impossible ranges
select id, song_id, title, start_measure, end_measure
from public.sam_snippets
where start_measure < 1 or end_measure < start_measure;
```
