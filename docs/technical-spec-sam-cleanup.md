# SAM Cleanup — Technical Specification

## Overview

The five-milestone refactor is complete. This is a follow-up cleanup pass
addressing five specific issues surfaced during code review, plus a
constants extraction. None of these are blocking, but landing them now —
before diving into playback debugging — means the next debugging session
is against a clean codebase where "is this a real bug or refactor
artifact" has an easy answer.

## Non-goals

- No behavior changes (except #1, which fixes a latent correctness bug).
- No new features.
- No changes to the lyric storage architecture, MCP boundaries,
  Supabase schema, or any of the four already-sized components
  (`AudioControls`, `StatsBar`, `SnippetPanel`, `ScoreRenderer`).
- No changes to `useMIDI` or `usePracticeSession`.

## Issues Being Fixed

### #1 — `getSeekForMeasure` ignores anchors when `audioOffsetMs` is missing (correctness)

**File:** `lib/useAudioSync.js`

Currently, when a target measure does not have its own `audioOffsetMs`,
`getSeekForMeasure` falls back to extrapolating from measure 1's offset
using `defaultBpm`:

```js
const audioOffsetMs1 = song.measures[0]?.audioOffsetMs ?? 0;
let totalBeats = 0;
for (let i = 0; i < measNum - 1; i++) {
  totalBeats += getMeasDurationQ(song.measures[i]);
}
return audioOffsetMs1 + totalBeats * msPerBeat;
```

This ignores anchors set on intermediate measures. With anchors at
measures 1 and 17 to model a tempo drift, `getSeekForMeasure(9)` returns
a seek time based on measure-1 BPM extrapolation — which is wrong by the
cumulative drift between m.1 and m.9. ScrollEngine's
`audioMsToBeatPos` uses the same anchors for piecewise-linear
interpolation; `getSeekForMeasure` should use the inverse of that
mapping for consistency.

**Fix:** Build a `beatPos → audioMs` interpolation that mirrors
`ScrollEngine.audioMsToBeatPos`. Walk `song.measures` to compute the
target measure's `beatPos`, then map that to audio ms using anchors:

- 0 anchors → return 0
- 1 anchor → BPM-based extrapolation from that anchor (same as today
  when `audioOffsetMs1 = 0`)
- 2+ anchors → piecewise-linear: find the segment containing `beatPos`
  and linearly interpolate audioMs between the bounding anchors.
  Extrapolate beyond the last anchor using the rate of the final
  segment, and before the first anchor using the rate of the first
  segment.

If the target measure has its own `audioOffsetMs`, return that directly
(it acts as its own anchor).

Update `getSnippetAudioEndMs` similarly — it currently uses the same
BPM-based extrapolation for the end timestamp.

**Note:** `audioAnchors` is computed against `activeMeasures` (which is
already snippet-sliced), but `getSeekForMeasure` walks `song.measures`.
The anchors used for seek math need to be re-derived from
`song.measures`, not `activeMeasures`, so a snippet that doesn't start
at measure 1 still gets accurate seeks. Add a separate
`songAudioAnchors` memo derived from `song.measures` for use by the
seek functions; keep the existing `audioAnchors` memo (derived from
`activeMeasures`) for ScrollEngine consumption.

### #2 — `saveLyrics` partial-failure leaves rows/blob inconsistent (durability)

**File:** `lib/useLyricEditor.js`

Currently `saveLyrics` loops over `lyricPlacements`, firing one UPDATE
per word_order, then runs `recompileMeasures`. If any update fails
partway, you get partial saves: some rows updated, others not, then the
recompile is skipped, then the blob diverges from the rows.

**Fix:** Replace the per-row update loop with a single batch operation.
Two options:

- **Preferred:** Use `supabase.from("sam_song_lyrics").upsert(rows, {
  onConflict: "song_id,word_order" })` with all rows in one call. One
  round-trip, atomic per row at minimum. Build the upsert payload from
  `lyricPlacements` selecting only `song_id`, `word_order`,
  `measure_num`, `rh_index`. **Verify the table has a unique constraint
  on `(song_id, word_order)` before using `onConflict`** — if not,
  either add the constraint or use the fallback below.
- **Fallback:** Wrap the existing loop in a try/catch where, on any
  failure, fetch fresh placements from the DB and call
  `setLyricPlacementsState(...)` to reset the in-memory state to the
  truth of what persisted. This doesn't make the operation atomic but
  prevents the user from editing on top of a phantom in-memory state.

Either way, only call `recompileMeasures` if the batch succeeded.

### #3 — `useNumericInput.commit()` treats 0 as invalid (latent foot-gun)

**File:** `lib/useNumericInput.js`

```js
if (!n || (min != null && n < min)) {
  n = fallback;
}
```

`!n` is true for `n === 0`, so a legitimate zero input falls through to
the fallback. None of the current consumers (BPM, timing window, chord
ms, measure width, playback speed) accept 0 as valid, so this is
harmless today. But the next consumer that does — for example, an
audio-offset-ms input where 0 means "starts at the beginning" — will
silently lose the user's input.

**Fix:** Change the validity check to:

```js
if (Number.isNaN(n) || (min != null && n < min)) {
  n = fallback;
}
```

`Number("")` returns `NaN` (falsy but caught by `Number.isNaN`).
`Number("abc")` returns `NaN`. `Number("0")` returns `0` (valid). This
is the actual intent.

### #4 — `lyricEditHandlers` memo deps are fragile (extensibility)

**File:** `lib/useLyricEditor.js`

```js
const lyricEditHandlers = useMemo(
  () => ({ onPullBack: handleLyricPullBack, ... }),
  [lyricPlacements, rhNoteSequence, rhSeqIdxMap, skipTiedNotes]
);
```

The four handler functions are plain `function` declarations inside
the hook body, so they're recreated every render. The memo deps list
the values they close over — but the handler names themselves aren't
in the deps array. This works as long as every handler closes only
over the values listed. The `eslint-disable-next-line` is hiding that
this assumption is implicit. A fifth handler that closes over, say,
`songDbId` would silently capture stale state.

**Fix:** Wrap each handler in `useCallback` with explicit deps, then
list the four callbacks in the memo deps:

```js
const handleLyricPullBack = useCallback((wordOrders) => {
  // ... existing body
}, [lyricPlacements, rhNoteSequence, rhSeqIdxMap, skipTiedNotes]);

// ... same for the other three

const lyricEditHandlers = useMemo(
  () => ({
    onPullBack: handleLyricPullBack,
    onPushForward: handleLyricPushForward,
    onCascadePullBack: handleLyricCascadePullBack,
    onCascadePushForward: handleLyricCascadePushForward,
  }),
  [
    handleLyricPullBack,
    handleLyricPushForward,
    handleLyricCascadePullBack,
    handleLyricCascadePushForward,
  ]
);
```

Remove the `eslint-disable-next-line`. Verify each handler's deps
array reflects what it actually reads.

### #5 — Constants extraction (maintainability)

**New file:** `lib/samConstants.js`

Centralize values that are duplicated across files or magic numbers in
animation/audio code:

```js
// Default settings applied when a song doesn't specify them
export const DEFAULTS = {
  bpm: 68,
  timingWindowMs: 300,
  chordMs: 80,
  measureWidth: 300,
  playbackSpeed: 100,
};

// Geometry shared between ScrollEngine and useAudioSync.
// TARGET_LINE_PCT and LEAD_IN_PCT determine where notes appear and
// when they cross the target line; both files MUST use the same values
// or audio will desync from visual scroll.
export const SCROLL_GEOMETRY = {
  targetLinePct: 0.15,   // 15% from left edge
  leadInPct: 0.25,       // 25% of viewport for first-note approach
  staffHeight: 350,
  fallbackViewportWidth: 800,
};

// Metronome click gain for on-beat vs off-beat ticks
export const METRONOME_GAIN = {
  onBeat: 0.3,
  offBeat: 0.15,
};
```

**Apply at:**

- `SamPlayer.jsx` — five `useNumericInput(...)` initializers, the five
  `?? <number>` fallbacks in `handleSongLoaded`.
- `NumericSettings.jsx` — five `?? <number>` fallbacks in `isDirty`,
  `commit({ fallback: <number> })` calls.
- `SongMetadataEditor.jsx` — five `?? <number>` fallbacks in
  `handleSaveEdit`'s `.set()` calls.
- `useAudioSync.js` — `viewportWidth || 800` becomes
  `SCROLL_GEOMETRY.fallbackViewportWidth`; `viewportWidth * 0.25`
  becomes `viewportWidth * SCROLL_GEOMETRY.leadInPct`.
- `ScrollEngine.jsx` — `TARGET_LINE_PCT = 0.15` and `STAFF_H = 350`
  module constants → import from `samConstants`. The `leadInPx =
  viewportWidth * 0.25` becomes `viewportWidth *
  SCROLL_GEOMETRY.leadInPct`. The metronome `gainValue = isOnBeat ? 0.3
  : 0.15` becomes `METRONOME_GAIN.onBeat / METRONOME_GAIN.offBeat`.

After this pass, changing the default BPM is one edit. More
importantly, the implicit coupling between `ScrollEngine`'s
`leadInPx = viewportWidth * 0.25` and `useAudioSync.getApproachMs`'s
matching `leadInPx = viewportWidth * 0.25` becomes explicit — they
both import from the same constant and a divergence becomes
impossible by construction.

## Implementation Order

1. **#5 first (constants extraction).** Pure mechanical refactor, no
   logic changes. Lands cleanly and gives the other fixes named
   constants to refer to.
2. **#3 (commit() zero check).** Tiny single-line fix. Trivial.
3. **#4 (lyricEditHandlers memo).** Mechanical conversion. Risk is
   low; verification is the existing lyric-editing flow.
4. **#1 (anchor-aware seek).** Most logic change. Worth landing alone
   so verification can isolate it.
5. **#2 (saveLyrics atomicity).** Last because it depends on a manual
   prerequisite (verifying the unique constraint on the lyrics table)
   and the fix differs based on the answer.

## Manual Prerequisite (before #2)

Before attempting the upsert path for #2, confirm whether
`sam_song_lyrics` has a unique constraint on `(song_id, word_order)`.
The CLI agent should check this via the Alfred MCP `get_database_schema`
tool first, OR ask the user to run:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sam_song_lyrics'::regclass AND contype = 'u';
```

If a unique constraint exists, use the upsert path.
If not, use the fallback (try/catch with state resync) and add a
Notes entry that the constraint should be added later for proper
upsert support.

## Success Criteria

- `getSeekForMeasure` returns audio-ms values that interpolate
  correctly across multi-anchor songs (verified by setting a second
  anchor on a test song and confirming snippet-start audio aligns).
- `saveLyrics` either persists all placements atomically OR detects
  partial failure and re-syncs in-memory state from the DB.
- `useNumericInput.commit()` accepts 0 as a valid input when no `min`
  is set or when `min <= 0`.
- `lyricEditHandlers` is generated without an `eslint-disable`; all
  four handlers are `useCallback` with explicit deps.
- All five default settings values appear in exactly one file
  (`lib/samConstants.js`).
- `TARGET_LINE_PCT`, `STAFF_H`, `leadInPct`, viewport fallback width,
  and metronome gain values appear in exactly one file.
- No new console errors or warnings during full play-through of
  "Someone Like You" measures 1-9 with audio.
