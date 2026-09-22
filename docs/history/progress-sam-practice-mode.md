# Progress: SAM Practice Mode

## Status: COMPLETE — verified at the piano 2026-09-22

### Development Steps
- [x] Step 1: Reconnaissance — map where Play starts the scroll, how the playback clock works, where notes are graded, every place that records data, and how backing audio starts. Report findings and a short plan. No code changes.
- [x] Step 2: Practice button and mode — button next to Play, same scroll and range as Play, backing audio off, one practice-mode flag that blocks every recording path. No stopping yet.
- [x] Step 3: Stop on incorrect — stop immediately on a wrong note; on a missed note, stop and move the score back so the missed beat is at the play line; highlight the required notes.
- [x] Step 4: Resume on held chord — resume when every note starting on the stuck beat is held together; ignore wrong keys while stopped; reset the clock to the beat's scheduled time; do not re-grade the held keys.
- [x] Step 5: Piano verification on the Surface — full run-through of all success criteria with real input, plus a check that normal Play is unchanged.

### Notes

#### Step 1 findings (2026-09-22) — no code changed

**Where Play starts the scroll.** `handlePlay` (SamPlayer.jsx:972) → `ensureAudioContext()` →
`await ensureRangeIsSaved(snippet)` → `startFromTopOfRange` (SamPlayer.jsx:929):
`resetCounters()`, `armPass()`, `beginSession()`, `clearTimers()`, `prepareAudioSeek(seekMs)`,
`setPlaybackState("playing")`. The scroll is driven solely by `playbackState === "playing"`
reaching ScrollEngine's animation effect (ScrollEngine.jsx:161). Range / repeat / rest arrive as
props already computed for Play: `measures={activeMeasures}` (snippet slice + appended rest bars),
`loop={!!snippet || songRepeatActive}`, `restMeasureCount={appendedRestCount}`, `firstPassStart`.

**The clock.** One clock, in `scrollStateRef` (ScrollEngine.jsx:472), published to SamPlayer via
`scrollStateExtRef`. `pxPerMs` comes from `bpm` and the first measure's rendered width; every beat's
`targetTimeMs` is geometric — `(xPx - originPx - targetX) / pxPerMs` — so timing and scroll position
cannot drift apart. **With no audio element, `elapsed === performance.now() - state.scrollStartT`.**
With audio it is derived from `audioElement.currentTime` through anchor interpolation plus
`audioSyncOffset`. `state.elapsed` / `state.elapsedAtMs` are published per frame; `elapsedAt()`
(noteMatching.js:60) adds the sub-frame delta so a keypress is timed to when it arrived.

  → KEY CONSEQUENCE FOR STEPS 3-4: because Practice has backing audio off, `elapsed` is a pure
  function of `scrollStartT`. Freezing is "hold elapsed at a constant"; resuming at the stuck beat's
  scheduled time is `scrollStartT = performance.now() - beat.targetTimeMs`. No count-in, nothing
  skipped, no drift.

**Grading — one grader, two entry points.**
- Wrong / partial / hit: `handleChord` (SamPlayer.jsx:461), fired by useMIDI's chord buffer
  (`chordGroupMs`, 80ms default) carrying the FIRST key's press time. `findClosestBeat` → first
  pending beat within ±`timingWindowMs`; `matchChord` → hit | partial | miss. Special case
  (SamPlayer.jsx:522): an ALL-wrong chord does not consume the beat — it stays pending so the player
  can correct, and the struck pitches park in `attemptedNotesRef` for the miss scanner.
- Missed: the forward scanner in ScrollEngine's frame (ScrollEngine.jsx:717). Fires when
  `elapsed > targetTimeMs + timingWindowMs`, so a miss is known `timingWindowMs` LATE — this is
  exactly why the spec requires moving the score back. Also `sweepUnplayedTail` at the loop teleport.

**The required set already exists.** `allMidi` / `rhMidi` / `lhMidi` on each beat event are built
from `struckMidi(evt)` (scoreRender.js:538), which deliberately excludes notes tied over from an
earlier beat. The spec's "every note that STARTS on the stuck beat, in the hands being practised" is
literally `hm === "lh" ? beat.lhMidi : hm === "rh" ? beat.rhMidi : beat.allMidi`. Nothing to compute.

**Every write path.**

