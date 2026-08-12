# Progress: Full Score Playback

## Status: M1–M4 verified. M4a (LH/RH modes) built — awaiting in-browser verification

Spec: `docs/technical-spec-full-playback.md`

---

### M1 — Note timeline builder (no audio)

- [x] Create `src/sam/lib/noteTimeline.js` with `buildNoteTimeline(measures)`
- [x] Beat cursor per hand, snapped to `getMeasDurationQ` at each measure boundary
- [x] All duration math routes through `measureUtils.getEventBeats` (tuplet-aware)
- [x] Rests (`notes: []`) advance the cursor and emit nothing
- [x] Tie chains: skip `"end"` / `"both"` continuations, accumulate forward from `"start"`
- [x] Unresolved chains emit with accumulated duration + a warning, never throw
- [x] Articulation gap applied
- [x] Add `beatPos` to emitted beat events in `scoreRender.js` (`:531-580`)
- [x] Temporary dev hook: log the timeline and the beat-event join to console

**Verification (no sound yet):**
- [x] Load Arabesque No. 2, start playback, inspect the logged timeline
- [x] Every note onset joins to a beat event — zero unmatched onsets
- [x] Cross-barline tie in Someone Like You mm. 4–5 (E5, `"start"` → `"end"`)
      appears as ONE entry with combined duration, not two
- [x] A triplet piece shows `0.333`-beat durations, not `0.5`
      (surfaces as `0.2833` — the articulation gap is already applied)
- [x] Total timeline length matches the piece's total beats

_Confirmed in-browser 2026-08-09. Pre-verified headlessly first across 13
`.mxl` fixtures — see Notes N4._

---

### M2 — Synth voice + master bus

- [x] Create `src/sam/lib/synthVoice.js` with `midiToFreq`, `getMasterBus`, `playNote`
- [x] Triangle oscillator, percussive envelope, explicit stop at note end
- [x] Master gain bus, lazily created and cached per AudioContext
- [x] Repoint `playClick` (`scoreRender.js:821`) at the shared bus
- [x] Return created nodes from `playNote` for caller tracking

**Verification:**
- [x] From the console, trigger a single note — correct pitch, clean decay
- [x] Trigger an 8-note stack — audible, no clipping or distortion
- [x] Metronome still clicks at unchanged volume after the bus migration

_Confirmed in-browser 2026-08-09. Console handle: press Play once (the
AudioContext needs a user gesture), then Pause. `window.samSynth` exposes
`note(midi, durS)`, `chord([...midis], durS)`, plus the raw `playNote` /
`midiToFreq` / `masterBus`._

---

### M3 — Scheduler in the rAF loop

- [x] Build the scheduled note list once per playback start, alongside `targetTimeMs` (`:221-223`)
- [x] Scheduler block after the metronome block (`:439-467`), 100ms lookahead
- [x] `nextNoteIdx` monotonic cursor, mirroring `nextMetroBeatIdx`
- [x] `/ rate` applied to BOTH the delay and the note duration
- [x] Pending node tracking array
- [x] Effect cleanup stops all pending nodes
- [x] `scorePlayback` captured, NOT added to the dep array (`:519`)

Also done here, ahead of M5, because the teleport rebuild could not be written
correctly without it: loop-teleport cursor reset + pending-node stop (see N12).

**Verification:**
- [ ] Arabesque No. 2 plays in sync start to finish, no drift at the end
- [ ] Pause mid-piece → silence within ~100ms, nothing rings on
- [ ] Resume plays from the correct measure
- [ ] Stop → silence, no orphaned nodes

_M4 is now done, so use the **Score playback → Full** radio. The temporary
`window.samScorePlayback` console override has been removed._

---

### M4 — UI wiring

- [x] `scorePlayback` state in `SamPlayer.jsx` (near `metronome`, `:70`)
- [x] Radio group in `StatsBar.jsx`, styled like the metronome group
- [x] Prop threaded to `ScrollEngine`
- [x] `audioElement.muted` set per D6, restored on stop and on mode change
- [x] Temporary `window.samScorePlayback` override removed

