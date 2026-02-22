# Sam — Time Signature Generalization, Matching Forgiveness & Timing Window Unification

## Technical Specification v1.0

**Date:** 2026-02-22
**Scope:** Generalize all hardcoded 4/4 assumptions, improve note matching forgiveness, unify timing window controls.

---

## 1. Overview

Sam currently assumes 4/4 time throughout. This spec covers three independent workstreams:

- **Workstream A (Time Signatures):** Generalize 11 hardcoded 4/4 sites across 4 files to support arbitrary time signatures from MusicXML.
- **Workstream B (Matching Forgiveness):** Change note matching to be more recovery-friendly — extra notes don't kill hits, wrong-only chords don't consume beats.
- **Workstream C (Timing Window):** Replace the confusing `windowMs` + hidden `GRACE_MS` with a single symmetric "Timing Window" control.

---

## 2. Key Concepts

### 2.1 Measure Duration in Quarter Notes (`durationQ`)

The universal currency for timing is **quarter-note equivalents**:

```
durationQ = (numerator / denominator) * 4
```

| Time Sig | durationQ | Example |
|----------|-----------|---------|
| 4/4      | 4.0       | Standard |
| 3/4      | 3.0       | Waltz |
| 2/4      | 2.0       | March/Ragtime |
| 6/8      | 3.0       | Compound duple |
| 9/8      | 4.5       | Compound triple |
| 12/8     | 6.0       | Compound quadruple |
| 5/4      | 5.0       | Irregular |
| 7/8      | 3.5       | Irregular |
| 2/2      | 4.0       | Cut time |
| 5/8      | 2.5       | Irregular |

### 2.2 Cumulative Beat Position (`musicalBeat`)

Instead of `measIdx * 4`, `musicalBeat` must be a running sum of all preceding measure durations:

```
measStartBeat[0] = 0
measStartBeat[i] = measStartBeat[i-1] + durationQ(measure[i-1])
musicalBeatInCopy = measStartBeat[measIdx] + tickPositionWithinMeasure
```

### 2.3 Proportional Measure Widths

Measure pixel width scales linearly with `durationQ`:

```
measureWidthPx = baseMeasureWidth * (durationQ / 4)
```

This preserves constant pixels-per-quarter-note across the entire score, which means `pxPerMs` remains constant and the scroll→time mapping stays linear.

### 2.4 Symmetric Timing Window

A single `timingWindowMs` (default 300ms) controls:
- `findClosestBeat()` search radius: ±timingWindowMs
- Miss scanner deadline: `targetTimeMs + timingWindowMs`

Effective window: symmetric ±300ms around the target time.

---

## 3. Workstream A: Time Signature Generalization

### 3.1 Data Model Changes

#### songParser.js

Each measure object gains a `timeSignature` field:

```js
{
  number: 1,
  rh: [...],
  lh: [...],
  timeSignature: { beats: 3, beatType: 4 }  // 3/4 time
}
```

The parser already tracks `timeBeats` and `beatType` internally and updates them when `<attributes><time>` appears. The change is simply attaching them to each measure:

```js
measures.push({
  number: measIdx + 1,
  rh, lh,
  timeSignature: { beats: timeBeats, beatType: beatType }
});
```

The top-level `timeSignature` string remains for display/DB purposes.

#### measureUtils.js

Add a new exported utility:

```js
export function measureDurationQ(timeSig) {
  if (!timeSig) return 4; // default 4/4
  return (timeSig.beats / timeSig.beatType) * 4;
}
```

Add `getMeasDurationQ(measure)` convenience:

```js
export function getMeasDurationQ(measure) {
  return measureDurationQ(measure.timeSignature);
}
```

Update `padVoice` (used in both ScoreRenderer and ScrollEngine) to accept target beats:

```js
function padVoice(events, targetBeats = 4) {
  let total = 0;
  for (const evt of events) total += DURATION_BEATS[evt.duration] || 1;
  const result = [...events];
  let remaining = targetBeats - total;
  // ... rest unchanged
}
```

