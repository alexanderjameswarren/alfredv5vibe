# Progress: Audio Spin-Up Freeze Fix

## Status: Patch applied — awaiting verification

---

## The Patch

### Development Steps
- [x] Open `ScrollEngine.jsx`
- [x] Add `lastAudioMs: null,` to the `scrollStateRef.current` initialization block (around line 242-252) — placed adjacent to the existing `audioSyncOffset: null,` line for clarity
- [x] Replace the audio-playing branch (currently around lines 271-286 — the `if (audioElement && !audioElement.paused) { ... }` block, including the `audioEndMs` check at the end) with the version in the spec
- [x] Verify lint passes
- [x] Confirm the diagnostic `[DEBUG audio frame N]` log block from the previous diagnosis is removed (if it's still present)

### Notes
- Two edits in `ScrollEngine.jsx`: added `lastAudioMs: null` to `scrollStateRef.current` init, and replaced the audio-playing branch (including its trailing `audioEndMs` check) with the gated version per spec. The `[DEBUG audio frame N]` block plus its `state._audioStartLogCount` plumbing both lived inside the old branch and were removed by the replacement. Grep confirms no `DEBUG audio frame` or `_audioStartLogCount` references remain.
- `npm run build` succeeds with no new warnings.


---

## Verification

### Primary Bug — Stutter at Target Line
- [ ] Cold reload, load "Someone Like You" with audio
- [ ] Press Play from full song start
- [ ] Watch the first note as it approaches and crosses the target line
- [ ] **Expected:** scroll moves at constant speed through the entire lead-in and into the playing phase. No visible stutter, freeze, or "drag" at the moment the first note crosses the target line.
- [ ] **Bug behavior (before patch):** ~25ms freeze ("drag") at the target-line crossing

### Snippet Playback
- [ ] Apply snippet m.4-8
- [ ] Press Play
- [ ] Watch m.4 cross the target line
- [ ] **Expected:** no stutter, smooth scroll throughout

### Resume Playback
- [ ] Apply snippet m.4-8
- [ ] Press Play, let m.6 become visible past the target line, press Pause
- [ ] Press Resume
- [ ] **Expected:** scroll begins at m.6 lead-in (resume bug from earlier patch still working), AND no stutter as m.6 crosses the target line

### Audio/Visual Sync — Regression Check
- [ ] Press Play, let song run for at least 10 seconds
- [ ] Listen for first lyric ("I heard")
- [ ] Watch the corresponding note cross the target line
- [ ] **Expected:** lyric audio and visual target-line crossing happen simultaneously, same as before patch

### Metronome — Regression Check
- [ ] Enable metronome (Beat mode)
- [ ] Press Play
- [ ] Listen for tick consistency from lead-in through playing phase
- [ ] **Expected:** ticks at constant tempo with no perceptible rate change at the target line

### Playback Speed — Regression Check
- [ ] Set playback speed to 75%, press Play
- [ ] **Expected:** scroll runs at 75% rate throughout, no stutter at target line, audio and visual stay in sync
- [ ] Set playback speed to 125%, press Play
- [ ] **Expected:** scroll runs at 125% rate throughout, same behavior

### Notes


---

## Sign-Off

- [ ] No stutter/freeze at target-line crossing for full song
- [ ] No stutter for snippet playback
- [ ] No stutter on resume
- [ ] Audio/visual sync unchanged after transition
- [ ] Metronome behavior unchanged
- [ ] Playback at 75% / 125% works as before, with no new stutter
- [ ] No new console errors or warnings

### Known Follow-Ups
- Sustained-rate-mismatch case (audio engine playing at e.g. 0.99×
  wall clock) is not addressed by this patch. If observed in the
  future, would need additional rate-correction logic. Not
  expected on standard hardware.
- Eventually a timing-module refactor (consolidating the
  measure↔beat↔audioMs↔px translations into one named module)
  would replace this patch with a more principled clock-unification
  approach. That is a separate, larger change.
