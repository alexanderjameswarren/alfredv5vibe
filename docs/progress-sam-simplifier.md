# Progress: SAM Song Simplifier (Phase 2)

## Status: M2 complete, awaiting verification

Branch: `phase-2-simplifier`

Spec: `docs/technical-spec-sam-simplifier.md`

Every milestone has mechanical exit criteria. Do not proceed past one until its
checkboxes are ticked and the human has verified.

---

### M1 — Plan format and validation ✅

Files: `tools/sam-tools/lib/plan.schema.json`, `tools/sam-tools/lib/plan.js`,
`tools/sam-tools/test/plan.test.js`

- [x] `plan.schema.json` written, covering every setting in spec §4
- [x] Plan loader validates against it; unknown key or unknown enum value is a hard error
- [x] Measure-range string parser handles `"37,57-61,68"` including single numbers, ranges, and whitespace
- [x] Overlapping ranges rejected
- [x] Out-of-range measure numbers rejected
- [x] `settings: null` parsed as "untouched"

**Exit criteria**
- [x] Unit tests: a valid plan parses; each of the five rejection cases errors with a clear message
- [x] A plan with `"lhFill": "banana"` fails validation, naming the offending key

27 tests, all passing (`npm test` in `tools/sam-tools`).

---

### M2 — Identity transform and invariant harness ✅

Files: `tools/sam-tools/lib/verify.js`, `tools/sam-tools/lib/simplify.js`,
`tools/sam-tools/test/verify.test.js`

- [x] All eight §5 invariants implemented as a reusable `verify(input, output)`
- [x] Empty plan (`default: {}`, no ranges) produces output structurally identical to input
- [x] Seam-aware tie check: an unmatched tie at a `sourceMeasure` discontinuity passes; an orphan elsewhere fails

**Exit criteria**
- [x] Identity run on La Candeur (38 measures) — zero differences
- [x] Identity run on Someone Like You (82 measures, 16 tuplet measures, 229 tied events) — zero differences
- [x] **Mutation test:** four mutations, four catches — LH duration sum (inv 4),
      removed RH top note (inv 5), changed `audioOffsetMs` (inv 3), dropped
      measure (inv 1). Plus four more: tuplet marker stripped (inv 4 via
      tuplet-scaled math), time signature and `symbol` (inv 2), removed RH
      event (inv 6), changed `chord`/`sourceMeasure` (inv 8).

55 tests across M1 + M2, all passing.

---

### M3 — LH grid quantization

- [ ] `lhGrid` cell division for `whole`/`half`/`quarter`/`eighth`; `none` is a no-op
- [ ] `lhFill: onset` including the fallback rule (spec §4.2)
- [ ] `lhFill: union`
- [ ] `lhCap` with `lhKeep: root-third` and `root-fifth`
- [ ] Density floor: grid never increases LH event count for a measure
- [ ] Tuplet guard: a cell boundary falling inside a tuplet group leaves that group alone

**Exit criteria**
- [ ] Someone Like You m1 LH at quarter/onset/cap 2/root-third yields four A3+C#4 quarter events
- [ ] The same measure at `union` yields A3+C#4 (bottom two of A3,C#4,E4) — demonstrating the two fills differ
- [ ] A sustained whole-note LH measure (e.g. m79) is UNCHANGED at quarter grid — density floor holds
- [ ] Every §5 invariant passes on a full-song grid run
- [ ] Unit test per grid size asserting per-hand duration sum is preserved

---

### M4 — RH thinning

- [ ] `rhStack: melody-only`, `melody-plus-one`, `all`
- [ ] Top note determined by `max(midi)`; hard error if the notes array is not pitch-ascending
- [ ] RH event count unchanged
- [ ] Tie chains removed whole or not at all
- [ ] Melody blips detected and reported, NOT corrected

**Exit criteria**
- [ ] Someone Like You RH stack drops to 1 throughout at `melody-only`
- [ ] RH event count per measure identical to original on all 82 measures
- [ ] Highest note of every RH event identical to original (invariant 5)
- [ ] Lyrics and fingerings survive a full-song RH thin unchanged
- [ ] All 18 melody blips appear in the run report

---

### M5 — Ranges, skip-and-flag, reporting

- [ ] Range overrides applied; `settings: null` leaves measures bit-identical
- [ ] Skip-and-flag on any measure a transform cannot handle; never a silent skip
- [ ] Confirmation prompt above 25% skipped; `--yes` bypasses; never a hard fail
- [ ] Structured run report written to `generationNotes` per spec §8
- [ ] Advisory reports: short untouched runs, repeated ranges, melody blips

**Exit criteria**
- [ ] The ten untouched measures in the reference plan are bit-identical to the original
- [ ] m37 appears in `shortUntouchedRuns` (length 1)
- [ ] A plan range covering m22–32 reports `alsoAppearsAt` m46–55 and m69–78
- [ ] Run report is valid JSON and round-trips through the export document

---

### M6 — Regression check

- [ ] Post-transform analysis run at the same tempo as the pre-transform analysis
- [ ] Per-measure, per-metric comparison
- [ ] Any metric worse in output than input is an ERROR naming measure, metric, and both values