### 3.2 File-by-File Changes

#### songParser.js
| Change | Description |
|--------|-------------|
| Attach time sig to measures | Add `timeSignature: { beats: timeBeats, beatType: beatType }` to each measure |

#### measureUtils.js
| Change | Description |
|--------|-------------|
| Add `measureDurationQ()` | New exported function |
| Add `getMeasDurationQ()` | Convenience wrapper |
| Update `padVoice` signature | Accept `targetBeats` parameter |

#### vexflowHelpers.js
| Change | Description |
|--------|-------------|
| `getMeasureWidth()` | Accept time sig, scale by `durationQ / 4` |

New signature:
```js
export function getMeasureWidth(timeSig, isFirst, fixedWidth) {
  const base = fixedWidth || DEFAULT_MEASURE_WIDTH;
  const durationQ = timeSig ? (timeSig.beats / timeSig.beatType) * 4 : 4;
  const scaled = base * (durationQ / 4);
  return scaled + (isFirst ? CLEF_EXTRA : 0);
}
```

#### ScoreRenderer.jsx (5 changes)

| # | Line(s) | Current | New |
|---|---------|---------|-----|
| 1 | padVoice calls | `padVoice(events)` | `padVoice(events, durationQ)` |
| 2 | VF.Voice construction | `{ num_beats: 4, beat_value: 4 }` | `{ num_beats: timeSig.beats, beat_value: timeSig.beatType }` |
| 3 | Time sig display | `addTimeSignature("4/4")` | `addTimeSignature(\`${ts.beats}/${ts.beatType}\`)` |
| 4 | getMeasureWidth calls | `getMeasureWidth(m, i === 0, measureWidth)` | `getMeasureWidth(m.timeSignature, i === 0, measureWidth)` |
| 5 | musicalBeatInCopy (if used) | Not present in ScoreRenderer | N/A |

#### ScrollEngine.jsx (9 changes)

| # | What | Current | New |
|---|------|---------|-----|
| 1 | padVoice calls | `padVoice(events)` | `padVoice(events, durationQ)` |
| 2 | VF.Voice construction | `{ num_beats: 4, beat_value: 4 }` | `{ num_beats: ts.beats, beat_value: ts.beatType }` |
| 3 | Note reposition divisor | `trebleTicks[i] / 4` | `trebleTicks[i] / durationQ` |
| 4 | `musicalBeatInCopy` | `measIdx * 4 + t` | `measStartBeat + t` (precomputed cumulative sum) |
| 5 | `totalMusicalBeatsPerCopy` | `measures.length * 4` | Sum of all measure durationQ values |
| 6 | `pxPerBeat` | `effectiveMeasureWidth / 4` | Use any measure's `width / durationQ` (constant by construction) |
| 7 | Measure width calculation | `getMeasureWidth(null, false, measureWidth)` | `getMeasureWidth(m.timeSignature, false, measureWidth)` |
| 8 | Loop teleport `totalMusicalBeats` | `measures.length * 4` | Same precomputed sum |
| 9 | `getMeasureWidth` in render | All calls | Pass time sig from measure |

### 3.3 Precomputed Arrays (ScrollEngine)

Before the render loop, compute once:

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

Then inside the per-measure render:
```js
const durationQ = measDurations[measIdx];
const measStartBeat = measStartBeats[measIdx];
// musicalBeatInCopy = measStartBeat + t  (where t is tick position within measure)
```

### 3.4 VexFlow Voice Time Signature

When creating VF.Voice:
```js
const ts = measure.timeSignature || { beats: 4, beatType: 4 };
const trebleVoice = new VF.Voice({ num_beats: ts.beats, beat_value: ts.beatType })
  .setStrict(false)
  .addTickables(trebleNotes);
```

Keep `.setStrict(false)` as a safety net but now the ticks should actually match.

### 3.5 Metronome (Compound Meter)

For compound meters (numerator divisible by 3 and ≥ 6), the metronome should click on dotted-quarter boundaries:

```js
function getMetronomeInfo(timeSig) {
  const { beats, beatType } = timeSig || { beats: 4, beatType: 4 };
  const isCompound = beats >= 6 && beats % 3 === 0;
  if (isCompound) {
    // Click on dotted quarter notes (3 eighth notes = 1.5 quarter notes)
    const clicksPerMeasure = beats / 3;
    const clickIntervalQ = (3 / beatType) * 4; // in quarter notes
    return { clicksPerMeasure, clickIntervalQ };
  }
  // Simple meter: click on each beat
  const clicksPerMeasure = beats;
  const clickIntervalQ = (1 / beatType) * 4;
  return { clicksPerMeasure, clickIntervalQ };
}
```

The metronome tick spacing in ms: `clickIntervalQ * msPerBeat` where `msPerBeat = 60000 / bpm` and bpm refers to quarter notes.

**Note:** This is a refinement. For v1 the metronome can continue clicking on quarter notes for all meters. The compound-meter enhancement can be a follow-up.

---

## 4. Workstream B: Matching Forgiveness

### 4.1 Extra Notes Don't Kill Hits

**File:** `noteMatching.js` → `matchChord()`

Current logic returns "miss" when extra notes are present even if all expected notes are played. Change:

```js
export function matchChord(played, expected) {
  const playedSet = new Set(played);
  const expectedSet = new Set(expected);

  const missingNotes = expected.filter((n) => !playedSet.has(n));
  const extraNotes = played.filter((n) => !expectedSet.has(n));

  if (missingNotes.length === 0) {
    // All expected notes present — hit regardless of extras
    return { result: "hit", missingNotes, extraNotes };
  }

  if (extraNotes.length === 0 && missingNotes.length > 0) {
    return { result: "partial", missingNotes, extraNotes };
  }

  return { result: "miss", missingNotes, extraNotes };
}
```

### 4.2 Wrong-Only Chords Don't Consume Beats

