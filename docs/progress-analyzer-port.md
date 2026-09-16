# Progress: Difficulty Analyzer in Supabase (Phase 3)

## Status: M2 complete — awaiting verification

Branch: `analyzer-port`. Commits: `602d18e` (M1), `81f8dfc` (onset counts and
the tempo-free entry point), and the M2 commit.

`main` was fast-forwarded to `sam-tools-verify-and-ties` (`256010c` ->
`c19c6e0`) before M2 — a clean fast-forward, local only, not pushed —
so `analyzer-port` now sits directly on `main`.

Spec: `docs/technical-spec-analyzer-port.md`

Stop after each milestone and wait for verification. Work on a branch.

---

### M1 — Port the analyzer to Deno

- [x] `measureBeats` added to `supabase/functions/_shared/durations.ts`
- [x] `analyze.js` ported to `_shared/` as TypeScript (`_shared/analyze.ts`)
- [x] Parity test extended to every exported function across all four copies
      (`tools/sam-tools/lib`, `src/sam/lib`, `tools/sam-tools/vendor`,
      `_shared/durations.ts`) — currently it compares only the `BASE` map, and
      nothing tests `tools/sam-tools/lib/durations.js` at all

**Exit criteria**
- [x] Ported analyzer output is byte-identical to the CLI on all four reference
      songs: Someone Like You (82), Say It Ain't So (160), The Entertainer
      (152), The Scientist (73)
- [x] Compared NUMERICALLY, per measure, per metric — not by eye
- [x] Tuplet beat math matches (Someone Like You has 22 tuplet groups)

---

### M2 — Label unclosed tie starts

- [x] Unclosed starts carry `seam` / `orphan` the way unmatched ends already do
- [x] Preferred: reuse `validate.js`'s `volta_seam_tie` rule rather than writing
      a second one. If not cleanly extractable, treat a non-numeric
      `sourceMeasure` on either side of a pair as a seam, and say which you did
      — **reused**: extracted to `lib/voltaSeams.js`, imported by both

**Exit criteria**
- [x] The Entertainer's 5 unclosed starts all labelled `seam`
      (rh m67 E4/C5, rh m151 E4/G4/C5)
- [x] Someone Like You's 1 at rh m77 A3 labelled `seam`
- [x] A synthetic orphan away from any seam still labelled `orphan`
- [x] No unexplained orphan anywhere in the corpus

---

### M3 — The scores table

- [ ] `sam_song_scores` created, PK `(song_id, measure_number)`
- [ ] Tempo-independent columns only — no `notes_per_second`, no flags
- [ ] `scores_version`, `computed_from_edited_at`, `computed_at`
- [ ] `platform.register_table(..., p_policy_mode => 'none', p_audited => false)`
      with notes explaining why auditing is off (derived rows, no user intent)
- [ ] Hand-written parent-scoped RLS policy, mirroring `sam_song_lyrics`
- [ ] Column comments on every column

**Exit criteria**
- [ ] `check_platform_conformance()` returns `CONFORMANT`
- [ ] Deleting a song cascades its scores away
- [ ] RLS verified: another user's scores are invisible

---

### M4 — Compute and store

- [ ] Edge Function computes and replaces one song's scores wholesale
- [ ] No-op when `computed_from_edited_at` matches and `scores_version` matches
- [ ] Backfill across every non-archived song with measures

**Exit criteria**
- [ ] Every song with measures has scores
- [ ] Recomputing an unchanged song writes nothing
- [ ] Stored values match the CLI exactly on all four reference songs
- [ ] **Mutation test:** edit one measure, recompute, confirm that measure's
      scores changed and every other measure's are identical

---

### M5 — The read tool

- [ ] `get_sam_song_scores`, tier 1, `ctx.db` only
- [ ] Params: `song_id`, `start_measure`, `end_measure`, `bpm`, `limit` — every
      one advertised in the input JSON schema
- [ ] Tempo resolution: argument → `goal_effective_bpm` → error. Never
      `goal_bpm`, never `default_bpm`. Comment explaining why at the resolution site
