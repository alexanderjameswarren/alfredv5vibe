# SAM play tweaks — technical spec (sam_play_tweaks-h3n)

Three changes to SAM's song player, as built. No database changes.

## 1. Lead-in from tempo

**Before.** The lead-in was a fixed screen distance: the first note started
`SCROLL_GEOMETRY.leadInPct` (25%) of the scroll box's width to the right of the
play line. Its length in seconds fell as tempo rose.

**Rule.** Lead-in = that distance + the smallest number of whole beats that
makes the total last at least 3 real seconds (`SCROLL_GEOMETRY.leadInMinMs`).
It is never shorter than before. A beat is a quarter note, the same unit as BPM.

**Real scroll speed.** The 3 seconds are measured at the speed the score
actually scrolls: the bpm ScrollEngine receives, scaled by the audio's
playbackRate when backing audio drives the clock. Since step 3, a song without
audio has its speed folded into that bpm.

**One calculation.** `src/sam/lib/leadIn.js` exports `leadInPx()`. Two places
use it: ScrollEngine, which decides where the score starts, and useAudioSync's
`getApproachMs()`, which decides when backing audio starts. ScrollEngine logs
one `[LeadIn]` console line per run start.

**Effect elsewhere.** Target times, the metronome grid and the loop wrap all
share one origin, so they move with it. Adding whole beats keeps metronome
clicks on the grid. Scoring and pass counting are unchanged.

**Where it applies.** Every run start: Play, Practice, a warm-up rung change,
and resume after Pause. There is no lead-in between loop cycles, and none after
a Practice stop. Nothing new is displayed.

## 2. Early first note at the loop wrap

**Cause.** When looping, ScrollEngine renders three copies of the range. Copy 0
is the pass in progress. At the wrap, every beat is reset to pending and the
per-cycle counters rotate. An early press just before the wrap matched copy 1's
first beat, was counted in the outgoing cycle, and was then reset. The new
cycle then marked it missed.

**Fix (`src/sam/lib/loopBoundary.js`).**
1. Carry-over. Each beat event carries `copy`. At the wrap, ScrollEngine
   snapshots copy 1's states before the reset, then puts them back on copy 0,
   recoloured for the scored hand.
2. Credit. SamPlayer grades and colours a press on a copy-1 beat at once, but
   queues it. handleLoopCount counts the queue after setLoopIteration, so the
   press lands in the new cycle. A fresh run (loop count 0) drops the queue.
3. An all-wrong press on a copy-1 beat is recorded as an extra, not held as
   `attempted`.

The timing window is unchanged. A wider early window for the first note was
considered and dropped: with this fix, early first notes score correctly with
the existing window.

**Coverage.** Snippet loops and whole-song loops, with or without rest bars.
Passes, the plan line and the warm-up ladder read the corrected per-cycle
counts.

## 3. Speed % on songs without audio

**Gap.** On a song without audio the rail shows only the BPM box. A speed other
than 100 could still arrive from four places: the saved song, a plan item, Set
tempo, or the goal label. Practice then scrolled at BPM × speed, and Play at
plain BPM.

**Fix.** In SamPlayer, on a song without audio, any speed other than 100 is
folded into the BPM box: BPM becomes round(BPM × speed / 100), and speed becomes
100. The box, Play and Practice all mean the same tempo. Songs with audio are
untouched. If a song was saved with a speed other than 100, Save appears when it
is opened, and saving stores the folded BPM at 100%.

## Files

New:
- src/sam/lib/leadIn.js, leadIn.test.js
- src/sam/lib/loopBoundary.js, loopBoundary.test.js
- src/sam/SamPlayer.loop.test.jsx
- src/sam/SamPlayer.speed.test.jsx

Changed:
- src/sam/lib/samConstants.js
- src/sam/components/ScrollEngine.jsx
- src/sam/lib/useAudioSync.js
- src/sam/SamPlayer.jsx
- src/sam/SamPlayer.practice.test.jsx
