# SAM Patch — Resume-from-Measure Race in `handleLoopCount`

## Overview

When the user pauses a snippet at measure N>start and presses Resume,
the scroll briefly displays measure N at the lead-in position — then,
~6ms later, the playback effect re-runs with `firstPassStart=0` and
overwrites the origin to position the snippet's first measure at the
lead-in instead. The user sees scroll begin at the snippet's first
measure, not the paused measure. Audio continues to play from the
paused measure correctly because `pausedMeasure` is read at the
moment Resume is clicked, before the race.

## Root Cause

`handleLoopCount` in `SamPlayer.jsx` (lines 251-255):

```js
const handleLoopCount = useCallback((n) => {
  setLoopCount(n);
  setLoopIteration(n);
  setPausedMeasure(null);
}, [setLoopIteration]);
```

This is wired into `<ScrollEngine onLoopCount={handleLoopCount}>`.
Inside ScrollEngine's playback effect (line 256):

```js
if (onLoopCount) onLoopCount(0);
```

ScrollEngine fires `onLoopCount(0)` at the start of every playback
session (full song, snippet, or resume), as part of initializing the
loop counter for the new session. This is correct from ScrollEngine's
perspective.

But SamPlayer's handler clears `pausedMeasure` regardless of `n`. So
when Resume fires:

1. `handleResume` does NOT clear `pausedMeasure` (intentionally — it
   needs to drive `firstPassStart`).
2. `setPlaybackState("playing")` triggers a re-render.
3. ScrollEngine's playback effect runs with `firstPassStart` derived
   from `pausedMeasure` (e.g., 2 for snippet m.4-8 paused at m.6).
   `originPx` is set correctly to put m.6 at the lead-in.
4. ScrollEngine fires `onLoopCount(0)` near the bottom of the effect.
5. SamPlayer's `handleLoopCount(0)` clears `pausedMeasure`.
6. SamPlayer re-renders with `pausedMeasure=null`. `firstPassStart`
   becomes 0.
7. ScrollEngine's effect re-runs because `firstPassStart` is a prop
   that changed. Now `originPx` is recomputed for `startEvtIdx=0`,
   placing the snippet's first measure (m.4) at the lead-in.

The visual effect is exactly what the user observes: scroll briefly
starts at m.6 then immediately jumps to start at m.4.

## The Fix

The intent of clearing `pausedMeasure` inside `handleLoopCount` is to
invalidate the resume-from-measure offset *when a loop wrap happens*.
On a wrap, the user no longer wants the next iteration to start at
the paused measure — they want a normal full-snippet pass. But this
intent only applies to wraps, where `n > 0`. The initial `n=0`
notification at the start of a session must not clear `pausedMeasure`
because that's the very value that drives correct origin setup.

In `SamPlayer.jsx`, change `handleLoopCount`:

```js
const handleLoopCount = useCallback((n) => {
  setLoopCount(n);
  setLoopIteration(n);
  if (n > 0) setPausedMeasure(null);
}, [setLoopIteration]);
```

Single-line change inside the existing callback.

## Why This Is the Right Layer

The race exists because two pieces of information are entangled
through one callback:
- "session started, here is the new loop counter" (n=0)
- "playback wrapped, here is the new iteration count" (n>0)

ScrollEngine treats them as the same event, but they have different
implications for `pausedMeasure` invalidation. SamPlayer is the layer
that knows what `pausedMeasure` means; ScrollEngine doesn't and
shouldn't. The fix is at the SamPlayer layer because that's where the
distinction is meaningful.

An alternative fix — removing the `onLoopCount(0)` call in ScrollEngine
— would also work but couples ScrollEngine's internal counter
semantics to SamPlayer's expectations more tightly. The chosen fix
keeps ScrollEngine's behavior (always emit on session start) and
adapts SamPlayer to the actual semantics it cares about.

## Components Affected

| File | Change |
|------|--------|
| `SamPlayer.jsx` | One-line change in `handleLoopCount` |

No other files change. Specifically: do not modify ScrollEngine's
`onLoopCount(0)` emission; do not touch the resume handler; do not
modify how `pausedMeasure` is set elsewhere.

## Caveats

This fix addresses **only** the resume-position bug (described as
"bug #1" in the previous patch round). It does not address the
scroll-speed-change-at-target-line bug ("bug #3"). That bug has a
separate root cause involving the lead-in vs audio-sync clock seam
and is out of scope for this patch.

Successful resolution of bug #1 may make bug #3 more visible (because
once the scroll is correctly positioned at the paused measure, the
user can now actually observe the speed-change behavior at the
target-line crossing). That's expected. Bug #3 will be addressed
separately.

## Success Criteria

- Apply snippet m.4-8 to "Someone Like You" with audio.
- Press Play, let it scroll until m.6 is visible. Press Pause.
- Confirm title bar shows "paused at m.6".
- Press Resume. Scroll begins at m.6 with the lead-in (m.6 enters
  from the right at the 25% lead-in offset, scrolls left to cross
  the target line, audio resumes at the corresponding moment).
- Scroll does NOT briefly start at m.6 then snap back to m.4.
- Let the snippet play to the end and wrap. On the wrap, the next
  iteration starts at m.4 normally (not at m.6) — confirming that
  the n>0 path correctly clears `pausedMeasure`.
- Repeat with full-song playback paused mid-song — same expected
  behavior.