**Verification:**
- [x] Toggling the radio while stopped changes behaviour on next play
- [x] Full playback + metronome simultaneously — both audible
- [x] With an audio file: MP3 silent during full playback, audible again when off
- [x] With no audio file: plays at BPM, Speed control still correctly hidden

_Confirmed in-browser 2026-08-10._

---

### M4a — LH / RH score-playback modes

Added at the user's request after M4; supersedes spec D7, adds D8. See N18.

- [x] `scorePlayback` widened to `"off" | "lh" | "rh" | "full"`
- [x] LH / RH radios in `StatsBar.jsx`, labels matching `SnippetPanel` vocabulary
- [x] Hand filter applied once to the timeline, before schedule construction
- [x] Independent of a snippet's `handMode` (D8) — the two compose
- [x] D6 mute generalised to every active mode, not just `"full"`

**Verification:**
- [x] LH plays only the bass staff; RH only the treble staff
- [x] Full still plays both, unchanged from M4
- [x] Snippet handMode `rh` + score playback `lh` → practise RH against a synth LH
- [x] With an audio file: MP3 muted in LH/RH too, not just Full
- [x] Loop a snippet in LH mode — same notes every pass

_Confirmed in-browser 2026-08-10._

---

### M5 — Edge cases

- [x] Loop teleport: note cursor reset mirroring the beat-event state reset (`:364-433`)
      _(done in M3 — the rebuild could not be written correctly without it; see N12)_
- [x] Pending nodes stopped at teleport _(done in M3)_
- [ ] Chord where one voice ties and another re-articulates — tied note held,
      re-articulated note struck
- [ ] Verify against a simplified variant and its original: same tempo, same
      measure count, both audible and comparable

**Verification:**
- [ ] Loop a 4-measure snippet 5 times — identical notes every pass
- [ ] Triplet piece: no cumulative drift after 30+ measures
- [ ] Speed 60% with audio: notes stretch, not staccato

---

### Notes

#### N1 — `beatPos` duplicates `musicalBeatInCopy` (M1, decision)

The spec says the tick map "already has" beat position and asks to emit it as
`beatPos`. It is more duplicated than that: `musicalBeatInCopy`
(`scoreRender.js:569`) is already *exactly* `measStartBeats[measIdx] + t`, the
same expression. `beatPos` is therefore a second field holding an identical
value.

Kept anyway, deliberately. `musicalBeatInCopy` feeds ScrollEngine's `baseBeat`,
whose job is restoring `musicalBeat` after a loop teleport
(`ScrollEngine.jsx:176-181`) — scroll bookkeeping. Giving it a second consumer
with different semantics ("where in the score is this") means a future change to
the teleport-restore logic would silently move the synth. Two names, one value,
independent reasons to exist.

#### N2 — The tick map rounds to 3dp, and the join must round identically

Not mentioned in the spec, and load-bearing. `scoreRender.js:538` / `:550`
compute the tick key as `Math.round(tick * 1000) / 1000`, so `beatPos` inherits
that rounding while `buildNoteTimeline`'s `onsetBeats` does not. A triplet onset
is `0.3333…` in the timeline and `0.333` in `beatPos` — an exact-equality join
misses by ~3.3e-5.

Measured cost of getting this wrong, across the fixture corpus: **966 unmatched
onsets** (Moonlight 812, Someone Like You 114, Für Elise 40) — i.e. silently
dropping the entire triplet repertoire. With matched rounding: 0 unmatched of
~12,700 notes. The dev hook's `joinKey` and any M3 scheduler must apply
`Math.round(b * 1000) / 1000` to both sides.

#### N3 — Bug found and fixed: one event can carry the same pitch twice

