# SAM play tweaks — progress (sam_play_tweaks-h3n)

Spec: docs/technical-spec-sam_play_tweaks-h3n.md

| Step | What | Status |
|---|---|---|
| 1 | Lead-in helper (whole beats) and tests, shared by ScrollEngine and useAudioSync | complete, verified 2026-10-13 (Fly Me v3: 3162 ms at 120 BPM +5 beats, 3052 ms at 85 +3, 3323 ms at 60 +2; loops wrap with no gap) |
| 2 | Carry-over at the loop wrap; credit the early press to the new cycle | done, awaiting Alex's check |
| 3 | Wider first-note early window with the two safety rules | not started |
| 4 | Full test suites; finish docs | not started |
| 5 | Alex checks the lead-in timing on his Surface after a checkpoint, before the project closes | not started |

## Decisions (2026-10-13)
- Lead-in adds whole beats, not bars.
- No countdown or overlay.
- The speed % gap in Play on songs without audio is not fixed here.

## Step 2 notes
- Beat events carry `copy`; copy 0 is always the pass in progress.
- ScrollEngine snapshots copy 1's states before the wrap's reset and puts them
  back on copy 0, recoloured (loopBoundary.js).
- SamPlayer queues graded presses on copy-1 beats and counts them in
  handleLoopCount, after setLoopIteration. A fresh run (0) drops the queue.
- An all-wrong press on a copy-1 beat is recorded as an extra, not held as
  `attempted`, which would otherwise ride into a later pass.

## Findings
- Speed % control on a song without audio: not reachable. The rail shows the
  BPM box, and the Audio section of the More drawer (Speed % and Audio sync
  BPM) renders only when the song has an audio file. Speed can still differ
  from 100 without being visible. Three things can set it: the song's saved
  playback_speed, a plan item's target_playback_speed (via Open, or via "Set
  tempo" on the plan line), and the goal label. In that case Practice scrolls at
  BPM × speed while Play scrolls at BPM.
