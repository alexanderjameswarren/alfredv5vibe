# Progress: SAM Practice Mode

## Status: Step 2 complete — awaiting verification

### Development Steps
- [x] Step 1: Reconnaissance — map where Play starts the scroll, how the playback clock works, where notes are graded, every place that records data, and how backing audio starts. Report findings and a short plan. No code changes.
- [x] Step 2: Practice button and mode — button next to Play, same scroll and range as Play, backing audio off, one practice-mode flag that blocks every recording path. No stopping yet.
- [ ] Step 3: Stop on incorrect — stop immediately on a wrong note; on a missed note, stop and move the score back so the missed beat is at the play line; highlight the required notes.
- [ ] Step 4: Resume on held chord — resume when every note starting on the stuck beat is held together; ignore wrong keys while stopped; reset the clock to the beat's scheduled time; do not re-grade the held keys.
- [ ] Step 5: Piano verification on the Surface — full run-through of all success criteria with real input, plus a check that normal Play is unchanged.

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