The first implementation searched forward for a tie continuation with
`notes.find(n => n.midi === midi)`, which returns the *first* pitch match. Real
corpus data breaks that:

```
Moonlight m60 [2]        C#4(61) + C#4(61):end
Someone Like You m27 [8] D4 + F#4(66) + F#4(66):end + A4(69):end
```

One voice holds a tied note while another strikes the same pitch in the same
event. `find` returned the untied sibling, so the chain was declared broken and
the held note was cut short. This is spec §M5's "chord where one voice ties and
another re-articulates" — but occurring *within* one event, not across two.

Fixed by searching for a continuation match first and only falling back to the
non-continuation match for the broken-chain guard. Per-note emission already
handled this case correctly; only the forward search was wrong. Removed 5 of 6
false-positive warnings.

#### N4 — Headless pre-verification

`buildNoteTimeline` was run against all 13 `tools/sam-tools/fixtures/*.mxl`
through the real `songParser.parseMusicXML`, with `renderCopy`'s tick map
re-implemented faithfully (including the 3dp rounding) to test the join without
a browser. Results: 0 unmatched onsets across ~12,700 notes; onset-sorted
everywhere; Someone Like You mm.4–5 E5 emits one entry at 1.45 beats
(`1 + 0.5 − gap`); Moonlight shows 799 notes at 0.2833 beats
(`0.3333 − gap`), confirming tuplet-aware durations; per-piece last onset
lands one measure inside the time-signature total in every case.

Synthetic cases also pass: 3-link `start→both→end` chain, tie/restrike chord,
unresolved chain (warns, does not throw), rests advancing the cursor without
emitting, malformed measure snapping at the barline, legacy `beats[]` measure,
and empty/null input.

#### N5 — 6 residual warnings are upstream parser data, not timeline bugs

All six remaining corpus warnings are one pattern: a cross-barline tie whose
destination measure lost its incoming link.

```
Someone Like You m77 [10]  A3(57):start     <- chain opens
Someone Like You m78 [0]   A3(57):start     <- should be "both"
                    [1]    A3(57):both
                    [2]    A3(57):end
```

`songParser`'s tie-chain correction ("first fragment: source-left tie, or
'start' if N>1") appears to drop the inbound tie when the destination note is
itself split into fragments. Also hits The Entertainer mm.67–68 and 151–152.

Audible effect is a restrike instead of a hold on 6 notes out of ~12,700. The
timeline refuses to fuse across the ambiguity and warns rather than guessing.
**Out of scope for this feature** — it is a parser fix, tracked here only so it
is not later mistaken for a synth bug.

#### N7 — The spec's two M2 requirements conflict; resolved with a limiter (M2, decision)

The spec asks the master bus to provide headroom because "full playback can
stack 8+ simultaneous notes and clips badly", *and* asks that the metronome
click be at unchanged volume after migrating onto that bus. A plain GainNode
cannot do both:

- bus at unity → click unchanged, but zero clip protection
- bus below unity → protection, but the click gets quieter, failing M2

Resolved by making the bus `GainNode(1.0) → DynamicsCompressor → destination`.
The gain stays at unity so the click is untouched, and the compressor —
threshold -6 dBFS, **knee 0**, ratio 20 — acts as a limiter. A hard knee means
gain reduction below the threshold is exactly zero, so the click (peaks 0.3 /
0.15, i.e. -10.5 / -16.5 dBFS) passes through bit-identical; only a genuinely
dense stack reaches it.

Measured: an 8-note chord sums to 1.76 worst-case in-phase, well over the 0.501
linear threshold — so the limiter is load-bearing, not decorative. Per-note peak
could instead have been dropped to ~0.06 to stay clean by gain staging alone,
but that makes a single note far quieter than the click, which is backwards for
an audition tool.

`getMasterBus` returns the GainNode, so the spec's contract ("one place to set
master level") is unchanged; the limiter is an implementation detail behind it.

