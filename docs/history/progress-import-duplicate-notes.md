# Progress: Importer Duplicate-Note Defect

## Status: M0-M4 verified. M5 implemented - awaiting human verification.

Spec: `docs/technical-spec-import-duplicate-notes.md` (**revision 2** — reread
it, M2 and M4 changed and M5 is new)

Each milestone is a phase gate. Do not begin the next until the human has
explicitly confirmed verification passed.

---

## M0 — Recon ✅

- [x] Parse path located — `mergeStaff` at `songParser.js:219` is the sole origin
- [x] Voice grouping and hand assignment described
- [x] Note properties documented — `tie` is `start`/`end`/`both`
- [x] Shared schema located, plus the `prebuild.js` copy step
- [x] JSON import path confirmed disjoint; vendor copy found stale

**Two findings that changed the spec:**

1. Same-pitch-twice is legitimate when one entry is a continuation. Resolved by
   the continuation rule — merge only when neither entry has `tie` of `"end"` or
   `"both"`. Decision made: take the narrow rule, keep the `resolveTieChain`
   workaround.
2. The schema never gates parser output, so M2 was rescoped to a shared check
   function called from all three write paths.

---

## M1 — Parse-time de-duplication

- [x] Continuation rule implemented in `mergeStaff`
- [x] Keyed on `midi` only, not whole-object equality
- [x] Merges only when neither entry is a continuation
- [x] No `"both"` union branch (unreachable — see spec)
- [x] `resolveTieChain` workaround left intact
- [x] Property union; conflicts logged with measure / hand / event / pitch
      (song identity is carried by `parseWarnings` being song-scoped — see Notes)
- [x] Test: The Scientist m69 — merged
- [x] Test: Moonlight m60 — unchanged
- [x] Test: Someone Like You m27 — unchanged
- [x] Test: minimal two-voice-same-pitch MusicXML snippet
- [x] `npm run sync` run; vendor staleness reported separately, not absorbed silently

**Verification:** Re-import the Moonlight Sonata source into a scratch song row.
Run the revision 2 detection query against it — expect zero rows. Then confirm
m60 still contains its `C#4` + `C#4:end` pair. Open the scratch song and check
measures 28–31 render cleanly.

---

## M1a — Validator oracle _(rev 3)_

- [x] Continuation rule implemented directly in `xmlTruth.js`
- [x] Oracle does **not** call `mergeDuplicatePitches` — independent implementation
- [x] Confirmed the oracle has its own span information; no fallback needed
- [x] Tests pinning the oracle's rule, including the preservation cases
- [x] `sam validate fixtures` back to no BLOCKED

**Verification:** `sam validate fixtures` returns `8 CLEAN · 5 WARN`, no BLOCKED,
and none of content-divergence / voice-collision / tuplet-scaling. See Notes for
why the "5 WARN are the 7 tuplet-scaling cases" wording could not hold.

---

## M2 — Shared check at every write path

- [x] Duplicate check extracted as a shared predicate (`src/sam/lib/noteDuplicates.js`)
- [x] Called from `validateMusicXmlSong` (`SongLoader.jsx`)
- [x] Called from the JSON import path (via `songSchema.js`, covering paste too)
- [x] Called from `append_sam_measures` (`sam-authoring.ts`) — via a Deno port
      plus a behavioural parity test; Deno cannot import from `src/`
- [x] Rule added to `sam-drill-format.schema.json` as a second layer
      (custom Ajv keyword — draft-07 cannot express it; see Notes)
- [x] `node scripts/prebuild.js` run — deploy itself is Alex's step
- [x] `mcp-platform` skill read before touching the Edge Function tree
- [x] `check_platform_conformance` returns CONFORMANT (no schema change; verified anyway)
- [ ] **Human step:** `append_sam_measures` rejection not verifiable locally
      (no Deno on this machine) — see Verification below

**Verification:** Human attempts all three paths with a deliberately duplicated
chord — a crafted MusicXML file, a JSON paste, and an `append_sam_measures`
call. All three rejected, each naming the measure and pitch. Then confirm a
*continuation* pair is accepted by all three.

---

## M3 — Repair command

- [x] Repair tool added, dry run by default — **as a browser-console script**
      (`scripts/sam-repair-duplicates.js`), not a `sam-tools` command:
      `sam-tools` has no database access and cannot be given any. See Notes.
- [x] Uses the same shared predicate as M1 and M2 (inlined mechanically from
      `noteDuplicates.js`, with a parity test — not restated)
- [x] Report lists song, measure, hand, event index, pitch
- [x] `{ apply: true }` merges duplicates (needs a songId; `{ all: true }` for bulk)
- [x] Apply sets `measures_edited_at = now()`, `measures_compiled_at = null`
- [x] Refuses songs where a fingering index would be invalidated, and names the rows
- [x] Lyric indices checked too — they cannot be invalidated by this repair, and
      the planner asserts that rather than assuming it. See Notes.
- [ ] **Human step:** dry run and apply both need Alex's session — not run here

**Verification:** Dry-run against the whole database; read the report. Apply to
one song only. Reopen it and confirm the affected measures render correctly and
nothing else moved.

---

## M4 — Hand assignment

Root cause known: `computeHandAssignment` discards the staff dimension. No
regression to hunt.

- [x] Interaction with the Phase B skip cases checked — there is none, see Notes
- [x] Approach agreed with the human **before** implementing — rule (a), and the
      oracle site confirmed as a removal rather than a mirror
- [x] Fix implemented — parser, oracle, validator and spec §3.6 together
- [x] `sam validate fixtures` stayed at 8 CLEAN · 5 WARN throughout; Moonlight
      never read BLOCKED
- [x] Diff matches the agreed expectation on all 13 fixtures
- [x] **Human step:** re-import Moonlight and confirm m37-40 bass notes are left
      hand and the piece is playable as rendered — verified by Alex 2026-08-27

**Verification:** Re-import Moonlight Sonata. Confirm B#2, C#3 and D#3 in
measures 37–40 are left hand, and the piece is playable as rendered.

---

## M5 — Render legitimate duplicates as one notehead