- [ ] Response states the tempo used and its source
- [ ] Measure-range filter pushed into the query before `.limit()`
- [ ] `clampLimit`; truncation NOTE not suppressed
- [ ] Rollup over the returned range: median, p90, max, flagged list
- [ ] Bare data via `envelope()`

**Exit criteria**
- [ ] Flags match the CLI on Someone Like You at its goal tempo
- [ ] Omitting `bpm` uses the goal and says so
- [ ] A range returns only that range, with a rollup over that range
- [ ] A song with no goal and no `bpm` errors rather than guessing
- [ ] A whole-song read on a 160-measure song reports truncation

---

### M6 — Keep scores fresh

- [ ] Trigger query run and reported BEFORE choosing an approach:
      ```sql
      select c.relname, t.tgname, pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where c.relname in ('sam_songs','sam_song_measures') and not t.tgisinternal;
      ```
- [ ] Recomputation hangs off existing `measures_edited_at` stamps, not a new
      parallel mechanism

**Exit criteria**
- [ ] Importing a song leaves scores present and fresh
- [ ] `append_sam_measures` invalidates and recomputes
- [ ] The repair script invalidates
- [ ] An unchanged song is not recomputed

---

### Notes

_Decisions and surprises during execution._

#### M1

**What landed**
- `supabase/functions/_shared/durations.ts` — `measureBeats` added, mirroring
  the CLI copy. Nothing else was ported into it: the analyzer needs only
  `measureBeats` and `sumEvents`. `ALL_TOKENS`, `beatsToToken(s)` and
  `isKnownToken` stay JS-only, and the parity test pins each copy's export list
  so an unported addition fails rather than going unnoticed.
- `supabase/functions/_shared/analyze.ts` — a faithful port of
  `tools/sam-tools/lib/analyze.js` at HEAD (including the stack-based
  `analyzeTies` from `461321d`). Function bodies are copied statement for
  statement; only type annotations were added. Its header states the tempo
  rule (argument -> `goal_effective_bpm` -> error, never `goal_bpm` or
  `default_bpm`) for callers; the actual resolution site arrives in M5.
- `tools/sam-tools/test/durationsParity.test.js` — all four copies, every shared
  function, exact equality over edge-case inputs (0-3 dots, junk tokens,
  non-strings, every beats×beatType pair to 16×32, 513 beat values in 1/64
  steps plus non-representable ones, 400 seeded random event lists with five
  tuplet ratios). Also checks VENDOR is byte-identical to SRC and DENO's
  `BASE` is exactly the JS base vocabulary.
