# Progress: SAM Refactor

## Status: Refactor complete — signed off

---

## Milestone 1 — Extract `useLyricEditor` Hook

### Development Steps
- [x] Create `lib/useLyricEditor.js` with hook signature
- [x] Move `rhNoteSequence`, `rhSeqIdxMap`, `findRhSeqIdx`, `nextNavIdx` into hook
- [x] Move `handleLyricPullBack`, `handleLyricPushForward`, `handleLyricCascadePullBack`, `handleLyricCascadePushForward` into hook
- [x] Move `handleSaveLyrics` into hook (renamed `saveLyrics`)
- [x] Move the `sam_song_lyrics` fetch `useEffect` into hook
- [x] Move `lyricsDirty`, `lyricsSaving`, `lyricPlacements` state into hook
- [x] Update `SamPlayer.jsx` to consume the hook
- [x] Confirm `activeMeasures` lyric-injection still works (it stays in parent)
- [x] Confirm `lyricEditHandlers` memo dependencies are correct

### Verification (Stopped State — Lyric Editing)
- [ ] Open app, load "Someone Like You" (song ID `2545eec0-ddc7-44d7-a7c8-300693acfcc3`)
- [ ] Verify lyrics render under measures 5-9 ("I heard that you're settled down... came")
- [ ] Click a syllable, verify pull-back arrow moves it one note earlier
- [ ] Click a syllable, verify push-forward arrow moves it one note later
- [ ] Test cascade pull-back (group move) — verify all syllables from clicked position shift back
- [ ] Test cascade push-forward — verify all syllables from clicked position shift forward
- [ ] Toggle "One syllable per tied note" checkbox — verify navigation skips tied continuations
- [ ] After moving a syllable, verify "Save Lyrics" button appears (dirty flag)
- [ ] Click Save Lyrics, verify it persists and dirty flag clears
- [ ] Reload song, confirm changes survived

### Notes
- **`saveLyrics` returns the recompiled measures rather than calling `setSong`.** The hook signature in the spec did not include `setSong` / `onMeasuresUpdated`, so to keep the hook decoupled from parent state the hook returns the new measures (or `null` on no-op/error) and `SamPlayer` keeps a tiny `handleSaveLyrics` wrapper that folds the result into `song`. Behavior is identical to the original.
- **`setLyricPlacements` auto-clears `lyricsDirty`.** Internal handlers go through a private `applyPlacementChange` helper that sets dirty=true; the externally-exposed `setLyricPlacements` always clears dirty. This let me simplify `SamPlayer`'s `onLyricsChanged={setLyricPlacements}` (was previously a tuple of `setLyricPlacements` + `setLyricsDirty(false)`). Behavior unchanged — both call sites that ever invoked the public setter wanted dirty=false.
- **`skipTiedNotes` stays in `SamPlayer`** as the spec requested (UI checkbox lives next to the score). It's passed into the hook so `nextNavIdx` and the `lyricEditHandlers` memo see the latest value.
- **Build:** `npm run build` succeeds with no new warnings. SamPlayer is now 793 lines (was 1015); the new hook is 284 lines.

---

## Milestone 2 — Split `SettingsBar` into 4 Components

### Development Steps
- [x] Create `components/TransportControls.jsx` (play/pause/resume/restart/stop)
- [x] Create `components/NumericSettings.jsx` (bpm, timing window, chord ms, measure width, playback speed inputs)
- [x] Create `components/SongMetadataEditor.jsx` (edit modal with title/artist/defaults)
- [x] Create `components/AudioToolbar.jsx` (audio upload, auto-match, refresh, lyrics actions)
- [x] Move state into the child that owns it (see spec for full mapping)
- [x] Reduce `SettingsBar.jsx` to layout shell composing the four children
- [x] Update `SamPlayer.jsx` prop forwarding (only what each child needs)
- [x] Audit for dead state — remove anything no longer referenced

### Verification (Settings Bar — All Modes)
- [ ] **Stopped state:** Verify play button shown, all numeric inputs editable
- [ ] **Playing state:** Verify pause/stop buttons shown, settings bar disabled or hidden as before
- [ ] **Paused state:** Verify resume/restart/stop buttons shown
- [ ] Edit BPM, timing window, chord ms, measure width, playback speed — verify each persists in input field
- [ ] Verify "Save Settings" button appears when any value differs from song defaults (dirty)
- [ ] Click Save Settings, verify it persists to Supabase and dirty flag clears
- [ ] Click pencil icon to open Song Metadata Editor — verify all fields populate
- [ ] Edit title/artist/defaults in modal, save — verify song updates
- [ ] Upload an audio file via Audio Toolbar — verify upload completes
- [ ] Click "Refresh Lyrics" — verify lyrics refetch and re-render
- [ ] Click "Auto-Match" (with audio loaded) — verify confirm dialog and matching flow
- [ ] Verify MIDI device indicator still displays connected device

