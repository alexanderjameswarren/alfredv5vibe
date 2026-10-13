# SAM play tweaks — technical spec (sam_play_tweaks-h3n)

Two changes to SAM's song player. No database changes.

## Tweak 1: lead-in from tempo

**Today.** The lead-in is a fixed screen distance: the first note starts
`SCROLL_GEOMETRY.leadInPct` (25%) of the scroll box's width to the right of the
play line, and scrolls in at the score's speed. Nothing is stored or
configurable. Its length in seconds falls as tempo rises.

**Rule.** Lead-in = today's distance + the smallest number of whole beats that
makes the total last at least 3 real seconds (`SCROLL_GEOMETRY.leadInMinMs`).
Never shorter than today. A beat is a quarter note, the same unit as BPM.

**Real scroll speed.** "Real seconds" means wall-clock time at the speed the
score actually scrolls:

- Practice: BPM × speed %, folded into the bpm ScrollEngine receives.
- Play with backing audio: BPM, with the clock scaled by the audio's
  playbackRate (speed % / 100).
- Play without backing audio: BPM only. Speed % does not reach the scroll here
  (known gap, deliberately not fixed in this project).

**One calculation.** `src/sam/lib/leadIn.js` exports `leadInPx()`, used by
ScrollEngine (where the score starts) and by useAudioSync (when backing audio
starts). They must agree or audio starts out of step with the first note.

**Effect elsewhere.** Every target time, the metronome grid and the loop wrap
are measured from the same origin, so they move with it. Adding whole beats
keeps metronome clicks on the same grid. Pass counting, plan progress and
accuracy are unaffected.

**Where it applies.** Every run start: Play, Practice, Warmup (including a rung
change, which restarts the scroll), and resume after Pause. There is no lead-in
between loop cycles, and none after a Practice stop.

**Display.** None. No countdown or overlay.

## Tweak 2: early first note on loops

**Cause.** The player renders three copies of the range. At the loop wrap
(teleport), every beat of every copy is reset to pending and the per-cycle
counters rotate. The wrap fires just before the next cycle's first note, so an
early press is matched to copy 1's first beat, counted in the OUTGOING cycle,
and then reset. The new cycle then marks it missed.

**Fix.**
1. Carry-over: at the wrap, beats in the incoming copy that are already
   resolved keep their state and colour in the new copy 0.
2. Credit: an early press on the next cycle's first beat is graded and coloured
   at once, but recorded only after the counters rotate, so it counts toward the
   new cycle.
3. Window: the first scoreable beat of each cycle accepts presses up to
   max(timingWindowMs, one beat) early. The late side is unchanged.

**Safety rules for the wider window.**
- (a) It applies only when every scoreable beat of the outgoing cycle is
  resolved, so a late last note is never stolen.
- (b) It applies only when the press is nearer the new first beat than the old
  last beat. A wrong note in that zone is recorded as an extra against the old
  cycle.

**Coverage.** Snippet loops and whole-song loops, with or without rest bars.

**Stats.** The new cycle loses its false miss and the old cycle its surplus
hit. Early offsets of up to one beat now enter the average timing.

## Step 3b: speed % on songs without audio

**Gap.** On a song without audio the rail shows only the BPM box; there is no
Speed % control. A speed other than 100 could still arrive from the saved
song, a plan item's target speed, or Set tempo. Practice then scrolled at
BPM × speed, while Play scrolled at plain BPM. Neither matched what the box
showed.

**Fix.** On a song without audio, SamPlayer folds any speed other than 100
into the BPM box: BPM becomes round(BPM × speed / 100), and speed becomes 100.
The box, Play and Practice then all mean the same tempo. ScrollEngine gets
that BPM at rate 1, so the lead-in is timed from it.

**Side effects.** The heard tempo is unchanged, apart from rounding to a whole
BPM, so pass rows and plan credit read the same. If the song's saved speed was
not 100, Save appears on load, and saving stores the folded BPM with 100%.
Songs with audio are untouched.

## Files

New:
- src/sam/lib/leadIn.js, leadIn.test.js
- src/sam/lib/loopBoundary.js, loopBoundary.test.js
- src/sam/SamPlayer.loop.test.jsx

Changed:
- src/sam/lib/samConstants.js
- src/sam/components/ScrollEngine.jsx
- src/sam/lib/useAudioSync.js
- src/sam/SamPlayer.jsx
- src/sam/lib/noteMatching.js, noteMatching.timing.test.js
- possibly SamPlayer.hits.test.jsx, SamPlayer.audio.test.jsx, passTail.js, passTail.test.js
