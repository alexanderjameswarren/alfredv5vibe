# Progress: Importer Duplicate-Note Defect

## Status: M0 complete - awaiting human sign-off before M1

Spec: `docs/technical-spec-import-duplicate-notes.md`

Each milestone is a phase gate. Do not begin the next one until the human has
explicitly confirmed the verification steps passed.

---

## M0 — Recon

- [x] Parse path located and reported (file paths + event-construction function)
- [x] Voice grouping and hand-assignment logic located and described
- [x] Note object property set documented, including all possible `tie` values
- [x] Shared JSON Schema location identified
- [x] Confirmed whether the JSON import path shares the same parse code

**Verification:** Human reads the report. No code has changed — confirm with
`git status` that the working tree is clean.

**Open question to answer here:** can the note format express a note that is
both tied from the previous event and tied to the next? The merge rule in M1
depends on the answer.

---

## M1 — Parse-time de-duplication

- [ ] Merge rule implemented in the event-construction path
- [ ] Keyed on `midi` only, not on whole-object equality
- [ ] Property union implemented; conflicts logged with full location context
- [ ] Unit test: The Scientist m69 reference case
- [ ] Unit test: minimal two-voice-same-pitch MusicXML snippet
- [ ] Tests pass

**Verification:** Re-import the Moonlight Sonata source into a scratch song row.
Run the detection query from the spec against that row. Expect zero rows. Open
the scratch song in the app and confirm measures 28–31 render cleanly.

---

## M2 — Validation rule

- [ ] "No duplicate `midi` within one event" added to shared schema
- [ ] `mcp-platform` skill read first if this touches the Edge Function tree
- [ ] `append_sam_measures` rejects a batch containing the reference case
- [ ] `check_platform_conformance` returns CONFORMANT (if platform-governed)

**Verification:** Human calls `append_sam_measures` with a deliberately
duplicated chord and confirms the whole batch is rejected with a clear error
naming the measure and pitch.

---

## M3 — Repair command

- [ ] `sam-tools` command added, `--dry-run` is the default
- [ ] Report lists song, measure, hand, event index, pitch for every duplicate
- [ ] `--apply` merges duplicates
- [ ] `--apply` sets `measures_edited_at = now()` and `measures_compiled_at = null`
      on each affected song
- [ ] Refuses any song where a stored fingering or lyric index would be invalidated,
      and says which

**Verification:** Run dry-run against the whole database and read the report.
Then apply to one song only. Reopen that song in the app and confirm the
affected measures render correctly and nothing else moved.

---

## M4 — Hand assignment

- [ ] Root cause identified; stated as shared-with-M1 or independent
- [ ] Regression window checked against the actual source documents rather than
      assumed from row timestamps
- [ ] Approach agreed with the human **before** implementing
- [ ] Fix implemented

**Verification:** Re-import Moonlight Sonata. Confirm B#2, C#3 and D#3 in
measures 37–40 are assigned to the left hand, and that the piece is playable as
rendered.

---

## Notes

_Record decisions, surprises, and anything the spec got wrong._

### M0 recon findings (2026-08-26)

**Q1 — Where MusicXML is parsed; the function that builds an event's `notes` array.**

- Entry point: `parseMusicXML(xmlString)` — `src/sam/lib/songParser.js:621`.
- Three phases, per the file header:
  - Phase A — `parseMeasureIntermediate(measEl, state, options)` (`songParser.js:295`)
    reads `<note>` elements and builds one note object per pitched note at
    `songParser.js:424-449`. Chord members (`<chord/>`) append to the previous
    event's `notes` at `songParser.js:503-506`. Events are keyed
    `` `${staff}:${voice}` `` into a `Map`. **This phase does not produce
    duplicates** — a duplicate would require the same voice to repeat a pitch
    inside one `<chord>`, which the corpus does not do.
  - Phase C — `mergeStaff(voices, staff, measureLen)` — `songParser.js:219`.
    **This is the function that builds the final `notes` array, and it is where
    the duplicate is created.** For each time segment it loops over *every*
    voice on the staff (`songParser.js:250`), and for every source event
    covering that segment it pushes every note onto one flat `notes` array
    (`songParser.js:263-275`) with **no pitch de-duplication of any kind**.
    Two voices sounding the same pitch across the same segment therefore
    contribute two entries. The mechanism the spec proposes is confirmed, and
    `mergeStaff` is the correct place for the M1 merge rule.
  - `mergeAndConvert` (`songParser.js:588`) adapts the timeline and calls
    `fromTimeline`; called once per hand at `songParser.js:887-888`
    (staff `"1"` -> `rh`, staff `"2"` -> `lh`).
- `fromTimeline` (`src/sam/lib/durations.js:168`) is strictly one-segment-in /
  one-event-out and only shallow-copies notes (`durations.js:175`). It cannot
  create or remove a note. `mergeStaff` is the sole origin.
