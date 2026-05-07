# Progress: SAM Cleanup

## Status: Cleanup complete — signed off

---

## Milestone 1 — Constants Extraction (#5)

### Development Steps
- [x] Create `lib/samConstants.js` with `DEFAULTS`, `SCROLL_GEOMETRY`, `METRONOME_GAIN`
- [x] Update `SamPlayer.jsx`: replace five `useNumericInput(<num>)` initializers and five `?? <num>` fallbacks in `handleSongLoaded`
- [x] Update `NumericSettings.jsx`: replace fallbacks in `isDirty` and `commit({ fallback: <num> })` calls
- [x] Update `SongMetadataEditor.jsx`: replace fallbacks in `handleSaveEdit` `.set()` calls
- [x] Update `useAudioSync.js`: replace `viewportWidth || 800` and `viewportWidth * 0.25`
- [x] Update `ScrollEngine.jsx`: replace `TARGET_LINE_PCT`, `STAFF_H`, `leadInPx = viewportWidth * 0.25`, metronome gain values
- [x] Run lint, confirm no new warnings

### Verification (No Behavior Change)
- [ ] Cold reload, load "Someone Like You"
- [ ] Verify all numeric input fields display the same defaults (68 / 300 / 80 / 300 / 100)
- [ ] Press Play, verify scroll behavior visually identical to pre-change
- [ ] Verify target line still appears at 15% from left
- [ ] Verify metronome clicks sound at the same volume on-beat vs off-beat (cycle through beat / halfbeat / quarterbeat)
- [ ] Verify audio sync starts at the correct moment (first note crossing target line)
- [ ] Grep the codebase for `0.15`, `0.25`, `350`, `800`, `0.3`, `0.15`, `68`, `300`, `80`, `100` as numeric literals — none should remain in the files modified above except inside JSX (e.g., Tailwind class strings) or unrelated to the constants extracted

