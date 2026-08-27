# Technical Spec: Importer Duplicate-Note Defect

## Overview

The MusicXML importer sometimes writes the same pitch twice into a single
notation event. A chord that should read D4 + F4 + A4 is stored as
D4 + F4 + F4 + A4.

Two consequences:

- **Rendering.** VexFlow draws two noteheads on the same staff line, displacing
  one sideways, and draws a spurious tie curve from the extra note. The measure
  looks smeared and wrong.
- **Indexing.** Fingerings (`note_index`), lyric placement, and the
  simplification pipeline all address notes by position within an event. A
  phantom note shifts every index after it.

A second, probably-related defect was found during investigation and is scoped
here as a separate milestone: some recent imports assign every voice to the
right hand, including notes well below middle C.

## Evidence

**Confirmed instance.** "The Scientist - Coldplay"
(`f3bb321f-aa95-4c73-bfdc-bdf3d36f8096`), measure 69, right hand, event 0:

```json
{
  "voice": "1",
  "duration": "8",
  "notes": [
    { "midi": 62, "name": "D4", "tie": "start" },
    { "midi": 65, "name": "F4", "tie": "start" },
    { "midi": 65, "name": "F4" },
    { "midi": 69, "name": "A4", "tie": "start" }
  ]
}
```

Note that the two F4 entries are *not* identical — one carries a tie and one
does not. Any fix that de-duplicates by comparing whole note objects will miss
this case. De-duplication must key on pitch alone.

This row has since been repaired by hand. It is recorded here as the reference
case, not as outstanding work.

**Pattern instance.** Beethoven's Moonlight Sonata, imported four times under
various titles. Duplicates cluster in measures 28–31 and 37–40 and land on every
third event — exactly the triplet arpeggio passages where the melody note is
written as a separate voice sounding the same pitch as a note in the
accompanying arpeggio figure.

That is the likely mechanism: **when two voices sound the same pitch at the same
moment, the importer flattens them into one chord and keeps both copies.**
Confirming this mechanism is the first milestone.

**Hand-assignment anomaly.** In `16fe4e76-b080-49d2-8208-3ee75f36ccc1`
("Moonlight Sonata 1st Movement", created 2026-08-06) and
`55f08134-3188-4b0b-a1de-bb72040c01c7` ("moonlight2", created 2026-08-05
16:45), every duplicate is tagged `rh`, including B#2, C#3 and D#3 — bass notes
that belong in the left hand. In `ee62f974` (created 2026-08-05 16:41) and
`98d02ba2` (created 2026-06-11), the same notes are correctly tagged `lh`.

That timing suggests a regression landed on 2026-08-05 between 16:41 and 16:45,
but the two groups may simply have been imported from different source files.
Do not treat the regression window as established until it is checked against
the actual source documents.

## Scope

**In scope**

1. Locate the parse path and confirm the mechanism.
2. Prevent duplicate pitches at parse time.
3. Add a validation rule so a duplicate can never be written again, by any path.
4. Repair existing affected rows.
5. Investigate and fix the hand-assignment anomaly.

**Out of scope**

- Any change to the notation format itself.
- Repeat expansion, `audio_offset_ms`, or the simplification pipeline.
- Cleaning up archived or stale song rows (handled separately).

## Design decisions

### De-duplication keys on MIDI pitch, not on the note object

Two entries for MIDI 65 are the same sounding pitch regardless of what else
differs between them. Compare `midi` only.

### Merge, do not simply drop

Dropping the later duplicate would have discarded the tie in the reference case
above, purely by luck of ordering. Instead, collapse the duplicates into one
note that carries the union of their properties:

- `midi` and `name` are taken from the first entry. If two entries share a
  `midi` but disagree on `name` (e.g. an enharmonic spelling like A#4 vs Bb4),
  keep the first and log a warning — do not fail the import.
- Any property present on one entry and absent on the others is carried onto the
  merged note.
- If two entries carry the *same* property with *different* values, that is a
  genuine conflict. Log it with song, measure, hand, event index and pitch, keep
  the first value, and continue.

Conflicts should be rare. The purpose of logging rather than failing is to find
out whether they are rare before deciding how to handle them properly.

### Tie conflicts are the one case worth handling explicitly

If the duplicates carry tie values that differ, the musically correct result is
usually a note that is both tied from the previous event and tied to the next.
Whether the notation format can express that is a recon question (Milestone 0,
question 3). If it can, produce it. If it cannot, keep the first value and log.

### Fix at parse time, and enforce at write time

Fixing the parser stops new bad data. Adding the rule to the shared validation
schema stops *any* path from writing it — including `append_sam_measures` and
anything the simplification pipeline generates later. Do both. The validator is
the durable guarantee; the parser fix is what makes imports actually work.

### Repair is a separate, reversible pass

Existing rows are repaired by a CLI command with an explicit dry-run mode, not
by a migration. Rows are already in the database and nothing is on fire; a
readable report of what would change is worth more than speed.

## Implementation notes

### Invalidating the compiled blob

`sam_songs.measures` holds a compiled copy of the whole song and the app serves
that copy. Any repair that writes to `sam_song_measures` must also, for each
affected song:

```sql
update sam_songs
set measures_edited_at = now(),
    measures_compiled_at = null
where id = :song_id;
```

Setting `measures_compiled_at` to null marks the compiled copy stale so the app
rebuilds it from the rows. A repair that skips this will appear to do nothing.

### Index-shifting side effects

Removing a note shifts `note_index` for every later note in that event. Before
repairing any song, check `sam_song_fingerings` and `sam_song_lyrics` for rows
pointing at affected events. As of this writing no affected song has lyrics or
fingerings on an affected measure, but the repair command must check rather than
assume, and must refuse to touch a song where it would silently invalidate a
stored index.

### Platform layer

If the validation rule is added to a shared schema consumed by the Supabase Edge
Function tools, that change is governed by the platform contract. Read the
`mcp-platform` skill before touching anything under the Edge Function or
`_shared/` tree. Do not infer the rules — they are in that skill.

## Milestones

### M0 — Recon (no code changes)

Locate and report, without changing anything:

1. Where MusicXML is parsed into the SAM event format. File paths and the
   function that builds a single event's `notes` array.
2. How voices are grouped and how the per-voice hand assignment is computed.
3. What the full set of properties on a note object is, and specifically what
   values `tie` can take.
4. Where the shared JSON Schema used by `append_sam_measures` lives.
5. Whether the parse path is shared with any other importer (the JSON import
   path used by `json_import` songs, if it is distinct).

Deliverable: a written report. No edits.

### M1 — Parse-time de-duplication

Implement the merge rule in the event-construction path. Add unit tests using
the reference case above as a fixture, plus a two-voice-same-pitch case built
from a minimal MusicXML snippet.

### M2 — Validation rule

Add "no two notes in one event may share a `midi` value" to the shared schema.
Confirm `append_sam_measures` rejects a batch containing the reference case.

### M3 — Repair command

A `sam-tools` command with `--dry-run` (default) and `--apply`. Reports every
affected song, measure, hand, event and pitch. On apply, merges duplicates,
invalidates the compiled blob, and refuses any song where a stored fingering or
lyric index would be invalidated.

### M4 — Hand assignment

Investigate the anomaly described under Evidence. Determine whether it shares a
root cause with the duplicate defect or is independent, then fix. Scope and
approach to be agreed after the investigation, not before.

## Success criteria

- A fresh import of the Moonlight Sonata source produces zero duplicate pitches.
- The duplicate-detection scan (below) returns no rows for any non-archived song.
- `append_sam_measures` rejects a batch containing a duplicate pitch.
- Bass notes in a freshly imported Moonlight Sonata are assigned to the left
  hand.

## Detection query

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
group by m.song_id, s.title, m.number, m.source_measure,
         h.hand, (e.idx - 1), (n.el ->> 'name'), (n.el ->> 'midi')
having count(*) > 1
order by s.title, m.song_id, m.number, event_index;
```

Grouping must include `song_id`. Grouping by title alone conflates the multiple
song rows that share a title and produces meaningless counts.