| What | Where | Trigger |
|---|---|---|
| `sam_sessions` insert | usePracticeSession.js:160 | `startSession` ← `beginSession()` (Play / Resume / Restart) |
| `sam_sessions` update | usePracticeSession.js:407 | `endSession()` (Pause, Stop, close song, open plan item) |
| `sam_sessions` update, raw keepalive fetch | usePracticeSession.js:~500 | visibilitychange / pagehide net — fires WITHOUT pressing Stop |
| `sam_session_events` insert | usePracticeSession.js:371 | fan-out in `endSession` from `eventsRef` (`recordEvent` / `recordExtra`) |
| `sam_passes` insert | useSamPasses.js:137 | `recordPass` ← `creditPass` ← `handleContentEnd` / `handleRangeEnded`, gated on `armedRef` |
| Pass counter | `countPass` (usePassCounts) | local state only, on SUCCESSFUL pass insert |
| Plan progress | `refreshPlanProgress()` RPC | read-only, on successful pass insert |
| Practice stats / time | `usePracticeStats` refetch | read-only, on `onSessionEnded` |
| `sam_snippets` insert/update | snippetsApi.js:143,162 | `ensureRangeIsSaved` INSIDE `handlePlay` |
| Browser storage | NumericSettings.jsx, PlanChecklist.jsx | UI panel state only — NO practice stats in localStorage |

Blocking `beginSession`, `armPass`, `recordEvent`, `recordExtra` and `creditPass` silences everything
downstream for free, the page-hide net included (no session id exists to patch). The only write NOT
downstream of those is `ensureRangeIsSaved`.

**Backing audio, three sources.** (1) the MP3 — `prepareAudioSeek` stows a seek, ScrollEngine's
`onScrollStart` fires `scheduleAudioStartOnScroll`, which arms a timer and calls `play()`;
(2) the synth — the `scorePlayback` prop, captured once per run into `scoreOn`; (3) the metronome —
the `metronome` prop. Spec allows the metronome to follow Play, so it stays.

#### Plan for steps 2-4

- **Step 2**: `practiceMode` state + `practiceRef` (ScrollEngine captures callbacks in a dep-less
  effect, so anything read inside the frame must be a ref — the existing `passContextRef` pattern).
  `handlePracticePlay()` = `startFromTopOfRange` minus `armPass`, `beginSession`, `prepareAudioSeek`.
  Gate: pass `enabled: !practiceRef.current` INTO `usePracticeSession` and `useSamPasses` and
  short-circuit at the top of each write function, rather than at the six SamPlayer call sites — one
  flag either way, but a future call site cannot defeat it. ScrollEngine gets `audioElement={null}`,
  `scorePlayback="off"`, `onScrollStart={null}`. A stripped practice bar replaces
  `FocusedPlaybackBar`, whose Session / Passes / Accuracy readouts would be lying.
- **Step 3**: `state.frozenAtMs` in the ScrollEngine frame — when set, it IS `elapsed`, and miss
  detection, metronome, synth, teleport and content-end are all skipped; rAF keeps running.
  `stopAtBeat(evt)` sets `frozenAtMs = evt.targetTimeMs`, which both puts the beat exactly on the
  play line and is the resume time. Wired into the two existing grading points only.
- **Step 4**: held-key Set in `useMIDI` via a new optional `onHeldChange`; superset test against the
  beat's required set; resume with `scrollStartT = performance.now() - evt.targetTimeMs`,
  `frozenAtMs = null`, `evt.state = "skipped"` so neither the scanner nor `findClosestBeat` can
  revisit it. `handleChord` suppressed while frozen; chord buffer cleared on resume.

#### Decisions — settled by Alex 2026-09-22

1. **Sustain pedal ignored.** "Held" means fingers only. Held-key tracking stays minimal: a `Set`
   updated on note-on / note-off, active only in Practice. Nothing beyond that. (The gap: useMIDI.js:57
   returns early on anything but Note On velocity > 0, so today there is no concept of a held key.)
2. **Playback speed scales the scroll.** In Practice, feed ScrollEngine `bpm * playbackSpeed / 100`,
   because `playbackSpeed` only ever reached the clock through `audioElement.playbackRate` and the
   MP3 is off.
3. **Practice skips `ensureRangeIsSaved` entirely.** Practising an ad-hoc range writes nothing at
   all, not even a `sam_snippets` row.
4. **Stop on anything that is not a full `"hit"`** — partial included. On the stuck beat, keep the
   grader's EXISTING colours rather than inventing a highlight: amber/orange for a partial, red for
   wrong or missed.