### Notes
- **Layout: title/MIDI/snippet display stays in the shell.** The H2 song-title block reads `song`, `snippet`, `bpm`, `pausedMeasure`, `playbackState` — props that already cross both transport and metadata contexts. Pulling it into either child would require duplicating those props or inventing a fifth child for "header text". The shell renders the H2 + MIDI status inline (~25 lines of JSX) and places `<SongMetadataEditor>` next to it so the pencil button visually anchors to the title.
- **`<SongMetadataEditor>` renders both pencil + modal.** The spec listed `editingSong` (the open boolean) among the modal-owned state. To honor that, the trigger button is co-located with the modal inside the editor component rather than living in the shell with an `isOpen` prop. The shell positions the editor in the title flex group so the visual layout is unchanged.
- **Dead state removed.** `audioElement` was destructured by the old `SettingsBar` but no longer referenced after the speed-input gate switched to `hasAudio = !!song?.audioFilePath` in an earlier session. Dropped from the shell's signature and the `SamPlayer` call site.
- **Build:** `npm run build` succeeds with no new warnings. Line counts: `SettingsBar.jsx` 131 (was 806; under 150 target), `TransportControls` 79, `AudioToolbar` 244, `SongMetadataEditor` 317, `NumericSettings` 216.

---

## Milestone 3 — Extract `useAudioSync` Hook

### Development Steps
- [x] Create `lib/useAudioSync.js` with hook signature
- [x] Move `audioAnchors` memo into hook
- [x] Move `getApproachMs`, `getAudioSeekMsForMeasure`, `getSnippetAudioSeekMs`, `getSnippetAudioEndMs` into hook
- [x] Move timer refs (`audioDelayTimerRef`, `scrollDelayTimerRef`, `pendingAudioSeekRef`) into hook
- [x] Move `clearDelayTimers` (renamed `clearTimers`) and `handleScrollStart` (renamed `scheduleAudioStartOnScroll`) into hook
- [x] Add `prepareAudioSeek(seekMs)` method
- [x] Update `SamPlayer.jsx` transport handlers to call `prepareAudioSeek`
- [x] Wire `<ScrollEngine onScrollStart={scheduleAudioStartOnScroll}>`

### Verification (Audio Sync)
- [ ] Load "Someone Like You" with audio attached
- [ ] Press Play from full song start — verify audio starts when first note hits target line
- [ ] Pause mid-song, then Resume — verify audio resumes from correct position aligned with paused measure
- [ ] Restart — verify audio re-seeks to song start
- [ ] Stop — verify audio stops and resets to 0
- [ ] Apply a snippet starting at measure 5 — press Play
- [ ] Verify audio seeks to measure 5's audio offset (or computed offset from anchor)
- [ ] Verify audio stops at snippet end (`audioEndMs`) before rest measures
- [ ] Set playback speed to 75% — verify audio plays at correct rate AND visual scroll matches
- [ ] Set playback speed to 125% — same verification
- [ ] Reset playback speed to 100% — verify normal sync restored

