# Technical Spec: Full Score Playback

## Overview

Add a "Full playback" option alongside the existing metronome radio group. When
selected, a Web Audio synth plays the notes of the score in time with the
existing scroll, driven by the same clock the metronome already uses.

Primary purpose: **auditioning simplifier output.** The user needs to hear
whether a simplified variant still sounds like the piece, without being able to
play it themselves. Timbre fidelity is explicitly not a goal; rhythmic and
harmonic accuracy are.

## Architecture decisions

### D1 — Raw Web Audio, not Tone.js

Tone.js is not a dependency of this project and will not be added. `playClick`
(`scoreRender.js:821-832`) is already the established pattern: create
oscillator + gain per event, schedule against `audioCtx.currentTime`,
fire-and-forget. A note voice is the same shape with a MIDI-derived frequency
and a longer envelope.

Rationale: no new dependency, no second AudioContext, no third timebase to
reconcile with the `<audio>` element and the scroll clock.

### D2 — Onsets come from the existing beat events; only durations are new

Beat events are built by interleaving both hands' tick maps
(`scoreRender.js:531-580`) and each carries `targetTimeMs` in content-time
(`ScrollEngine.jsx:221-223`). Every note onset therefore already coincides with
a beat event.

The synth must NOT compute its own onset times from `msPerBeat`. It joins to
the existing beat events, guaranteeing the synth and the scroll can never
drift.

What beat events do not carry is note-off. Computing sounding duration —
including tie chains and tuplets — is the only genuinely new timing work.

### D3 — Scheduling mirrors the metronome exactly

Content-time comparison inside the rAF loop, 100ms lookahead, wall-clock
conversion at the `audioCtx` boundary via `/ rate`:

```js
playNote(audioCtx, audioCtx.currentTime + delayS / rate, midi, durationS / rate);
```

Note duration takes the same `/ rate` divisor as the delay. Without it, held
notes run long at reduced speed.

`playbackSpeed` is not a new control. `rate` is read off
`scrollStateRef.current.playbackRate` (`ScrollEngine.jsx:285`), which is `1`
when there is no audio file. Full playback works at BPM in the no-audio case
with no additional wiring.

### D4 — Separate state, orthogonal to the metronome

`metronome` is a single string enum covering four options of one dimension.
Full playback is a different dimension — the user may plausibly want synth and
a click simultaneously. Add a second piece of state rather than widening the
existing enum.

```js
// "full" = both hands; see D8 for the lh/rh values added after M4.
const [scorePlayback, setScorePlayback] = useState("off"); // "off" | "lh" | "rh" | "full"
```

### D5 — Mode is fixed for the duration of a playback run

`StatsBar` is unmounted while `playbackState === "playing"`
(`SamPlayer.jsx:675-745`), so the mode can only be changed while stopped or
paused. `scorePlayback` is therefore captured by the ScrollEngine effect the
same way `audioCtx` is, and does NOT go in the dep array — adding it would
restart playback from the top on toggle.

### D6 — MP3 mutes during full playback

When `scorePlayback === "full"` and an audio file exists, the `<audio>` element
is muted for the run. Scroll sync still reads `audioElement.currentTime`, so
anchor interpolation is unaffected — only output is silenced.

Deliberately not implemented: a combined synth + recording mode. If the A/B
turns out useful for simplifier testing it becomes a `"full+audio"` enum value,
no structural change.

### D7 — Both hands, always ~~(superseded 2026-08-10)~~

> **Superseded at the user's request after M4 shipped.** Score playback is now
> a four-value enum — `"off" | "lh" | "rh" | "full"` — where `"full"` is both
> hands and `lh`/`rh` sound one hand only. See D8.

~~v1 ignores `handMode`. Playing only the hand the user is not practicing is a
plausible future feature but is a practice aid, not an audition tool, and is
out of scope.~~

### D8 — Hand selection is independent of the snippet's `handMode`

The two are deliberately NOT coupled:

- a snippet's `handMode` selects the hand the **player is scored on**
  (miss detection, MIDI chord matching)
- `scorePlayback` selects the hand the **synth sounds**

Keeping them separate is what makes the useful combination possible: set a
snippet to `rh` and score playback to `lh`, and you practise the right hand
against a synthesised left hand. Deriving one from the other would make that
unreachable.

Implementation is a filter on the timeline's existing per-note `hand` field.
Onsets, durations and tie resolution are hand-agnostic and unchanged, so this
adds no new timing logic — see progress note N18.

Labels follow `SnippetPanel`'s vocabulary (LH / RH). The both-hands value stays
`"full"` rather than becoming `"both"`, to keep the feature's name and every
prior decision in this document valid.

## New files

### `src/sam/lib/noteTimeline.js`

Pure module, no audio, no React. Fully unit-testable.

```js
buildNoteTimeline(measures) -> {
  notes: [{ onsetBeats, durationBeats, midi, hand }],  // sorted by onsetBeats
  warnings: [string],
}
```

Rules:

- Walk `rh` and `lh` independently, accumulating a beat cursor per hand.
- At each measure boundary, snap the cursor to
  `measureStartBeats + getMeasDurationQ(measure)`. Do not let a malformed
  measure drift the whole timeline.
