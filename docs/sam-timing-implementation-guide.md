# Sam — Implementation Guide for Claude CLI

## How to Use This Document

This is a step-by-step implementation guide. Give Claude CLI this file and say:
**"Read this document and execute Step N"**

Each step is independent and testable. Steps within a workstream should be done in order. Workstreams A, B, and C are independent of each other.

**After each step**, there is a ✅ VERIFY section. Test the app manually before proceeding.

**Test files** are in the same directory as this guide. Load them via the song loader to verify behavior.

---

## Prerequisites

- All source files are in the project's existing locations
- Test JSON files from this delivery are available for upload into Sam
- VexFlow is loaded and functional

---

## WORKSTREAM A: Time Signature Generalization

### Step A1: Add `measureDurationQ` utility to measureUtils.js

**File:** `src/lib/measureUtils.js` (or wherever measureUtils lives in the project)

**Changes:**

1. Add two new exported functions at the top of the file (after `DURATION_BEATS`):

```js
/**
 * Calculate measure duration in quarter-note equivalents.
 * e.g., 4/4 → 4, 3/4 → 3, 6/8 → 3, 7/8 → 3.5, 5/4 → 5
 */
export function measureDurationQ(timeSig) {
  if (!timeSig) return 4;
  return (timeSig.beats / timeSig.beatType) * 4;
}

/**
 * Convenience: extract durationQ from a measure object.
 */
export function getMeasDurationQ(measure) {
  return measureDurationQ(measure?.timeSignature);
}
```

2. Update the `padVoice` function signature to accept `targetBeats`:

**Change the function signature from:**
```js
function padVoice(events) {
```
**To:**
```js
function padVoice(events, targetBeats = 4) {
```

**And change inside the function from:**
```js
let remaining = 4 - total;
```
**To:**
```js
let remaining = targetBeats - total;
```

**Also update the fallback rest duration selection.** The current code uses `"w"` (4 beats) as the first option. For measures shorter than 4 beats, the while loop still works correctly because it tries each duration from largest to smallest. No change needed to the rest of padVoice.

3. Update `voiceToBeats` to accept and use measure's time signature. No changes needed — it already accumulates positions from durations additively. The beat positions are time-sig-agnostic.

**Do NOT change `normalizeMeasure`** — it passes through as-is.

#### ✅ VERIFY Step A1
- Run the app, load any existing 4/4 song
- Confirm it still renders and plays correctly (regression check)
- No visible changes expected — this step only adds utilities and changes a default parameter

---

### Step A2: Attach per-measure time signature in songParser.js

**File:** `src/lib/songParser.js` (or wherever songParser lives)

**Changes:**

1. In the `measureEls.forEach` loop, where measures are pushed, change:

**From:**
```js
measures.push({ number: measIdx + 1, rh, lh });
```

**To:**
```js
measures.push({
  number: measIdx + 1,
  rh,
  lh,
  timeSignature: { beats: timeBeats, beatType: beatType }
});
```

This is the only change. The variables `timeBeats` and `beatType` are already tracked and updated when `<attributes><time>` appears in the MusicXML. Now they get attached to every measure.

The top-level `timeSignature` string (`${timeBeats}/${beatType}`) should remain for the DB/display layer.

#### ✅ VERIFY Step A2
- Load a MusicXML file (any existing one)
- Open browser console
- After song loads, inspect the parsed song object. Each measure should have a `timeSignature` field:
  ```js
  { beats: 4, beatType: 4 }
  ```
- Load a 4/4 song — confirm it still renders and plays correctly

---

### Step A3: Update getMeasureWidth in vexflowHelpers.js

**File:** `src/lib/vexflowHelpers.js` (or wherever vexflowHelpers lives)

**Changes:**

1. Update `getMeasureWidth` function:

**From:**
```js
export function getMeasureWidth(measure, isFirst, fixedWidth) {
  const width = fixedWidth || DEFAULT_MEASURE_WIDTH;
  return width + (isFirst ? CLEF_EXTRA : 0);
}
```