5. **The all-wrong chord case stops immediately.** SamPlayer.jsx:522 leaves the beat pending so the
   player can correct it; in Practice that must stop the scroll on the spot rather than waiting
   `timingWindowMs` for the miss scanner to catch up.

#### Step 2 built (2026-09-22)

**Files changed**
- `src/sam/SamPlayer.jsx` — the flag, `handlePractice`, practice-aware transports, ScrollEngine props.
- `src/sam/lib/usePracticeSession.js` — practice guards on `startSession`, `recordEvent`,
  `recordExtra`, `endSession` and the page-hide net.
- `src/sam/lib/useSamPasses.js` — practice guards on `armPass` and `recordPass`.
- `src/sam/components/TransportControls.jsx` — the Practice button.
- `src/sam/components/SettingsBar.jsx` — passes `onPractice` through.
- `src/sam/components/PracticeBar.jsx` — NEW, the playing-state chrome for Practice.
- `src/sam/SamPlayer.practice.test.jsx` — NEW, 8 tests.

**The flag.** `practiceModeRef` (the gate, set synchronously) + `practiceMode` state (the UI),
moved together by `setPractice`. The ref is handed to both recording hooks, which guard every
function of theirs that can reach the database — not the six SamPlayer call sites, so a future
caller cannot reintroduce a write. Set by `handlePractice`, cleared by `handlePlay`, `handleStop`,
`handleFullStop`, `closeOpenSong` and `handleSongLoaded`. Cleared AFTER `endSession()` in the stop
paths, so a practice run's session close is still refused. NOT cleared by Pause — pause and resume
are one practice run interrupted, the same rule Play follows for a playthrough.

**One start path.** `startFromTopOfRange(activeSnippet, { practice })` — `practice` is the only
difference between the two transports, so range, tempo, repeat and rest cannot drift apart.
Practice skips `armPass`, `beginSession`, `ensureRangeIsSaved` and `prepareAudioSeek`.

**Audio off.** ScrollEngine gets `audioElement={null}`, `audioAnchors={EMPTY_ANCHORS}`,
`audioEndMs={null}`, `scorePlayback="off"`, `onScrollStart={null}`. Metronome untouched, per spec.

**Speed.** `practiceBpm = bpm * playbackSpeed / 100` (decision 2). Verified by test: a song at 70%
hands ScrollEngine 45.5 rather than 65, while Play still hands it 65 and lets the audio element
carry the rate.

**UI.** Practice sits immediately right of Play, identical shape (`px-4 py-2`, `min-h-[44px]`,
`text-sm`), violet instead of primary blue, stopped-state only. While running, `PracticeBar`
replaces `FocusedPlaybackBar`: a Pause button, an oversized PRACTICE badge and "Nothing is
recorded." Every number on the normal bar (Session time, Completed Passes, Playthrough accuracy,
Session accuracy) is deliberately absent — with no session behind them they would be lying.

**Verification.** 538 SAM tests pass (530 before + 8 new); production build compiles clean. The new
suite drives every grading outcome, a timed-out miss, a credited pass by both routes, pause/resume
and stop through a Practice run and asserts `mockWrites` is EMPTY — and the last test runs the
identical sequence under Play to prove the mock still records, so the assertions cannot pass
vacuously.

**Noted for Step 5:** the Practice button matches Play's size exactly, as the spec asked. If it is
not legible enough at the piano without glasses, bump both to `text-base` / `w-5 h-5` then.

#### Step 3 built (2026-09-22)

**Decisions governing steps 3 and 4, confirmed by Alex before this step**
1. Stop on anything that is not a full `"hit"`: wrong, partial and missed.
2. The all-wrong chord case (SamPlayer.jsx:522, beat left pending) stops IMMEDIATELY in Practice —
   it must not wait out the timing window for the miss scanner.
3. On the stuck beat keep the grader's EXISTING colours, no new highlight: amber/orange for a
   partial, red for wrong or missed.
4. (Step 4, not yet built) Held-key tracking stays minimal — a `Set` updated on note-on/note-off,
   active only in Practice. Sustain pedal ignored.

