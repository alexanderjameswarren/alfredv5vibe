# SAM play tweaks — progress (sam_play_tweaks-h3n)

**Status: Complete (2026-10-13).**

Spec: docs/history/technical-spec-sam_play_tweaks-h3n.md

| Step | What | Status | Outcome |
|---|---|---|---|
| 1 | Lead-in helper (whole beats), shared by ScrollEngine and useAudioSync | complete | Verified on the Surface. Fly Me v3 readings: 3162 ms at 120 BPM (+5 beats), 3052 ms at 85 (+3), 3323 ms at 60 (+2). Loops still wrap with no gap. |
| 2 | Carry-over at the loop wrap; early press credited to the new cycle | complete | Verified on the Surface at the piano: the early first note scored green every cycle. |
| 3 | Wider first-note early window, with two safety rules | dropped | Not needed. After step 2, early first notes scored green every cycle with the existing window. |
| 3b | Speed % on songs without audio folded into the BPM box (Play = Practice = the box) | complete | Covered by automated tests; Alex chose to skip the Surface test. |
| 4 | Full test suites; docs | complete | SAM suite 876/876, app suite 2437/2437, CLI tests 224/224. |
| 5 | Lead-in timing check on the Surface | complete | Done as part of step 1. |

## Decisions (2026-10-13)
- The lead-in adds whole beats, not bars.
- No countdown or overlay.
- The speed % gap was first left alone, then fixed the same day as step 3b.
- The wider window (step 3) was dropped.

## Step 2 notes
- Beat events carry `copy`; copy 0 is always the pass in progress.
- Before the wrap resets the beats, ScrollEngine snapshots copy 1's states. It
  then puts them back on copy 0, recoloured (loopBoundary.js).
- SamPlayer queues graded presses on copy-1 beats and counts them in
  handleLoopCount, after setLoopIteration. A fresh run (0) drops the queue.
- An all-wrong press on a copy-1 beat is recorded as an extra. It is not held as
  `attempted`, which would otherwise carry it into a later pass.

## Findings
- On a song without audio there is no Speed % control: the rail shows the BPM
  box, and the drawer's Audio section appears only for songs with an audio
  file. A speed could still arrive from the saved song, a plan item, Set tempo,
  or the goal label. Step 3b now folds it into the BPM box.
