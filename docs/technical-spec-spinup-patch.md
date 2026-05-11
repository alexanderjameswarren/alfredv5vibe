# SAM Patch — Audio Spin-Up Freeze at Target Line

## Overview

When the first note crosses the target line, the visual scroll
freezes for ~25ms ("drag" feel) before resuming at correct speed.
This is the residual symptom of bug #3 from the earlier debug pass.
It is not a tempo issue (sustained rate offset) — it is a one-time
~3-frame freeze caused by HTMLMediaElement's startup latency
desynchronizing from the playback effect's moment of switching from
wall-clock to audio-clock as the elapsed-time source.

Diagnostic evidence from a full-song play (m.1, `seekMs = 0`):

```
Frame 0: wallElapsed=2175.9, audioMs=0.0, elapsed=2175.9
Frame 1: wallElapsed=2184.4, audioMs=0.0, elapsed=2175.9  ← frozen
Frame 2: wallElapsed=2192.6, audioMs=0.0, elapsed=2175.9  ← frozen
Frame 3: wallElapsed=2201.0, audioMs=2.7, elapsed=2178.1  ← resumes
```

For three frames (~25ms), `audioElement.paused === false` but
`audioElement.currentTime` has not yet started advancing past the
seek target. ScrollEngine commits `audioSyncOffset` on the first
such frame using the stale `currentTime`, then `elapsed` stays
frozen until `currentTime` actually starts moving.

## Root Cause

In `ScrollEngine.jsx`, lines 271-277:

```js
if (audioElement && !audioElement.paused) {
  const audioMs = audioElement.currentTime * 1000;
  const contentElapsed = audioMsToBeatPos(audioMs) * msPerBeat;
  if (state.audioSyncOffset === null) {
    state.audioSyncOffset = (now - state.scrollStartT) * rate - contentElapsed;
  }
  elapsed = state.audioSyncOffset + contentElapsed;
```

The branch is gated on `!audioElement.paused`, which is true the
moment `play()` is called. But the audio engine itself takes
20-100ms to actually start emitting samples; during that window
`currentTime` reports the post-seek value unchanged. By the spec,
`paused` flips synchronously on `play()` while `currentTime`
advances only once playback is actually producing output.

`audioSyncOffset` is computed once (the `=== null` guard) using
`(now - scrollStartT) * rate - contentElapsed`. When
`contentElapsed = 0` (because `audioMs = 0` for several frames),
`audioSyncOffset = wallElapsed - 0 = wallElapsed_at_lock_moment`.
Subsequent frames compute `elapsed = audioSyncOffset + contentElapsed`.
With `contentElapsed` still 0, `elapsed` stays frozen at the
wallElapsed value from the lock moment. Once `currentTime` finally
starts advancing, `contentElapsed` grows from 0 → real value, and
`elapsed` resumes — but the lock moment was wrong, so the catch-up
manifests as a 25ms scroll stall.

## The Fix

Defer locking `audioSyncOffset` until `currentTime` has actually
advanced. Track the previous `audioMs` value across frames; treat
`audioMs > lastAudioMs` as the signal that the audio engine has
started producing samples. While that signal has not yet fired,
fall through to the wall-clock branch (same formula as the lead-in
phase).

The fix needs to handle the edge case where the seek target is `0`
(full song from m.1 with `audioOffsetMs1 = 0`). In that case,
`audioMs = 0` initially and `audioMs = 0` after spin-up for one
more frame before advancing. The "has it advanced" check works for
this case because `lastAudioMs` initializes to `null` and the
strict `>` comparison correctly detects the first transition from
0 → nonzero.

In `ScrollEngine.jsx`, replace the audio-playing branch
(lines 271-286 currently, including the snippet-end-pause check
that immediately follows). New shape:

```js
if (audioElement && !audioElement.paused) {
  const audioMs = audioElement.currentTime * 1000;

  // HTMLMediaElement's `paused` flips synchronously on play(), but
  // `currentTime` only advances once the audio engine starts producing
  // samples (~20-100ms after play()). Locking audioSyncOffset using a
  // pre-advance currentTime value freezes elapsed for the spin-up window
  // — the visible "scroll stall" at the target-line crossing. Wait for
  // currentTime to actually move before committing the offset; until
  // then, fall through to wall-clock elapsed (same formula as lead-in).
  const audioAdvancing =
    state.lastAudioMs != null && audioMs > state.lastAudioMs;
  state.lastAudioMs = audioMs;

  if (state.audioSyncOffset === null && !audioAdvancing) {
    elapsed = (now - state.scrollStartT) * rate;
  } else {
    const contentElapsed = audioMsToBeatPos(audioMs) * msPerBeat;
    if (state.audioSyncOffset === null) {
      state.audioSyncOffset =
        (now - state.scrollStartT) * rate - contentElapsed;
    }
    elapsed = state.audioSyncOffset + contentElapsed;
    if (elapsed < 0) elapsed = 0;
  }

  // Pause audio when snippet's real measures end (rest measures follow)
  if (state.audioEndMs != null && audioMs >= state.audioEndMs) {
    audioElement.pause();
    state.audioRestPaused = true;
    state.restWallAnchor = now;
    state.restElapsedAnchor = elapsed;
  }
}
```

Also add `lastAudioMs: null` to the `scrollStateRef.current = { ... }`
initialization block (line 242-252):

```js
scrollStateRef.current = {
  scrollStartT: performance.now(),
  originPx,
  pxPerMs,
  targetX,
  copyWidth,
  audioSyncOffset: null,
  lastAudioMs: null,                  // NEW
  audioEndMs,
  audioRestPaused: false,
  playbackRate: audioElement ? (audioElement.playbackRate || 1) : 1,
};
```

## Why This Works

While the audio engine is spinning up:
- `lastAudioMs` is null on entry to the branch (first frame), so
  `audioAdvancing = false`.
- The wall-clock formula computes `elapsed`, matching the lead-in
  formula exactly. Visually continuous.
- `lastAudioMs` is updated each frame.
- After 1+ frames where `audioMs` doesn't change, `audioAdvancing`
  remains false (because `audioMs > lastAudioMs` is false when
  they're equal).

The first frame where `audioMs > lastAudioMs`:
- `audioAdvancing = true`.
- Branch into the offset-commit path.
- `audioSyncOffset = (now - scrollStartT) * rate - contentElapsed`.
- `elapsed = audioSyncOffset + contentElapsed = (now - scrollStartT) * rate`.

That's the same value the wall-clock branch produced on the
previous frame, with one frame's worth of additional progress.
**Continuous.** From this frame forward, the audio-sync branch
governs `elapsed`, but the offset was committed at the moment audio
*actually* started — not at the moment `paused` flipped. No stall.

## Why Not Just Use Wall Clock Throughout

The reason ScrollEngine switches to audio-clock at all is to
correct for clock drift: if the audio engine plays at 0.999×
real-time, scroll should match audio's rate, not wall-clock rate,
or audio and visual will drift apart over the course of the song.
The audio-clock branch is correct in steady state. The bug is only
in the transition.

## Components Affected

| File | Change |
|------|--------|
| `ScrollEngine.jsx` | Add `lastAudioMs` to scrollStateRef init; add `audioAdvancing` gate in audio-playing branch |

No other files change. Specifically: do not modify `useAudioSync`,
do not modify `prepareAudioSeek` or `scheduleAudioStartOnScroll`,
do not change `originPx`/`approachMs` math.

## Caveats

This fix addresses the spin-up freeze only. It does not change
steady-state audio-sync behavior: once `audioSyncOffset` is
committed, the elapsed math is identical to before.

If audio playback rate genuinely differs from wall-clock rate (e.g.,
0.99×), the visible scroll matches audio rate after the lock — same
as before this fix. That sustained-rate-mismatch case is not
addressed here and is a separate concern; observed audio playback
on the dev machine should be at 1.0× wall-clock for content played
at `playbackSpeed=100`.

The first frame's wall-clock-elapsed branch uses `rate` from
`state.playbackRate`. This matches the lead-in formula. In the
edge case where `playbackRate` was changed between lead-in start
and audio actually starting, both formulas would use the same
captured value — consistent.

## Success Criteria

- Press Play on full song from m.1. Watch the first note approach
  the target line. **No visual stutter** as the note crosses the
  target line. Scroll appears to move at constant speed throughout
  the lead-in and into the playing phase.
- Press Play on a snippet starting at m.4. Same expected behavior:
  no stutter at target-line crossing.
- Resume from a paused snippet (e.g., m.4-8 paused at m.6). Same
  expected behavior: no stutter when m.6 crosses the target line.
- Audio remains synced with visual after the transition (i.e., the
  fix doesn't introduce a new offset between audio and the score).
- Metronome ticks (when enabled) remain at constant tempo across
  the transition.
- No regression in steady-state playback or in playback at
  non-100% speeds.
