# SAM scoring definitions

What every practice number means, and what it cannot tell you. Written 2026-09-18.

Anyone — person or Claude — reading `sam_session_events`, `sam_passes` or
`sam_sessions.summary` should read this first. The same statements live on the
database columns (migrations 029 and 030) and in the description of every tool
that returns this data, so they cannot be missed by someone who only sees one of
those.

## The four outcomes

Every expected beat produces exactly one row in `sam_session_events`.

| result | meaning |
|---|---|
| `hit` | Every note the beat called for was played within the matching window. |
| `miss` | The beat was not played correctly. Either nothing was struck at it — raised on elapsed time **without consulting MIDI**, so a session with no keyboard attached records a full count of misses — or what was struck was wrong, in which case `played_notes` carries those keys. |
| `partial` | Some but not all of the beat's notes were played. |
| `extra` | A keystroke that was **not an attempt at any beat**: it matched nothing within the window. Not a beat outcome at all. An attempt at a beat that was simply wrong is a `miss` carrying its pitches. |

`wrong` is permitted by the constraint but **has never been written**, and is
not expected to be. An all-wrong chord is deliberately left pending so the
player can correct it, and is later timed out by the scanner as a plain `miss`.

## Accuracy

```
accuracy = hits / (hits + misses)
```

- **A partial counts as neither.** It sits outside the ratio and is reported on
  its own. Partials are rare (about 1% of rows).
- **An extra counts as nothing at all.** It never enters attempts, hits, misses,
  accuracy or any timing average.
- **Accuracy is null, not 0, when nothing was measured** — no MIDI note arrived,
  or no beat was scored. Null means unmeasurable; 0 means measured and every
  note wrong. Never treat null as 0 in an aggregate.

## A corrected wrong key still counts as a hit

If a wrong key is struck and the right one follows within the window, the beat
scores as a **hit**.

This is deliberate, not an oversight. The score answers "did I play the
passage", and penalising a slip that was recovered in time makes that number
less useful. What was struck is not lost: an unattached keystroke becomes its
own `extra` row, and a wrong attempt AT a beat is kept on that beat's `miss`
row, neither of which changes a score.

## One fumble is one row

Wrong notes are recorded against the beat they belong to:

- **A chord with some wrong notes** already scores a `miss`, and its
  `played_notes` holds what was struck.
- **An all-wrong chord** leaves the beat pending so it can be corrected. If it
  is not, the scanner's `miss` for that beat carries the keys that were struck.
  (For one day, 2026-09-18, this also wrote a companion `extra` row. That is
  withdrawn, because it made one fumble two rows and a per-measure count could
  double it.)
- **Notes carried on a miss are not counted.** They never reach `notesPlayed`,
  so no score moves.
- **An `extra`** is only a keystroke that belonged to no beat at all.

So a count of wrong notes should read both `extra` rows and the `played_notes`
of `miss` rows, and can trust that one attempt appears once.

### Only the notes that were actually wrong

A failing chord records **every key struck, the correct ones included**. A
pitch is a wrong note only when it is **not in that beat's `expected_notes`**;
the overlap is the part he got right. Pastorale m34 reported 55, 62 and 60 as
its top mistakes until this was fixed — all three are in that chord.

On an `extra` row `expected_notes` is empty by definition, so every pitch on
one is wrong.

### Tied-over notes are not mistakes

A note **tied into** a bar is sounding but never struck, so the score never
asks him to play it and it is absent from that beat's `expected_notes`.
Playing a snippet that begins mid-phrase he strikes those notes to place his
hand — Autumn Leaves m15 listed D3 (50) and F#3 (54) in about 50 passes each
for exactly this reason.

Since 2026-09-19 `get_sam_measure_stats` reads the bar's own notation and
treats pitches tied into it as expected. They are neither wrong notes nor
extras, and are reported separately as `tied_in_strikes`. A note carries
`tie: "start" | "end" | "both"`; **`"end"` and `"both"` are both
continuations** — already sounding.

### The app asked for notes it was already holding — fixed 2026-09-20