**To:**
```js
export function getMeasureWidth(timeSig, isFirst, fixedWidth) {
  const base = fixedWidth || DEFAULT_MEASURE_WIDTH;
  const durationQ = timeSig ? (timeSig.beats / timeSig.beatType) * 4 : 4;
  const scaled = base * (durationQ / 4);
  // Enforce minimum width so VexFlow can render notes without overlap
  const clamped = Math.max(scaled, 100);
  return clamped + (isFirst ? CLEF_EXTRA : 0);
}
```

**IMPORTANT:** The first parameter changes meaning from `measure` (which was ignored) to `timeSig`. All callers must be updated in subsequent steps.

#### ✅ VERIFY Step A3
- The app may break at this point if callers haven't been updated yet
- That's expected — proceed immediately to Step A4
- If you want to verify in isolation: temporarily pass `null` from callers (behavior unchanged since `null` defaults to durationQ=4)

---

### Step A4: Update ScoreRenderer.jsx

**File:** `src/components/ScoreRenderer.jsx` (or wherever it lives)

**Changes (5 sites):**

**4a. Import measureDurationQ:**
Add at the top:
```js
import { measureDurationQ } from "../lib/measureUtils";
```
(Adjust path to match project structure.)

**4b. Update getMeasureWidth calls:**

In the `measureWidths` calculation, change:
```js
const measureWidths = measures.map((m, i) => getMeasureWidth(m, i === 0, measureWidth));
```
To:
```js
const measureWidths = measures.map((m, i) => getMeasureWidth(m.timeSignature, i === 0, measureWidth));
```

**4c. Update padVoice calls:**

Inside the `measures.forEach` loop, where voice format is processed, find:
```js
const rhEvents = padVoice(measure.rh || []);
const lhEvents = padVoice(measure.lh || []);
```
Change to:
```js
const durationQ = measureDurationQ(measure.timeSignature);
const rhEvents = padVoice(measure.rh || [], durationQ);
const lhEvents = padVoice(measure.lh || [], durationQ);
```

**4d. Update VF.Voice construction:**

Find:
```js
const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
```
Change to:
```js
const ts = measure.timeSignature || { beats: 4, beatType: 4 };
const trebleVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
```
And same for bassVoice:
```js
const bassVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
```
Keep `.setStrict(false)` on both.

**4e. Update time signature display:**

Find:
```js
treble.addClef("treble").addTimeSignature("4/4");
bass.addClef("bass").addTimeSignature("4/4");
```
Change to:
```js
const firstTs = measures[0]?.timeSignature || { beats: 4, beatType: 4 };
const tsStr = `${firstTs.beats}/${firstTs.beatType}`;
treble.addClef("treble").addTimeSignature(tsStr);
bass.addClef("bass").addTimeSignature(tsStr);
```

#### ✅ VERIFY Step A4
- Load a 4/4 song → should render identically to before
- Load `test-3-4-waltz.json` → measures should be noticeably narrower than 4/4
- Load `test-2-4-march.json` → measures should be half-width
- Time signature display should show "3/4" or "2/4" respectively
- Notes should be correctly spaced within each measure

---

### Step A5: Update ScrollEngine.jsx — Rendering

**File:** `src/components/ScrollEngine.jsx` (or wherever it lives)

This is the largest step. The changes fall into two groups: rendering (this step) and timing (Step A6).

**Changes:**

**5a. Import measureDurationQ and getMeasDurationQ:**
```js
import { measureDurationQ, getMeasDurationQ } from "../lib/measureUtils";
```

**5b. Precompute measure duration arrays.**

In the SVG render `useEffect` (the one that calls `renderCopy`), after the `measures` guard, add:

```js
const measDurations = measures.map(m => getMeasDurationQ(m));
const measStartBeats = [];
let cumBeat = 0;
for (let i = 0; i < measures.length; i++) {
  measStartBeats.push(cumBeat);
  cumBeat += measDurations[i];
}
const totalMusicalBeatsPerCopy = cumBeat;
```

**5c. Update measure width calculations.**

Find where `singleMeasureWidths` is computed:
```js
const singleMeasureWidths = measures.map(() => getMeasureWidth(null, false, measureWidth));
```
Change to:
```js
const singleMeasureWidths = measures.map((m) => getMeasureWidth(m.timeSignature, false, measureWidth));
```

