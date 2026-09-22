# SAM Practice Mode — Technical Spec

## Overview
A new **Practice** button next to Play. It scrolls the score exactly like Play (same tempo, same speed control, same loaded range), but the scroll stops whenever a note is graded incorrect. The scroll resumes only when every note of that beat is held down at the same time. Practice mode is for working out fingering and chords, not for measuring performance, so it records nothing.

## Behaviour

### Starting
- The Practice button sits immediately to the right of Play and matches its styling. It must be legible at a distance (Alex plays without glasses).
- It starts playback from the same position, at the same tempo, over the same range (whole song or snippet, including repeat and rest settings) that Play would use.
- While Practice is running, the button shows an active state. Stop/reset works the same as for Play.
- Play and Practice cannot run at the same time.

### Backing audio
- Backing audio (synced recording, stems, and any synth playback) is off in Practice mode. Metronome behaviour may follow Play.

### Stopping
- The scroll stops the moment the existing grader marks a note incorrect. This covers two cases:
  - **Wrong note:** a key is pressed that the grader marks as wrong. Stop immediately. The target beat is the beat the grader associated that press with.
  - **Missed note:** a required note was never played and its timing window has closed. The grader only knows this after the window passes, so the score will have scrolled slightly past the beat. When stopping, move the score back so the missed beat sits exactly at the play line.
- In both cases the "stuck beat" is shown at the play line. Visually highlight the notes that must be held (reuse any existing highlight/colour; a clear, high-contrast cue is enough).
- Use the grader that already exists. Do not write a second grading system.

### Resuming
- The required set is every note that **starts** on the stuck beat, in the hands currently being practised. Tied continuations (notes that are only held over from an earlier beat) are not required.
- The scroll resumes when all notes in the required set are held down at the same moment. The order in which they were pressed does not matter.
- Extra or wrong keys pressed while stopped are ignored — they neither block nor delay resuming, and they are not graded or recorded.
- On resume, the song's playback clock is set to the stuck beat's exact scheduled time, as if the beat had been played on time. Playback continues at normal speed from there with no count-in. Time spent stopped is not counted and nothing is skipped.
- The keys held to satisfy the stuck beat must not be re-graded as new presses for later notes, and releasing them must not trigger anything.
- If the next note comes very quickly after resuming, that is acceptable. Accuracy matters here, not tempo.

### Recording — nothing
Practice mode must write nothing, anywhere:
- no `sam_sessions` row, no `sam_session_events`, no `sam_passes` row, no pass counter increment;
- no practice-plan progress or checklist changes;
- no accuracy or statistics updates, no practice-time totals, no "last played" or similar fields, and no browser-storage stats.
The cleanest approach is a single practice-mode flag checked at every recording entry point, rather than scattered checks.

### End of range
- At the end of the range, behave like Play (loop with the same rest setting if repeat is on, otherwise stop). Completing the range in Practice mode is never a pass.

## Out of scope
- Count-in after resume.
- Backing audio in Practice mode.
- Any database or MCP tool changes. This feature is app-side only.

## Success criteria
1. Practice scrolls at the same speed as Play with backing audio off.
2. A wrong note stops the scroll immediately; a missed note stops it with the missed beat moved back to the play line.
3. Holding all of that beat's notes together resumes playback from that beat's scheduled time; wrong keys while stopped are ignored.
4. After any Practice run, no new rows exist in `sam_sessions`, `sam_session_events` or `sam_passes`, and plan progress is unchanged.
5. Normal Play behaves exactly as before.
