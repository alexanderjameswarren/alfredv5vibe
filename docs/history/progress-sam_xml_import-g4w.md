# Progress: sam_xml_import-g4w — DONE 2026-10-28

Spec: `docs/history/technical-spec-sam_xml_import-g4w.md`.

| Step | Status |
|---|---|
| S1 plan | Done 2026-10-28 |
| S2 claim + docs | Done 2026-10-28 |
| S3 parser, fixtures, tests | Done 2026-10-28 (corpus regression run in S5) |
| S4 scoring + rendering + import sentences | Done 2026-10-28 |
| S5 xmlTruth sync, re-vendor, corpus regression | Done 2026-10-28, plus the bar-number label work (S5b, S5c) |
| S6 repair script + SQL | Done 2026-10-28 (Great Balls of Fire only, S6b) |
| S7 database step | Done 2026-10-28. Migration 183 ran and `verify_repair.sql` passed. Checkpoint `947b883` is merged to main, and the `db:` claims are released |
| S8 Finish | Ready for Alex's gitpush Finish |

## After Finish (Alex)
- Archive and re-import these five songs. They have no practice history, so they were left out of the repair and a fresh import gives them the new parser:
  - Fly Me To The Moon v2
  - Green Onions (Terrence)
  - Green Onions (FR8)
  - Green Onions (Solo Eiden)
  - Moonlight Sonata 1st Movement
- Add `vexflow@4.2.2` as a dev dependency (`npm i -D vexflow@4.2.2`) once `package.json` is free. It was held by overwatch-q4n throughout. Until then `ScoreRenderer.labels.vexflow.test.jsx` is skipped (7 tests).

## Open follow-ups
- The 8vb / 8va marking is not drawn: The Entertainer's `<octave-shift>` is read, but no bracket is drawn. It is also the parser's standing `<octave-shift>` tone finding in `npm run validate` (Für Elise, The Entertainer, Green Onions).
- Clef changes are not supported: the treble staff is always treble and the bass staff always bass, so a passage written under a clef change draws with many ledger lines. Not needed for any current song. About 1 step: parser, both renderers and the padding.

## S7: database step (2026-10-28)
- Drift check on gitsync `f8e827d..3e2321a`: nothing touched `sam_song_measures`, `sam_songs`, `sam_song_fingerings` or `sam_song_lyrics`.
- `db:table:sam_song_measures` and `db:table:sam_songs` were claimed. The migration was numbered `183_sam_repair_notation_measures.sql`; it only updates rows and grants nothing.
- Alex ran it, and `verify_repair.sql` passed: all four lists empty, and Great Balls of Fire marked to recompile. The app check of bars 70–74, 94 and 36–37 passed.

## S3
- `src/sam/lib/songParser.js`:
  - Tremolo markers. Two-note tremolos are halved and the 2:1 ratio removed.
  - Gliss/slide markers.
  - Cue notes and hidden pitched notes become rests, and their chord members are dropped.
  - Notes outside MIDI 21–108 get `unscored: true`.
  - A warning for content cut at the barline.
  - New structured warning kinds: `marking`, `dropped`, `range`, `cut`.
- Fixtures in `src/sam/lib/__fixtures__/notation/`, tests in `src/sam/lib/songParser.notation.test.js`.
- Checked by hand against the real source files:
  - Great Balls of Fire m70–74 now `h h`, and m94 `q q h` / `h h`. The D8 notes in m36–37 are unscored.
  - Fly Me v2 m79–80 now `q q 8 8` and `q q 8 8`.
  - Green Onions (Terrence) m49 unchanged (out of scope, see spec).
- Corpus regression NOT run. The claims guard blocked the scratch-copy command (it read a
  redirect inside the scratch folder as a repo path). It runs properly in S5, once the
  vendor copy is claimed.
- `unscored` has no effect in the app yet. `struckMidi` is changed in S4.

## S6b: Great Balls of Fire only (2026-10-28)
- Alex chose to repair only Great Balls of Fire (in C JaK), 4a4f0519. That song has 115 passes and 7 snippets; marking-only bars are included. Fly Me v2, the three Green Onions and Moonlight get archived and re-imported after the merge instead.
- Script additions: `--song <id>`, and the CSV export is read directly (`readExport`, tested).
- Run on the export (31 songs; 95 measures for this song, unchanged in count and numbering) and the local JaK(in C) `.mxl`: 23 measures change, with 24 one-row guards (23 measures plus `sam_songs`). There are no fingerings or lyrics to remap.
- Alex approved the script writing the two claimed files, and it ran on 2026-10-28 at 11:24.
  - It wrote `supabase/migrations/_pending_sam_xml_import-g4w_repair_notation_measures.sql` and `supabase/tests/sam_xml_import-g4w/verify_repair.sql`. Both are byte-identical to the reviewed scratch copies.
  - `git status --untracked-files=all` before and after differs only by those two files.
  - The report is unchanged: 23 measures, count stays 95.

## S6: repair script (2026-10-28)
- `tools/sam-tools/bin/repair-notation.js <export.json> <xml-dir>` reads files only.
  - It re-parses each song, compares played measures with the stored rows (notes, durations, tuplets, markings, unscored), and emits the repair as one transaction.
  - Each UPDATE is matched on song, number and the stored rh/lh, and guarded to exactly one row.
  - Fingerings and lyrics in changed measures are remapped by onset and pitch; unmatched rows are listed, not deleted.
  - It sets `sam_songs.measures_edited_at` so the app rebuilds the blob.
  - A song whose measure count or numbering changes is skipped.
  - It also writes `verify_repair.sql` (one read-only JSON) and a report.