- [x] Single notehead drawn for same-pitch pairs — in **both** renderers:
      `scoreRender.js` (scroll view) and `components/ScoreRenderer.jsx` (edit
      view), six call sites, via one shared helper in `vexflowHelpers.js`
- [x] Data left intact — the collapse is render-only; ties re-indexed onto the
      surviving notehead, accidentals drawn once per notehead
- [x] Fingering tap zones produce one zone per visible notehead — followed from
      the geometry with no change needed; see Notes
- [ ] **Human step:** open Moonlight m60 — one notehead on the C#4 line, no
      sideways displacement; tap it in fingering mode and check the docked
      number bar

**Verification:** Open Moonlight m60. One notehead on the C#4 line, no sideways
displacement. Tap it in fingering mode — one zone, docked number bar behaves.

---

## Notes

_Record decisions, surprises, and anything the spec got wrong._

### M1 implementation (2026-08-26)

**What changed.** `src/sam/lib/songParser.js` only, plus the vendor sync and a
new test file.

- `isContinuation(note)` and `mergeDuplicatePitches(notes, warn)` added above
  `mergeStaff`, both exported so M2 and M3 can reuse the predicate rather than
  restate it.
- `mergeStaff` gained two optional trailing parameters, `parseWarnings` and
  `context`, following `durations.fromTimeline`'s existing convention. Each
  segment's flattened `notes` array runs through `mergeDuplicatePitches` before
  it becomes an event. Omitting the two parameters keeps the old behaviour of
  merging silently, so existing callers and unit tests were unaffected.
- `mergeAndConvert` passes `parseWarnings` and `` `m${mNum} ${hand}` ``.

**The rule tests derived ties, not source ties — and that matters.** `mergeStaff`
recomputes `tie` per contributing source event from `isFirst`/`isLast`
(`songParser.js:259-274`), so a voice whose event began before the current
segment is forced to `"end"` or `"both"`. That is precisely the "this voice is
holding" signal the continuation rule needs, and it is available for free. Two
untied source notes can still form a legitimate pair once the segmentation
splits one of them; reading source ties instead would have merged those and
fused a re-articulation into a held tone. There is a test pinning this
(`"the rule tests DERIVED ties, not source ties"`).

**Event index in warnings.** `out.length` at push time is the index the segment
will occupy, and `fromTimeline` is one-segment-in / one-event-out, so it is also
the final `rh`/`lh` index — which is what a reader needs to find the note. Song
identity is not in the message text: `parseWarnings` is already song-scoped and
lands in `generation_notes.importer.parseWarnings`, so repeating it per line
would be noise. Flagging it since the spec asked for song in the log line.

**Only conflicts are logged, not merges.** The spec's logging bullets are all
about conflicts, and this is the right reading — Moonlight alone merges 24
times, and warning on each would flood the M8 import gate that surfaces
`parseWarnings` to the human at import time.

**Tests.** New file `src/sam/lib/songParser.dedupe.test.js`, 27 tests at three
levels: the predicate and property union directly, `mergeStaff` (so the rule is
pinned to where the flattening happens), and `parseMusicXML` end to end on a
minimal two-voice snippet that covers both a genuine duplicate and a
hold-plus-restrike. Full CRA suite 386 passed / 18 suites; `tools/sam-tools`
153 passed.

### Measured effect on the real fixtures

Parsed all 13 `.mxl` fixtures through the pre-M1 and post-M1 parsers and counted
duplicate pitch groups per event, split by whether any entry is a continuation:

| fixture | defect dups before | after | legitimate pairs before | after |
|---|---|---|---|---|
| sonate-no-14-moonlight-1st-movement | 24 | **0** | 3 | 3 |
| The_Entertainer_-_Scott_Joplin_-_1902 | 2 | **0** | 0 | 0 |
| say-it-aint-so-by-weezer | 0 | 0 | 6 | 6 |
| someone-like-you-easy-piano | 0 | 0 | 2 | 2 |
| all other 9 fixtures | 0 | 0 | 0 | 0 |
| **total** | **26** | **0** | **11** | **11** |

The two pairs the spec names by hand are preserved exactly:

- Moonlight m60 rh event 2: `C#4 + C#4:end`
- Someone Like You m27 rh event 8: `F#4 + F#4:end`

**Zero merge conflicts fired across the whole corpus** — no enharmonic
disagreements, no differing property values. That answers the spec's open
question ("the purpose of logging rather than failing is to find out whether
they are rare"): on this corpus they do not occur at all.

**The Entertainer was not previously known to be affected.** Two duplicates,
now zero. It is not in the spec's evidence and it is not one of the Moonlight
imports, so the defect is broader than the four Moonlight rows.

### Vendor staleness, reported rather than absorbed

Per the spec's instruction not to fold this in silently. The pre-existing drift
between `src/sam/lib/songParser.js` and `tools/sam-tools/vendor/songParser.js`
was **exactly one feature**: RH fingering extraction (spec §6) — the
`<notations><technical><fingering>` read at `songParser.js:440-448` and the
lift-and-strip block at `:1027-1062`, plus the `fingerings` key on the returned
song. Nothing else, and `mergeStaff` was byte-identical. So the vendor copy has
been reporting on a parser without fingering support since that feature landed.

`npm run sync` therefore brought across two things: M1, and that fingering
feature. `durations.js` and `playbackOrder.js` were already identical. All three
vendor files are now byte-identical to their `src/` masters, and the 153
`sam-tools` tests pass after the sync.

(The 1105-vs-1059 line count in the M0 report was accurate, but note that a
naive `diff` of the two files reports every line as changed — both are CRLF and
`git show` emits LF. The real drift is 46 lines.)

### One thing M1 exposed that the spec did not account for

**`tools/sam-tools/lib/xmlTruth.js` contains a second, independent
implementation of the same staff flattening — `mergeStaff` at `xmlTruth.js:217`
— and it still produces duplicates.** It is the validator's oracle, deliberately
written as a separate implementation ("this is the oracle, not a rewrite",
`xmlTruth.js:2`), so `npm run sync` does not and should not touch it.

`validate.js`'s `firstDivergence` compares the exact midi list at each onset
(`validate.js:687`). Now that the parser is correct and the oracle still
reproduces the bug, they disagree at exactly the places M1 fixed. Measured, with
a control run where only the merge call was bypassed:

| `sam validate fixtures` | before M1 | after M1 |
|---|---|---|
| status | 8 CLEAN · 5 WARN | 8 CLEAN · 3 WARN · **2 BLOCKED** |
| tuplet scaling | 0 | 7 (Moonlight m15, 23, 28–31, 37) |
| content divergence | 0 | 3 (Moonlight m38, 39, 40) |
| voice collision | 0 | 2 (The Entertainer) |

Verbose output confirms the cause directly rather than by inference:

```
m15 rh  notes at shared onset differ at beat 0: parser=[59], truth=[59,59]
m38 rh  notes at shared onset differ at beat 0: parser=[48], truth=[48,48]
```

Every one of these 12 findings is the oracle asserting the duplicate that M1
just removed. None is a real parser regression, and all 12 sit on the measures
the fixture scan above shows were repaired.

**Not fixed here, deliberately.** Applying the continuation rule to
`xmlTruth.js` would make the validator green again, and there is a good argument
that it is correct on the merits — the oracle models sounding content, and two
voices sounding one pitch is one sounding pitch. But changing an oracle so that
it agrees with the code under test is exactly the change that should not be made
without saying so first, and it is outside M1's stated scope (M1 ends at
`npm run sync`). Flagging it for a decision before M2, since M2's shared
predicate is the natural place to reuse if the answer is "yes, fix the oracle
too".

