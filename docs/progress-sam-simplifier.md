# Progress: SAM Song Simplifier (Phase 2)

## Status: M4 complete, awaiting verification

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

### M3 — LH grid quantization ✅

Files: `tools/sam-tools/lib/lhGrid.js`, `tools/sam-tools/test/lhGrid.test.js`

- [x] `lhGrid` cell division for `whole`/`half`/`quarter`/`eighth`; `none` is a no-op
- [x] `lhFill: onset` including the fallback rule (spec §4.2)
- [x] `lhFill: union`
- [x] `lhCap` with `lhKeep: root-third` and `root-fifth`
- [x] Density floor: grid never increases LH event count for a measure
- [x] Tuplet guard: a cell boundary falling inside a tuplet group leaves that group alone

**Exit criteria**
- [x] Someone Like You m1 LH at quarter/onset/cap 2/root-third yields four **`A3`** quarter events
      *(corrected 2026-08-13: the original line said `A3+C#4`, which is the union result. m1's LH
      is single sixteenths, so only `A3` sounds at beat 0 and §4.2 is right as written.)*
- [x] The same measure at `union` yields A3+C#4 (bottom two of A3,C#4,E4)
- [x] A measure where the two fills DIFFER — m1 itself differs (`A3` vs `A3+C#4`);
      also covered at half grid, cap 3 (`h:A3` vs `h:A3+C#4+E4`)
- [x] A sustained whole-note LH measure (m79) is UNCHANGED at quarter grid — density floor holds
- [x] Every §5 invariant passes on a full-song grid run — all four grid sizes × both fills
- [x] Unit test per grid size asserting per-hand duration sum is preserved

83 tests at M3. 105 after M4.

---

### M4 — RH thinning ✅

Files: `tools/sam-tools/lib/rhThin.js`, `tools/sam-tools/test/rhThin.test.js`

- [x] `rhStack: melody-only`, `melody-plus-one`, `all`
- [x] Top note determined by `max(midi)`; hard error if the notes array is not pitch-ascending
- [x] RH event count unchanged
- [x] Tie chains removed whole or not at all
- [x] Melody blips detected and reported, NOT corrected

**Exit criteria**
- [x] Someone Like You RH stack drops to 1 throughout at `melody-only`
- [x] RH event count per measure identical to original on all 82 measures
- [x] Highest note of every RH event identical to original (invariant 5)
- [x] Lyrics and fingerings survive a full-song RH thin unchanged
- [x] All 18 melody blips appear in the run report

105 tests across M1–M4, all passing.

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

**RESOLVED 2026-08-13 — what an omitted setting key means.** Spec §4 gave a
default per setting while M2 expected `default: {}` to be an identity
transform; those disagreed. Settled in favour of the **gating/modifier split**,
and §4 has been amended to match:

- *Gating* (`lhGrid`, `rhStack`) decide WHETHER a transform runs. Absent means
  OFF — `none` and `all` respectively.
- *Modifier* (`lhFill`, `lhCap`, `lhKeep`) decide HOW an active transform
  behaves, keep their §4 defaults, and take effect only when their parent
  gating setting is active. A modifier without its parent is **inert, not an
  error**.

So `default: {}` is a true identity transform and M2's exit criterion stands as
written. The reason is asymmetry of failure: under the other reading, a plan
that omitted `rhStack` would strip the right hand to melody-only without being
asked — silently applying the one transform that touches the melody. This way
the failure mode is a version that is not simplified enough, which shows up
immediately in the metrics and costs one edit. Under-transforming is visible;
over-transforming silently is not.

Implemented in `plan.js` as `SETTING_DEFAULTS`, `GATING_OFF`,
`effectiveSettings()`, `lhActive()`, `rhActive()` and `inertSettings()`.

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

#### M3

**RESOLVED 2026-08-13 — the `onset` exit criterion was a slip in the tracker.**
It named the union result on the onset line. m1's LH is sixteen single
sixteenths (`A3 C#4 E4 C#4` ×4), so the only pitch sounding at beat 0 is `A3`,
and §4.2 — "the pitches sounding at the START of the cell" — is right as
written. The tracker line is corrected; the code is unchanged.

