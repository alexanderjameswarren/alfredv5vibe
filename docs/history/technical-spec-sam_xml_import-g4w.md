# SAM MusicXML import: tremolos, glissandos and special notation

Project code `sam_xml_import-g4w`. Plan confirmed by Alex 2026-10-28. **Done 2026-10-28**; the
progress record is `docs/history/progress-sam_xml_import-g4w.md`.

## Outcome (how the plan below changed)
- The Green Onions (Terrence) m49 fold was approved and built: a nested-triplet run becomes
  one triplet eighth that keeps its first chord, with a `dropped` warning.
- Bar numbers are placed from the drawn SVG (`scoreRender.placeBarLabels`), and the score
  grows upward only when something drawn starts above the top edge. Some songs got taller
  (Für Elise +50 px, The Entertainer +10); Alex accepted this.
- The repair (migration 183) was applied to Great Balls of Fire (in C JaK) only, and
  verified. The songs with no practice history are archived and re-imported instead:
  Fly Me v2, Green Onions (Terrence, FR8 and Solo Eiden) and Moonlight 1st movement.
- S7 claimed `db:table:sam_song_measures` and `db:table:sam_songs`. No fingerings or lyrics
  needed remapping.

## Problem
Some imported MusicXML/MXL scores store bad bars around tremolos and glissandos: pairs of
whole notes in one bar, bars whose tokens add up to more than the time signature, and
pitches at or above the top of the keyboard. Notes that cannot be seen or played are
still expected notes, so they score as misses.

## Findings (step 1)
- Two-note tremolos. MuseScore writes each note at the full displayed value, halves
  `<duration>` and adds a 2:1 `<time-modification>`. The parser kept the ratio, so the bar
  was stored as `w(2:1) w(2:1)`. The timing was right, but whole notes were drawn and any
  sum of tokens overflowed. If a file is written at full length with no ratio,
  `mergeStaff` cut the second note at the barline without saying so.
- Octave-shift is never applied, and that is correct: `<pitch>` is the sounding pitch.
  D8 (MIDI 110) comes straight from the source file. In Great Balls of Fire it is the top
  of a written slide.
- Cue notes were imported as normal notes, and a hidden (`print-object="no"`) pitched note
  was imported and scored. Grace notes are dropped, with a warning.
- No keyboard range check exists anywhere. A note above C8 can never be hit.
- Every stored note that is not a tie continuation is an expected note
  (`measureUtils.struckMidi`). There is no hidden flag.

## Decisions
| Case | Rule |
|---|---|
| Single tremolo | Keep it as a held note. `note.tremolo = {type:"single", marks}` |
| Two-note tremolo | Two notes, each half the total length, ratio removed. `note.tremolo = {type:"start"/"stop", marks}`. A full-length pair is halved, so the second note is no longer cut |
| Glissando / slide | Keep the start and end notes. `note.gliss = {kind:"glissando"/"slide", type:"start"/"stop"/"both"}` |
| Range guard | Any note outside MIDI 21–108 gets `note.unscored = true`, is drawn grey, and is warned about |
| Grace | Dropped, as before |
| Cue | Dropped (the head becomes a rest, its chord members go), with a warning |
| Hidden pitched note | Dropped the same way, with a warning. Hidden rests are unchanged |
| Content past the barline | Still cut, now with a warning (`kind: "cut"`) |

New `parseWarningsStructured` kinds:
- `marking` (tremolo / glissando / slide)
- `dropped` (cue, hidden)
- `range`
- `cut`

The string warnings still contain the literal `<tag>`, so validate.js's Group B check
still treats those tags as acknowledged.

## Existing songs: repair in place, never re-import
- Re-importing creates a new song, so the history is lost.
- Re-loading into the same song fails: `fanOutMeasures` deletes the measure rows, and
  `sam_session_events.measure_id` points at those rows with no `ON DELETE` rule.
- So the repair updates `rh`/`lh` only on bars whose re-parsed content differs.
  Numbering stays the same, and fingerings and lyrics in repaired bars are remapped.
- A bar whose re-parsed content is unchanged is left alone. That covers the correct
  triplet and quintuplet bars: Green Onions Solo Eiden / FR8, Autumn Leaves, Für Elise,
  Fly Me to the Moon v1, and Terrence.

The affected songs:

| Song | id | Bars (played, printed) | History |
|---|---|---|---|
| Great Balls of Fire (in C JaK) | 4a4f0519-d62c-4177-b2f9-05ad224dc02b | Tremolos at 70–74 and 94 (printed 69–73, 93). D8 slides at 36–37 (printed 35–36) | 111 passes, 7 snippets, no fingerings or lyrics |
| Fly Me To The Moon v2 | f7e5a26c-5bae-4453-a967-83fa3348c498 | Tremolos at 79–80 | No passes |
| Green Onions (Terrence) | cd452aa2-88f3-42c4-a095-4313db02a7a8 | 49 right hand overfull (7.67 beats). Not a tremolo, see below | — |

## Green Onions (Terrence) bar 49
- The source writes three dotted-32nd triplet notes (Ab4+C5, A4, Ab4) at `<duration>53`
  each, at 480 divisions, then a `<forward>1`. Together they fill one triplet eighth
  (160 divisions).
- Musically this is a triplet inside a triplet: each note is 1/9 of a beat. The exporter
  could not express that, so it rounded.
- 53/480 is 0.1104 beats, which no SAM token can express. `fromTimeline` falls back to a
  best-effort `q` for each note, and the bar grows to 7.67 beats.
- None of the rules above covers it.
- Proposed fix (built in S4; see Outcome): when a run of segments inside one source tuplet
  cannot be represented, fold the run into one event that spans the whole run (here a
  triplet eighth, `8` 3:2). Keep the first note and warn about the rest, as is done for
  grace notes. Then the bar adds up to 4 beats and the rest of the bar is unaffected.

## Steps
| Step | What |
|---|---|
| S3 | Parser changes, one fixture per case, tests |
| S4 | `struckMidi` skips `unscored`. `scoreRender` draws the tremolo strokes, the gliss line and grey unscored notes. SongLoader sentences for the new kinds |
| S5 | Bring `tools/sam-tools/lib/xmlTruth.js` `NOTATION_TIERS` into line with the parser. Re-vendor the parser and run the corpus regression |
| S6 | Re-parse script in `tools/sam-tools/bin/` that writes `_pending_sam_xml_import-g4w_repair_notation_measures.sql` (changed bars only, plus fingering/lyric remaps) |
| S7 | Database step: gitsync, drift check, claim `db:table:sam_song_measures`, `sam_song_fingerings` and `sam_song_lyrics`, number the migration, Alex runs it, verify, Checkpoint |
| S8 | Finish |