**5d. Pass duration info into renderCopy.**

The `renderCopy` function needs access to per-measure durations and start beats. Change its signature:

**From:**
```js
function renderCopy(VF, ctx, measures, copyIdx, xStart, measureWidth) {
```
**To:**
```js
function renderCopy(VF, ctx, measures, copyIdx, xStart, measureWidth, measDurations, measStartBeats) {
```

Update the call site:
```js
const { beatMeta } = renderCopy(VF, ctx, measures, c, xStart, measureWidth, measDurations, measStartBeats);
```

**5e. Inside renderCopy — update measure width per measure.**

Find:
```js
const measureWidths = measures.map(() => getMeasureWidth(null, false, measureWidth));
```
Change to:
```js
const measureWidths = measures.map((m) => getMeasureWidth(m.timeSignature, false, measureWidth));
```

**5f. Inside renderCopy — update padVoice calls.**

Find:
```js
const rhEvents = padVoice(measure.rh || []);
const lhEvents = padVoice(measure.lh || []);
```
Change to:
```js
const durationQ = measDurations[measIdx];
const rhEvents = padVoice(measure.rh || [], durationQ);
const lhEvents = padVoice(measure.lh || [], durationQ);
```

**5g. Inside renderCopy — update VF.Voice construction.**

Find both:
```js
const trebleVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
const bassVoice = new VF.Voice({ num_beats: 4, beat_value: 4 })
```
Change to:
```js
const ts = measure.timeSignature || { beats: 4, beatType: 4 };
const trebleVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
const bassVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
```

**5h. Inside renderCopy — update note repositioning divisor.**

Find:
```js
let correctX = noteStartX + (trebleTicks[i] / 4) * usableWidth;
```
Change to:
```js
let correctX = noteStartX + (trebleTicks[i] / durationQ) * usableWidth;
```
Same for bass:
```js
let correctX = noteStartX + (bassTicks[i] / durationQ) * usableWidth;
```

**5i. Inside renderCopy — update musicalBeatInCopy.**

Find (voice format path):
```js
musicalBeatInCopy: measIdx * 4 + t,
```
Change to:
```js
musicalBeatInCopy: measStartBeats[measIdx] + t,
```

Find (legacy beats format path):
```js
musicalBeatInCopy: measIdx * 4 + (beat.beat - 1),
```
Change to:
```js
musicalBeatInCopy: measStartBeats[measIdx] + (beat.beat - 1),
```

#### ✅ VERIFY Step A5
- Load a 4/4 song → should render and scroll identically to before
- Load `test-3-4-waltz.json` → measures should be proportionally narrower
- Load `test-mixed-time-sigs.json` → different-width measures visible
- At this point timing may be slightly off — that's fixed in Step A6

---

### Step A6: Update ScrollEngine.jsx — Timing Chain

**File:** `src/components/ScrollEngine.jsx`

**Changes in the animation/playback useEffect (the second useEffect):**

**6a. Update totalMusicalBeatsPerCopy.**

Find:
```js
const totalMusicalBeatsPerCopy = measures.length * 4;
```
This appears in multiple places (reset loop, build events, teleport). Change ALL instances to use the precomputed value. Since this is in a different useEffect from where `measDurations` is computed, you need to either:

Option A: Recompute inside this useEffect:
```js
let totalMusicalBeatsPerCopy = 0;
for (const m of measures) totalMusicalBeatsPerCopy += getMeasDurationQ(m);
```

Option B: Store it in a ref from the render useEffect and read it here.

**Option A is simpler and recommended.**

**6b. Update pxPerBeat calculation.**

Find:
```js
const effectiveMeasureWidth = getMeasureWidth(null, false, measureWidth);
const pxPerBeat = effectiveMeasureWidth / 4;
```

With proportional widths, px-per-beat is constant across all measures by construction. Use any measure (e.g., the first) to derive it:

```js
const firstDurationQ = getMeasDurationQ(measures[0]);
const firstMeasWidth = getMeasureWidth(measures[0].timeSignature, false, measureWidth);
const pxPerBeat = firstMeasWidth / firstDurationQ;
```