**The fill default is PROVISIONAL pending M6.** `onset` stays the default for
now. `union`'s problem is documented in §4.2 — it can emit chords that never
sounded, and it made LH jump worse than the original in prototyping. M6 will
measure both fills on this song and the default gets ruled on with numbers
rather than argument.

**Decisions taken**

- *Gridding uses the hand's OWN span, not the time signature.* Several
  Someone Like You measures have an LH running 4.5–7 beats in a 4/4 bar
  (old-parser damage the export faithfully reproduces). Gridding to the
  signature would silently rewrite the sum and trip invariant 4; gridding to
  what is actually there preserves it and still quantizes. Tested.
- *A ragged final cell decomposes* via `beatsToTokens` rather than being
  rounded, so an odd time signature cannot produce an unwritable duration.
- *Quantization drops ties*, per §5.1 — cell fill discards the old events
  entirely, so a chain cannot survive half-removed.

**The density floor does real work.** A full-song quarter grid leaves **23 of
82 measures** alone, every one because the LH already had ≤4 events.

Those are **`unneeded`, not `unable`** (ruling, 2026-08-13). The floor working
as designed is not a failure: nothing was left too hard and there is nothing
for a human to confirm. Spec §7 and §8 now split the two counters, and only
`unable` gates the 25% confirmation prompt. Under the old single counter the
reference plan would have prompted at 28% for no reason.

**The tuplet guard fires, but not at quarter grid.** Someone Like You has LH
triplets at m51, 53, 74 and 76, each spanning beats 3–4. At quarter grid the
boundary at beat 3 is the group's *edge*, not a point inside it, so the group
grids normally. At **eighth** grid the boundary at 3.5 falls inside and the
guard protects the group verbatim. Both branches are tested; without the
eighth-grid case the guard would have looked untested-but-passing.

**LH ties survive by accident, not by design.** The only LH chains in Someone
Like You are m79→m80→m81, all sustained whole notes that the density floor
refuses to touch, so both ends come through intact. A song with a tie crossing
out of a quantized measure into an untouched one would orphan it — invariant 7
catches that, and it becomes a skip-and-flag case in M5.

#### M4

**The melody rule and the whole-chain rule collide, and the collision is
real.** Four RH tie chains in Someone Like You are *mixed*: the tied pitch is
the top note of one event and an inner voice of the next (m22, m27, m46, m69).
Under `melody-only`, §4.4 says the m22 top note must be retained and §5.1 says
the chain must not survive half-removed. Both cannot hold if "removing the
chain" means removing every note in it.

Resolved by reading §5.1 as being about the LINK, not the notes: the tie
marker is dropped and the note stays. That satisfies every stated invariant —
the melody note survives (inv 5), no dangling marker exists (inv 7), and the
event count is untouched (inv 6). The audible effect is a re-articulation
where the score had a tie, in four places, all reported in `strippedTies`.
The alternative — retaining the whole chain — would have left RH stack at 2 in
those measures and failed the M4 exit criterion.

**Ties are handled as LINKS, not chains.** A note marked `both` is the end of
one link and the start of the next, so breaking one side leaves the other
intact: `both` becomes `start` or `end` rather than being wiped. Handling
links is what makes a dangling marker structurally impossible, which is the
property §5.1 is actually asking for. Tested.

**A chain reaching an untouched measure retains its note instead.** An
untouched measure must stay bit-identical, so its tie marker cannot be
stripped — the removable partner is kept instead and the chain survives whole.
Less thinning, never a broken tie. This never fires on the reference plan
(zero chains straddle the untouched boundary) but a different plan could, so
it is built and tested synthetically.

**`NotImplementedYet` retired.** Every setting in the vocabulary is now
implemented, so nothing threw it. The lasting form of that guard is a test —
"no silent no-ops" — asserting every non-OFF value either changes something or
records a reason. That property outlives the milestone window.

**Blips confirmed at 18, and untouched.** Every one is reported, and the output
top note at each blip position is bit-identical to the input. Tested
explicitly rather than assumed, since "we did not correct it" is the sort of
claim that quietly stops being true.