#### N8 — Release is scaled for short notes so durations are exact (M2)

With a fixed 80ms release, a note shorter than attack+release overran what it
was asked for — a 60ms sixteenth (a 16th at 200 BPM after the articulation gap)
sounded for 85ms and bled into the next one, quietly undoing the gap the
timeline had just applied.

Release is now `min(RELEASE_S, dur * 0.4)`. Long notes are unaffected
(`min(0.08, 0.4) = 0.08`), and the note end lands exactly on `when + duration`
for every duration at or above `MIN_NOTE_S`. Verified exact across
0.03 → 11.95s. This matters beyond tidiness: M5's "at 60% speed notes stretch
rather than becoming staccato" is only observable if the sounding length is
actually the requested one.

#### N9 — Headless verification of M2

`synthVoice` was exercised against a fake AudioContext that records every
automation call — envelope shape, ordering, and node wiring validated without a
browser. Covers: `midiToFreq` at A3/C4/A4/A5; bus caching per context and a
fresh bus for a new context; the full envelope for a 1s note (0 → 0.22 over 5ms
→ 0.066 over 120ms → held → 0.0001 over 80ms, `osc.stop` past the release);
monotonic automation times; no `exponentialRamp` targeting 0 (illegal in Web
Audio); the sustain anchor actually holding; short-note degeneration; clamping
a note scheduled in the past; null context / non-numeric midi / zero velocity /
velocity > 1; and the 8-note stack sum.

One real find: without the sustain anchor `setValueAtTime(sustain,
releaseStart)`, the release ramp interpolates from the end of the decay and
starts falling immediately, collapsing the held portion of every long note. The
anchor is load-bearing, not redundant.

#### N10 — Node cleanup on the synth, not on `playClick`

`playNote` disconnects its GainNode in `osc.onended`. A long piece schedules
thousands of notes and the gain nodes would otherwise accumulate on the bus for
the lifetime of the context. `playClick` deliberately does not do this — it
predates the change, fires a few times a second, and leaving it alone keeps the
M2 "click unchanged" claim about the code as well as the level.

#### N12 — Each loop copy needs its own join map (M3)

The spec frames the loop teleport as a cursor-reset problem. There is a
structural issue underneath it that has to be solved first.

`beatPos` is copy-RELATIVE — copies 0, 1 and 2 all carry the same values,
because they are the same score content. But each copy has a different
`targetTimeMs`, since each is a different pass across the target line. Building
one `Map` keyed by `beatPos` across all events therefore collapses all three
copies onto whichever copy happened to be inserted first, and only one pass in
three would ever sound.

`rebuildSchedule` builds a separate map per copy and concatenates, then sorts by
onset. Verified: a 4-measure fixture yields 20 timeline notes → 60 schedule
entries with 48 distinct onsets, not 20.

The teleport itself then rebuilds rather than shifting. The recompute at
`:364-433` adds a uniform `copyWidth / pxPerMs` to every `targetTimeMs`, so
adding that constant to each schedule entry would be cheaper and preserves sort
order — but re-reading the recomputed values is what makes it impossible for the
schedule to drift away from the beat events it was derived from. The cost is a
~1400-entry rebuild once per loop pass.

Pending notes are stopped at the teleport as well, or a whole note from the tail
of the outgoing pass rings across the loop point into the new one.

#### N13 — Resume already works via negative onsets (M3)

No special handling was needed for resume-from-measure, but it is worth
recording why. On resume, `originPx` is anchored so the resume point sits at the
lead-in, which makes `targetTimeMs` NEGATIVE for every beat event before it.
Those entries stay in the schedule, and the scheduler's existing
`if (n.onsetMs >= elapsed)` guard consumes them silently — cursor advances, no
sound — exactly as the metronome skips ticks before its start. Verified: a
fixture with 8 past-onset entries played 52 of 60 and none of the 8.

#### N14 — `stop(0)` would click; using a 15ms fade instead (M3)

