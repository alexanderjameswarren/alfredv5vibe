# Progress: SAM Refactor

## Status: Not Started

---

## Milestone 1 — Extract `useLyricEditor` Hook

### Development Steps
- [ ] Create `lib/useLyricEditor.js` with hook signature
- [ ] Move `rhNoteSequence`, `rhSeqIdxMap`, `findRhSeqIdx`, `nextNavIdx` into hook
- [ ] Move `handleLyricPullBack`, `handleLyricPushForward`, `handleLyricCascadePullBack`, `handleLyricCascadePushForward` into hook
- [ ] Move `handleSaveLyrics` into hook (renamed `saveLyrics`)
- [ ] Move the `sam_song_lyrics` fetch `useEffect` into hook
- [ ] Move `lyricsDirty`, `lyricsSaving`, `lyricPlacements` state into hook
- [ ] Update `SamPlayer.jsx` to consume the hook
- [ ] Confirm `activeMeasures` lyric-injection still works (it stays in parent)
- [ ] Confirm `lyricEditHandlers` memo dependencies are correct

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


---

## Milestone 2 — Split `SettingsBar` into 4 Components

### Development Steps
- [ ] Create `components/TransportControls.jsx` (play/pause/resume/restart/stop)
- [ ] Create `components/NumericSettings.jsx` (bpm, timing window, chord ms, measure width, playback speed inputs)
- [ ] Create `components/SongMetadataEditor.jsx` (edit modal with title/artist/defaults)
- [ ] Create `components/AudioToolbar.jsx` (audio upload, auto-match, refresh, lyrics actions)
- [ ] Move state into the child that owns it (see spec for full mapping)
- [ ] Reduce `SettingsBar.jsx` to layout shell composing the four children
- [ ] Update `SamPlayer.jsx` prop forwarding (only what each child needs)
- [ ] Audit for dead state — remove anything no longer referenced

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


---

## Milestone 3 — Extract `useAudioSync` Hook

### Development Steps
- [ ] Create `lib/useAudioSync.js` with hook signature
- [ ] Move `audioAnchors` memo into hook
- [ ] Move `getApproachMs`, `getAudioSeekMsForMeasure`, `getSnippetAudioSeekMs`, `getSnippetAudioEndMs` into hook
- [ ] Move timer refs (`audioDelayTimerRef`, `scrollDelayTimerRef`, `pendingAudioSeekRef`) into hook
- [ ] Move `clearDelayTimers` (renamed `clearTimers`) and `handleScrollStart` (renamed `scheduleAudioStartOnScroll`) into hook
- [ ] Add `prepareAudioSeek(seekMs)` method
- [ ] Update `SamPlayer.jsx` transport handlers to call `prepareAudioSeek`
- [ ] Wire `<ScrollEngine onScrollStart={scheduleAudioStartOnScroll}>`

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


---

## Milestone 4 — Extract `scoreRender.js` from `ScrollEngine`

### Development Steps
- [ ] Create `lib/scoreRender.js`
- [ ] Move `DURATION_BEATS` constant
- [ ] Move `padVoice` function
- [ ] Move `renderCopy` function
- [ ] Move `drawStaveTies` (currently nested inside `renderCopy`)
- [ ] Move `playClick` function
- [ ] Update imports in `ScrollEngine.jsx`
- [ ] Verify `ScrollEngine.jsx` is now ~550 lines, contains only React-bound code

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


---

## Milestone 5 — `useNumericInput` Helper Hook

### Development Steps
- [ ] Create `lib/useNumericInput.js`
- [ ] Replace `[bpm, bpmInput]` pair with `useNumericInput(68)`
- [ ] Replace `[timingWindowMs, timingWindowMsInput]` pair
- [ ] Replace `[chordMs, chordMsInput]` pair
- [ ] Replace `[measureWidth, measureWidthInput]` pair
- [ ] Replace `[playbackSpeed, playbackSpeedInput]` pair
- [ ] Update `<NumericSettings>` to consume hook returns
- [ ] Update `handleSongLoaded` and `handleSettingsOverride` to call `.set()` and `.setInput()` (or `.reset(value)`)

### Verification (Numeric Inputs — Final Check)
- [ ] Edit BPM in input, click away (blur) — verify value commits
- [ ] Type invalid input (e.g., "abc"), blur — verify it reverts to last valid value
- [ ] Load a different song — verify all numeric inputs reset to that song's defaults
- [ ] Apply a snippet with saved settings — verify inputs override to snippet settings
- [ ] Save Settings dirty detection still works correctly

### Notes


---

## Final Sign-Off

### Success Criteria Check
- [ ] `SamPlayer.jsx` under 700 lines (was 1,015)
- [ ] `SettingsBar.jsx` under 150 lines (was 806)
- [ ] `ScrollEngine.jsx` under 600 lines (was 960)
- [ ] No new console errors or warnings during full play-through
- [ ] Measures 1-4 of "Someone Like You" still register hits with same accuracy as baseline
- [ ] Full snippet save / load / archive flow works
- [ ] Audio offset editing in stopped state still works
- [ ] All five development steps marked complete above

### Final Manual Test Run
- [ ] Cold reload, load "Someone Like You"
- [ ] Play measures 1-4 with MIDI keyboard, confirm hit accuracy unchanged
- [ ] Apply snippet m.5-9, RH only, with audio — confirm full flow
- [ ] Edit a syllable placement, save lyrics, confirm persisted
- [ ] Edit settings, save, reload — confirm persisted
