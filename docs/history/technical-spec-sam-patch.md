# SAM Patch — Virtual Anchor at Snippet Start

## Overview

Three reported playback bugs share a single root cause: `audioAnchors`
in `useAudioSync.js` is derived by walking `activeMeasures` and
pushing an anchor only for measures that have an explicit
`audioOffsetMs`. When a snippet starts at a measure that does not
have its own `audioOffsetMs` (the typical case — only measure 1 of a
song usually carries an anchor), the snippet's `audioAnchors` is
either empty or has its first anchor at a `beatPos > 0`. This
desynchronizes the audio↔beat mapping used by ScrollEngine, which
breaks playback in three ways:

- **Bug #1 — Resume from a paused measure appears to restart the
  scroll** because elapsed time computed from `audioMsToBeatPos`
  jumps wildly when audio starts.
- **Bug #2 — Snippet audio is several seconds late** because
  `getSeekForMeasure` correctly seeks the audio element to the right
  audio-file timestamp (e.g., 14000ms for measure 4) but ScrollEngine
  interprets that audioMs as "14000ms past beat 0 of activeMeasures,"
  applying an incorrect rate and offset.
- **Bug #3 — Scroll speed and metronome shift tempo when the music
  hits the target line** because before audio starts the scroll uses
  wall-clock elapsed (`(now - scrollStartT) * rate`), but the moment
  audio starts the scroll switches to `audioSyncOffset +
  contentElapsed` where `contentElapsed` uses the broken anchors. The
  rate change is the visible speed shift.

## Root Cause

In `lib/useAudioSync.js`:

```js
const audioAnchors = useMemo(() => {
  if (!activeMeasures.length) return [];
  const anchors = [];
  let cumulativeBeats = 0;
  for (const m of activeMeasures) {
    if (m.audioOffsetMs != null) {
      anchors.push({ beatPos: cumulativeBeats, audioMs: m.audioOffsetMs });
    }
    cumulativeBeats += getMeasDurationQ(m);
  }
  return anchors;
}, [activeMeasures]);
```

For a full-song play, `activeMeasures[0]` is the song's measure 1,
which usually has `audioOffsetMs = 0` (or some small offset). An
anchor at `beatPos: 0` is pushed. The audio↔beat mapping starts at
the correct origin.

For a snippet starting at measure 5, `activeMeasures` slices out
measures 5-N. Measure 5 has no `audioOffsetMs`, so no anchor is
pushed at `beatPos: 0`. Either the array is empty (no anchors
anywhere in the snippet) or the first anchor is at some
non-zero `beatPos` (if a later measure happens to have an anchor).

Either way, ScrollEngine's `audioMsToBeatPos` falls back to a
default origin of `{ beatPos: 0, audioMs: 0 }` (the empty case) or
extrapolates backward from a non-zero anchor (the partial case),
both of which return wrong beat positions for the audio timestamps
that `getSeekForMeasure` is producing.

## The Fix

When `activeMeasures` represents a snippet, ensure there is always
an anchor at `beatPos: 0` whose `audioMs` is the audio-file timestamp
for the snippet's first measure. If the snippet's first measure
already carries an explicit `audioOffsetMs`, the existing logic
already handles it. If not, derive one by computing what the audio
timestamp *would* be at that measure using the song-level seek math.

Update `audioAnchors` in `lib/useAudioSync.js`:

```js
const audioAnchors = useMemo(() => {
  if (!activeMeasures.length) return [];
  const anchors = [];
  let cumulativeBeats = 0;
  for (const m of activeMeasures) {
    if (m.audioOffsetMs != null) {
      anchors.push({ beatPos: cumulativeBeats, audioMs: m.audioOffsetMs });
    }
    cumulativeBeats += getMeasDurationQ(m);
  }
  // Ensure the snippet has an anchor at beatPos: 0 so ScrollEngine's
  // audioMsToBeatPos has a correct origin for the snippet's first
  // measure. Without this, audio↔beat mapping is wrong whenever the
  // snippet's first measure lacks an explicit audioOffsetMs.
  if (snippet && (anchors.length === 0 || anchors[0].beatPos !== 0)) {
    const startAudioMs = getSeekForMeasure(snippet.startMeasure);
    anchors.unshift({ beatPos: 0, audioMs: startAudioMs });
  }
  return anchors;
}, [activeMeasures, snippet, song]); // eslint-disable-line react-hooks/exhaustive-deps
```