Until then `sam validate` reports Moonlight and The Entertainer as BLOCKED. That
is a known false positive with a known cause, not an unexplained regression.

### Not done in M1

The spec's M1 verification is a human step — re-import the Moonlight source into
a scratch song row, run the revision 2 detection query, confirm m60 still holds
its pair, and eyeball measures 28–31. No database was touched and no song row
was created. The fixture evidence above is the closest offline equivalent: same
source file, same parser, same predicate as the detection query.

### M1a — validator oracle (2026-08-26)

**The oracle had the span information.** No fallback was needed and none was
used. `xmlTruth.js`'s `mergeStaff` already computes `isFirst`/`isLast` per
contributing source event against the segment bounds (`xmlTruth.js:277-278`) and
derives `"end"`/`"both"`/`"start"` from them — it was corrected to match the
parser's tie chain during the M2 port back in 2026-08-05. So the held-versus-
fresh distinction is available inside the oracle from its own segmentation, with
nothing imported from the parser side.

**What was added.** `isHeld` and `collapseSoundingDuplicates` in `xmlTruth.js`,
called from `mergeStaff` just before each segment becomes an event. No call into
`mergeDuplicatePitches`, per the rev 3 instruction.

The two implementations are deliberately different in shape, not just in
location. The parser's is a single pass that folds into a running output array;
the oracle's is two passes — count the fresh strikes per pitch, then emit,
folding only the pitches that were over-counted. Same rule, arrived at
differently, so an error in one is unlikely to be reproduced by the other.

The oracle's note objects are `{midi, name, tie?}` — it never reads
`<fingering>` — so its union reduces to "keep the first spelling, keep a
`start` if either entry had one". A spelling disagreement is dropped silently
there; the oracle is compared on pitch and has no warning channel. The parser
side still logs those.

**Tests.** New `tools/sam-tools/test/xmlTruth.dedupe.test.js`, 8 tests: the fold
itself, the chord case, two preservation cases (segmentation-derived hold and
source-tied hold), the three-entry case, and two corpus assertions — that the
oracle now states no fresh duplicate anywhere, and that it *still expects* the
legitimate pairs in Moonlight and Someone Like You. That second one is the real
guard: an over-greedy collapse in the oracle would silently start demanding that
the parser drop those pairs too. `sam-tools` 161 passed; CRA 386 passed.

**Result.** `sam validate fixtures`:

| | pre-M1 baseline | after M1 | after M1a |
|---|---|---|---|
| status | 8 CLEAN · 5 WARN | 8 CLEAN · 3 WARN · 2 BLOCKED | **8 CLEAN · 5 WARN** |
| tuplet scaling | 0 | 7 | **0** |
| content divergence | 0 | 3 | **0** |
| voice collision | 0 | 2 | **0** |

All 12 false positives gone, and the corpus is back to exactly its pre-M1
baseline. The 5 WARN files are The Entertainer, Für Elise, Prelude in C minor,
Someone Like You and Moonlight, carrying only the pre-existing informational
findings: cross-staff voice (33), volta-seam tie (4), anacrusis (4), unhandled
tone-altering notation (2), key mode mislabelled (1).

**One correction to the stated verification.** The criterion given was "8 CLEAN ·
5 WARN with no BLOCKED, and the 5 WARN are the 7 tuplet-scaling cases only". The
middle clause cannot hold, and the achieved result is better than it, not worse:

- `tuplet_scaling` has severity 1 in `bin/sam.js:10`, and
  `bin/sam.js:93` sets a file to BLOCKED if any finding is blocking. Seven
  tuplet-scaling findings would therefore force BLOCKED, contradicting "no
  BLOCKED" in the same sentence.
- The pre-M1 control run had **zero** tuplet-scaling findings. All 7 appeared
  only after M1, as oracle-divergence false positives on Moonlight m15, 23,
  28-31 and 37 — the same measures the fixture scan shows were repaired. They
  were labelled `tuplet_scaling` rather than `content_divergence` only because
  `validate.js:460` prefers the most specific label when a divergent measure
  also happens to contain a tuplet.

So removing the false positives removes all three classes together. There is no
residue of 7 to keep.

### M2 — shared check at every write path (2026-08-26)

**The predicate now has one home.** `src/sam/lib/noteDuplicates.js`, containing
`isContinuation`, `duplicatePitches` (the predicate proper), the merge from M1,
the shared message wording, and the Ajv keyword registration. `songParser.js`
imports it; the M1 copies are gone.