- Export query: `supabase/tests/sam_xml_import-g4w/1_export_for_repair.sql` (read-only).
- Tests: `tools/sam-tools/test/repairNotation.test.js` (8, including the CSV reader).
- Preview without the database ("stored" = the HEAD parser's output, across 41 local source files):
  - Changes in Fly Me v2, all four Great Balls of Fire variants, Green Onions FR8, Terrence and Solo Eiden, and Moonlight m37.
  - Many of those are marking-only: a slide or glissando line, no note or rhythm change.
  - Unchanged: Autumn Leaves, the other Fly Me versions, Pastorale, La Petite Réunion, Arabesque, La Candeur, The Scientist and the rest.

## S5c: bar labels from the drawn SVG (2026-10-28)
- The S5b rule (predicting from notehead pitch) failed in Alex's test, because stems, beams and accidentals reach higher. It is replaced.
- `scoreRender.js` now reads the drawn shapes themselves: `shapeBox` and `drawnBoxes` read path data (absolute or relative, arcs included), rects, lines and text.
- `placeBarLabels` lifts a bar number (and its followers: section label, audio-offset badge) to 2 px above the highest shape under its width, only when a shape overlaps it.
- `topRoomFor` and `growSvgTop` grow the SVG upward through the viewBox when anything (music or a lifted label) starts above y = 0. Nothing is re-laid-out.
- `scorePadding` now sizes only the gap between the staves and the room below.
- Both views call these helpers after drawing.
- Verified with real VexFlow 4.2.2 under jsdom, using a scratch harness that mounts the real `ScrollEngine` and `ScoreRenderer`, with an independent shape reader: all 16 songs, both views, no label overlaps and nothing clipped.
  - Für Elise bars 23, 102–105; Fly Me v2 bars 79–81; Great Balls of Fire bars 30, 31, 36, 37, 70–72, 74 and 75: all clear.
- New test `ScoreRenderer.labels.vexflow.test.jsx`, with fixture `__fixtures__/notation/label-bars.json`. It covers 3 bars of each song in both views, plus an unchanged bar.
  - It needs VexFlow: `npm i -D vexflow@4.2.2` (`package.json` is held by overwatch-q4n), or VEXFLOW_PATH. It is skipped without one.
  - With the scratch copy it passes 7/7. With label placement disabled, 6 fail.
- Height changes, practice and browse the same:
  - Für Elise +50.
  - Fly Me v2 +10.
  - Arabesque +20.
  - Pastorale +10.
  - The Entertainer +10 (its stems and beams already sat under 88 labels).
  - Green Onions +50.
  - Great Balls of Fire +70.
  - The other 9 corpus songs +0.

## S5b: bar labels per bar (2026-10-28, superseded by S5c)
- `scoreRender.js` had `barLabelText`, `barLabelLift` and `clampLabelLift`.
  - A bar's label (and its section label) lifted only when one of that bar's treble notes sat under the label text, placed by beat the way `applyTimeProportionalLayout` places it.
- Alex's test found it missed stems, beams and accidentals, which is what led to S5c.

## S5 (done; the song-level label rule here was superseded by S5b, then S5c)
- `xmlTruth.js` now follows the same rules as the parser, written independently: cue and hidden notes dropped, two-note tremolos halved with no ratio, notes outside MIDI 21–108 marked unscored, nested-triplet runs folded.
- `NOTATION_TIERS`: tremolo and cue moved A→B; glissando and slide moved A→C.
- Corpus `npm run validate`: output byte-identical to the pre-change baseline, so the Moonlight m37 block is cleared.
- The real Great Balls of Fire, Fly Me v2 and Green Onions files validate with no new findings. Green Onions shows the `<octave-shift>` tone finding the parser has always had (Für Elise and The Entertainer show it too).

## S4 fix: crash on import (2026-10-28)
- The crash: `ReferenceError: Cannot access 'layout' before initialization` in `ScoreRenderer.jsx`.
- The cause: my padding destructure at the top of the render effect read `layout`, but the effect declares its own `const layout = []` (ghost overlay) further down. That put the read in the temporal dead zone, so it crashed on any song once VexFlow was loaded.
- The fix: the memo is renamed `staffLayout`.
- The test: `ScoreRenderer.padding.test.jsx` renders with the real scoreRender module and a stand-in VexFlow. It fails with the same ReferenceError if the bug is put back.
- ScrollEngine had no such clash.

## S4 (done)
- `struckMidi` skips `unscored` notes.
- `scoreRender.js`: `scorePadding`, `noteHeadY`, `styleUnscored`, `noteMarks` and `drawNotationMarks`. `renderCopy` takes `pad`.
- `ScrollEngine.jsx` and `ScoreRenderer.jsx` use the padding, draw unscored notes grey and draw the markings.
- SongLoader shows `range`, `dropped` and `cut` as visible warnings.
- The parser folds a tuplet-inside-a-tuplet run into one event (Green Onions (Terrence) m49), with fixture `nested-triplet.musicxml`.
- `vendor/songParser.js` was re-synced by applying the same edits; it is identical to `src`.
- Great Balls of Fire m36–37 left-hand D8: the source has no clef change and no octave-shift. Those notes really are written on staff 2, so this is not a parser error.
