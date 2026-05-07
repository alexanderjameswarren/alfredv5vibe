# Progress: SAM Audio Anchor Patch

## Status: Patch applied — awaiting verification

---

## The Patch

### Development Steps
- [x] Open `lib/useAudioSync.js`
- [x] Locate the `audioAnchors` useMemo (currently lines ~30-41)
- [x] Add the virtual anchor injection inside the useMemo body, after the existing for-loop, before the return:

```js
if (snippet && (anchors.length === 0 || anchors[0].beatPos !== 0)) {
  const startAudioMs = getSeekForMeasure(snippet.startMeasure);
  anchors.unshift({ beatPos: 0, audioMs: startAudioMs });
}
```

- [x] Update the deps array to include `snippet` and `song`. Add an eslint-disable comment for the missing `getSeekForMeasure` dep (it would cause infinite re-memoization since it's recreated each render):

```js
}, [activeMeasures, snippet, song]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [x] Verify lint passes with no warnings beyond the explicit disable comment

### Notes
- Patch applied as specified — only `lib/useAudioSync.js` touched. `npm run build` succeeds with no new warnings.
- The new branch fires only when `snippet` is set AND there isn't already a real anchor at `beatPos: 0`. Full-song playback (no snippet) is untouched, so the regression check should observe no change.
- **TDZ fix:** initial application threw `Cannot access 'songAudioAnchors' before initialization` at runtime when a snippet was selected. The snippet-virtual-anchor injection calls `getSeekForMeasure`, which closes over `songAudioAnchors`. The previous file order was `audioAnchors` first, then `songAudioAnchors` — so calling `getSeekForMeasure` from inside the `audioAnchors` memo body hit the `const` TDZ before `songAudioAnchors`'s `useMemo` had run. Reordered within the same file: `songAudioAnchors` and the helper functions (`beatPosToAudioMs`, `songBeatPosForMeasure`, `getSeekForMeasure`, `getSnippetAudioEndMs`) now appear before the `audioAnchors` memo. No other change.


---

## Verification

### Bug #2 — Snippet audio timing
- [ ] Load "Someone Like You" with audio attached (song ID `2545eec0-ddc7-44d7-a7c8-300693acfcc3`)
- [ ] **Baseline (full song):** Press Play from full song start. Note the wall-clock moment when the first lyric is heard (end of measure 4). Note `audioElement.currentTime` at that moment — should be the same value you observed before the patch (~14000ms).
- [ ] **Test (snippet starting at measure 4):** Apply snippet starting at measure 4. Press Play. The first lyric should sound at the same `audioElement.currentTime` value as the full-song case (~14000ms). Critically, the wall-clock delay between Play and first lyric should match the visual delay between Play and the first note crossing the target line.
- [ ] If the audio counter starts at the right value (~11250ms for measure 4 with `defaultBpm: 64`) and lyrics arrive when the corresponding note crosses the target line, bug #2 is fixed.
- [ ] **Test (snippet starting at measure 5):** Same check at a different start measure. Confirm consistent behavior.

### Bug #3 — Constant scroll speed
- [ ] With a snippet selected (any start measure ≥ 2), press Play
- [ ] Watch the metronome ticks (set metronome to "Beat" so they're audible) AND the visual scroll
- [ ] Both should remain at constant tempo from the moment scroll begins until the end of the snippet
- [ ] **Specifically:** there should be NO perceptible speed change at the moment the first note crosses the target line. Before the patch, the scroll/metronome ran at one rate during the lead-in (~250ms) and a different rate after audio started.
- [ ] Repeat with playback speed at 75% and 125% — the behavior should be the same (constant within each test, just at a different overall rate)

### Bug #1 — Resume scroll position
- [ ] **Resume mid-snippet:**
  - Apply a snippet with at least 5 measures (e.g., m.5-12)
  - Press Play, let it scroll to ~m.8, press Pause
  - Confirm "paused at m.8" is shown in the title bar
  - Press Resume
  - **Expected:** Scroll begins at m.8 with the lead-in (m.8 appears at ~25% to the right of the target line, then scrolls left to cross it). Audio resumes at the m.8 audio timestamp aligned with the visual.
  - **Bug behavior (before patch):** Scroll restarts from m.5 (snippet start), even though audio correctly resumes at m.8.
- [ ] **Resume from full song:**
  - From a fresh start, press Play on full song, scroll to ~m.10, Pause
  - Press Resume
  - **Expected:** Scroll begins at m.10 with lead-in, audio resumes at m.10 audio timestamp, visual and audio aligned.

### Regression check — Full song playback (the case that already worked)
- [ ] Cold reload, load "Someone Like You"
- [ ] Press Play from full song start (no snippet)
- [ ] Verify all behavior is identical to before the patch:
  - Audio starts when first note crosses target line (~250ms after Play)
  - Lyrics align with notes
  - Metronome ticks at constant tempo
  - Scroll speed unchanged at any point
  - Loop teleport still works at end of song

### Notes


---

## Sign-Off

- [ ] All three bugs verified fixed
- [ ] Full-song playback unchanged
- [ ] No new console errors or warnings
- [ ] Latent issue noted: `getSeekForMeasure` still uses BPM-extrapolation
  for measures lacking `audioOffsetMs`. Single-anchor songs unaffected;
  multi-anchor support is a future change. (See cleanup pass M4 — never
  landed; can be picked up after the timing-module refactor.)