Until 2026-09-20 the app decided `expected_notes` with
`notes.every(n => n.tie === "end")`, per EVENT. Two shapes defeated that:

| shape | what the app demanded |
|---|---|
| every note `tie: "end"` | nothing — **correct** |
| every note `tie: "both"` (middle links of a longer chain) | **a key for a note already sounding** |
| a mixed chord: one voice tied over, another re-articulated | **both notes**, the tied one included |

So in the second and third cases **he was scored as missing notes he was
correct not to play.** An all-held beat he rightly left alone scored a full
miss; a mixed chord where he played only the re-articulated note scored a
`partial`, because the held note read as missing.

The score itself was never wrong about this — tie arcs are drawn from
`tieEndpoints`, which has always handled `"both"`. The staff drew a tie and
the scorer punished him for obeying it.

**The fix.** One shared predicate, `measureUtils.isContinuation`, judging
**per note**: a note is already sounding when its tie is `"end"` or
`"both"`, and is asked for otherwise. `scoreRender` (what the player is
asked to play) and `noteTimeline` (what the synth sounds) now import the same
function instead of keeping two rules that disagreed.

## ⚠️ THE ACCURACY BREAK OF 2026-09-20

**On any piece containing ties, accuracy before and after 2026-09-20 is not
comparable.** Nothing about the playing changed; the app stopped asking for
notes it was already holding.

What moves, and which way:

- **Misses fall.** A beat of nothing but held notes used to raise a miss on
  elapsed time when he correctly played nothing. Those beats are now
  unscoreable — they ask for no key at all — so they leave the ratio entirely.
- **Partials become hits.** A mixed chord played correctly (only the
  re-articulated note) scored `partial`; it now scores `hit`. Since a partial
  sits outside `hits / (hits + misses)` and a hit is inside it, this raises
  accuracy.
- **Nothing regresses.** `matchChord` tolerates extra notes, so if he keeps
  the habit the old rule taught him and strikes the held note anyway, the beat
  still scores a hit.
- **Attempts fall** on affected pieces, because beats that ask for nothing are
  no longer counted.

So **accuracy rises** on pieces with ties, by an amount set by how many of
their beats are affected. Do not read the rise as playing better. Run
`supabase/migrations/061_scope_tie_both_and_mixed_chords.sql` to size it per
song: it counts the affected measures and the already-recorded misses and
partials sitting on them.

Existing rows keep their old `expected_notes`; only sessions from the deploy
onward carry the corrected set. The analysis-side fix below is what covers the
history.

### How the two tie fixes compose

They do not overlap, and nothing falls between them.

- The **app fix** decides what is EXPECTED, so it changes hits and misses from
  the deploy onward.
- The **analysis fix** (`get_sam_measure_stats`) decides what counts as a
  WRONG NOTE, and reads the notation directly, so it corrects history too.

A note tied into a bar that he strikes anyway now matches no beat, so it
becomes an `extra` row — and the analysis fix already recognises those and
reports them as `tied_in_strikes` rather than mistakes. The app fix produces
more of exactly the rows the analysis fix knows how to classify. Neither
corrects the same number twice.

### A skipped beat can steal the next keystroke

The matcher takes the **first** pending beat inside the window, not the
closest ([noteMatching.js](../src/sam/lib/noteMatching.js) — the doc comment
says so deliberately, to stop a systematically late player cascading onto the
following beat).

The cost is that **a beat he skipped stays pending for the full `windowMs`**
and can match the next keystroke, which is then recorded against the wrong
beat with a large negative offset. So an isolated very-late note next to a
missed beat is more likely an artefact than dragging. This was left as it is
on purpose: the lateness that would trigger a bad match is being reduced
first (see the calibration break above), and "prefer the closest beat" would
reintroduce the cascade the current rule prevents.

## Loop cycles he sat out

Misses are raised on elapsed time **without consulting MIDI**, so a loop left
running while he resets his hands records a full measure of misses per cycle.
AL m15–16 shows 202 loop iterations against 23–29 real passes.