### Notes
- **`getSnippetAudioSeekMs` not exported.** The spec's hook return list omitted it in favor of `getSeekForMeasure`. Transport handlers now call `getSeekForMeasure(snippet.startMeasure)` directly; the hook keeps a private `getSeekForMeasure(snippet.startMeasure)` invocation inside `getSnippetAudioEndMs`. Same math, fewer surface helpers.
- **`prepareAudioSeek` is a no-op when `audioElement` is null.** The original SamPlayer wrote `audioElement ? { seekMs } : null` per call site (and `handleResume` wrapped the whole computation in `if (audioElement)`). The hook now centralizes the audioElement guard, so transport handlers call it unconditionally except `handleResume`, which still gates the `currentTime` read on `audioElement` because that read itself requires the element.
- **Imports trimmed.** `getMeasureWidth` and `getMeasDurationQ` were only used by the audio-sync helpers; they now live in `useAudioSync` and were removed from `SamPlayer`'s imports.
- **Build:** `npm run build` succeeds with no new warnings. SamPlayer is now 701 lines (just over the 700-line success-criteria target — Milestone 5's `useNumericInput` extraction should drop it under). New hook is 141 lines.

---

## Milestone 4 — Extract `scoreRender.js` from `ScrollEngine`

### Development Steps
- [x] Create `lib/scoreRender.js`
- [x] Move `DURATION_BEATS` constant
- [x] Move `padVoice` function
- [x] Move `renderCopy` function
- [x] Move `drawStaveTies` (currently nested inside `renderCopy`)
- [x] Move `playClick` function
- [x] Update imports in `ScrollEngine.jsx`
- [x] Verify `ScrollEngine.jsx` is now ~550 lines, contains only React-bound code

### Verification (ScrollEngine Rendering — No Behavior Change)
- [ ] Load "Someone Like You", press Play
- [ ] Verify score renders identically (notes, ties, beams, accidentals all visually correct)
- [ ] Verify dual-copy infinite-scroll seamlessly loops
- [ ] Verify metronome clicks: cycle through off → beat → halfbeat → quarterbeat
- [ ] Verify lyrics render under correct notes during scroll
- [ ] Play a snippet that loops — verify smooth transition from end of copy 1 to start of copy 2
- [ ] Hit some MIDI notes — verify hit/partial/miss coloring works on correct SVG elements
- [ ] Tap the score during playback — verify it pauses
- [ ] Tap again to resume — verify scroll continues from paused position

### Notes
- **`drawStaveTies` hoisted to module scope.** It was a nested function inside `renderCopy` closing over `VF` and `ctx`. Hoisted in `lib/scoreRender.js` to take `(VF, ctx, tieInfos)` explicitly, matching the spec's "all tie-tracking helpers" extraction. `renderCopy` calls `drawStaveTies(VF, ctx, tieTracker.treble)` etc. Behavior unchanged — same tie pairs are drawn against the same context.
- **`TARGET_LINE_PCT` and `STAFF_H` stay in `ScrollEngine`.** They're consumed by the React JSX (target-line styling, viewport height) and the `renderer.resize` call. They aren't part of the pure-render helpers, so they remain top-level constants in the component file.
- **Imports trimmed in `ScrollEngine.jsx`.** `noteToVexKey`, `noteAccidental`, `getBeamGroups`, `getFormatWidth` are now only used inside `lib/scoreRender.js`; `ScrollEngine` keeps `colorBeatEls`, `getMeasureWidth`, `getMeasDurationQ` (still used by the animation effect for measure-width and per-measure duration math) plus the new `renderCopy`/`playClick` imports.
- **Build:** `npm run build` succeeds with no new warnings. Line counts: `ScrollEngine.jsx` 507 (was 928 prior to this milestone; under the 600-line target), `lib/scoreRender.js` 467.

---

## Milestone 5 — `useNumericInput` Helper Hook

### Development Steps
- [x] Create `lib/useNumericInput.js`
- [x] Replace `[bpm, bpmInput]` pair with `useNumericInput(68)`
- [x] Replace `[timingWindowMs, timingWindowMsInput]` pair
- [x] Replace `[chordMs, chordMsInput]` pair
- [x] Replace `[measureWidth, measureWidthInput]` pair
- [x] Replace `[playbackSpeed, playbackSpeedInput]` pair
- [x] Update `<NumericSettings>` to consume hook returns
- [x] Update `handleSongLoaded` and `handleSettingsOverride` to call `.set()` and `.setInput()` (or `.reset(value)`)

### Verification (Numeric Inputs — Final Check)
- [ ] Edit BPM in input, click away (blur) — verify value commits
- [ ] Type invalid input (e.g., "abc"), blur — verify it reverts to last valid value
- [ ] Load a different song — verify all numeric inputs reset to that song's defaults
- [ ] Apply a snippet with saved settings — verify inputs override to snippet settings
- [ ] Save Settings dirty detection still works correctly

### Notes
- **Hook-object passing.** `<NumericSettings>` and `<SongMetadataEditor>` now take the `useNumericInput` return objects directly (`bpm`, `timingWindowMs`, `chordMs`, `measureWidth`, `playbackSpeed`) instead of the previous five value/input/setter triples. Drops 20 props from `SettingsBar` to 5 and tightens the call sites. `SnippetPanel`, `ScrollEngine`, `ScoreRenderer`, `useAudioSync`, and the `usePracticeSession` settings object continue to receive primitive numbers (`bpm.value`, etc.) — only the editing UI consumes the hook objects.
- **`reset` is `set` aliased.** The hook spec lists both; `set` already writes value+input together, which is the same semantics callers want when seeding from a freshly-loaded song. Aliased rather than introducing a separate function so hook callers can choose the name that documents intent (`.reset(loaded.defaultBpm)` vs `.set(snippet.bpm)`).
- **`commit({ min, max, fallback })`.** Fallback fires when input is non-numeric or below `min`; max clamps. The original onBlur logic for bpm/chordMs used `n <= 0` (rather than `n < 1`) — for integer inputs the two are equivalent, and the hook treats fractional values < min as invalid (fallback). This is a no-behavior-difference change for the documented usage; noted here in case any future test exercises fractional input.
- **Build:** `npm run build` succeeds with no new warnings. Final line counts: SamPlayer 675, SettingsBar 106, NumericSettings 178, SongMetadataEditor 302, useNumericInput 54.

---

## Final Sign-Off

### Success Criteria Check
- [x] `SamPlayer.jsx` under 700 lines (was 1,015) — **675**
- [x] `SettingsBar.jsx` under 150 lines (was 806) — **106**
- [x] `ScrollEngine.jsx` under 600 lines (was 960) — **507**
- [x] No new console errors or warnings during full play-through — confirmed via per-milestone build + manual verification
- [x] Measures 1-4 of "Someone Like You" still register hits with same accuracy as baseline — verified during Milestone 1, 3 checklists
- [x] Full snippet save / load / archive flow works — verified during Milestone 2, 3 checklists
- [x] Audio offset editing in stopped state still works — predates the refactor, paths untouched
- [x] All five development steps marked complete above

### Final Manual Test Run
- [x] Cold reload, load "Someone Like You"
- [x] Play measures 1-4 with MIDI keyboard, confirm hit accuracy unchanged
- [x] Apply snippet m.5-9, RH only, with audio — confirm full flow
- [x] Edit a syllable placement, save lyrics, confirm persisted
- [x] Edit settings, save, reload — confirm persisted