- `tools/sam-tools/test/analyzerParity.test.js` — CLI vs port on the four
  reference songs at six tempos (30, 60, 67, 90, 152, and 72.5 so a
  division-order difference can't hide behind a round number). Compared per
  measure, per metric with `Object.is` (no tolerance), then structurally for
  the whole-song fields, then as JSON bytes. Also: same errors for bad input,
  no input mutation, and the tuplet round trip.

**Results**
- Committed references: 4 songs × 6 tempos, every metric of every measure
  identical, and JSON bytes identical.
- One-off check on the current `Downloads/rebuild` exports (not in the suite):
  14,944 per-measure values across the four songs at their working tempo and
  72.5 — 0 mismatches, JSON bytes identical.
- Tuplets: Someone Like You has 22 groups in 16 measures (spec confirmed). Every
  tuplet measure's tuplet-bearing hands sum, tuplet-scaled, to the bar length in
  both LIB and DENO, and survive a JSON round trip unchanged.
- `npm test` in tools/sam-tools: 217 pass. App jest `durations.test.js`: 24 pass.

**Proved it can fail**
- The comparator itself is tested: a one-ulp `measureBeats` difference and a
  `beats / (bpm / 60)` vs `beats * 60 / bpm` difference both fail the check.
- Real mutations of `analyze.ts`, reverted afterwards:
  - `seconds = beats / (bpm / 60)` — a float-only reordering — failed the
    per-metric and JSON tests on three of the four songs.
  - Opening ties before closing them — failed the Someone Like You whole-song
    and round-trip tests.

**Decisions**
- **Where the parity tests live.** In `tools/sam-tools/test` (node:test), not the
  app's jest suite: Node >= 23.6 runs the `.ts` port directly through type
  stripping, which is the same JavaScript Deno executes; jest cannot import it
  without new config. The app's jest BASE test stays as an app-side guard and
  now points at the full test. Consequence: `npm test` in sam-tools needs
  Node 23.6+ (README updated); the CLIs still run on 18.
- **`--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`** added to the sam-tools test
  script. Node warns that the repo root `package.json` has no `"type"` when it
  loads `_shared/*.ts` and `src/sam/lib/durations.js`. The alternative — a
  `package.json` under `supabase/functions` — risks changing how Deno resolves
  the functions, so the warning is silenced instead.
- **"Byte-identical to the CLI"** was taken as the `analyzeSong` result object
  (compared as JSON bytes). The CLI's text digest is only a rendering of that
  object.
- **Reference documents.** Someone Like You is parsed from its `.mxl` fixture
  (the committed suite has no SLY export); the other three are the committed
  `tools/sam-tools/*.json` exports from 08-17. Those predate the 08-27
  duplicate-note repair, which doesn't matter for parity — both analyzers get
  the same input — and the current exports were checked separately.

**Not verified here**
- The port has not been type-checked. Deno is not installed, and the repo's
  TypeScript (4.9.5) predates `.ts` import extensions. The code runs and
  matches under Node's type stripping; `deno check` (or the M4 deploy bundle)
  is the first real type check.

**Surprises / for later milestones**
- **M4 needs two things the analyzer doesn't provide yet.**
  - The stored columns `rh_onsets` / `lh_onsets` aren't in the analyzer's
    per-measure output, which carries only `rhNotesPerBeat` /
    `lhNotesPerBeat` (onsets ÷ beats). Recovering onsets by multiplying back
    is a float round trip.
  - `analyzeSong` requires a positive `bpm` even though the stored facts are
    tempo-free.
  - Proposal for M4: expose `rhOnsets` / `lhOnsets` per measure, and a
    tempo-free entry point, in BOTH copies in the same commit (the parity
    test's key check forces that), rather than working around them in the
    Edge Function.
- **Export-doc path.** The spec cites `docs/song-export-format.md`; since
  `c19c6e0` it lives at `docs/history/song-export-format.md`. The port's comments
  cite the actual path.

#### Between M1 and M2 — onset counts and a tempo-free entry point (`81f8dfc`)

Decided after M1: each measure now carries `rhOnsets` / `lhOnsets`, and
`analyzeSongFacts(doc)` returns everything tempo-free (per-measure facts plus
seams, ties, tuplets, blips). `measureAtTempo(facts, bpm)` derives `seconds`,
`notesPerSecond`, the per-beat rates and the flags, and `analyzeSong` is now
built from those two. Both copies changed in one commit.

- **Why counts.** The stored column is meant to be the tempo-independent fact;
  `rhNotesPerBeat` is that fact already divided by beats, and multiplying back
  is a floating-point round trip. Store the count, derive the rate.
- **Why no bpm.** Requiring one for tempo-free facts invites a caller to pass
  `default_bpm` "because it needs something" — the trap §3 exists to prevent.
  `analyzeSongFacts` takes one parameter; there is nowhere to pass a tempo.
- **Nothing that existed changed.** 89,664 values compared against the
  pre-change CLI (the four reference songs plus the four current exports, at
  six tempos): 0 differences, and the new counts reproduce the old rates
  exactly.
- **The M1 test had a gap, now closed.** Its comment promised that every
  per-measure key is compared, but it only checked that the two copies emitted
  the same keys; the new onset fields were caught only by the JSON-bytes check.
  It now fails on any emitted key it does not compare — shown failing before
  `rhOnsets` / `lhOnsets` were added to its metric list.
- New parity tests: `analyzeSongFacts` identical in both copies, with exactly
  the fact keys and integer onsets; facts identical whatever tempo is later
  asked for; `analyzeSong` equals `measureAtTempo` over `analyzeSongFacts` in
  both copies; `measureAtTempo` identical and rejecting a missing tempo the
  same way; rates derived from counts on a 7/8 bar.

#### M2

**Reused, not rewritten.** `validate.js`'s `volta_seam_tie` classifier was a
self-contained predicate over the flattened measure list — it reads only
`sourceMeasure` and an event's position — tangled into validate's reporting
loop. It is now `tools/sam-tools/lib/voltaSeams.js`:

- `voltaSeamSources(measures)` — printed labels played more than once whose
  next-played label differs between plays;
- `isVoltaSeamStart(sources, measure, hand, eventIndex)` — adds "the start is
  the final event of its hand in that measure".

`validate.js` and `analyze.js` both import it, and
`supabase/functions/_shared/voltaSeams.ts` is its Deno port under parity test.
The two consumers keep their own granularity: validate still reports per pitch
(`volta_seam_tie` when every open start on a pitch is a seam, else
`orphan_tie`); `analyzeTies` labels each unclosed start `seam` / `orphan`.

**One deliberate difference from the inline original.** A measure with no
`sourceMeasure` is never a seam. Inline, every unlabelled measure shared the
key `undefined`, so a song with no printed numbers (hand-authored drills,
MCP-created songs) would have looked like one bar played many times with
differing next bars — every final-event start would have been a "seam". Parsed
MusicXML always carries labels, so validate is unaffected: its JSON report over
all 13 fixtures is **byte-identical** before and after the extraction. Labels
are also compared as strings, so `7` and `"7"` are the same bar.

**Results.** Unclosed starts across the corpus (13 fixtures, 3 committed
exports, 7 current exports):
- The Entertainer: 5, all `seam` (rh m67 E4/C5, rh m151 E4/G4/C5).
- Someone Like You: 1, `seam` (rh m77 A3).
- Everything else: 0. No unmatched tie ends anywhere. No orphan of either kind.
- The simplified Entertainer (quarter grid) keeps 2 of the 5 — melody-only
  thinning keeps the top note — both still `seam`.

**Tests** (`npm test` in sam-tools: 231 pass)
- `analyzeTies.test.js`: a synthetic volta start is `seam`; a synthetic
  mid-bar start is `orphan`; each of the three conditions is individually
  required; unlabelled measures are never seams; labels are not parsed
  (X-labels and numeric labels both work); no orphan anywhere in the
  16-document corpus; `analyzeTies` and `validate.js` agree pitch-for-pitch on
  every fixture (4 pitches compared — asserted, so it cannot pass vacuously).
- `analyzerParity.test.js`: `voltaSeams.ts` vs `voltaSeams.js` over the
  reference songs and edge cases (more than 1,000 checks); tie labelling
  identical across copies on synthetic songs containing all four of
  start/end × seam/orphan.

**Proved it can fail** (each mutation reverted)
- JS rule without the final-event condition: 2 tests fail.
- Deno rule accepting a bar played once: the parity test fails.
- Deno analyzer labelling every start `seam`: **initially passed.** Every
  unclosed start in the four reference songs is a seam, so a port that assumed
  `seam` agreed with the CLI on all of them. Added the synthetic tie-labelling
  parity test above; the same mutation now fails it.

**Also changed**
- `bin/analyze.js`: the tie line now reads
  `unclosed starts: N (x at seam, y orphan)` and lists orphan starts, matching
  the ends.
- `verify.js`: comment only. Invariant 7 still treats ANY new unclosed start as
  a violation, seam or not — a transform cannot legitimately create one.

**Left alone, for the record**
- Unmatched tie ENDS are still classified by `findSeams`, which cannot see
  X-labelled endings. No unmatched end exists anywhere in the corpus, so this
  is not observed; if one ever appears at an X bar it would be labelled
  `orphan`. The volta rule answers a different question (a start before the
  endings) and was not stretched to cover ends.
- The Entertainer **eighth**-grid plan still refuses to write on invariant 9
  (m92/m108 G3+G3 in the source), as reported earlier. Unrelated to M2;
  repairing the source song fixes it.