A cycle is **sat out** when every beat of that measure in that iteration is a
miss with nothing struck at all. One key anywhere makes it an attempt, however
badly it went — this only removes cycles with no playing in them, never bad
playing.

`get_sam_measure_stats` therefore reports **two hit rates, never
interchangeable**:

| field | over | answers |
|---|---|---|
| `hit_rate_all` | every loop iteration | how did it go overall |
| `hit_rate_attempted` | only iterations he played in | how did it go when he played |
| `hit_rate_settled` | those, minus the first attempt of each sitting | **is this bar hard** |

with `sat_out_iterations` and `first_attempt_iterations` alongside. All three
are true; they answer different questions.

### Why the first attempt comes out

Pastorale m26 read 78% attempted off passes that actually ran **29, 94, 94,
100, 100, 100, 100** — one cold first run, not a hard bar. A pooled rate
answers "how did it go", and on a short snippet a sitting holds few passes, so
one fumbled first attempt dominates it.

`hit_rate_settled` drops the **earliest attempted iteration of each session**
per measure — one per sitting, never more. A cycle he sat out is not an
attempt and so is never mistaken for the first one.

Excluding the first attempt was chosen over a "last N attempts" rate because
it uses every remaining pass rather than discarding data, needs no arbitrary
N, and targets exactly the effect observed: cold reading, which happens once
per sitting.

`weakest_measures` ranks on `hit_rate_settled` where a measure has enough
settled beats and on `hit_rate_attempted` otherwise; each row says which under
`ranked_on`.

## What a wrong-note count counts

The unit is the **pass**: one session plus one loop iteration. Each pitch
carries three numbers — `passes`, `sessions` and `days`.

⚠️ **A pass is not an occasion.** Drilling a bar twenty times in one sitting
produces twenty passes, and on a short snippet that is a couple of minutes.
"Recurring in 7 passes" read like a habit when it was one afternoon.

A pitch is therefore **headlined** in `recurring_wrong_notes` only when it
appears in **at least 3 distinct passes AND at least 2 distinct sittings** — a
pattern has to survive going away and coming back. Everything below that bar
stays visible in `all_wrong_notes` with its raw counts, so the threshold hides
nothing; it only decides what leads.

⚠️ **The wrong-note list is only as good as these rules, and every pattern
investigated so far has turned out to be a measurement artefact rather than a
mistake.** It depends on three fixes, all dated 2026-09-19: only unexpected
pitches are counted; pitches tied into a bar are treated as expected; the
count is passes and sittings, not rows. Check any pattern against the score
before reporting it.

## ⚠️ THE CALIBRATION BREAK OF 2026-09-19

**Timing offsets recorded before 2026-09-19 and after it are not comparable.**
Nothing about the playing changed; the measurement did.

Two defects were fixed on that date:

1. **The press time was the flush time.** A chord is buffered and delivered on
   a `setTimeout` of `chordGroupMs` (80 ms by default) after its last key, and
   the offset was measured at that moment. Every event therefore carried about
   80 ms of built-in lateness — more whenever the main thread was busy, which
   is worst at a loop restart. `useMIDI.js` now captures `performance.now()` as
   the MIDI event arrives and carries it through to the matcher.
2. **The clock was read once per animation frame.** `findClosestBeat` read
   `scrollState.elapsed`, written once per rAF, so offsets were quantised to
   ~17 ms and stale by up to a frame. The matcher now adds the time elapsed
   since that frame, from the press time.

### What to expect the numbers to do

| figure | across the boundary |
|---|---|
| `mean_offset_ms` | **about 80–100 ms less late.** A session that averaged −120 ms should now read roughly −20 to −40 ms |
| entry lateness | the biggest change: the old 120–225 ms entries were mostly main-thread congestion at the teleport, so expect these to fall furthest, perhaps to −30 ms or better |
| mid-phrase offsets | down by roughly the same ~80 ms constant |
| `drift_ms_per_pass` | should **shrink toward zero** — much of the old drift was congestion decaying over a pass |
| `interval_ratio` and its spread | **unchanged, and the only figures comparable across the date.** A constant offset cancels out of a gap, which is exactly why they exist |
| hit rate, accuracy | **unchanged.** The window is ±300 ms and the shift is ~80 ms, so almost nothing changes which beat a keystroke matched. A keystroke previously 290 ms "late" and only just inside the window will now land comfortably inside it, so a handful of borderline beats may move from miss to hit |