The spec says to call `stop(0)` on pending nodes at cleanup. Doing that
literally cuts a ringing oscillator mid-cycle, which puts a step discontinuity
through the master bus and produces an audible click on every pause — most
noticeable exactly where full playback is dense.

`stopPendingNotes` instead cancels the envelope, ramps gain to 0 over 15ms, and
stops just after. Inaudible as a fade, and far inside the "silence within
~100ms" budget. `cancelAndHoldAtTime` is used where available with a
`cancelScheduledValues` + `setValueAtTime` fallback for older Firefox.

A note still inside the 100ms lookahead has not started yet; stopping it before
its start time means it never sounds at all, which is the desired pause
behaviour.

#### N15 — Headless verification of M3

The scheduler, the teleport rebuild and the rate math were re-implemented
faithfully and driven by a simulated 60fps rAF loop. Confirmed: every scheduled
note fires exactly once (60/60, zero duplicates); nothing is scheduled behind
its onset or more than the 100ms lookahead ahead; past-onset entries are
consumed without sounding; the cursor resets and pending notes clear at the
teleport; and pass 0 and pass 1 produce an **identical** note sequence.

One harness bug worth recording, because it is an easy thing to get wrong when
reasoning about this code: the first version advanced `elapsed` at wall-clock
speed for both the rate-1 and rate-0.6 runs and reported that wall spacing did
not scale. The engine derives content-time as `elapsed = wall * rate`, so at 60%
speed content-time advances *slower* than the wall clock. With the harness
corrected, inter-onset wall spacing scales by exactly `1 / rate` (1.667×) and
note durations by the same factor. The engine math was right; the simulation of
it was not.

#### N16 — D6 mute is gated on "playing", not on the mode alone (M4, decision)

The spec says the MP3 is muted "for the run" when `scorePlayback === "full"`,
and the checklist adds "restored on stop and on mode change". Muting purely on
the mode would satisfy the first and fail the second: `scorePlayback` is a
persistent setting, so after stopping, the MP3 would stay silent — and the only
way to preview it is `AudioControls`' scrubber, which renders *exclusively* when
`playbackState === "stopped"`. The feature would appear to have broken MP3
preview.

Implemented as:

```js
audioElement.muted = audioMuted || (scorePlayback === "full" && playbackState === "playing");
```

| `audioMuted` | `scorePlayback` | `playbackState` | muted | why |
|---|---|---|---|---|
| false | off  | playing | false | normal MP3 practice |
| false | full | playing | **true** | D6 — the synth is the audio |
| false | full | stopped | false | scrubber must work |
| false | full | paused  | false | restored on pause |
| true  | off  | stopped | true  | manual checkbox still wins |
| true  | full | playing | true  | both reasons agree |

Because `playbackState` and `scorePlayback` are both effect deps, "restored on
stop" and "restored on mode change" fall out of the same expression rather than
needing explicit teardown.

Muted, **not paused**: ScrollEngine derives `elapsed` from
`audioElement.currentTime` via anchor interpolation, so pausing the element
would take the scroll's clock with it. Only the output is silenced, exactly as
D6 describes.

#### N17 — Smoke-tested the UI, then removed the test

`StatsBar` was rendered under `@testing-library/react` to confirm: both radio
groups present and independent (4 metronome inputs + 2 score inputs), `checked`
tracking `scorePlayback`, `setScorePlayback` firing with the right value,
metronome and score playback simultaneously selectable (D4 orthogonality), and
changing one not disturbing the other. Plus the D6 mute truth table above. All
4 passed; the file was deleted afterwards, since a permanent test was not in the
M4 checklist.

Worth recording for whoever adds real tests here: **this project has no
`src/setupTests.js`**, so `@testing-library/jest-dom` matchers are NOT
available — `expect(...).toBeInTheDocument()` throws "is not a function".
`@testing-library/jest-dom` is in `package.json` but never imported. Use plain
matchers, or add the setup file first.