Since `firstMeasWidth / firstDurationQ = baseWidth / 4` for all measures (proportional scaling), this works universally.

**6c. Update musicalBeat reset in the event-build loop.**

Find:
```js
musicalBeat: copyIdx * totalMusicalBeatsPerCopy + meta.musicalBeatInCopy,
```
This should now work correctly because `musicalBeatInCopy` was fixed in Step A5 and `totalMusicalBeatsPerCopy` is fixed above.

**6d. Update the loop teleport beat reset.**

Find in the teleport section:
```js
const totalMusicalBeats = measures.length * 4;
```
Change to:
```js
const totalMusicalBeats = totalMusicalBeatsPerCopy;
```
(Use the same variable computed in 6a.)

**6e. Update the reset loop at the start of the playback useEffect.**

Find:
```js
const totalMusicalBeatsPerCopy = measures.length * 4;
```
Replace with the recomputed value from 6a (make sure the variable is in scope).

#### ✅ VERIFY Step A6
- Load `test-3-4-waltz.json` → Play → notes should arrive at the target line in time with the metronome (if BPM is set to match)
- Load `test-2-4-march.json` → Play → half-width measures scroll at correct speed
- Load `test-mixed-time-sigs.json` → Play → scroll speed should feel consistent (constant px/second) despite varying measure widths
- Load `test-5-4-irregular.json` → Play → 5-beat measures should feel correctly timed
- Load any existing 4/4 song → confirm no regression
- **Key test:** Tap along with the metronome. Notes should consistently arrive at the target line on the beat, regardless of time signature.

---

## WORKSTREAM B: Matching Forgiveness

### Step B1: Extra notes don't kill hits in matchChord

**File:** `src/lib/noteMatching.js`

**Changes:**

Replace the `matchChord` function body:

**From:**
```js
export function matchChord(played, expected) {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missingNotes = expected.filter((n) => !playedSet.has(n));
  const extraNotes = played.filter((n) => !expectedSet.has(n));

  if (missingNotes.length === 0 && extraNotes.length === 0) {
    return { result: "hit", missingNotes, extraNotes };
  }

  if (extraNotes.length === 0 && missingNotes.length > 0) {
    return { result: "partial", missingNotes, extraNotes };
  }

  return { result: "miss", missingNotes, extraNotes };
}
```

**To:**
```js
export function matchChord(played, expected) {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missingNotes = expected.filter((n) => !playedSet.has(n));
  const extraNotes = played.filter((n) => !expectedSet.has(n));

  // All expected notes present → hit (extra notes are tolerated)
  if (missingNotes.length === 0) {
    return { result: "hit", missingNotes, extraNotes };
  }

  // Some expected notes present, none wrong → partial
  if (extraNotes.length === 0 && missingNotes.length > 0) {
    return { result: "partial", missingNotes, extraNotes };
  }

  // Some expected notes missing AND wrong notes played → miss
  return { result: "miss", missingNotes, extraNotes };
}
```

#### ✅ VERIFY Step B1
- Load `test-matching-chords.json` and play
- Target is C4+E4 chord: play C4+E4+G4 (add extra G4) → should show **green** (hit)
- Target is C4: play C4+D4 simultaneously → should show **green** (hit)
- Target is C4+E4: play only C4 → should show **amber** (partial)
- Target is C4+E4: play only D4+F4 → should show **red** (miss)

---

### Step B2: Wrong-only chords don't consume beats

**File:** Wherever the `onChord` callback processes MIDI input against beat events. This is likely in the parent practice component that wires `useMIDI`'s `onChord` to `findClosestBeat` and `matchChord`.

**Find the code that looks approximately like:**
```js
const closest = findClosestBeat(beatEvents, scrollState, windowMs);
if (!closest) { /* handle no match */ return; }
const match = matchChord(played, closest.beat.allMidi);
closest.beat.state = match.result;  // consumes the beat
```