**Do not read the jump as improvement.** Never average or compare mean
offsets, entry lateness or drift across 2026-09-19. Compare interval ratios
instead, or compare only within one side of the date.

There is a residual constant left — whatever latency the keyboard, the USB
stack and the audio path add — so the mean offset is still calibration plus
error, just with the largest software term removed.

## Timing

`timing_delta_ms` and `summary.avgTimingDeltaMs`:

- **POSITIVE = EARLY (rushing). NEGATIVE = LATE (dragging).**
- It comes from `targetTimeMs - elapsed` in `src/sam/lib/noteMatching.js`, so a
  beat still in the future is positive.
- The database column comment said the opposite until 2026-09-18. The code has
  always been this way.

Three limits on any average:

1. **The window truncates it.** A keystroke further from its beat than the
   session's `settings.windowMs` matches no beat and is never recorded as a
   timing value, so the extremes are invisible and the mean is pulled toward
   zero. Whatever the window is, the magnitude cannot exceed it.
   - **On an `extra` row** the value is the distance to the nearest pending
     beat, and is stored **only when that is within twice the window** — null
     otherwise. A keystroke a beat and a half from anything is unattached, not
     early or late. Twice the window, rather than a fraction of a beat, because
     `windowMs` is already the app's definition of "close enough to be an
     attempt at this beat", so the rule scales with how strict the session was
     rather than with its tempo. **Extras from before 2026-09-18 stored the
     number regardless; values of several seconds exist and are noise.**
2. **Latency rides along.** Any fixed MIDI or audio latency appears as a
   constant offset on every row.
3. **Different windows aren't comparable** (below).
4. **There is a measurement floor of about 17 ms** (next section).

## The measurement floor

`ScrollEngine.jsx` writes `state.elapsed` **once per animation frame** from
`performance.now()`, and `findClosestBeat` in `noteMatching.js` reads that
published value rather than sampling the clock when the key arrives. So every
offset is quantised to the frame interval — **about 17 ms at 60 Hz** — and is
stale by up to one frame.

**A spread, or a difference between measures, under roughly 20 ms is
measurement noise and must not be reported as a finding.**

Two consequences worth knowing:

- Frame staleness makes `elapsed` too small, so it biases offsets **positive
  (early)**. A render stall cannot manufacture apparent lateness.
- A much larger floor sits in the input path: `useMIDI.js` discards the MIDI
  event's own `timeStamp` and flushes a chord on a `setTimeout` of
  `chordGroupMs` (default **80 ms**) after its last key, measuring the offset
  at flush time. That is ~80 ms of built-in lateness on every event, and more
  when the main thread is busy. It is a constant, so it lands in calibration
  rather than error — but it is why the absolute mean offset should never be
  read as playing.

## Entries versus mid-phrase

Coming in after a rest or a loop restart is a **different skill** from playing
inside a phrase, and the two run at very different offsets: live evidence has
him 120–225 ms late on entries and near zero mid-phrase. Mixing them corrupts
both numbers.

A struck beat is an **entry** when it is the first struck beat of a pass, or
when the beat struck before it sat **two or more measures back** — a rest of at
least a full bar, whatever the time signature. This is deliberately
conservative: a short rest inside a bar is not called an entry, so mid-phrase
may carry a few soft entries, but nothing mid-phrase is wrongly thrown out.

Because a measure-range or snippet filter hides earlier bars, the first beat
inside the range counts as an entry — correct for a snippet, which is what he
actually practises.

