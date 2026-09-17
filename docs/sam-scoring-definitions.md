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
| `miss` | The beat passed unplayed. Raised on elapsed time **without consulting MIDI**, so a session played with no keyboard attached records a full count of misses rather than nothing. |
| `partial` | Some but not all of the beat's notes were played. |
| `extra` | A keystroke belonging to no expected beat: a wrong key, or a note too far from its beat to match. Not a beat outcome at all. |

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
less useful. What was struck is not lost: since 2026-09-18 it is recorded as its
own `extra` row, which changes no score.

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
2. **Latency rides along.** Any fixed MIDI or audio latency appears as a
   constant offset on every row.
3. **Different windows aren't comparable** (below).

So comparisons **within** one session — this bar against that bar — are far more
reliable than the absolute number.

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