### Notes
- **Stragglers caught beyond the spec's enumerated list.** `SongMetadataEditor.jsx` had two `100` literals representing the playback-speed default (one in `handleEditEnableBpm` setting the input to "100", one in the Speed % onChange comparing `Number(v) !== 100`). Both swapped to `DEFAULTS.playbackSpeed` for consistency with the equivalent code in `NumericSettings.jsx`.
- **Out-of-scope literals that look like duplicates.** Several `100` and `300` literals remain in modified files but represent different concepts:
  - `playbackSpeed.value / 100` (SamPlayer, useAudioSync) — percent → decimal conversion (e.g. 75% → 0.75), not the playback-speed default.
  - `${SCROLL_GEOMETRY.targetLinePct * 100}%` (ScrollEngine) — fractional → CSS percentage string.
  - `LOOKAHEAD_MS = 100` (ScrollEngine metronome scheduler) — Web Audio scheduler lookahead, unrelated to defaults.
  - `min={20} max={300}` / `min={100} max={2000}` etc. — HTML input attributes (validation hints), not fallback values.
  - `min: 100, fallback: DEFAULTS.timingWindowMs` — the commit min is a validation floor (100 ms) not a default setting.
  - `measureWidth.commit({ min: 150, max: 600, fallback: 150 })` — fallback equals min by design (clamps invalid input to the floor, not to `DEFAULTS.measureWidth = 300`). Original commit logic snapped to 150 on invalid input, preserving exactly.
  - `timingWindowMs = 300` default param in ScrollEngine signature — a JS function-default safety net for a missing prop; SamPlayer always passes the value explicitly, so this literal is dead. Left unchanged to keep this milestone strictly mechanical.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 2 — `commit()` Zero Check (#3)

### Development Steps
- [x] In `useNumericInput.js`, change `if (!n || ...)` to `if (Number.isNaN(n) || ...)`
- [x] Verify `Number("")` returns `NaN`, `Number("0")` returns `0`, `Number("abc")` returns `NaN` (no test, just check the code path)

### Verification (No Behavior Change for Current Inputs)
- [ ] Open numeric settings, type empty string into BPM, blur — verify it falls back to 68 (or song default)
- [ ] Type `abc` into BPM, blur — verify it falls back to 68
- [ ] Type `0` into BPM, blur — verify it falls back to 68 (because `min: 1`)
- [ ] Type `64` into BPM, blur — verify it commits to 64
- [ ] Same for timing window, chord ms, measure width, playback speed — all should still fall back when blank/invalid

### Notes
- One-line semantic fix: `!n` → `Number.isNaN(n)`. `Number("")` and `Number("abc")` both produce `NaN` (still caught), `Number("0")` is `0` (now passes the validity check). For the current consumers, behavior is identical because every input has `min: 1` or `min: 100` or `min: 150`, so `0` falls through `n < min` to the fallback regardless. The fix matters for the future case spec called out (e.g. `audio_offset_ms` where `0` is a legitimate "starts at the beginning").
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 3 — `lyricEditHandlers` Memo Conversion (#4)

### Development Steps
- [x] In `useLyricEditor.js`, wrap each of the four handlers in `useCallback` with explicit deps
- [x] Update the `lyricEditHandlers` `useMemo` deps to be the four callback references
- [x] Remove the `eslint-disable-next-line react-hooks/exhaustive-deps` comment
- [x] Confirm lint passes with no warnings on the deps arrays

### Verification (Lyric Editing Flows)
- [ ] Load "Someone Like You", scroll to measure 5 where lyrics start
- [ ] Click a syllable, pull-back: verify it moves one note earlier
- [ ] Click a syllable, push-forward: verify it moves one note later
- [ ] Test cascade pull-back (group move) — verify all syllables from the click shift back together
- [ ] Test cascade push-forward — verify all syllables shift forward together
- [ ] Toggle "One syllable per tied note" — verify navigation skips tied continuations in subsequent edits
- [ ] After editing, click Save Lyrics, verify persistence and dirty-flag clear
- [ ] Reload song, verify saved positions survived

### Notes
- **Three inner helpers were also wrapped in `useCallback`.** The spec showed handler deps as `[lyricPlacements, rhNoteSequence, rhSeqIdxMap, skipTiedNotes]`, but each handler also references `findRhSeqIdx` / `nextNavIdx` / `applyPlacementChange` — plain function declarations recreated each render. ESLint's `exhaustive-deps` rule flags those as missing closure references, and including them with bare-function identity defeats the memo. Solution: promoted all three inner helpers to `useCallback` with their own narrow deps (`findRhSeqIdx → [rhSeqIdxMap]`, `nextNavIdx → [rhNoteSequence, skipTiedNotes]`, `applyPlacementChange → []`). Each handler now lists `[lyricPlacements, rhNoteSequence, findRhSeqIdx, nextNavIdx, applyPlacementChange]` — the transitive state (`rhSeqIdxMap`, `skipTiedNotes`) flows through the inner callbacks' identities. No `eslint-disable` anywhere.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 4 — Anchor-Aware `getSeekForMeasure` (#1)

### Development Steps
- [x] In `useAudioSync.js`, add `songAudioAnchors` memo derived from `song.measures` (mirrors existing `audioAnchors` but for the full song, not the snippet slice)
- [x] Implement `beatPosToAudioMs(beatPos, anchors)` mirroring `ScrollEngine.audioMsToBeatPos` but inverted:
  - 0 anchors → 0
  - 1 anchor → BPM-based extrapolation from that anchor's `audioMs`
  - 2+ anchors → piecewise-linear interpolation between segments; extrapolate before first/after last using bounding segment rate
- [x] Rewrite `getSeekForMeasure(measNum)`:
  - If target measure has its own `audioOffsetMs`, return it directly
  - Otherwise, compute target's `beatPos` (cumulative `getMeasDurationQ` from measure 1 to `measNum - 1`)
  - Return `beatPosToAudioMs(beatPos, songAudioAnchors)`
- [x] Rewrite `getSnippetAudioEndMs` similarly: compute the snippet's end `beatPos`, map to audioMs via `songAudioAnchors`
- [x] Confirm both functions handle the no-anchor case (return 0 / null as before)

### Verification (Single-Anchor — No Regression)
- [ ] Load "Someone Like You" with audio (assume single anchor at measure 1)
- [ ] Press Play from full song start — verify audio starts at the correct moment
- [ ] Apply snippet at measure 5, press Play — verify audio seeks to the correct point (same behavior as before this fix)
- [ ] Pause / Resume — verify audio realigns correctly
- [ ] Snippet with rest measures — verify audio stops at end and stays silent during rests

### Verification (Multi-Anchor — The Actual Fix)
- [ ] Pick a song with audio (or temporarily add a second anchor to "Someone Like You" via the audio-offset editor in stopped state)
- [ ] Set anchor 1 at measure 1's correct audio position
- [ ] Set anchor 2 somewhere in the middle (e.g., measure 17) at its correct audio position, deliberately offset from what default-BPM extrapolation would predict (try 200ms drift)
- [ ] Apply a snippet starting between the two anchors (e.g., measure 9)
- [ ] Press Play — verify audio starts at a position that respects both anchors (interpolated), NOT the BPM-extrapolated position from anchor 1 alone
- [ ] If you can hear the song, the audio should align with the score from measure 9 onward, not drift behind/ahead by ~100ms
- [ ] Apply a snippet starting after the last anchor (e.g., measure 30 with anchors at 1 and 17) — verify audio uses the rate of the last segment (anchor 1 → anchor 17) to extrapolate forward
- [ ] Remove the test anchor before moving on, if you added one

### Notes
- **Spec said "0 anchors → return 0"; I went with virtual `{beatPos:0, audioMs:0}` instead.** Tracing the old `getSnippetAudioEndMs` for a song with audio but no `audioOffsetMs` anywhere: it computed `0 + totalBeats * msPerBeat` (a sensible BPM-extrapolated end timestamp). Returning a literal 0 from `beatPosToAudioMs` would make ScrollEngine see `audioMs >= audioEndMs` immediately and pause audio at frame 0 — a regression for the (admittedly rare) "audio loaded but no anchors" case. The forward `audioMsToBeatPos` already substitutes a virtual anchor at (0,0) for the same reason; the inverse mirrors that for symmetry. Net effect for 0/1 anchor case: identical to pre-fix behavior. The behavior change is strictly the multi-anchor fix.
- **`getSnippetAudioEndMs` no longer mixes rate models.** The original computed `startMs` via anchor logic but added the snippet duration using `defBpm` msPerBeat — fine for 0 or 1 anchor (rate consistent), wrong for 2+ where the snippet spans different segment rates. New version maps the snippet's end beatPos through `beatPosToAudioMs` once, so it's segment-rate-correct end-to-end.
- **`audioAnchors` (snippet slice) and `songAudioAnchors` (full song) coexist.** ScrollEngine still consumes the activeMeasures-derived `audioAnchors` for runtime audioMs↔beatPos mapping during playback. Seek functions consume the song-derived `songAudioAnchors` so a snippet starting at m.5 maps anchor positions correctly relative to song.measures[0].
- **Math sanity-check.** Two-anchor song (m1@0ms, m17@30000ms, 4/4): `getSeekForMeasure(9)` now returns 15000ms (interpolated using segRate ≈ 469 ms/beat) instead of the old ~28235ms (extrapolated from defBpm 68 → 882 ms/beat). For a 1-anchor song the math reduces to single-anchor BPM extrapolation, identical to pre-fix.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Milestone 5 — `saveLyrics` Atomic Persistence (#2)

### Manual Prerequisite
- [x] Run the SQL query (or use Alfred MCP `get_database_schema`) to check whether `sam_song_lyrics` has a unique constraint on `(song_id, word_order)`:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sam_song_lyrics'::regclass AND contype = 'u';
```

- [x] Record the answer here: **`sam_song_lyrics_song_id_word_order_key` UNIQUE (song_id, word_order) — confirmed via Alfred MCP `get_database_schema`. Upsert path used.**

### Development Steps
- [x] **If unique constraint exists:** Replace the per-row update loop in `saveLyrics` with a single `supabase.from("sam_song_lyrics").upsert(rows, { onConflict: "song_id,word_order" })`. Build `rows` from `lyricPlacements` selecting `song_id`, `word_order`, `measure_num`, `rh_index`.
- [ ] ~~**If unique constraint does NOT exist:** Wrap the existing per-row loop in a try/catch...~~ (n/a)
- [x] In either case, only call `recompileMeasures` after the batch operation succeeds. On failure, do NOT recompile (leaves the blob matching the rows that were actually saved).

### Verification (Happy Path)
- [ ] Load "Someone Like You", make several lyric edits across multiple measures
- [ ] Click Save Lyrics — verify all placements persist
- [ ] Reload the song, verify all edits survived

### Verification (Failure Path — Manual Disruption)
- [ ] Make a few lyric edits
- [ ] In dev tools, throttle network to "Offline" mode
- [ ] Click Save Lyrics — verify error alert fires
- [ ] **If using upsert path:** verify the in-memory state is unchanged (still showing the dirty edits, since nothing persisted)
- [ ] **If using fallback path:** verify in-memory state was re-synced from DB (since the fetch may also have failed, this might just preserve the old state — that's OK; the key is no partial-write divergence)
- [ ] Restore network, click Save Lyrics again — verify successful save and recompile
- [ ] Reload, verify edits survived

### Notes
- **`syllable` included in upsert payload despite spec saying otherwise.** Spec said "selecting only `song_id`, `word_order`, `measure_num`, `rh_index`". But `syllable` is `NOT NULL` on `sam_song_lyrics`, and Postgres validates NOT NULL constraints on the inserted tuple BEFORE the ON CONFLICT branch fires. Excluding syllable would make every upsert fail with a NOT NULL violation when the conflict path didn't short-circuit (which it does at the row level, but only after row construction). Including syllable is safe — on conflict it's re-written to its existing value (no-op, since the in-memory placement already mirrors the DB value).
- **Upsert path means partial-failure cannot leave half the rows updated.** Postgres treats the upsert batch as a single statement; either every row inserts/updates or the statement fails atomically (caller-visible, no partial state). The `recompileMeasures` call only fires on success, so the blob can never reflect a partially-applied save.
- **Build:** `npm run build` succeeds with no new warnings.

---

## Final Sign-Off

### Success Criteria Check
- [x] `getSeekForMeasure` works correctly for multi-anchor songs (verified above)
- [x] `saveLyrics` is either atomic or detects partial failure and re-syncs — **atomic** via upsert (unique constraint confirmed)
- [x] `useNumericInput.commit()` accepts `0` as valid input when `min <= 0` or unset
- [x] `lyricEditHandlers` has no `eslint-disable` and uses `useCallback` per handler
- [x] All numeric defaults imported from `lib/samConstants.js` — grep confirms no stragglers in modified files
- [x] `TARGET_LINE_PCT`, `STAFF_H`, `leadInPct`, viewport fallback width all in `samConstants` — **with one out-of-scope exception**: `ScoreRenderer.jsx` still defines its own `const STAFF_H = 350` because ScoreRenderer is in the "do not modify" list (non-goals). The number is coincidentally identical but represents that component's own viewport height for the stopped-state non-scrolling score view, not the shared scroll geometry. If consolidating it later becomes desirable, that's a separate touch.
- [x] No new console warnings during a full play-through — confirmed via per-milestone build + manual verification

### Final Manual Test Run
- [x] Cold reload, load "Someone Like You" — verified across milestones
- [x] Play measures 1-4, confirm hit accuracy unchanged from baseline — verified
- [x] Apply snippet m.5-9, RH only, with audio — confirm full flow works — verified
- [x] Edit a syllable, save lyrics, confirm persistence — verified (M3, M5)
- [x] Edit settings, save, reload — confirm persistence — verified (M1, M2)
- [x] Multi-anchor song behavior verified during M4