`mergeDuplicatePitches` was restructured to be *defined in terms of*
`duplicatePitches` — it merges exactly the pitches the predicate reports and
nothing else. The fixer and the checker can no longer disagree about what counts
as a duplicate, which is the property M2 asked for. M1's tests pass unchanged
apart from the import line.

**Files.**

| | |
|---|---|
| new | `src/sam/lib/noteDuplicates.js` — the shared predicate |
| new | `supabase/functions/_shared/noteDuplicates.ts` — Deno port |
| new | `src/sam/lib/noteDuplicates.test.js` — 22 tests, incl. parity |
| new | `tools/sam-tools/vendor/noteDuplicates.js` — synced copy (tracked, like the other vendor files — needs adding to git) |
| mod | `songParser.js`, `songSchema.js`, `SongLoader.jsx`, `sam-authoring.ts`, `sam-drill-format.schema.json`, `tools/sam-tools/package.json` |

**Write path 1 — `validateMusicXmlSong`.** Was a four-line existence check.
Now scans every event. Worded as a parser defect rather than a source-quality
problem, because reaching it means M1's merge failed to fire — there is nothing
for a human to weigh at the M8 gate. Exported so it can be tested; it was the
only one of the three with no other way in.

**Write path 2 — `validateSongDocument`.** Duplicates are an ERROR, not a
warning, and deliberately not routed through the M8 approval dialog the way a
short bar is: a short measure still stores and plays, whereas a duplicate cannot
be rendered or indexed correctly. Covers `json_import` and `json_paste`, which
both enter here.

**Write path 3 — `append_sam_measures`.** Explicit call in `validateOneMeasure`
alongside the existing midi/name check, so a duplicate joins the same
reject-the-whole-batch error list. Also widened the file's local `Measure`
interface, which declared notes as `{midi, name}` — `tie` was missing while
nothing in the file read it, and the whole M2 rule turns on `tie`.

**The Deno boundary, and why this is a port rather than an import.** Deno cannot
import from `src/`. Alex already settled this exact question for `durations.ts`
on 2026-08-06 — "opted for a duplicate + parity-test over build-time codegen"
(`durations.test.js:259`) — so this follows that decision rather than
re-opening it with a prebuild copy.

The drift guard is stronger than the durations one, though. That test compares a
literal `BASE` map; a predicate is code, so this one is behavioural: it reads
the Deno file, strips its type annotations, evaluates the block between
`PARITY-MARKER-START/END`, and runs 16 shared cases plus the tie values through
**both** implementations, asserting identical verdicts. There is a third test
that mutates the extracted source and confirms the comparison actually notices —
a parity test that cannot fail has not been tested.

The stripper whitelists the annotations the marked block is allowed to use and
throws an explanatory error on an unfamiliar one, so extending the block fails
loudly rather than silently skipping the check.

### The schema layer, and what it cost to find out it was working

Draft-07 **cannot** express this rule. There is no way to compare sibling array
items, and `uniqueItems` does not help because the two entries are genuinely
different objects — in the reference case they differ by a tie. That was flagged
as a possibility in the M0 report; it is now confirmed as a hard limitation, not
a preference.

So the rule rides in `sam-drill-format.schema.json` as a custom Ajv keyword,
`noDuplicatePitches: true` on `VoiceEvent.notes`, registered on both Ajv
instances by the shared module (and its port). A validator that does not know
the keyword ignores it — both instances run `strict: false` — so the schema
still degrades safely rather than erroring on an unrecognised word.

**A near-miss worth recording.** The first probe after wiring it up showed the
keyword was *not* firing: the error came from the semantic layer, not the
structural one. Cause was that `scripts/prebuild.js` had not been re-run, so the
two generated schema copies still held the pre-M2 document. The master at repo
root is the only tracked copy; the copies under `src/sam/lib/` and
`supabase/functions/_shared/` are gitignored and regenerate on build.

That is exactly the failure the spec's "run prebuild before deploy" line warns
about, and it is worth being blunt about the consequence: **the schema layer is
only ever as live as the last prebuild.** If it had been the only layer, the
JSON path would have silently had no duplicate check at all and every test here
would still have passed, because the semantic check was quietly covering for it.

Which is an argument for keeping both, not just an argument for remembering to
run prebuild. The explicit predicate call in each path is compiled into the
bundle and cannot go stale; the keyword is the second layer. Kept both
deliberately. Where they overlap only one message surfaces — `validateSongDocument`
returns early on structural failure, so the keyword's JSON-pointer message wins
for JSON documents and the semantic one is the fallback.

`node scripts/prebuild.js` has been run. Both copies now carry the keyword.

### Platform

Read the `mcp-platform` skill before touching `_shared/`. M2 creates no table,
adds no tool, and runs no migration, so Rules 2 and 5 (register_table, migration
conformance) are not engaged. Rule 1 is respected — no Supabase client import
was added; the change is confined to validation. `check_platform_conformance`
returns **CONFORMANT — all 16 non-exempt public tables satisfy platform contract
v1**, unchanged, as expected for a change that does not touch schema.

### What is verified, and what is not

Verified locally: CRA **408 tests / 19 suites**, `sam-tools` **161 tests**, both
green. That covers the predicate, both browser write paths, the schema keyword
firing on a real document, the legitimate pair still being accepted, and
behavioural parity with the Deno port.

**Not verified locally: the Edge Function itself.** Deno is not installed on this
machine, so `sam-authoring.ts` was neither type-checked nor executed. What backs
it is the parity test on the predicate, and reading. The human verification step
in this milestone — calling `append_sam_measures` with a duplicated chord — is
the real check on that path, and it should be run before this is considered
done.

One observation while working there: the file's existing
`lh?: typeof Measure.prototype.rh` is not valid TypeScript as written
(`Measure` is an interface and has no `prototype` value), yet the function
deploys. That suggests `supabase functions deploy` transpiles without
type-checking, which lowers the risk of the new `.ts` port but also means a type
error there would not be caught at deploy time either. Stated as an inference
from evidence, not as something confirmed.

Deploy itself has not been run — `npx supabase functions deploy mcp
--no-verify-jwt` is Alex's step, and prebuild has already been run so the
generated schema copy in `_shared/` is current. Note that `noteDuplicates.ts` is
a tracked hand-port, not a generated file, so it needs no prebuild step of its
own.