**File:** Wherever `findClosestBeat` result is processed (likely in the main practice component or a handler connected to `useMIDI`'s `onChord`).

The change: after `findClosestBeat` returns a candidate and `matchChord` is called, check if **zero** expected notes were played. If so, don't consume the beat:

```js
const match = matchChord(played, closest.beat.allMidi);

if (match.result === "miss" && match.missingNotes.length === closest.beat.allMidi.length) {
  // Every expected note is missing — player hit ONLY wrong notes.
  // Don't consume this beat. Leave it pending for another attempt.
  // Optionally: play a subtle "wrong" sound or flash indicator
  return;
}

// Otherwise: consume the beat (hit, partial, or miss-with-some-correct)
closest.beat.state = match.result;
```

This means:
- Target `[C4, E4]`, play `[D4]` → beat stays pending (zero overlap)
- Target `[C4, E4]`, play `[C4, D4]` → partial (one correct, one extra = partial by new rule since E4 missing)
- Target `[C4, E4]`, play `[C4, E4, G4]` → hit (all expected present, extra ignored)
- Target `[C4]`, play `[D4]` then play `[C4]` within window → D4 doesn't consume, C4 hits

### 4.3 Recovery Principle

The combination of 4.1 and 4.2 means:
1. Missing a note in an arpeggio leaves it pending
2. Playing subsequent correct notes scores them as hits
3. The missed note eventually turns red via the miss scanner (after timingWindowMs)
4. Player sees: one red note, rest green — "I recovered"
5. This trains the right habit: keep going, don't stop

---

## 5. Workstream C: Timing Window Unification

### 5.1 Remove GRACE_MS Constant

**File:** `ScrollEngine.jsx`

Remove: `const GRACE_MS = 150;`

### 5.2 Pass timingWindowMs as Prop

`ScrollEngine` receives `timingWindowMs` (default 300) as a prop:

```jsx
export default function ScrollEngine({
  measures, bpm, playbackState,
  timingWindowMs = 300,  // NEW — replaces both windowMs and GRACE_MS
  ...
})
```

### 5.3 Miss Scanner Uses timingWindowMs

In the animation frame loop:

```js
// OLD:
if (elapsed > evt.targetTimeMs + GRACE_MS) {

// NEW:
if (elapsed > evt.targetTimeMs + timingWindowMs) {
```

### 5.4 findClosestBeat Uses timingWindowMs

In `noteMatching.js`, `findClosestBeat` already accepts `windowMs` parameter. The caller should pass `timingWindowMs` instead of the old `windowMs`:

```js
// OLD:
const closest = findClosestBeat(beatEvents, scrollState, windowMs);

// NEW:
const closest = findClosestBeat(beatEvents, scrollState, timingWindowMs);
```

### 5.5 UI Changes (SettingsBar.jsx)

- Remove the "Window ms" input
- Rename or repurpose to "Timing Window" with default 300
- Keep "Chord ms" (separate concept — finger grouping for chords)
- Keep GRACE_MS removal (no separate late tolerance)

Old state variables to rename:
- `windowMs` → `timingWindowMs`
- `windowMsInput` → `timingWindowMsInput`

Label: `Timing ±ms`

### 5.6 Minimum Floor

Enforce minimum 100ms to prevent unusable settings:

```js
if (n < 100) n = 100;
```

---

## 6. Files Modified (Summary)

| File | Workstream | Changes |
|------|-----------|---------|
| `songParser.js` | A | Per-measure timeSignature |
| `measureUtils.js` | A | `measureDurationQ()`, `getMeasDurationQ()`, `padVoice` signature |
| `vexflowHelpers.js` | A | `getMeasureWidth()` accepts time sig |
| `ScoreRenderer.jsx` | A | 5 hardcoded 4/4 sites |
| `ScrollEngine.jsx` | A, C | 9 hardcoded 4/4 sites + GRACE_MS removal + timingWindowMs |
| `noteMatching.js` | B, C | matchChord forgiveness + findClosestBeat passes timingWindowMs |
| `SettingsBar.jsx` | C | Window → Timing Window rename, default 300 |
| Practice component (parent) | B, C | Wrong-only-chord non-consumption logic, prop wiring |

---

## 7. Testing Strategy

### Test files provided:

| File | Purpose |
|------|---------|
| `test-3-4-waltz.json` | 3/4 time — verifies measure width scaling, padding, voice construction |
| `test-6-8-compound.json` | 6/8 compound time — same durationQ as 3/4 but different beat grouping |
| `test-mixed-time-sigs.json` | Mid-piece time sig changes — verifies cumulative beat math |
| `test-5-4-irregular.json` | 5/4 time — non-integer relationship to 4/4 |
| `test-2-4-march.json` | 2/4 time — half-width measures |
| `test-matching-arpeggios.json` | Fast arpeggios for testing matching forgiveness |
| `test-matching-chords.json` | Chord accuracy edge cases |

### Verification checklist per test file:

1. Song loads without errors
2. Notation renders correctly (correct time sig display, proper note spacing)
3. Measures are proportionally sized (visual check: 3/4 narrower than 4/4)
4. Scrolling speed is consistent (notes arrive at target line at correct musical time)
5. Metronome clicks align with beats
6. Miss detection fires at correct times
7. Hit/miss/partial scoring is correct

---

## 8. Risks & Edge Cases

- **Pickup measures:** MusicXML anacrusis measures have note durations that don't fill the time signature. The parser should detect these (sum of durations < expected) and set a reduced `durationQ` or add a `pickup: true` flag. **Deferred to follow-up.**
- **Additive meters (3+2/8):** MusicXML can express these. VexFlow supports display. The `durationQ` math works correctly (5/8 = 2.5). **Supported automatically.**
- **Very long measures (e.g., 12/8 = 6Q):** Proportional width means these measures will be 1.5× the base width. At base 300px, that's 450px — acceptable.
- **Very short measures (e.g., 2/8 = 1Q):** Width = 75px. This may be too narrow for VexFlow to render notes without overlap. Consider a minimum measure width of ~100px. **Monitor during testing.**
