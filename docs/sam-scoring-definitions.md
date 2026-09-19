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

⚠️ **Tied-over notes are a known hole.** A note tied into a bar is sounding but
never struck, so it is absent from that beat's `expected_notes`. Playing a
snippet that starts mid-phrase, he strikes those notes to place his hand and
they are logged as recurring wrong notes although they are not errors — Autumn
Leaves m15 lists D3 and F#3 in ~50 passes each for exactly this reason. Treat
recurring wrong notes **in the first bar of a snippet**, or in any bar entered
from a rest, with suspicion until this is fixed.

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

| field | over |
|---|---|
| `hit_rate_all` | every loop iteration |
| `hit_rate_attempted` | only iterations he played in |

with `sat_out_iterations` alongside. Both are true. The second is the one that
answers "which measures do I miss" — a measure can read 40% / 95% purely
because the loop ran on without him. Difficulty is ranked on the attempted
rate.

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