**Add a guard before consumption:**
```js
const closest = findClosestBeat(beatEvents, scrollState, timingWindowMs);
if (!closest) { /* handle no match */ return; }
const match = matchChord(played, closest.beat.allMidi);

// If player hit ONLY wrong notes (zero overlap with expected), don't consume the beat.
// Leave it pending so the player can try again before the miss scanner catches it.
if (match.result === "miss" && match.missingNotes.length === closest.beat.allMidi.length) {
  // Optionally: record this as an "attempt" for post-session analysis
  // but do NOT change beat state or color
  return;
}

// Consume the beat
closest.beat.state = match.result === "hit" ? "hit" : match.result === "partial" ? "partial" : "missed";
```

**IMPORTANT:** Find the exact file and variable names in your project. The logic above is the pattern — adapt variable names to match your actual code.

#### ✅ VERIFY Step B2
- Load `test-matching-arpeggios.json` and play
- The file has a slow C-E-G arpeggio. Deliberately play D first (wrong note), then quickly play C → C should score as **hit** (green), not miss
- Play only wrong notes against a beat → beat should stay black/pending, then turn red after the timing window expires
- Play wrong note, wait for window to expire (beat turns red), then play correct note for the NEXT beat → next beat should score correctly (green)
- **Key test:** Miss the first note of the arpeggio, keep playing the remaining notes → remaining notes should be green. Only the missed note should eventually turn red.

---

## WORKSTREAM C: Timing Window Unification

### Step C1: Remove GRACE_MS constant and add timingWindowMs prop

**File:** `src/components/ScrollEngine.jsx`

**Changes:**

**1a. Remove the GRACE_MS constant:**
```js
// DELETE this line:
const GRACE_MS = 150;
```

**1b. Add `timingWindowMs` to the component props:**

Find the component signature:
```js
export default function ScrollEngine({ measures, bpm, playbackState, onBeatEvents, onLoopCount, onBeatMiss, scrollStateExtRef, onTap, measureWidth, metronomeEnabled = false, audioCtx = null, firstPassStart = 0, loop = true, onEnded }) {
```

Add `timingWindowMs = 300`:
```js
export default function ScrollEngine({ measures, bpm, playbackState, onBeatEvents, onLoopCount, onBeatMiss, scrollStateExtRef, onTap, measureWidth, metronomeEnabled = false, audioCtx = null, firstPassStart = 0, loop = true, onEnded, timingWindowMs = 300 }) {
```

**1c. Update the miss scanner to use timingWindowMs:**

Find:
```js
if (elapsed > evt.targetTimeMs + GRACE_MS) {
```
Change to:
```js
if (elapsed > evt.targetTimeMs + timingWindowMs) {
```

**1d. Add `timingWindowMs` to the useEffect dependency array** for the playback effect (since changing the window should restart the timing engine):

Find the dependency array at the end of the playback useEffect:
```js
}, [playbackState, svgReady, bpm]);
```
Add `timingWindowMs`:
```js
}, [playbackState, svgReady, bpm, timingWindowMs]);
```

#### ✅ VERIFY Step C1
- Load any song, play → miss detection should still work
- Timing should feel slightly more forgiving than before (300ms vs 150ms late tolerance)
- Notes that scroll past the target line should turn red after ~300ms instead of ~150ms

---

### Step C2: Update SettingsBar.jsx and parent wiring

**File:** `src/components/SettingsBar.jsx` and the parent component that manages state

**Changes in the parent component:**

**2a. Rename state variables:**

Find:
```js
const [windowMs, setWindowMs] = useState(500);
const [windowMsInput, setWindowMsInput] = useState("500");
```
Change to:
```js
const [timingWindowMs, setTimingWindowMs] = useState(300);
const [timingWindowMsInput, setTimingWindowMsInput] = useState("300");
```

**2b. Pass `timingWindowMs` to ScrollEngine:**
```jsx
<ScrollEngine
  ...
  timingWindowMs={timingWindowMs}
/>
```

**2c. Pass `timingWindowMs` to wherever `findClosestBeat` is called:**

Find the call to `findClosestBeat` and change the window parameter:
```js
// OLD:
const closest = findClosestBeat(beatEvents, scrollState, windowMs);
// NEW:
const closest = findClosestBeat(beatEvents, scrollState, timingWindowMs);
```

