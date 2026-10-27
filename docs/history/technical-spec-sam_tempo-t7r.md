# SAM — tempo against the plan, and the double lead-in

Two changes to the /sam player. No database work: the plan, its items and
`target_effective_bpm` are already loaded by `loadActivePlan`.

## Part A: tempo warning against the practice plan

### When it applies

Only when a plan item matches what is loaded, by the existing identity rule
(`itemForLoadedRange`): the same song and the same saved snippet, or the whole
song with no snippet. No matching by bars. With no matching item, every tempo
control looks exactly as it does today.

### The comparison

`planTempoCheck(item, bpm, playbackSpeed, { rungPercent, pausedMidLadder })` in
`src/sam/lib/activePlan.js`:

- heard = round(bpm × speed / 100) (`heardTempo`), compared with the item's
  `target_effective_bpm`. Never `default_bpm` or `goal_bpm`.
- `none`: no item, no target, or no usable tempo.
- `warmup`: a ladder rung below 100% is running, or a ladder was paused mid-run
  (Resume and Restart restart it at rung one, so the box's tempo is about to be
  replaced). The UI treats this exactly like `none`.
- `on`, `slower` or `faster` otherwise. `planBpm` is always returned when the
  item has a target.

### The qualifying rule, and the wording

A pass qualifies when `effective_bpm >= target_effective_bpm` (migrations 054
and 078, mirrored by `passQualifies`). There is no tolerance in either
direction: one beat slow does not count, and any faster pass does count on
tempo. So:

- Slower: red, "Below plan goal: 60" (Alex's wording, 2026-10-27).
- Faster: blue, "Faster than plan (60)". It still counts.

### Where it shows

The words come from one helper, `planTempoText`, used by both places below.

1. **Tempo box (rail, stopped and paused).** The message under the box, red when
   slower and blue when faster, with the box border to match; nothing when on
   plan. Updates live as the box or speed changes: it reads the draft
   (`.preview`), as Save does.
2. **Set tempo** moved from the far right of the plan line to the rail, directly
   above Save under the tempo box. Shown only when an item matches and the
   status is `slower` or `faster`. It calls the same `applyPlanTempo` as before.
3. **Playing bar.** A tempo alert in `FocusedPlaybackBar`, top row beside Pause,
   for the run in progress: solid red with a down arrow when slower, a blue
   outline with an up arrow when faster. Shown only for `slower` or `faster`.
   Quiet on warm-up rungs below 100%.

Never blocks playback. No popups. Red and blue only; amber stays with the Goal
button's "below goal".

## Part B: double lead-in after a tempo change

**Fixed (2026-10-27).** Cause 2 below, confirmed by Alex's logging. The scroll
effect no longer depends on `firstPassStart`: it is read when a run starts, and
Resume always starts one through `playbackState`. Cause 1 also fixed, by an
explicit signal rather than timing: when a warm-up rung advance changes the BPM
at the wrap, SamPlayer sets `continueAtWrapRef`; ScrollEngine takes it once when
the run restarts and carries on from the top of the range with no new lead-in.
Only a run already playing, with no audio, honours it. Every other restart keeps
the full lead-in. The audio-finished-loading restart is left as is (Alex,
2026-10-27).

Investigation notes, as written before the fix:

The scroll effect (`ScrollEngine.jsx`, deps at the end of the animation effect)
restarts from a fresh lead-in whenever any of these change while playing:
`playbackState`, `svgReady`, `bpm`, `timingWindowMs`, `audioElement`,
`firstPassStart`, `restMeasureCount`. `svgReady` toggles whenever `measures`,
`measureWidth` or `loop` change, and `measures` changes with `song`. Since
2026-10-13 every lead-in lasts at least 3 seconds (`leadIn.js`), so a restart
that used to be a short hop is now obvious.

Candidates, most likely first:

1. **Warm-up rung advance.** At the wrap, `handleLoopCount` puts the next rung's
   tempo in the box (`applyRungTempo`), which changes `bpm` and restarts the
   scroll with a full lead-in at the new tempo.
2. **Resume from a later bar.** `firstPassStart` comes from `pausedMeasure`. At
   the first wrap after Resume, `handleLoopCount` clears `pausedMeasure`, so
   `firstPassStart` changes and the scroll restarts.
3. **Tempo committed after playback starts.** The box saves on blur. If it still
   has focus when Resume is pressed, the commit lands later and changes `bpm`.
   Unlikely on desktop, where pressing the button takes focus first.
4. **Audio still loading** when Play is pressed (`audioElement` changes). Only for
   a song with audio.
