# Technical Spec: Importer Duplicate-Note Defect

**Revision 2** — updated after M0 recon. Changes from revision 1 are marked
_(rev 2)_.

## Overview

The MusicXML importer sometimes writes the same pitch twice into a single
notation event. A chord that should read D4 + F4 + A4 is stored as
D4 + F4 + F4 + A4.

Two consequences:

- **Rendering.** VexFlow draws two noteheads on the same staff line, displacing
  one sideways, and draws a spurious tie curve from the extra note.
- **Indexing.** Fingerings (`note_index`), lyric placement, and the
  simplification pipeline all address notes by position within an event. A
  phantom note shifts every index after it.

_(rev 2)_ Recon established that **not every duplicate is a defect.** Some are a
legitimate encoding the codebase already relies on. The distinction is now the
central design point of this spec — see "The continuation rule".

## Confirmed mechanism _(rev 2)_

`mergeStaff(voices, staff, measureLen)` at `songParser.js:219`. Per time
segment it loops over every voice on the staff (`:250`) and pushes every
covering note onto one flat array (`:263-275`) with no pitch de-duplication.
`fromTimeline` (`durations.js:168`) only shallow-copies, so `mergeStaff` is the
sole origin.

Tie values are computed per contributing source event from `isFirst`/`isLast`
(`:259-274`), which is why two entries for one pitch can carry different tie
values.

## The continuation rule _(rev 2)_

A note is a **continuation** if its `tie` is `"end"` or `"both"` — it is the
tail of a note struck earlier.

`noteTimeline.js:141-150` documents same-pitch-twice as legitimate: one voice
holds a tie through the beat while another strikes the pitch fresh. Named
corpus cases are Moonlight m60 (`C#4` + `C#4:end`) and Someone Like You m27
(`F#4` + `F#4:end`). `resolveTieChain` contains a deliberate workaround that
searches for the continuation note first, for exactly this reason.

Collapsing a continuation into a fresh strike is lossy in a way that changes
what is heard: playback would treat the pitch as held through when it was
actually re-articulated. Collapsing two non-continuations changes nothing.

**Therefore: merge a duplicate pair only when neither entry is a continuation.**

- The Scientist m69 — `F4{tie:"start"}` + `F4{}`. Neither is a continuation.
  **Merged.**
- Moonlight m60 — `C#4{}` + `C#4{tie:"end"}`. One is a continuation.
  **Left alone.**

Do not delete the `resolveTieChain` workaround. It remains load-bearing for the
cases this rule deliberately preserves.

A useful consequence: because merged pairs can never contain `"end"` or
`"both"`, the merged tie value is simply `"start"` if either entry has it and
absent otherwise. The `"both"` union branch is unreachable in this path and
should not be implemented.

## Scope

**In scope**

1. Prevent non-continuation duplicate pitches at parse time.
2. A shared duplicate check called from every write path.
3. Repair existing affected rows.
4. Fix hand assignment.
5. Render legitimate duplicates as a single notehead.

**Out of scope**

- Changing the notation format.
- Repeat expansion, `audio_offset_ms`, the simplification pipeline.
- Stale song row cleanup.

## Design decisions

### De-duplication keys on MIDI pitch, not on the note object

Two entries for MIDI 65 are the same sounding pitch regardless of what else
differs. Compare `midi` only. Whole-object comparison would miss the reference
case, where the two F4 entries differ by a tie.

### Merge, do not simply drop

Dropping the later entry would have discarded the tie in the reference case
purely by luck of ordering. Collapse into one note carrying the union:

- `midi` and `name` from the first entry. If two entries share a `midi` but
  disagree on `name` (an enharmonic spelling such as A#4 vs Bb4), keep the first
  and log a warning — do not fail the import.
- Any property present on one entry and absent on the others carries onto the
  merged note.
- Same property, different values: log with song, measure, hand, event index and
  pitch; keep the first; continue.

### Note properties _(rev 2)_

The complete set is `midi` (required), `name` (required), `tie` (optional), and
`fingering` (transient, stripped at `songParser.js:1043-1059`, never stored).

`tie` takes `"start"`, `"end"`, or `"both"` — **not** `"stop"`, as revision 1
guessed. Enum at `sam-drill-format.schema.json:166`; produced at
`songParser.js:435` and `:270`; consumed by `scoreRender.js:483-484`,
`noteTimeline.js:150`, and `validate.js:539-540`.

### The schema does not gate the MusicXML path _(rev 2)_

`validateMusicXmlSong` (`SongLoader.jsx:32-37`) is a four-line existence check.
The strict schema is deliberately not applied to parser output — see
`songSchema.js:11-31` for why (inline lyric handling).

So a schema rule alone would cover `json_import`, `json_paste` and
`append_sam_measures` while leaving the actual defect path ungated. **The check
must be a shared function called from all three sites**, with the schema rule as
a second layer rather than the only one. The parser fix is load-bearing, not a
convenience.

### Repair is a separate, reversible pass

A CLI command with an explicit dry-run default, not a migration.

## Implementation notes

### Invalidating the compiled blob

`sam_songs.measures` holds a compiled copy the app serves. Any repair writing to
`sam_song_measures` must also, per affected song:

```sql
update sam_songs
set measures_edited_at = now(),
    measures_compiled_at = null
where id = :song_id;
```

A repair that skips this will appear to do nothing.

### Build steps _(rev 2)_

- The schema master is `sam-drill-format.schema.json`. `prebuild.js:16-33` copies
  it to two gitignored locations: `src/sam/lib/` for `songSchema.js:39`, and
  `supabase/functions/_shared/` for `sam-authoring.ts:24`. **M2 must run
  `node scripts/prebuild.js` before deploying.**
- `tools/sam-tools/vendor/songParser.js` is an `npm run sync` copy, currently
  **stale** (1059 lines vs 1105). `mergeStaff` is byte-identical, so the CLI
  validator and its test suite exercise the same code — but **M1 must end with a
  sync**, and the pre-existing staleness should be reported separately rather
  than silently absorbed.

### Index-shifting side effects

Removing a note shifts `note_index` for every later note in that event. The
repair command must check `sam_song_fingerings` and `sam_song_lyrics` and refuse
any song where it would silently invalidate a stored index.

### Platform layer

If changes reach the Edge Function or `_shared/` tree, read the `mcp-platform`
skill first. Do not infer those rules.

### The validator oracle is fixed independently _(rev 3)_

`xmlTruth.js:217` holds a second implementation of staff flattening. It is
deliberately not a copy of the parser and `npm run sync` does not touch it.

It produces duplicates, so post-M1 it disagrees with the parser at exactly the
places M1 repaired (2 BLOCKED, 12 divergences, all false positives).

The oracle is wrong on the merits — it models sounding content, and two voices
on one pitch is one sounding pitch. Fix it. **But implement the rule in
`xmlTruth.js` directly. Do not call `mergeDuplicatePitches` from the oracle.**
Sharing the predicate would make a bug inside it invisible to the validator in
both directions, including a wrongly-merged legitimate pair.

If `xmlTruth.js` lacks the span information needed to derive the continuation
signal independently, stop and report that before falling back to the shared
predicate.

## Milestones

### M0 — Recon ✅ complete

Findings folded into this revision.

### M1 — Parse-time de-duplication

Implement the continuation rule in `mergeStaff`.

- Keyed on `midi` only.
- Merge only when neither entry is a continuation (`tie` of `"end"` or `"both"`).
- Property union; conflicts logged with full location context.
- Do not implement a `"both"` union branch — unreachable here.
- Do not remove the `resolveTieChain` workaround.

Tests: The Scientist m69 reference case (merged); Moonlight m60 and Someone Like
You m27 (preserved unchanged); a minimal two-voice-same-pitch MusicXML snippet.

Ends with `npm run sync`.

### M2 — Shared check at every write path _(rev 2, rescoped)_

Extract the duplicate check as a shared function. Call it from
`validateMusicXmlSong`, the JSON import path (`SongLoader.jsx:601-635`), and
`append_sam_measures` (`sam-authoring.ts`). Add the rule to
`sam-drill-format.schema.json` as a second layer. Run `node scripts/prebuild.js`.

The check rejects non-continuation duplicates only, matching M1 exactly. A
single shared predicate used by both, so the two can never drift.

### M3 — Repair command

`sam-tools` command, `--dry-run` default, `--apply` to write. Reports song,
measure, hand, event index and pitch. On apply: merges, invalidates the compiled
blob, refuses songs where a stored fingering or lyric index would be
invalidated. Uses the same shared predicate as M1 and M2.

### M4 — Hand assignment _(rev 2, root cause identified)_

`computeHandAssignment` (`:532`) tallies each voice number's majority staff
across the whole song (`:749-760`) and **discards the staff dimension
entirely**. A score that reuses voice numbers on both staves therefore collapses
an entire voice onto one hand. That fully explains the right-hand bass notes.

**The 2026-08-05 regression theory from revision 1 is dead.** No regression
landed; the logic has always had this hole. Do not spend time on the timestamps.

Phase B is skipped for the `useTwoParts` and single-staff-`midi<60`
configurations (`:648-651`) — check how those interact before changing the
tally.

Agree the approach before implementing.

**Outcome (2026-08-27). The milestone changed shape; recorded here because the
rev 3 statement above is now only half right.**

"Discards the staff dimension" is true, but the limitation underneath it is
granularity: a per-song rule cannot represent a voice whose hand genuinely
changes during the piece. Moonlight m37-41 has nothing on the treble staff at
all — voices 1 and 2 are engraved entirely on the bass staff — and the song
majority drags the whole arpeggio into the right hand.

**The rule is now per-run, not per-song** (spec §3.6 rule 5, amended): a voice
follows the engraving where it sits wholly on the other staff for two or more
consecutive measures. Split measures are never re-routed; a run of one is not
enough. **Run length is a proxy for left-hand occupancy**, which is deliberately
not implemented — it is simpler and agrees on all 13 fixtures, and it is written
down in §3.6 as the first place to look if the rule ever misfires.

**The oracle site is a REMOVAL, not a mirror.** `computeHandAssignmentTruth` is
deleted rather than updated. M1a's independent second implementation worked
because duplicate-pitch is a *fact* — one right answer, so two implementations
converge and a disagreement is a real bug. Hand assignment is a *policy* with
free parameters (the 60% threshold, the run length, tie-breaks, what counts as a
note); two independent implementations of a policy only agree where both encode
the same arbitrary constants, at which point the second is a copy with different
spelling and every future refinement costs a mirroring pass.

`buildTruth(xml, { routing })` now takes the parser's routing as an input and
answers the question that is a fact — given this routing, is the content in each
hand right? The parser publishes `handRouting` for that purpose. Routing itself
is checked by four invariants that hold for any correct assignment (see M4's
checklist), and the run-length constant is pinned in a parser fixture test, not
in the oracle. Facts in the oracle, policy in tests.

Accepted cost: a routing policy that is *self-consistently* wrong passes the
oracle and is caught only by the fixture expectation test.

### M5 — Render legitimate duplicates as one notehead _(rev 2, new)_

The continuation rule deliberately preserves same-pitch pairs, which means the
original visual complaint persists for those cases: two noteheads stacked on one
staff line.

Correct engraving draws a single notehead. Fix in the render layer
(`scoreRender.js`), leaving the data intact. Also affects the fingering tap-zone
layer, which would otherwise offer two Voronoi zones over one visible notehead —
confirm the docked number bar behaves.

Lower priority than M1–M3. Cosmetic, but it is what prompted the investigation.

## Success criteria

- Fresh import of the Moonlight Sonata source produces zero **non-continuation**
  duplicates.
- The detection query below returns no rows for any non-archived song.
- Moonlight m60 and Someone Like You m27 still contain their same-pitch pairs.
- All three write paths reject a non-continuation duplicate.
- Bass notes in a freshly imported Moonlight Sonata are assigned to the left hand.

## Detection query _(rev 2, excludes legitimate pairs)_

```sql
select m.song_id,
       s.title,
       m.number,
       m.source_measure,
       h.hand,
       e.idx - 1 as event_index,
       n.el ->> 'name' as note,
       count(*) as copies
from sam_song_measures m
join sam_songs s on s.id = m.song_id
cross join lateral (values ('rh', m.rh), ('lh', m.lh)) as h(hand, arr)
cross join lateral jsonb_array_elements(h.arr) with ordinality as e(ev, idx)
cross join lateral jsonb_array_elements(e.ev -> 'notes') as n(el)
where s.archived = false
  and coalesce(n.el ->> 'tie', '') not in ('end', 'both')
group by m.song_id, s.title, m.number, m.source_measure,
         h.hand, (e.idx - 1), (n.el ->> 'name'), (n.el ->> 'midi')
having count(*) > 1
order by s.title, m.song_id, m.number, event_index;
```

Two things this query gets right that the revision 1 version did not: it groups
by `song_id` (grouping by title conflates rows sharing a title and produces
meaningless counts), and it excludes continuation notes so legitimate pairs are
not reported as defects.