**Changes in SettingsBar.jsx:**

**2d. Update the prop names and label:**

Change the "Window ms" input label and props. Find:
```jsx
<label className="text-sm text-muted">
  Window ms:{" "}
  <input
    type="number"
    value={windowMsInput}
    ...
```

Change to:
```jsx
<label className="text-sm text-muted">
  Timing ±ms:{" "}
  <input
    type="number"
    value={timingWindowMsInput}
    ...
```

**2e. Update the default/validation in the onBlur handler:**

Find:
```js
if (!n || n <= 0) { setWindowMs(500); setWindowMsInput("500"); }
```
Change to:
```js
if (!n || n < 100) { setTimingWindowMs(300); setTimingWindowMsInput("300"); }
```

Note the minimum floor of 100ms.

**2f. Update the onChange handler similarly**, replacing `setWindowMs`/`setWindowMsInput` with the new names.

**2g. Update the min attribute:**
```jsx
min={100} max={2000}
```

#### ✅ VERIFY Step C2
- Settings bar should show "Timing ±ms: 300" instead of "Window ms: 500"
- Set timing to 100ms → play → very tight, lots of misses
- Set timing to 500ms → play → very forgiving
- Set timing to 50ms → on blur it should snap to 100ms minimum
- Set timing to empty → on blur should default to 300
- "Chord ms" input should be unchanged

---

## WORKSTREAM D: Test File Verification (All Workstreams)

After completing all steps above, run through each test file systematically.

### Test D1: Regression — Existing 4/4 songs
- Load any previously working song from the library
- Confirm: renders correctly, scrolls correctly, hit detection works, metronome aligns

### Test D2: test-3-4-waltz.json
- Measures should be 75% the width of a 4/4 measure at the same base width
- Time signature "3/4" should display on the first measure
- 3 quarter note beats per measure
- Metronome should click 3 times per measure

### Test D3: test-6-8-compound.json
- Measures should be same width as 3/4 (both have durationQ = 3)
- Time signature "6/8" displayed
- Notes should be eighth-note groupings
- Metronome currently clicks on quarter notes (compound meter metronome is a future enhancement)

### Test D4: test-mixed-time-sigs.json
- First measures in 4/4 should be normal width
- Measures that switch to 3/4 should be narrower
- Measures that switch to 2/4 should be even narrower
- Scroll speed should feel constant throughout (no visual acceleration/deceleration)
- Hit detection should work across all time signatures

### Test D5: test-5-4-irregular.json
- Measures should be 125% the width of 4/4
- Time signature "5/4" displayed
- 5 quarter note beats per measure

### Test D6: test-2-4-march.json
- Measures should be 50% the width of 4/4
- Time signature "2/4" displayed
- Notes should be correctly spaced within the narrow measures

### Test D7: test-matching-arpeggios.json (Matching Forgiveness)
- Play correct notes → green
- Play wrong note then correct note quickly → green (wrong note doesn't consume)
- Miss a note entirely → only that note turns red, subsequent notes still score independently
- Verify recovery is possible mid-arpeggio

### Test D8: test-matching-chords.json (Matching Forgiveness)
- Hit all expected notes + extras → green (extras tolerated)
- Hit some expected notes → amber (partial)
- Hit only wrong notes → beat stays pending, turns red after timing window

### Test D9: Timing Window
- Set to 300ms, play with moderate accuracy → reasonable hit rate
- Set to 100ms, play same passage → fewer hits, more misses
- Confirm the window is symmetric: deliberately play 200ms early → should hit at 300ms window
- Deliberately play 200ms late → should hit at 300ms window
- Play 400ms late at 300ms window → should miss

---

## Summary of All Changed Files

| File | Steps |
|------|-------|
| `measureUtils.js` | A1 |
| `songParser.js` | A2 |
| `vexflowHelpers.js` | A3 |
| `ScoreRenderer.jsx` | A4 |
| `ScrollEngine.jsx` | A5, A6, C1 |
| `noteMatching.js` | B1 |
| Parent practice component | B2, C2 |
| `SettingsBar.jsx` | C2 |