- **Why the reference case has one F4 tied and one not.** The tie value is
  computed per contributing source event from `isFirst`/`isLast`
  (`songParser.js:259-274`) — whether *that voice's* event starts and ends on
  the segment boundary. Two voices whose events have different spans get
  different tie values for the same pitch. This confirms the spec's point that
  de-duplication must not compare whole note objects.
- Note ordering: `mergeAndConvert` sorts `notes` ascending by `midi`
  (`songParser.js:606-611`), so duplicates always end up adjacent.

**Q2 — Voice grouping and hand assignment.**

- Grouping: Phase A keys every event by `` `${staff}:${voice}` ``
  (`songParser.js:497-499`), staff from `<staff>` (or `options.forceStaff`),
  voice from `<voice>`, both defaulting to `"1"`.
- Tally: `songParser.js:749-760` counts, **per voice number**, how many
  non-rest events landed on each staff, accumulated across the whole song into
  `voiceStaffTallies`.
- Assignment: `computeHandAssignment(voiceStaffTallies, parseWarnings)` —
  `songParser.js:532`. For each **voice number**, picks the staff with the most
  notes across the entire song; emits a `parseWarning` when the winning share is
  below 60% but assigns to it anyway.
- Application: `applyHandAssignment(intermediateVoices, assignment)` —
  `songParser.js:569`. Rekeys every event to `` `${assignedStaff}:${voice}` ``
  and re-sorts by onset.
- Three configurations, decided in `parseMusicXML` at `songParser.js:648-651`:
  - multi-staff single part -> Phase B runs (song-level per-voice assignment);
  - `useTwoParts` (1 staff, 2+ parts) -> part index forces the staff, Phase B skipped;
  - `usePerNoteFallback` (1 staff, 1 part) -> per-note `midi < 60` -> staff `"2"`
    (`songParser.js:453-461`), Phase B skipped.
- **Relevant to M4, reported but not investigated:** assignment is keyed on the
  voice *number alone*, deliberately discarding the staff dimension. Any score
  where the same voice number appears on both staves (common in music21 output,
  where each staff restarts at voice 1) has that whole voice collapsed onto the
  majority staff. That is a sufficient mechanism to put B#2/C#3/D#3 in the right
  hand without any regression having landed. The sub-60% warning would fire in
  that case, so `generation_notes.importer.parseWarnings` on the affected song
  rows is the cheapest first check in M4.

**Q3 — Note object properties, and the full `tie` value set.**

Properties on a note as emitted by the parser:

| property | type | source | notes |
|---|---|---|---|
| `midi` | integer 0-127 | `pitchToMidi` (`songParser.js:38`) | required |
| `name` | string, step + optional accidental + octave | `noteName` (`songParser.js:42`) | required |
| `tie` | `"start"`, `"end"`, `"both"`, or absent | `songParser.js:432-439`, rewritten by `mergeStaff` `songParser.js:264-274` | optional |
| `fingering` | integer 1-5 | `songParser.js:444-448` | **transient only** — lifted into a parallel `fingerings[]` array and deleted from the note at `songParser.js:1043-1059`. Never present in a stored measure. |

That is the complete set. The schema's `Note` definition is
`additionalProperties: true`, so a hand-authored or MCP-authored document could
carry more, but no code path in the repo emits anything else.

**Answer to the open question: YES — the format can express a note that is both
tied from the previous event and tied to the next. The value is `tie: "both"`.**

It is not a theoretical capability; it is already load-bearing end to end:

- Schema: `"tie": { "enum": ["start", "end", "both"] }` —
  `sam-drill-format.schema.json:166`.
- Produced by the parser in two places: directly from a `<note>` carrying both
  `<tie type="start">` and `<tie type="stop">` (`songParser.js:435`), and
  synthesised by `mergeStaff` for the middle fragments of an N-way split
  (`songParser.js:270`).
- Consumed correctly by rendering (`src/sam/lib/scoreRender.js:483-484`,
  `src/sam/components/ScoreRenderer.jsx:287-288`), by playback
  (`src/sam/lib/noteTimeline.js:44` and `:150` — `"both"` is treated as a middle
  link that keeps the chain walking), and by the validator's orphan-tie check
  (`tools/sam-tools/lib/validate.js:539-540`).

So the spec's preferred branch is available: **when merging duplicates whose tie
values differ, produce the union — `"end"` + `"start"` -> `"both"`** — rather
than keeping the first and logging.

**Q4 — Shared JSON Schema.**

- Master, and the only tracked copy: `sam-drill-format.schema.json` at the repo
  root. `Note` definition at line 158; `VoiceEvent.notes` at line 128.
- `scripts/prebuild.js:16-33` copies it verbatim to two generated locations,
  both gitignored (`.gitignore:29-32`):
  - `src/sam/lib/sam-drill-format.schema.json` — consumed by
    `src/sam/lib/songSchema.js:39` (Ajv) for the JSON import path;
  - `supabase/functions/_shared/sam-drill-format.schema.json` — consumed by
    `supabase/functions/_shared/tools/sam-authoring.ts:24`, which is where
    `append_sam_measures` lives (tool definition at `sam-authoring.ts:230`,
    validation and rejection at `sam-authoring.ts:250-260`).