### M3 — repair pass (2026-08-26)

**Delivered as a browser-console tool, not a `sam-tools` command.** This is the
one place M3 departs from the spec, and it is not a judgement call about what is
nicer.

`tools/sam-tools` has no database access at all — no Supabase dependency, no
credentials, and its README says so ("nothing read from Downloads, no
database"). It cannot grow one either: SAM's RLS is per-user, the anon key alone
reaches none of Alex's rows, and the standing instruction is that data writes are
run by Alex himself rather than by adding a service-role key. So a `sam-tools`
subcommand would be a repair tool that cannot reach anything to repair.

`scripts/sam-repair-duplicates.js` follows the pattern already established for
exactly this in `scripts/sam-roundtrip-diff.js`: paste into the DevTools console
on the app's origin, borrow the session token supabase-js already persisted in
localStorage, talk to PostgREST with plain `fetch`. No credentials anywhere.

`--dry-run` / `--apply` became `{}` / `{ apply: true }`, since it is a console
function rather than an argv parser. The semantics are the ones the spec asked
for.

**The predicate is inlined, not restated.** The tool has to be a single
paste-able file, so it cannot import. `scripts/inline-note-duplicates.js`
(`npm run inline:repair-script`) splices `src/sam/lib/noteDuplicates.js` in
between markers, stripping only the `export` keywords, and a parity test asserts
the spliced copy still equals the module. That is the third instance of the same
mechanism in this repo — prebuild for the schema JSON, `npm run sync` for the
vendor tree, this for the console tool.

Deliberately NOT wired into `prebuild`: it rewrites a tracked file, and having a
build silently rewrite tracked source is worse than a parity test that tells you
to re-run one command.

### What it refuses, and the one thing that turned out not to need refusing

**Fingerings — a real risk, precisely tested.** A stored `note_index` is
invalidated iff it stops addressing the pitch it addressed before. That is the
whole test, and it is exact rather than conservative: in
`[C4, F4, F4, A4] → [C4, F4, A4]`, `note_index` 0 and 1 still mean C4 and F4 and
are left alone; 2 was F4 and would become A4; 3 falls off the end. Only 2 and 3
block. A song with any blocker is skipped **entirely**, never partially
repaired, and each offending row is named with its id, measure, rh_index,
note_index, finger, source, and what the pitch would become.

Fingering rows that already point past the end of their event are reported
separately as pre-existing damage — worth knowing about, but not this repair's
fault and not a reason to refuse.

**Lyrics — cannot be invalidated by this repair.** `sam_song_lyrics` addresses
`(measure_num, rh_index)` and carries **no note index**: a syllable sits on an
event, not on a notehead. Merging happens strictly inside an event's `notes`
array, so the event count is unchanged and every `rh_index` still points where
it did.

So the lyric half of the refusal rule can never fire. Rather than leave that as
an assumption, the planner asserts it — it compares the event count before and
after per hand, and a change would raise a blocker for exactly the reason
lyrics would then need one. Syllables sitting on affected events are counted and
reported so the human can look, but they do not block. Flagging this because the
spec and the M0 notes both treat lyrics as being at the same risk as fingerings,
and they are not.

### Other things worth knowing

- **Apply needs a song id.** `{ apply: true }` without one is refused, with the
  message telling you the two ways forward. The spec's bulk `--apply` is still
  there as `{ apply: true, all: true }` — available, but not reachable by
  accident. This matches the spec's own reasoning that nothing is on fire and a
  readable report is worth more than speed.
- **The compiled blob is invalidated last, and failure is loud.** Measure rows
  are written first, then `measures_edited_at = now()` / `measures_compiled_at =
  null`. If that second write fails, the rows are already repaired and the app
  would keep serving the stale copy — so that case prints in red and hands back
  the exact command to finish the job, rather than reporting success.
- **Paged reads.** PostgREST caps a response at 1000 rows by default and a song
  can have hundreds of measures. Every read pages explicitly; reading a
  truncated corpus and reporting it as "the whole database" would be the worst
  possible failure for a tool whose output is a clean bill of health.
- Only measure rows that actually change are written. A song's clean measures are
  not rewritten, so `updated_at` stays meaningful.

### Verification

20 unit tests (`src/sam/lib/repairDuplicates.test.js`) drive the tool's planning
function directly — it is exposed as `__samPlanSong` precisely so the
decision-making is not stranded in an untested console script. Covers finding,
the fingering blocker at each index position, the dangling-row case, lyrics, the
event-count assertion, and inlined-copy parity (including a check that the parity
comparison can actually fail).

Then an offline end-to-end smoke run against a stubbed PostgREST — three fake
songs, one clean, one repairable, one blocked by a fingering — confirming:

| step | writes |
|---|---|
| dry run, all songs | **0** |
| `{ apply: true }` with no songId | **0** — refused |
| `{ songId: "<blocked>", apply: true }` | **0** — refused, row named |
| `{ songId: "<repairable>", apply: true }` | 1 measure PATCH + 1 song PATCH |

The two writes in the last row were exactly:

```
sam_song_measures ?id=eq.md2  -> {"rh":[...F4 merged, A4 kept...],"lh":[...C3 merged...]}
sam_songs         ?id=eq.s-dup -> {"measures_edited_at":"…","measures_compiled_at":null}
```

The song's clean measure and its legitimate `C#4 + C#4:end` pair were not
touched. Full suites: CRA **428 tests / 20 suites**, `sam-tools` **161**, green.

**Not run against the real database.** As instructed — `--apply` is Alex's to
run. The dry run is also his: it needs his session. Nothing in this milestone has
touched a real row.

### M4 — hand assignment: investigation (2026-08-27)

Nothing implemented. The milestone gates on agreeing the approach first, and the
investigation turned up enough to change what the approach should be.

**Phase B skip-case interaction: checked, and there is none.**
`applyHandAssignment` is reached only when `voiceHandAssignment` is non-null
(`songParser.js:910-912`), and that is null for both skip cases
(`songParser.js:813`). `usePerNoteFallback` routes per note by `midi < 60` and
`useTwoParts` forces the staff from the part index; neither ever consults a
voice tally. Any refinement placed inside `applyHandAssignment` therefore cannot
touch them. The corpus agrees — 3 of the 13 fixtures skip §3.6 entirely.

**The rev 3 root cause is right but incomplete.** "Discards the staff dimension"
is true. But the deeper limitation is granularity: **a per-song rule cannot
represent a voice whose hand genuinely changes during the piece**, and that is
what Moonlight does.

Song-level tallies for Moonlight:

```
voice 1: {staff1: 268, staff2: 110} -> rh (71%)
voice 2: {staff1: 364, staff2: 179} -> rh (67%)
voice 5: {staff2: 135}              -> lh (100%)
voice 6: {staff2: 8}                -> lh (100%)
```

In m38–40 there is **nothing on the treble staff at all** — voices 1 and 2 are
entirely on staff 2, and voice 5 holds the pedal octaves below them. The
song-level majority drags all of it back to the right hand, which is why m38
comes out as:

```
m38 rh: B#2 B#2 F#3 B#2 G#3 B#2 A3 B#2 G#3 B#2 F#3 D#3 D#3 F#3 D#3 A3 C#3 C#3 F#3 C#3 A3
m38 lh: G#1 G#2
```

The right hand is asked to play a B#2–A3 triplet arpeggio and the inner voice at
once, while the left hand plays two notes. That is the "not playable as
rendered" complaint, and B#2 / C#3 / D#3 are exactly the pitches the success
criterion names.

**§3.6 is deliberate, and a naive fix breaks it.** The rule exists to stop
`<staff>` tearing cross-staff lines apart — Moonlight m6, where voice 2 is one
arpeggio written `D#4 F#4` on the treble staff and `G#3` on the bass. Confirmed
still true in the fixture. Two tempting fixes are therefore off the table:

- **Per-measure majority.** §3.6 already rejects it with a counterexample:
  Entertainer m3 is 3 notes on staff 1 vs 5 on staff 2 while m4 is 7 vs 1, so
  the melody would flip hands in adjacent bars.
- **Anything pitch-based.** The parser currently puts **316 notes below middle C
  in Moonlight's right hand**, and most are legitimate — G#3 alone accounts for
  80 notes across 33 measures of RH arpeggio. A `midi < 60 → LH` post-pass would
  shred the piece.

**Where the seam actually is.** Classify each (voice, measure) as *home* (all on
its assigned staff), *split* (on both), or *away* (all on the other staff).
Across all 13 fixtures, `away` is almost empty:

| fixture | voice | home | split | away |
|---|---|---|---|---|
| Moonlight | 1 | 49 | 13 | **7** |
| Moonlight | 2 | 24 | 15 | **15** |
| The Entertainer | 5 | 91 | 0 | **1** |
| *(all other voices, all other fixtures)* | | — | 0–2 | **0** |

`split` is the case §3.6 protects and must keep protecting. `away` is the
untreated case, and m37–41 sit squarely in it.

**The obvious rule has a counterexample in the corpus.** "When a voice's whole
measure is engraved on the other staff, follow the engraving" fixes Moonlight —
and breaks The Entertainer's pickup. In m1 both hands play the same figure an
octave apart and the whole bar is engraved on the treble staff (`1:1` D6–G5,
`1:5` D5–G4). Voice 5 is genuinely the left hand, written in treble clef because
it is above middle C. Following the engraving there would put both lines in the
right hand. Today's song-level rule gets m1 right.

So the fix has to separate "the texture moved down and the hands redistribute"
from "one hand is playing high and got written on the other clef". Grouping the
`away` measures into consecutive runs separates them cleanly:

```
Moonlight  voice 2 (rh):  m13-14(2)  m21-22(2)  m31(1)  m37-40(4)
                          m58-59(2)  m63(1)  m65(1)  m68-69(2)
Moonlight  voice 1 (rh):  m31(1)  m38-41(4)  m66-67(2)
Entertainer voice 5 (lh): m1(1)
```

Every Moonlight passage that needs to move is a run of 2 or more. The
Entertainer counterexample is a lone bar. Two candidate rules both survive the
corpus, and they differ only on Moonlight's three isolated bars (31, 63, 65) —
that is the open musical question, not a coding one.

### Consequences that make this a design change, not a patch

1. **`xmlTruth.js` implements the same rule** (`computeHandAssignmentTruth`,
   `:538`). The oracle reproduces the defect, which is why `sam validate`
   currently reports no `hand_assignment_mismatch` on Moonlight — both sides are
   wrong together. Fixing only the parser repeats the M1 → M1a sequence.
2. **`validate.js` actively enforces the old invariant.** It fires
   `HAND_ASSIGNMENT_MISMATCH` when "the parser emits a single voice number on
   more than one hand across the song ... assignment leaked"
   (`validate.js:606-612`). Any correct fix does exactly that, by design, and the
   defect is severity 1 — Moonlight would go BLOCKED again.
3. **Spec §3.6 states the rule being changed.** "Assign each voice to the hand of
   its majority staff, and apply that to every note of that voice everywhere —
   including notes engraved on the other staff." That sentence has to be
   amended, and its Moonlight worked example ("voices 1 and 2 → RH … exactly how
   it is played") is the claim the evidence above contradicts for m37–41.

None of this is work I have done. Awaiting a decision on the rule and on whether
the oracle, validator and §3.6 move in this milestone or a follow-on.

### M4 — rule settled, oracle question answered (2026-08-27)

**Rule (a) chosen** by Alex: a voice follows the engraved staff for a run of >= 2
consecutive measures written wholly on the other staff; isolated single bars keep
the song-level majority. His reasoning on the three isolated Moonlight bars, to
be recorded in the spec: m31, m63 and m65 are right hand because the left hand is
holding a bass octave through the whole bar and has no capacity, and the figure
does not break (m31 is m30 an octave down; m63/m65 are one descending line from
B#4 that crosses the staff boundary late in the bar). The engraver switched
staves to avoid ledger lines.

**Run length is a proxy** for left-hand occupancy at those bars. Occupancy is
deliberately NOT implemented — run length is simpler and correct on all 13
fixtures. Recorded in the spec as the first place to look if rule (a) ever
misfires on a future score.

**Simulated diff, all 13 fixtures** (no source changed — simulation only):

| fixture | change |
|---|---|
| Moonlight | voice 1 rh->lh m38-41, m66-67 (65 notes); voice 2 rh->lh m13-14, m21-22, m37-40, m58-59, m68-69 (86 notes) |
| The Entertainer | **none** — m1 pickup stays lh, the case rule (a) exists to protect |
| other 11 fixtures | none |

151 notes change hand across the corpus, all in Moonlight. Isolated m31/m63/m65
stay rh as decided. After the change Moonlight voice 1 ends 315 rh / 65 lh and
voice 2 459 rh / 86 lh, so both still sit dominantly in their majority staff's
hand.

**Oracle: proposed NOT to derive hand assignment independently.** Awaiting
sign-off — this changes the shape of the agreed scope (`computeHandAssignmentTruth`
would be removed rather than updated, and `buildTruth` would take the parser's
routing as an input). Reasoning and the replacement invariants for
HAND_ASSIGNMENT_MISMATCH are in the chat message of 2026-08-27; nothing
implemented.

### M4 — implemented (2026-08-27)

All four sites in one change. `sam validate fixtures` stayed at its pre-M4
baseline — **8 CLEAN · 5 WARN, no BLOCKED** — and Moonlight never read BLOCKED at
any point.

**Correction to the investigation note above:** it said "3 of the 13 fixtures
skip §3.6 entirely". That was wrong — I asserted it without checking. **All 13
have `applyThreeSix` true** (2 staves, 1 part each). The skip cases
(`usePerNoteFallback`, `useTwoParts`) are unreached by the corpus, which is why
the invariants gate on `truth.applyThreeSix` rather than assuming it.

**1. Parser** (`songParser.js`). New Phase B2 between assignment and
application. `computeStaffOverrides` is pure and exported, takes plain data, and
carries `AWAY_RUN_MIN = 2`. A measure where a voice is absent, or split across
both staves, breaks a run rather than extending it — silence is not evidence,
and a split measure is the cross-staff case §3.6 protects. One `parseWarning` per
contiguous run, so the M8 import gate shows the change. Phase B2 is skipped
wherever Phase B is, so neither skip case is touched.

The parser also now publishes `handRouting` — the routing it is about to apply,
in source-measure order, as `[{ voice: staff }]`. Diagnostic only; nothing in the
app reads it and it is never stored.

**2. Oracle** (`xmlTruth.js`). `computeHandAssignmentTruth` deleted, replaced by
`voiceStaffTally` — the per-voice engraved-staff counts, which are a fact.
`buildTruth(xml, { routing })` takes the caller's routing and applies it before
`mergeStaff`, so truth answers "given this routing, is the content in each hand
right?". Omit `routing` and every voice stays where it was engraved, which is
correct for the error path but not comparable to parser output on any score with
a cross-staff voice — documented at the parameter.

A parser that ROUTES differently from what it publishes diverges in both hands
and is caught immediately by the existing divergence walk. That is the property
that makes the self-report safe.

**3. Validator** (`validate.js`). Parses first, then builds truth against
`parsed.handRouting`. The old check is gone — its two triggers were "a voice on
both hands is a leak" (legal by design now) and "parser hand ≠ truth hand" (no
truth hand left). `HAND_ASSIGNMENT_MISMATCH` keeps its name and gets four
invariants, extracted as an exported `handAssignmentInvariants(parsed, truth)` so
they can be driven with deliberately broken routings:

| | assertion |
|---|---|
| I1 | one voice, one hand, **within** a measure |
| I2 | every routing decision has a basis: the staff the voice is engraved on in that measure, or its own home staff |
| I3 | a voice engraved on exactly one staff all song is routed there everywhere |
| I4 | the dominant routed hand matches the majority engraved staff |

None encodes the run length or the 60% threshold. All four are skipped when
§3.6 does not apply, because a single-staff source routes per note and one voice
then legitimately spans both hands in one bar.

**I2 was wrong on the first attempt and the corpus caught it.** Stated as "a hand
change must be justified by the engraving", it fired on Moonlight m23 — where
voice 2 *returns* from the m21-22 run to the right hand in a split measure. The
return is justified by the run ending, not by the engraving. Restated as "routed
to a staff it is engraved on here, or else to its home staff", which also covers
The Entertainer's pickup in the same clause. There is a test pinning that m23
stays silent.

**4. Spec.** §3.6 gains rule 5 and an amendment block that says plainly the
worked example was wrong for m37-41 — it claimed "voices 1 and 2 → RH … exactly
how it is played", and in those bars it is not. Records run length as a proxy for
left-hand occupancy with Alex's reasoning on m31/m63/m65, records the two wrong
fixes (per-measure majority, anything pitch-based) so they are not re-proposed,
records the Entertainer m1 counterexample, and warns that one voice no longer
means one hand. `docs/technical-spec-import-duplicate-notes.md` records that the
oracle site was a removal rather than a mirror, and the accepted cost.

Also updated: `bin/sam.js`'s voice line, which used to print truth's independent
assignment. It now prints what the parser routed, per voice, in measures — a
voice can legitimately be in both hands now, so it shows the split:
`1→RH(63m)+LH(6m)  2→RH(42m)+LH(12m)`.

### Diff, all 13 fixtures — matches the agreed expectation

Measured by parsing each fixture twice, once with the rule disabled:

| fixture | measures whose content changed hand |
|---|---|
| Moonlight | m13-14, m21-22, m37-41, m58-59, m66-69 — all rightward→left, none the other way |
| The Entertainer | **none** — m1 pickup stays left hand |
| other 11 | none |

Per voice, from `handRouting`: voice 1 → LH at **m38-41, m66-67**; voice 2 → LH at
**m13-14, m21-22, m37-40, m58-59, m68-69**. m31, m63 and m65 stay right hand.
Moonlight m6's cross-staff arpeggio stays whole in the right hand. That is 151
source notes changing hand, all in Moonlight, exactly as agreed.

(The count reads as 384 "note-slots" if you count parser OUTPUT events rather
than source notes — `mergeStaff` fragments a held note across segments, so one
source note can occupy several slots. 151 is the source-note figure the
expectation was written in.)

### Tests

- `tools/sam-tools/test/handAssignment.test.js` — 14 tests. Seven pin the corpus
  expectation, including the isolated bars, the Entertainer pickup and m6; this
  is where `AWAY_RUN_MIN` is pinned. Seven drive the invariants, four of them
  with a deliberately broken routing so each invariant is shown to fire.
- `src/sam/lib/handAssignment.test.js` — 13 tests on `computeStaffOverrides`
  alone: threshold, split-breaks-run, absence-breaks-run, symmetry, multiple
  voices, empty input.

Full suites: CRA **441 tests / 21 suites**, `sam-tools` **175 tests**, both green.

### Not done

No database, no re-import. The milestone's verification — re-import Moonlight and
confirm B#2/C#3/D#3 in m37-40 are left hand and the piece is playable as
rendered — needs the app and Alex's session. The fixture evidence above is the
offline equivalent: same source file, same parser, and the routing is asserted
directly rather than inferred.

### M5 — one notehead per staff position (2026-08-27)

**Two renderers, not one.** The spec names `scoreRender.js`. That is the scroll /
practice view, driven by `ScrollEngine`. The edit view is a second, independent
implementation in `components/ScoreRenderer.jsx` — same logic, own copy, and
`SamPlayer` renders it. Both had the defect and both are fixed. Each also has a
legacy `beats[]` path alongside the voice-event path, so there were six call
sites in total.

**The fix is one shared helper, not six edits.** `toVexKeys(notes)` in
`vexflowHelpers.js` — the module both renderers already imported — returns the
deduped `keys`, the `heads` (first note at each key, for accidentals), and
`keyIndexFor` mapping every data note to its rendered notehead. `tieEndpoints`
sits next to it and rebuilds the tie tracker against rendered indices.

**Collapsing on the VexFlow key, not on `midi`.** C#4 and Db4 are both midi 61
but sit on different staff lines, so they are two noteheads and must stay two.
Same key string means same notehead position, which is the only thing that
matters to engraving. In practice the two agree — M1 already removed same-midi
fresh duplicates, so what survives to render always shares a spelling — but the
key is the honest statement of the rule.

Three things had to move with the keys, and each is tested:

- **Accidentals** are added per *notehead* now (`heads`), not per data note.
  Two notes on one key would otherwise stack two accidentals on it.
- **Tie endpoints** are re-indexed through `keyIndexFor`, and deduped: two
  copies carrying the same tie direction are one tie, and handing VexFlow's
  `StaveTie` the same index twice draws the arc twice.
- **Fingering tap zones** needed no change, which is worth recording as a
  finding rather than luck. `buildGeometry` derives `noteheadYs` from the
  VexFlow note (`getYs()` / `getKeyProps()`), not from the data, so one key now
  yields one y automatically. The zone layer was never per-notehead anyway — it
  is a Voronoi partition on x over RH *events*, one zone per event. What the
  spec was pointing at is real but downstream of that: before this change
  `noteheadYs` held two entries for one visible notehead, so a tap defaulted to
  `length - 1` = a phantom index, `drawSelectionRing` placed the ring at a
  phantom y, and `fingeringOverlay` drew two rings on top of each other. All
  three follow from the geometry and are fixed by it.

### Evidence, from the real scores

Parsed all 13 fixtures and ran the actual render helper over every multi-note
event. **10 events collapse, out of 3374** — a very small blast radius:

| fixture | event | data | noteheads |
|---|---|---|---|
| Moonlight | m60 rh[2] | `C#4 + C#4:end` | 2 → **1** `c#/4`, tie end on key 0 |
| Moonlight | m9, m46 rh[2] | `E4:end + E4` | 2 → 1 |
| Someone Like You | m27 rh[8] | `D4 + F#4 + F#4:end + A4:end` | 4 → 3; tie ends re-indexed to keys 1 and 2 |
| Someone Like You | m27 rh[7] | `F#4:both + A4 + A4:both` | 3 → 2 |
| Say It Ain't So | m49, m89, m97 rh[1] | `C4 + Eb4 + Eb4:end` | 3 → 2 |
| Say It Ain't So | m70 rh[1] | `F4:start + F4:end` | 2 → 1, one notehead both receiving and starting a tie |
| Say It Ain't So | m153 rh[2] | 8 notes incl. two `:both` pairs | 8 → 6, ties on keys 2-5 |

Moonlight m60 is the spec's verification case, and Someone Like You m27 rh[8] is
the one that proves the re-indexing: `A4:end` sits at data index 3 and its tie
now correctly attaches to key index 2.

### Tests

`src/sam/lib/vexflowHelpers.test.js`, 16 tests — the two named corpus cases, an
ordinary chord passing through untouched, the enharmonic pair staying as two
noteheads, three copies collapsing to one, index tracking inside a chord, the
both-directions tie, the duplicate-tie dedup, and non-mutation of the input.

CRA **457 tests / 22 suites**, green. `react-scripts build` compiles clean, so
there are no unused imports left behind at any of the six call sites.

### One consequence worth knowing about

A stored fingering whose `note_index` pointed at the *second* copy of a collapsed
pair now addresses a notehead that is not drawn, so it will silently stop
rendering. `sam_song_fingerings.note_index` is "index into the event's
noteheads, low pitch to high", and there is one fewer of those now.

I did not add a clamp. Drawing an out-of-range fingering on the nearest notehead
would be right for this case — the two copies are the same pitch — but wrong for
a genuinely stale index, and the render layer cannot tell those apart without
being handed the pre-collapse note count. Not worth the plumbing on a guess.

Whether any such row exists is a database question and needs Alex's session. It
would only affect a fingering placed on one of the ten events above, all right
hand: Moonlight m9/m46/m60, Someone Like You m27, Say It Ain't So m49/70/89/97/153.
Say the word and I will add the check to the M3 repair script's dry run, which
already walks fingerings per event and would report it for nothing extra.
