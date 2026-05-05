# Progress: SAM Cleanup

## Status: Not Started

---

## Milestone 1 — Constants Extraction (#5)

### Development Steps
- [ ] Create `lib/samConstants.js` with `DEFAULTS`, `SCROLL_GEOMETRY`, `METRONOME_GAIN`
- [ ] Update `SamPlayer.jsx`: replace five `useNumericInput(<num>)` initializers and five `?? <num>` fallbacks in `handleSongLoaded`
- [ ] Update `NumericSettings.jsx`: replace fallbacks in `isDirty` and `commit({ fallback: <num> })` calls
- [ ] Update `SongMetadataEditor.jsx`: replace fallbacks in `handleSaveEdit` `.set()` calls
- [ ] Update `useAudioSync.js`: replace `viewportWidth || 800` and `viewportWidth * 0.25`
- [ ] Update `ScrollEngine.jsx`: replace `TARGET_LINE_PCT`, `STAFF_H`, `leadInPx = viewportWidth * 0.25`, metronome gain values
- [ ] Run lint, confirm no new warnings

### Verification (No Behavior Change)
- [ ] Cold reload, load "Someone Like You"
- [ ] Verify all numeric input fields display the same defaults (68 / 300 / 80 / 300 / 100)
- [ ] Press Play, verify scroll behavior visually identical to pre-change
- [ ] Verify target line still appears at 15% from left
- [ ] Verify metronome clicks sound at the same volume on-beat vs off-beat (cycle through beat / halfbeat / quarterbeat)
- [ ] Verify audio sync starts at the correct moment (first note crossing target line)
- [ ] Grep the codebase for `0.15`, `0.25`, `350`, `800`, `0.3`, `0.15`, `68`, `300`, `80`, `100` as numeric literals — none should remain in the files modified above except inside JSX (e.g., Tailwind class strings) or unrelated to the constants extracted

### Notes


---

## Milestone 2 — `commit()` Zero Check (#3)

### Development Steps
- [ ] In `useNumericInput.js`, change `if (!n || ...)` to `if (Number.isNaN(n) || ...)`
- [ ] Verify `Number("")` returns `NaN`, `Number("0")` returns `0`, `Number("abc")` returns `NaN` (no test, just check the code path)

### Verification (No Behavior Change for Current Inputs)
- [ ] Open numeric settings, type empty string into BPM, blur — verify it falls back to 68 (or song default)
- [ ] Type `abc` into BPM, blur — verify it falls back to 68
- [ ] Type `0` into BPM, blur — verify it falls back to 68 (because `min: 1`)
- [ ] Type `64` into BPM, blur — verify it commits to 64
- [ ] Same for timing window, chord ms, measure width, playback speed — all should still fall back when blank/invalid

### Notes


---

## Milestone 3 — `lyricEditHandlers` Memo Conversion (#4)

### Development Steps
- [ ] In `useLyricEditor.js`, wrap each of the four handlers in `useCallback` with explicit deps
- [ ] Update the `lyricEditHandlers` `useMemo` deps to be the four callback references
- [ ] Remove the `eslint-disable-next-line react-hooks/exhaustive-deps` comment
- [ ] Confirm lint passes with no warnings on the deps arrays

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


---

## Milestone 4 — Anchor-Aware `getSeekForMeasure` (#1)

### Development Steps
- [ ] In `useAudioSync.js`, add `songAudioAnchors` memo derived from `song.measures` (mirrors existing `audioAnchors` but for the full song, not the snippet slice)
- [ ] Implement `beatPosToAudioMs(beatPos, anchors)` mirroring `ScrollEngine.audioMsToBeatPos` but inverted:
  - 0 anchors → 0
  - 1 anchor → BPM-based extrapolation from that anchor's `audioMs`
  - 2+ anchors → piecewise-linear interpolation between segments; extrapolate before first/after last using bounding segment rate
- [ ] Rewrite `getSeekForMeasure(measNum)`:
  - If target measure has its own `audioOffsetMs`, return it directly
  - Otherwise, compute target's `beatPos` (cumulative `getMeasDurationQ` from measure 1 to `measNum - 1`)
  - Return `beatPosToAudioMs(beatPos, songAudioAnchors)`
- [ ] Rewrite `getSnippetAudioEndMs` similarly: compute the snippet's end `beatPos`, map to audioMs via `songAudioAnchors`
- [ ] Confirm both functions handle the no-anchor case (return 0 / null as before)

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


---

## Milestone 5 — `saveLyrics` Atomic Persistence (#2)

### Manual Prerequisite
- [ ] Run the SQL query (or use Alfred MCP `get_database_schema`) to check whether `sam_song_lyrics` has a unique constraint on `(song_id, word_order)`:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sam_song_lyrics'::regclass AND contype = 'u';
```

- [ ] Record the answer here: __________________

### Development Steps
- [ ] **If unique constraint exists:** Replace the per-row update loop in `saveLyrics` with a single `supabase.from("sam_song_lyrics").upsert(rows, { onConflict: "song_id,word_order" })`. Build `rows` from `lyricPlacements` selecting `song_id`, `word_order`, `measure_num`, `rh_index`.
- [ ] **If unique constraint does NOT exist:** Wrap the existing per-row loop in a try/catch. On any failure, fetch fresh placements from the DB and call `setLyricPlacementsState(...)` to reset in-memory state. Add a Notes entry that a `(song_id, word_order)` unique constraint should be added later.
- [ ] In either case, only call `recompileMeasures` after the batch operation succeeds. On failure, do NOT recompile (leaves the blob matching the rows that were actually saved).

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


---

## Final Sign-Off

### Success Criteria Check
- [ ] `getSeekForMeasure` works correctly for multi-anchor songs (verified above)
- [ ] `saveLyrics` is either atomic or detects partial failure and re-syncs
- [ ] `useNumericInput.commit()` accepts `0` as valid input when `min <= 0` or unset
- [ ] `lyricEditHandlers` has no `eslint-disable` and uses `useCallback` per handler
- [ ] All numeric defaults imported from `lib/samConstants.js` — grep confirms no stragglers
- [ ] `TARGET_LINE_PCT`, `STAFF_H`, `leadInPct`, viewport fallback width all in `samConstants`
- [ ] No new console warnings during a full play-through

### Final Manual Test Run
- [ ] Cold reload, load "Someone Like You"
- [ ] Play measures 1-4, confirm hit accuracy unchanged from baseline
- [ ] Apply snippet m.5-9, RH only, with audio — confirm full flow works
- [ ] Edit a syllable, save lyrics, confirm persistence
- [ ] Edit settings, save, reload — confirm persistence
- [ ] (Optional) Test multi-anchor song behavior if a song was added during M4 verification