`get_sam_measure_stats` ranks `most_late` and `most_early` on **mid-phrase
beats alone**. Ranked on everything, those lists simply find the bars he enters
on: Pastorale's "worst" measures were m37 (the last bar) and m1 — exit and
entry effects, not difficulty. `most_early` is **empty** when no measure had a
positive mean offset, rather than showing the least late one.

So comparisons **within** one session — this bar against that bar — are far more
reliable than the absolute number.

## Calibration versus error

A consistently negative mean offset does **not** on its own mean dragging.
`mean offset = calibration + error`, where calibration is MIDI and audio
latency plus where the eye aims against the scrolling line. A constant offset
shifts every note equally.

What isolates the error is the **gaps between struck notes**, which a constant
offset cancels out of:

- **Interval ratio** — the gap actually played divided by the gap the score
  asks for. Below 1 is genuinely faster than the tempo, above 1 slower, and
  1.00 is in time however large the mean offset. Derived as
  `actual = expected − (offset_now − offset_before)`.
- **Interval spread** — the standard deviation of those ratios: steadiness.
- **Drift within a pass** — the offset in the last third minus the first third.
  A constant offset cannot produce drift, so this is error.

Only gaps between two beats that were both struck, adjacent in the sequence (a
miss breaks the chain), inside **one measure** and one loop iteration are used.
Staying within a measure is what keeps this safe: `beat` is a quarter-note
position within its measure, so no barline, repeat or time-signature change
enters the arithmetic, and tuplets are already fractional quarter positions.

The gap length in milliseconds comes from the session tempo —
`60000 / (bpm × playbackSpeed / 100)`. A sitting whose tempo moved is excluded
from these figures (its `summary.tempo.min` and `max` differ), as is any
session with no recorded tempo. `get_sam_measure_stats` reports both the mean
(labelled calibration) and the interval figures, and says how many sessions it
skipped and why.

## The matching window changes the score

`sam_sessions.settings.windowMs` (default 300 ms) is how far from its beat a
keystroke may land and still match.

**It directly controls how forgiving scoring is.** Tightening it lowers accuracy
on identical playing.

⚠️ **The same passage practised at different window settings is not
comparable.** A drop in accuracy after tightening the window is the window, not
the playing. Any report comparing sessions must state the window behind each
figure and say plainly when they differ.

## Dates that limit the data

| data | available from |
|---|---|
| `sam_session_events` rows | 2026-02-14 |
| `partial` rows | 2026-09-18, plus earlier ones recovered by the 2026-09-18 backfill from `sam_sessions.events` |
| `extra` rows | 2026-09-18 only |
| `sam_passes.hits` / `misses` / `notes_played` / `accuracy_percent` | 2026-09-16 (part-way through the day) |
| `sam_passes.playback_speed` / `effective_bpm` | 2026-09-16 (part-way through the day) |

Also:

- **285 ended sessions have no event rows and never will.** The tab was closed
  mid-practice, which saves the summary but no events.
- **3,295 backfilled rows have a null `measure_id`** because their song was
  re-imported since. Their `measure_number` is correct — join on that.

## Measure numbers

Everything here uses **played** measure numbers, repeats written out — the same
numbering snippets, plans and the score use. The printed number is
`sam_song_measures.source_measure`, which differs wherever a bar repeats, and
should be shown alongside whenever a human reads a measure list.

Two traps for per-measure work:

- **Rest measures appended after a snippet** take numbers past the range that
  can collide with real measure numbers. Filter to the snippet's own range.
- **Loops:** a drilled bar contributes one row per beat per cycle. Report how
  many loop iterations are behind a rate, or heavy drilling on one bar silently
  dominates.

## Where else this is written down

- `sam_session_events` table and column comments — migrations
  `029_sam_session_events_result_values.sql` and
  `030_sam_session_events_extra_and_scoring_docs.sql`.
- Every MCP tool returning this data carries the short form in its description
  (`SAM_SCORING_RULES` in `supabase/functions/_shared/samScoringRules.ts`).
- The sign is stated at the calculation in `src/sam/lib/noteMatching.js`.
- The app's own accuracy rule lives in `src/sam/lib/practiceScoring.js`.