**Styling, same pass.** The violet Practice button was too harsh; it is now the outline treatment
its neighbours Tuning, Next and Full Song share — `border border-border`, no fill,
`text-muted-foreground hover:text-dark` — at Play's size and position, cap icon kept. Play stays the
one filled button because Play is the primary action. The PRACTICE badge is likewise neutral now
(`bg-secondary/40 border border-border`, the Playthrough badge's ground) with the text still
`text-2xl font-bold text-dark`: legibility without glasses was carried by SIZE and CONTRAST, never
by the colour.

**ONE NUMBER DOES BOTH JOBS.** `scrollState.frozenAtMs`, set by SamPlayer from inside the grader to
the stuck beat's own `targetTimeMs`. Because backing audio is off, `elapsed` is a pure function of
`scrollStartT`, so pinning it to that value simultaneously (a) puts the beat EXACTLY on the play
line — which is what moves the score BACK for a missed note, whose window only expires after the
scroll has gone past — and (b) is the value step 4 will resume from. There is no separate
"rewind" code path, and none is needed.

**ScrollEngine** (`frame`): a freeze branch at the top skips the loop teleport, the metronome, the
synth, the miss scanner and the end-of-range credit, writes the transform every frame so the score
holds position, publishes `elapsed` (Pause reads it to pick its measure) and keeps the rAF alive so
step 4's resume is seen on the next frame. The miss scanner also `break`s the instant a stop freezes
the run: two windows can expire in one frame at a fast tempo, and the second belongs to time the run
is no longer at.

**SamPlayer**: `stuckBeatRef` holds THE BEAT EVENT OBJECT, not an index or a copy — step 4 needs its
`targetTimeMs` and its `allMidi`/`rhMidi`/`lhMidi`, and the loop teleport rewrites both on every
event in the array. The freeze skips the teleport, so the object stays intact. `practiceStopAt` is
idempotent: the first stop wins, since a chord and the scanner can reach a beat in the same frame.
Wired in at the three grading outcomes only — `handleChord`'s graded branch (`result !== "hit"`),
`handleChord`'s all-wrong branch, and `handleBeatMiss` — so there is still exactly one grader.
`handleChord` returns immediately while stuck, so keys pressed then are neither graded nor recorded.
`clearStuckBeat` runs at every transport boundary.

The all-wrong branch is the only place anything is painted (red): it is the one failing outcome the
grader does not colour, because it deliberately leaves the beat PENDING so the player can correct
it. Left pending here too — an unconsumed beat is the cleanest thing for step 4 to resume from.

**Verification.** 548 SAM tests pass (538 before, 10 new); build clean. New tests cover: wrong,
partial and all-wrong stop; a full hit does not; a miss stops at the beat's own target time; the
first stop wins; keys while stuck are ignored and write nothing; Pause and Stop both leave a stopped
run silently; a fresh run starts unstuck; and — the guard against this leaking into Play — Play never
freezes on any of the four outcomes and still records. The writes-nothing test now unsticks between
outcomes, so every grading path is genuinely exercised rather than swallowed by the first freeze.

**Not covered by tests:** the ScrollEngine frame itself (transform, teleport skip, scanner break) has
no unit test — ScrollEngine is mocked out of every suite and is VexFlow/DOM-bound. That behaviour is
Surface-only verification.

#### Step 4 built (2026-09-22)

**Held keys — `useMIDI`.** A `Set`, updated on Note On and Note Off, reported through a new optional
`onHeldKeys` listener. It is the ONLY reason Note Off is looked at anywhere in SAM. Tracked only
while a listener is attached, and SamPlayer attaches one only while practising, so Play's path
through the handler is unchanged — there is a test for exactly that. A Note On with velocity 0 is
treated as a release, because plenty of keyboards send nothing else. **CC64 is deliberately absent:
"held" means fingers, and the pedal can neither add a key nor keep one.** The live Set is passed, not
a copy — copying on every key of a fast run would be pure garbage; the consumer reads it and does not
keep it.

Two small additions alongside: `cancelPendingChord()` (drop the chord group waiting to flush) and
`resetHeldKeys()` (start each run clean, so a key whose Note Off was lost to a hot-plug cannot make
every chord containing it resume for free).

**ORDERING MATTERS, AND IT IS THE SUBTLE PART.** The listener fires AFTER the chord buffer has taken
the press, not before. The key that completes a stuck chord resumes the run from inside that same
call, and the resume cancels the pending group — which is what stops those keys being graded as a
press at the beat the run has just moved on to. Notify first and that very note would be re-buffered
afterwards and land on the next beat anyway. There is a test pinning the order.

**The resume — `practiceResume`.** Required set is `requiredMidiFor(beat, handMode)` — `lhMidi`,
`rhMidi` or `allMidi`, already free of tied continuations because scoreRender builds them from
`struckMidi`. Same selection the grader itself uses, so the set required is exactly the set that was
judged. Resume fires the moment every required note is in the held set; order is irrelevant and
extras are simply not consulted. An empty required set resumes immediately rather than stranding the
run (unreachable — the scanner skips rest beats — but being stuck forever at the piano is the worst
failure this feature could have).

On resume: `beat.state = "skipped"` (the state the miss scanner AND `findClosestBeat` both step over,
so the beat can never be graded again and the keys still down cannot be read as a press at it);
`scrollStartT = now - beat.targetTimeMs`, which with backing audio off puts `elapsed` exactly at the
beat's scheduled time — no count-in, nothing skipped, time spent stopped not counted;
`frozenAtMs = null`; `cancelPendingChord()`. Colours are left exactly as the grader set them.

The loop teleport resets every beat to pending, which is right: the next pass grades it afresh.

**Metronome re-anchor.** `nextMetroBeatIdx` is a monotonic counter over `elapsed`, and a resume moves
the clock — usually BACKWARDS, by up to one timing window, since a missed beat is only known once its
window has closed. Without re-anchoring, the click fell silent until elapsed caught back up. The
frame after an unfreeze now recomputes the index from the new position. `subdivisionMs` was hoisted
out of the frame to make that possible.

**A circular dependency, broken with one ref.** `cancelPendingChord` comes out of `useMIDI`, which
needs `handleHeldKeys`, which needs `practiceResume`, which needs `cancelPendingChord`.
`cancelPendingChordRef` is what breaks the circle.

**Existing `useMIDI` mocks updated** in SamPlayer.audio / .hits / .plan tests: the hook's return
shape grew, and the doubles had to grow with it. Chose that over optional-chaining the hook's own
return value in SamPlayer, which would hide real breakage.

**Verification.** 1379 tests pass across the whole project (569 in SAM); build clean, no lint
warnings. New: `useMIDI.held.test.js` (8 tests) against the REAL hook — accumulate and release,
velocity-0 as release, pedal ignored, listener-after-buffer ordering, cancel, reset, and Play's path
untouched; plus 14 SamPlayer tests — resume on full hold, no resume on partial hold, extras ignored,
wrong keys neither resume nor block, beat settled to "skipped", chord group dropped, release after
resume does nothing, stops again on the next mistake, held keys inert when not stopped, a resumed run
still records nothing, Pause from stopped, clean held set per run, and Play attaching no listener at
all.

**Still Surface-only:** the ScrollEngine frame (transform, teleport skip, scanner break, metronome
re-anchor) has no unit test — it is mocked out of every suite and is VexFlow/DOM-bound.

#### Step 5 — verified at the Surface, 2026-09-22

Alex ran the whole feature at the piano. All five of the spec's success criteria hold.

1. **Practice scrolls at the same speed as Play with backing audio off.** Confirmed, including an
   audio-backed song at a reduced playback speed, where the percentage is folded into the bpm because
   the MP3 is no longer there to carry it.
2. **A wrong note stops the scroll immediately; a missed note stops it with the missed beat moved
   back to the play line.** Confirmed, along with the partial and all-wrong cases, and the backwards
   jump on a miss reads as deliberate rather than as a glitch.
3. **Holding all of that beat's notes together resumes from that beat's scheduled time; wrong keys
   while stopped are ignored.** Confirmed: chords held together, rolled chords, any order, extra keys
   alongside, wrong keys held first and then corrected without releasing them, one-hand snippets
   requiring only that hand, and tied notes requiring only the notes that genuinely start on the
   beat. The sustain pedal does not satisfy a chord. The metronome comes back in time after a resume,
   and a snippet still loops with its rest bars.
4. **No new rows in `sam_sessions`, `sam_session_events` or `sam_passes`, and plan progress
   unchanged.** The database check was empty after every practice run, at each of steps 2, 3 and 4.
5. **Normal Play behaves exactly as before.** Never stopped, never waited, counters and colours
   unchanged, and holding a chord down for several seconds during Play does nothing.

Feature complete. Final state: 1379 tests pass across the project (569 in SAM), build clean with no
lint warnings.

**Where the risk now sits, for whoever reads this next.** The recording gate is one flag checked
inside `usePracticeSession` and `useSamPasses`, not at SamPlayer's call sites, so a new write path
added INSIDE those hooks is covered automatically but a new hook that writes on its own would not be.
The ScrollEngine frame — the freeze, the transform, the teleport skip, the scanner break and the
metronome re-anchor — has no unit test, because ScrollEngine is mocked out of every suite and is
VexFlow/DOM-bound; that behaviour is only ever proved at the piano.