- Event durations come from `measureUtils.getEventBeats`, never
  `durations.tokenToBeats`. `getEventBeats` is the tuplet-aware wrapper; a
  triplet eighth stores `duration: "8"` with `tuplet: {actual:3, normal:2}` and
  sounds `0.333` beats, not `0.5`. Triplets are live in the corpus (Bach
  Invention, Moonlight).
- Rests are events with `notes: []`. Advance the cursor, emit nothing.
- **Tie handling.** `tie` is a per-note string: `"start" | "end" | "both"`,
  where `"both"` is a middle link in a 3+ chain.
  - Skip any note whose `tie` is `"end"` or `"both"` — it is a continuation and
    was already consumed by its chain head.
  - For a note whose `tie` is `"start"`, walk forward through subsequent events
    in the same hand, matching on `midi`, accumulating `getEventBeats` until a
    note with `tie === "end"` is found. Continue through `"both"` links.
  - If a chain does not resolve before the end of the hand, emit it with the
    accumulated duration and push a warning. Do not throw.
  - Do NOT reuse the renderer's tie logic. `drawStaveTies`
    (`scoreRender.js:151-170`) does pairwise adjacency matching for drawing
    arcs and does not model total sounding duration. The
    `every(n => n.tie === "end")` predicate at `scoreRender.js:541-545` is also
    not reusable — a chord where one voice ties and another re-articulates
    fails it.
- Apply an articulation gap so repeated pitches don't fuse:
  `durationBeats = max(durationBeats - gap, durationBeats * 0.5)` where `gap`
  is small and expressed in beats.

### `src/sam/lib/synthVoice.js`

```js
getMasterBus(audioCtx) -> GainNode   // lazily created, cached per context
playNote(audioCtx, when, midi, durationS, velocity) -> { osc, gain }
midiToFreq(midi) -> number           // 440 * 2 ** ((midi - 69) / 12)
```

- Triangle oscillator. Fast attack (~5ms), decay to a low sustain, short
  release. Percussive attacks make it easier to hear whether the melody line
  survived a transform.
- Routes through a shared master gain bus rather than straight to
  `destination`. Full playback can stack 8+ simultaneous notes across both
  hands and clips badly without headroom. Migrate `playClick` onto the same bus
  so click and synth share a master level.
- Returns the created nodes so the caller can track and stop them.

## Changed files

### `src/sam/lib/scoreRender.js`

- Expose beat position on each beat event. The tick map at `:531-580` already
  has it; add it to the emitted object as `beatPos` so the note timeline can
  join onsets to `targetTimeMs`. Purely additive.
- Repoint `playClick` at the shared master bus (D2 of synthVoice).

### `src/sam/components/ScrollEngine.jsx`

- Build the scheduled note list once per playback start, in the same block that
  computes `targetTimeMs` (`:221-223`): join `buildNoteTimeline` output to the
  beat events on `beatPos` to resolve `onsetMs`, and convert `durationBeats` to
  `durationMs` via `msPerBeat`.
- Add the scheduler immediately after the metronome block (`:439-467`), same
  100ms lookahead, same `/ rate` conversion. Advance a monotonic
  `nextNoteIdx` cursor exactly as `nextMetroBeatIdx` works — the timeline is
  onset-sorted, so a single forward cursor suffices.
- Track scheduled nodes in an array. On effect cleanup, call `stop(0)` on every
  node still pending. This is new — the metronome has no precedent to copy
  because a 40ms click doesn't survive a pause, but a whole note scheduled 2s
  out will ring through one.
- **Loop teleport.** The reset block at `:364-433` resets beat event states but
  deliberately does not reset `nextMetroBeatIdx`, because `elapsed` is
  continuous across a teleport. The note cursor is NOT in the same position —
  it indexes score content, which does wrap. Mirror whatever the beat-event
  state reset does, and stop pending nodes at the teleport.

### `src/sam/components/SamPlayer.jsx`

- `scorePlayback` state (D4), passed to `StatsBar` and `ScrollEngine`.
- Not persisted, not in `DEFAULTS`, not reset by `handleSongLoaded` — matches
  how `metronome` is handled today.
- Mute/unmute `audioElement` per D6.

### `src/sam/components/StatsBar.jsx`

- New radio group `name="scorePlayback"`, values `off` / `full`, styled
  identically to the metronome group.

## Explicitly out of scope

- Note highlighting as notes sound (`colorBeatEls` exists in
  `vexflowHelpers.js` if this is wanted later).
- Audition from the stopped-state renderer (`ScoreRenderer.jsx`) — separate
  code path, separate geometry.
- Any change to hit/miss scoring. If the user plays along on MIDI while the
  synth runs, `handleChord` still scores their input. That is acceptable; the
  audition use case does not involve playing along.
- Velocity, dynamics, pedal, articulation marks.

## Success criteria

1. Full playback of Arabesque No. 2 stays in sync with the scroll from first
   measure to last, with no audible drift at the end.
2. A piece containing triplets (Bach Invention or Moonlight) plays with correct
   triplet timing.
3. A piece containing cross-barline ties plays each tied note once, held for
   its full combined duration.
4. Playback works with no audio file loaded, at BPM.
5. At 60% speed with an audio file, notes stretch rather than becoming
   staccato.
6. Pause mid-piece produces silence within ~100ms; no note rings on.
7. Loop mode plays the same notes on every pass.
8. The metronome still works, alone and simultaneously with full playback.