- Consequence for M2: edit the root file only, then run `node scripts/prebuild.js`
  **before** `npx supabase functions deploy mcp --no-verify-jwt`, or the Deno
  import 404s at runtime.
- `uniqueItems` cannot express "no two notes share a `midi`" — the reference case
  has two *different* objects — so the rule needs either a JSON-Schema
  `contains`/`not` construction or, more likely, a semantic check alongside the
  existing ones in `songSchema.js` and in `sam-authoring.ts`. Both call sites,
  not just one.

**Q5 — Is the parse path shared with the JSON importer?**

No. They are fully disjoint.

- `src/sam/components/SongLoader.jsx:601-635` branches on file type. JSON goes
  `JSON.parse` -> `validateSongDocument` (`src/sam/lib/songSchema.js`, Ajv over
  the shared schema plus semantic checks) and never touches `songParser.js`.
  MusicXML goes `parseMusicXML` -> `validateMusicXmlSong`. Same split in the
  paste path (`SongLoader.jsx:663-690`).
- A `json_import` song therefore carries whatever `notes` arrays the document
  contained; it can only hold a duplicate if the document already had one — for
  example an export of an already-corrupted song, since `songExport.js`
  round-trips notes verbatim.
- **However, there is a second copy of the parser.**
  `tools/sam-tools/vendor/songParser.js` is a verbatim copy maintained by
  `npm run sync` in `tools/sam-tools/package.json:7`
  (`tools/sam-tools/README.md:29`). It is currently **stale** — 1059 lines
  against 1105 in `src/` — but `mergeStaff` is byte-identical between the two
  (verified by diff), so the defect is present in both. The `tools/sam-tools`
  `validate.js` and its whole test suite parse through the vendor copy. **M1 must
  end with `npm run sync` in `tools/sam-tools`,** or the CLI validator will keep
  reporting on unfixed parser output.

### Two things the spec assumes that the code does not support

**1. The duplicate shape is documented elsewhere in the codebase as legitimate,
not as a defect.** `src/sam/lib/noteTimeline.js:141-150` says, verbatim:

> A single event can legitimately carry the SAME pitch twice: one voice holding
> a tied note while another strikes that pitch fresh. Real in the corpus —
> Moonlight m60 `C#4+C#4:end`, Someone Like You m27 `F#4+F#4:end`.

`resolveTieChain` has an explicit workaround for it: it searches for the
*continuation* note first, because taking the first array entry would find the
untied sibling and wrongly declare the tie chain broken. That is the same shape
as the reference case (`F4:start` + `F4` in The Scientist m69), and it is what
the detection query counts.

This is a genuine conflict, not a wording quibble. Merging those two notes into
one is not information-preserving: `C#4{}` + `C#4{tie:"end"}` merged to a single
`C#4{tie:"end"}` tells `resolveTieChain` the pitch was held straight through,
when the source says it was re-struck. Sounding duration for that pitch will
change. The M1 merge rule as written will silently rewrite these events, and the
`noteTimeline.js` workaround becomes dead code that now mis-reports.

The spec has not been changed to accommodate this. Flagging it as the decision M1
cannot start without: either (a) accept the loss and delete the `noteTimeline.js`
workaround in the same change, or (b) narrow the merge rule so a pair where one
note is a tie continuation and the other is not is left alone, and only merge
pairs that are genuinely redundant. Option (b) would leave the reference case
(`F4:start` + `F4` — neither is a continuation, so it *is* redundant) fixed while
preserving Moonlight m60. That looks like the better rule, but it is a musical
judgement rather than a code one, so it is Alex's call.

**2. The M2 validation rule will not gate the MusicXML import path.** The spec
says the validator is "the durable guarantee ... stops *any* path from writing
it". It will not. `validateMusicXmlSong` (`SongLoader.jsx:32-37`) is a four-line
sanity check — object exists, `measures` is a non-empty array — and the shared
schema is deliberately not applied to parser output (`songSchema.js:11-31`
explains why: the parser legitimately emits inline `lyric`, which the strict
schema forbids). So M2 covers `json_import`, `json_paste` and
`append_sam_measures`, but a MusicXML import writes whatever `mergeStaff`
produced. The parser fix is load-bearing for that path, not a convenience. If a
real belt-and-braces guarantee is wanted, the duplicate-`midi` check needs to be
its own function called from all three of `songSchema.js`, `sam-authoring.ts`
and `validateMusicXmlSong`.

### Not verified in M0

The Moonlight hand-assignment mechanism above is a reading of the code, not a
confirmed diagnosis — it needs the actual source `.mxl` files, which M4 calls
for. No database queries were run; the reference case is taken from the spec as
written. Working tree is unchanged apart from this file.