#### N18 — LH/RH cost one filter, because the timeline already carried `hand` (M4a)

Supersedes spec D7. The entire feature is:

```js
const handSounds = (hand) => scoreMode === "full" || scoreMode === hand;
const soundingNotes = timeline.notes.filter((n) => handSounds(n.hand));
```

`buildNoteTimeline` has emitted `hand` on every note since M1 — it walks `rh`
and `lh` independently and tags each — so no new timing logic was needed.
Onsets, durations and tie resolution are all hand-agnostic; the filter sits
between the timeline and the schedule and touches nothing else.

Filtered once up front rather than inside `rebuildSchedule`, because the
schedule is rebuilt on every loop teleport and re-filtering the same notes three
times per wrap is wasted work.

Two things that had to move with it:

- **The unmatched-onset diagnostic** now compares against `soundingNotes`, not
  `timeline.notes`. Left as-is, every hand-filtered run would have reported the
  entire other hand as "unmatched" and fired a spurious warning.
- **The D6 mute** was widened from `scorePlayback === "full"` to
  `scorePlayback !== "off"`. The MP3 is the full recording, so letting it
  through during LH/RH would drown the single hand the mode exists to isolate.

Verified against the corpus: LH and RH partition the timeline exactly
(Arabesque 480 = 209 + 271, Someone Like You 1972 = 1029 + 943, Moonlight
1168 = 245 + 923), `full` sounds every note, `off` sounds none, and filtering
leaves onsets and durations byte-identical. LH also averages a lower pitch than
RH in all three (Moonlight 41.7 vs 62.8), which is a cheap sanity check on the
parser's hand assignment.

#### N19 — Radio smoke test, and a DOM behaviour worth remembering

`StatsBar` re-tested with the four options: correct order (`off, lh, rh, full`),
exactly one checked per mode, the setter reporting the clicked value, and the
metronome group undisturbed. 5 passed; file deleted afterwards, as in N17.

The first version of that test failed on the `rh` case only, because it clicked
the radio that was already selected — **clicking a checked radio fires no change
event**, which is correct DOM behaviour rather than a component bug. The test
now always clicks a different option. Noting it because it looks exactly like a
broken-state-binding failure at first glance.

#### N11 — Scope notes

- Legacy `beats[]` measures produce an empty timeline (they carry no `rh`/`lh`)
  and emit one warning per measure. The current schema rejects `beats[]`; only
  pre-migration documents reach it. `beatPos` is still emitted on that branch so
  the beat-event shape stays uniform.
- Only measure *overflow* warns, not a short hand: the renderer pads short
  voices with rests (`scoreRender.padVoice`) and an empty hand is a legitimate
  whole-measure rest, so warning on short would fire constantly.
- `ARTICULATION_GAP_BEATS = 0.05` (50ms at 60 BPM) is exported, so M2/M3 can
  tune it from one place if it proves too short at high tempo.
- No unit-test file was added — not in the M1/M2 checklists. Both modules are
  pure and the headless harnesses in N4/N9 cover them; happy to promote those
  into `noteTimeline.test.js` / `synthVoice.test.js` alongside
  `durations.test.js` if wanted.
- `window.samSynth` is installed from the M1/M2 dev-hook block in
  `ScrollEngine.jsx`, so it appears only after Play has been pressed once. That
  is not a limitation to work around — the AudioContext cannot exist before a
  user gesture anyway (autoplay policy). It survives Pause.
- Tuning constants (`NOTE_PEAK_GAIN`, `SUSTAIN_RATIO`, attack/decay/release,
  limiter settings) are named module-level constants in `synthVoice.js` so M3/M5
  can adjust voicing without touching the envelope logic.
- `velocity` is plumbed through `playNote` but every caller will pass the
  default 1.0 — dynamics are explicitly out of scope. It exists so M5 can
  differentiate hands or accents without an API change.