**Exit criteria**
- [ ] Reference plan on Someone Like You passes the regression check clean
- [ ] **Mutation test:** run the same plan with `lhFill: union` and confirm the check FIRES on LH jump (this regression was observed in prototyping — 16 semitones vs 12). If it does not fire, the check is not working.

---

### M7 — End-to-end on Someone Like You

- [ ] Full reference plan run produces an importable document
- [ ] Human imports it into SAM through the UI
- [ ] Human plays it

**Exit criteria**
- [ ] Post-transform metrics: notes/sec median ~3.4 max ~5.6; LH/beat 1.0 throughout; RH stack 1 throughout
- [ ] Flag count drops from 72/82 to a small number
- [ ] Measures 17, 18, 19, 41, 42, 43 STILL flag on notes-per-second — this is expected and correct (irreducible melody)
- [ ] Lyrics and audio offsets present on the imported song
- [ ] **Human verdict on whether it sounds right.** This is the real exit criterion. No automated check substitutes for it.

---

### Notes

#### M1

**BLOCKING QUESTION for M2 — what does an omitted setting key mean?**
Spec §4 gives a default per setting (`lhGrid: quarter`, `rhStack: melody-only`,
…), but M2's exit criteria expect `default: {}` to produce an identity
transform. Those disagree: filling omissions from the §4 table would make `{}`
mean quarter-grid + melody-only, which is the opposite of identity. The two
readings are (a) absent ⇒ take the §4 default, so identity must be written
explicitly as `{lhGrid: "none", rhStack: "all"}`; or (b) absent ⇒ no-op, and
the §4 column documents what the reference plan uses rather than what the
loader fills in.

The loader does not decide. It merges partials only — range settings over plan
default, key by key — and never invents a value, so M1 is complete under either
reading. Needs answering before M3 writes a transform.

**Decisions taken**

- *Duplicates inside one range string are rejected* (`"37,37"`, `"10-12,11"`).
  The spec only names overlaps *between* ranges, but the effect is identical
  and silently de-duplicating a typo hides a mistake. Same error class.
- *`settings` is a required key on a range*, not optional. Omitting it would
  make "leave these measures untouched" happen by accident; the spec's example
  writes `"settings": null` explicitly and now the schema demands it.
- *Errors accumulate.* Every stage collects all its problems before throwing,
  so fixing a plan doesn't take one run per mistake.
- *Out-of-range is checked against `1..measureCount`*, matching PLAYED numbers.
  Safe because fan-out renumbers measures 1..N with no gaps; if that ever
  stops being true this needs the real `number` values instead.

**Dependency added:** `ajv@^8.20.0` to `tools/sam-tools/package.json`, installed
into its own `node_modules` so the CLI stays standalone per its README. It is
the same validator the app and the Edge Function already use for the song
schema. No runtime network or database access.

**Test runner:** `node --test` (built in). No framework dependency; the app's
jest doesn't reach into `tools/`.

#### M2

**SURPRISE — the parser aliases measure content across repeats.** In
flattened output, La Candeur's m9 `rh` array IS m1's `rh` array, the same
object, because repeat flattening reuses the events rather than copying them.
`structuredClone` preserves that aliasing faithfully, so mutating m9 silently
mutated m1 — which is how two tie tests failed and how the aliasing was found.

Consequences:
- **Never mutate an input measure in place.** `simplifyMeasures` clones each
  measure independently, which breaks the aliasing; M3/M4 must keep doing that.
- Real exports are alias-free, because downloading serialises through JSON.
  The parser-derived test fixtures now do a JSON round-trip for the same
  reason, so tests see what the CLI will actually be handed.

**Tie tests are synthetic, deliberately.** Tie matching is keyed by pitch
within a hand, so corrupting a tie in a real song can be absorbed by another
chain on the same pitch and the mutation proves nothing. The seam rule is
tested on 3-measure fixtures with one pitch and explicit `sourceMeasure`
values; the real songs are tested for the absence of false positives instead
(229 tied events, 21 barline crossings, zero violations under identity).

**Deliberate refinement to invariant 7.** Tie integrity is judged RELATIVE TO
THE INPUT — only a problem the transform introduced counts. A song that
arrives with a pre-existing orphan must not fail an identity run. Spec §5.7
reads as an absolute check on the output; this is strictly safer and there is
a test for it.

**Known gap:** `analyzeTies` seam-labels unmatched tie ENDS but not unclosed
STARTS, so a transform that legitimately left a start dangling at a seam would
be reported. That cannot currently happen — §5.1 requires a chain to be
removed whole — so the stricter check stands until a transform needs otherwise.

**Deferred to M5:** the §9 output *document* assembly (title suffix,
`songType`, `parentSongId`, `generationNotes`). M2 returns measures only, so
"structurally identical to input" is literally true for the identity run.
`simplifyMeasures` throws `NotImplementedYet` for any active transform rather
than silently returning an unchanged song — a plan asking for `lhGrid:
quarter` today is an error, not a no-op.