The eslint-disable is needed because `getSeekForMeasure` is a
function declared in the same module body (recreated each render);
listing it in deps would cause infinite re-memoization. The values
it actually closes over (`song`, `bpm`) are listed.

## Why This Works for All Three Bugs

**Bug #2** — When playing a snippet at measure 4, `getSeekForMeasure(4)`
returns ~11250ms (or whatever the audio offset for measure 4 is).
The audio element seeks there. ScrollEngine sees
`audioElement.currentTime = 11250ms` and asks `audioMsToBeatPos(11250)`.
With the new virtual anchor `{ beatPos: 0, audioMs: 11250 }`,
the result is `0 + (11250 - 11250) / msPerBeat = 0`. That's correct —
the audio is at the start of the snippet, which is beat 0 of
`activeMeasures`. `contentElapsed = 0`. `audioSyncOffset` is
computed correctly. Audio and visual stay aligned.

**Bug #3** — Because `audioMsToBeatPos` now returns the right beat
positions, the rate of `contentElapsed` change vs wall clock is
exactly `bpm` (as it should be). When audio starts after the
lead-in, the elapsed math switches from `(now - scrollStartT) * rate`
to `audioSyncOffset + contentElapsed` *continuously* — both produce
the same instantaneous rate. No speed shift at the target line.

**Bug #1** — When resuming from a paused measure, `getSeekForMeasure`
correctly seeks audio to the paused measure's audio timestamp.
ScrollEngine's `originPx` correctly places the paused measure at
the lead-in position. Once audio starts, `audioMsToBeatPos` returns
beat positions consistent with the paused measure's geometric
position, so `audioSyncOffset` lands on a value that keeps `elapsed`
continuous with what the wall-clock path was producing. The scroll
no longer appears to jump.

## Caveats

### `getSeekForMeasure` itself still has a latent issue for multi-anchor songs

`getSeekForMeasure` (lines 45-57 of useAudioSync.js) currently
falls back to BPM-based extrapolation from measure 1's offset when
the target measure has no `audioOffsetMs`. With multiple anchors
across the song (planned but not yet used on real songs), this
extrapolation will be wrong by the cumulative tempo drift between
anchors. Cleanup milestone 4 was supposed to fix this but did not
land.

For this patch, that latent issue does not affect the three reported
bugs because "Someone Like You" only has one anchor (at measure 1).
The current single-anchor extrapolation produces correct results
for single-anchor songs.

**Do not fix `getSeekForMeasure` in this patch.** It was scoped out
of the current cleanup pass and is its own change. Note in the
progress file as known follow-up.

### `getSnippetAudioEndMs` uses similar BPM-extrapolation math

Same situation. Single-anchor songs work correctly. Multi-anchor
correction is out of scope here.

## Components Affected

| File | Change |
|------|--------|
| `lib/useAudioSync.js` | Add virtual anchor injection (~5 lines) |

That is the entire patch. No changes to ScrollEngine, SamPlayer,
or any other file.

## Success Criteria

- Bug #1: Resuming a paused snippet (paused at any measure) starts
  the scroll at the paused measure, with audio and visual aligned.
- Bug #2: Audio playback for a snippet starting at measure 4 hears
  the first lyric at the same wall-clock moment as audio playback
  starting from measure 1 (relative to when the note crosses the
  target line).
- Bug #3: Scroll speed is constant from the moment scroll begins
  through the entire snippet — no tempo shift when audio starts or
  when notes cross the target line.
- No new console errors or warnings.
- No regression in full-song playback (the case that already worked).
