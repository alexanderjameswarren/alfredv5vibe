# Progress: Difficulty Analyzer in Supabase (Phase 3)

## Status: M5 built — awaiting MCP deploy and verification in claude.ai

Branch: `analyzer-port` (pushed). M1 `602d18e`, onsets/tempo-free `81f8dfc`,
M2 `7e39443`, M3 `549832f` (run by Alex: CONFORMANT, 38 tables), M4 (verified
by Alex), the `[{result}]` fix `a7e34dd`, and the M5 commit.

`main` was fast-forwarded to `sam-tools-verify-and-ties` (`256010c` ->
`c19c6e0`) before M2 — a clean fast-forward — so `analyzer-port` sits directly
on `main`.

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

SQL: `supabase/migrations/026_sam_song_scores.sql` (written, **not yet run**).
Verification: `docs/sql/verify-analyzer-port-m3.sql`. Run
`docs/sql/analyzer-port-trigger-check.sql` first.

- [x] `sam_song_scores` created, PK `(song_id, measure_number)` — in the SQL
- [x] Tempo-independent columns only — no `notes_per_second`, no flags
- [x] `scores_version`, `computed_from_edited_at`, `computed_at`
- [x] `platform.register_table(..., p_policy_mode => 'none', p_audited => false)`
      with notes explaining why auditing is off (derived rows, no user intent)
- [x] Hand-written parent-scoped RLS policy, mirroring `sam_song_lyrics`
- [x] Column comments on every column
- [x] Trigger query (M6 section) run and reported — by Alex: `bump_parent_edited_at`
      exists (see M6 and the M3 notes)
- [x] `source_measure` column: left out (Alex, reasons in the M3 notes)
- [x] Migration run — Alex; `check_platform_conformance` returns CONFORMANT
      (38 tables); schema confirmed via `get_database_schema`

**Exit criteria**
- [x] `check_platform_conformance()` returns `CONFORMANT`
- [ ] Deleting a song cascades its scores away
- [ ] RLS verified: another user's scores are invisible

---

### M4 — Compute and store

Code: `supabase/functions/_shared/samScores.ts`, `supabase/functions/sam-scores/`,
`supabase/migrations/027_sam_song_scores_functions.sql`,
`scripts/sam-scores.js` (console: backfill / compute / twice),
`tools/sam-tools/bin/compare-scores.js`, `docs/sql/verify-analyzer-port-m4.sql`.

- [x] `deno check` run EARLY — before any M4 code: the port type-checks clean
- [x] Edge Function computes and replaces one song's scores wholesale
      (`replace_sam_song_scores`: delete + insert in one transaction)
- [x] No-op when `computed_from_edited_at` matches and `scores_version` matches —
      checked FIRST, by `sam_song_scores_freshness`, before any measure read
- [x] Uses `analyzeSongFacts`; nothing in M4 takes a bpm
- [x] Migration 027 run — Alex
- [x] `sam-scores` deployed — Alex (so the `src/sam/lib/keySignature.js`
      cross-tree import does bundle)
- [x] Backfill across every non-archived song with measures — Alex, console

**Exit criteria** — all verified by Alex, 2026-09-16
- [x] Every song with measures has scores — verify query 1: 32/32 songs
- [x] Recomputing an unchanged song writes nothing AND reads no measure rows —
      verify query 3: `diff --all-columns` reports 0 changed
- [x] Stored values match the CLI exactly on all four reference songs — verify
      query 2 + `compare-scores.js cli`: 5,604 values, 0 mismatches
- [x] **Mutation test:** edit one measure, recompute, confirm that measure's
      scores changed and every other measure's are identical — verify query 4:
      only m10 changed (rh_stack 1→2, rh_stretch 0→36, rh_jump 7→39)

---

### M5 — The read tool

Code: `supabase/functions/_shared/samScoresRead.ts` (logic),
`supabase/functions/_shared/tools/sam-scores.ts` (tool), registration in
`supabase/functions/mcp/index.ts`, tests in
`tools/sam-tools/test/samScoresRead.test.js`.

- [x] `get_sam_song_scores`, tier 1, `ctx.db` only
- [x] Params: `song_id`, `start_measure`, `end_measure`, `bpm`, `limit` — every
      one advertised in the input JSON schema — plus `flagged_only` (Alex's
      addition), also advertised
- [x] Tempo resolution: argument → `goal_effective_bpm` → error. Never
      `goal_bpm`, never `default_bpm`. Comment explaining why at the resolution site
- [x] Response states the tempo used and its source
- [x] Measure-range filter pushed into the query before `.limit()`
- [x] ~~`clampLimit`~~ **replaced (Alex):** default = the whole requested range,
      cap 200 (`MAX_MEASURES`); truncation reported, never suppressed
- [x] Rollup over the analyzed range: median, p90, max, flagged list
- [x] Bare data via `envelope()`
- [x] Inline recompute before the read, status reported; the description says
      loudly that this `get_*` tool writes
- [ ] Deployed — Alex: `npx supabase functions deploy mcp --no-verify-jwt`

**Exit criteria** (unit-tested; live checks need Alex, in a fresh claude.ai thread)
- [ ] Flags match the CLI on Someone Like You at its goal tempo
- [ ] Omitting `bpm` uses the goal and says so
- [ ] A range returns only that range, with a rollup over that range
- [x] A song with no goal and no `bpm` errors rather than guessing — **unit test
      only**: no live song can reach it (see the M5 notes)
- [ ] ~~A whole-song read on a 160-measure song reports truncation~~
      **Superseded by the cap of 200:** a whole-song read of Say It Ain't So
      (160) must now come back COMPLETE, `truncated: false`. Truncation is
      checked instead with an explicit small `limit`.
- [ ] `flagged_only` lists only flagged rows, with the same rollup as a full read

---

### M6 — Keep scores fresh

- [x] Trigger query run and reported BEFORE choosing an approach — **a trigger
      exists**: `bump_parent_edited_at`, AFTER UPDATE, per row, on
      `sam_song_measures`. Findings and the INSERT/DELETE trade-off are in the
      spec's M6 section.
- [x] `docs/sql/analyzer-port-stamp-functions.sql` run (Alex):
      `bump_song_edited_at` stamps with `now()` and has no no-op guard;
      `stamp_song_edited` is attached to `sam_song_lyrics`
      (`trg_lyrics_stamp_edited`, INSERT/UPDATE/DELETE, per row) — not dead
- [x] Decision recorded (spec M6): non-notation writes invalidate scores; M4's
      freshness check must be the cheap first step
- [ ] Trigger query, as originally written:
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

#### M3

**The trigger query was not run by Claude.** No MCP tool executes arbitrary
SQL, and `get_database_schema` does not report triggers. It is in
`docs/sql/analyzer-port-trigger-check.sql` for Alex to run before the
migration. The file also searches every function body for
`measures_edited_at`, which would catch a stamping trigger defined on some
other table. The only evidence so far is indirect: the drills-and-lineage
verification (`docs/history/progress-sam-drills-and-lineage.md:123`) logged
exactly one `UPDATE sam_songs` audit row for an append that inserted two
measure rows — the tool's own explicit stamp — which a row-level stamping
trigger would have multiplied. The migration does not depend on the answer;
M6 does.

**Decisions in the migration**
- **File location.** `supabase/migrations/026_*`, the numbered sequence the
  most recent schema migrations (DJ 005–025) use. The SAM pass-counter
  migrations went to `docs/migrations/`; the numbered folder was chosen for
  this one because it is a new table, not a column change.
- **`beats` is `double precision`.** It is the analyzer's JS number, and M4
  requires stored values to match the CLI exactly. Postgres 12+ prints float8
  in shortest-exact form, so the value round-trips through PostgREST
  unchanged. `numeric` would also hold 3.5, but would change the type a reader
  gets back for no gain.
- **Counts are `integer` with `>= 0` checks, and `measure_number >= 1`.** They
  document the invariants and would reject an analyzer bug at write time.
  `accidentals` is nullable (unknown key), with the same check when present.
- **`computed_from_edited_at` is nullable**, and freshness is
  `IS NOT DISTINCT FROM`, so a song whose `measures_edited_at` is NULL still
  compares equal to a row computed from NULL. Recorded in the table and column
  comments, since M4 and M5 will both implement the check.
- **No `updated_at`.** Rows are replaced wholesale, never updated.
- **No index beyond the primary key.** `(song_id, measure_number)` serves both
  read paths: every row for a song, and a measure range within one.
- **The policy is `TO authenticated`** — the spec's form. `sam_song_lyrics`'s
  policy expression is mirrored exactly (`EXISTS … sam_songs.user_id =
  auth.uid()`, FOR ALL, USING only, which Postgres also applies as the WITH
  CHECK). `register_table` has already stripped anon's grants either way.
- **`p_notes` states the audit exemption**, and the migration's comment block
  carries the full reasoning: derived rows, replaced wholesale, no user intent,
  reproducible by re-running the analyzer. The intent-bearing change (a
  measure edit) is audited where it happens.
- **Not added: a `source_measure` column.** The spec's column list does not
  have one. It would help with the repeated-measures hazard (§6): a whole-song
  aggregate could skip written-out repeats. Raised as a question rather than
  added.

**Verification design.** `docs/sql/verify-analyzer-port-m3.sql` checks shape,
constraints, policy, registry and conformance. The cascade and RLS checks run
in one `DO` block that creates a throwaway song and score row, reads them as
the owner, as a random other user, and as anon, tries an insert as the other
user, deletes the song, and then **always raises an error** whose message is
the result. The error rolls back everything the block did, so nothing can be
left behind whatever happens; a third query confirms it.

**Follow-up: the trigger check found a trigger (Alex, 2026-09-16).**
- `bump_parent_edited_at` on `sam_song_measures`, AFTER UPDATE, per row. Not
  INSERT or DELETE, so the delete-and-reinsert import path is stamped only by
  app code. Per-row firing means any M6 recomputation must work per song, never
  per row event. Full findings, corrected write-path table, and the cost of
  extending it to INSERT/DELETE: spec §4 M6.
- `stamp_song_edited` mentions `measures_edited_at` but is attached to no
  trigger on the two SAM tables. Neither function has ever been in the repo or
  its git history (`git log --all -S` finds nothing), so dead-vs-detached can
  only be settled from the database: `docs/sql/analyzer-port-stamp-functions.sql`
  (triggers on every table, event triggers, pg_cron, callers by name, CLI
  migration history, and both definitions).
- **`source_measure` stays out** (Alex): it would be a copy, not a fact, with
  nothing keeping it in sync with `sam_song_measures`; the join on
  `(song_id, number)` is trivial and indexed on both sides; and how repeats
  should count is still an open decision (spec §6).

#### M4

**Before any code: 026 confirmed and `deno check` run.** 026 is live and
`check_platform_conformance` returns CONFORMANT (38 non-exempt tables).
`deno check` (Deno 2.9.6, through `npx deno@2` — nothing installed globally) on
`_shared/analyze.ts`, `durations.ts` and `voltaSeams.ts`: **clean** — the
port's first real type check. For reference, the existing
`mcp/index.ts` reports 78 errors, all implicit-`any` handler parameters. They
predate this work; deploys do not type-check, so they have never blocked
anything. The new M4 files check clean.

**Finding: the Edge Function bundle is NOT limited to `supabase/functions/**`.**
`push-send/index.ts` imports `../../../src/utils/vapidFingerprint.js`, and
push-send is deployed and working. M1's premise — that the analyzer had to be
vendored because the deploy only bundles `supabase/functions/**` — came from an
older progress note and looks wrong. M4 uses the precedent:
`samScores.ts` imports the app's `src/sam/lib/keySignature.js` directly rather
than adding another copy. The analyzer port stays as it is — parity-tested, so
it is safe either way — but whether to replace it with a direct import of
`tools/sam-tools/lib/analyze.js` is now a real option. Not acted on.

**Design**
- `supabase/functions/_shared/samScores.ts` does the work and takes the client
  as a parameter (no Supabase import), so an MCP tool in M5 can pass `ctx.db`.
  Order:
  1. `sam_song_scores_freshness(song, SCORES_VERSION)` — one call. Fresh ->
     return `{status: "fresh", measures_read: 0, rows_written: 0}`.
  2. Otherwise read the song's title and key label, read measures (paged by
     1000 — PostgREST's cap), build the analyzer document exactly as an export
     of that song looks (`fifths` from the key label via the app's own
     `fifthsFromKeyLabel`), run `analyzeSongFacts`, map facts to columns in
     `toScoreRow`, and call `replace_sam_song_scores`.
  - Statuses: `fresh`, `computed`, `no-measures` (nothing to store, nothing
    stored), `cleared` (measures gone, old rows removed).
  - `SCORES_VERSION = 1`, the only copy of the number in code. The verify SQL
    hard-codes 1 and says so.
- `supabase/functions/sam-scores/` — standalone function, same shape as
  push-send: `verify_jwt = true`, client built from the caller's
  Authorization header, so RLS confines it to the caller's songs. One song per
  request; the backfill is a loop in `scripts/sam-scores.js`, keeping each
  request well inside the edge runtime's CPU budget. Registered in
  `supabase/config.toml`.
- **027 adds two SQL functions, both SECURITY INVOKER** (RLS applies as for a
  direct query; execute granted to `authenticated` only, revoked from anon):
  - `sam_song_scores_freshness` — why SQL and not a JS comparison: PostgREST
    returns timestamptz with microseconds and a JS `Date` would truncate them,
    so equality is decided in Postgres (`IS NOT DISTINCT FROM`). It never
    touches `sam_song_measures`.
  - `replace_sam_song_scores` — why a function: PostgREST runs each request in
    its own transaction, so a client-side delete then insert could leave a song
    with no scores. A function call is one transaction. It raises on a song the
    caller cannot see, because under RLS that would otherwise be a silent no-op.
- **The stamp is read BEFORE the measures.** If the measures change
  mid-compute, the rows carry the older stamp and the next check recomputes.
  Reading them the other way round could mark stale scores fresh.
- **The stamp is passed back verbatim** — the string PostgREST returned — so the
  stored value equals the song's exactly.
- **No bpm anywhere in M4.** `analyzeSongFacts` takes the document only.

**Tests** (`npm test` in sam-tools: 249 pass)
- `samScores.test.js` (11), with a fake client that records every table and
  function touched:
  - fresh: exactly one call (`sam_song_scores_freshness`), no table read, no
    write;
  - unseen song and a failed freshness check both error before any read;
  - stale: call order is freshness -> `sam_songs` -> `sam_song_measures` ->
    `replace_sam_song_scores`; the stamp goes back verbatim (microseconds); the
    rows equal the CLI's `analyzeSongFacts` on Someone Like You, every column,
    `Object.is`;
  - an unknown key label stores `accidentals` as null;
  - paging reads 2,500 measures in three pages and scores all of them;
  - no-measures writes nothing; measures-gone clears;
  - `toScoreRow`'s keys equal the column list `replace_sam_song_scores`
    unpacks (read from 027) and each is a real column in 026; and every fact
    is mapped except the printed label.
- `compareScores.test.js` (7): the comparison tool matches equal data, and
  fails on a one-value difference, on a last-bit float difference, on a stamp
  mismatch and on a missing song; `diff` isolates one changed measure and
  `--all-columns` catches a rewrite.
- **Mutation:** deleting the fresh-path early return in `samScores.ts` fails the
  fresh test (reverted).

**Not verified here — needs Alex:** running 027, deploying `sam-scores`, the
backfill, and the four exit criteria against the live database. Claude has no
database write access or SQL access, and did not deploy. Also unverified: that
the deploy bundles `src/sam/lib/keySignature.js`. push-send's identical import
says it will; if it does not, the deploy fails loudly, and the fix is to vendor
that one small function.

#### M5

**Decisions (Alex, 2026-09-16), each a change from the spec as first written:**

- **No `clampLimit`.** Its default of 20 and cap of 50 would cut most songs, and
  a cut list is harmless only when it looks cut. The tool description says it:
  "a truncated list says it is partial; a rollup over a fragment does not." A
  median, p90 and flagged list over measures 1–50 read exactly like a
  whole-song answer. So the default is the whole requested range and the cap
  is a local `MAX_MEASURES = 200` (longest song: 160). A whole-song read of Say
  It Ain't So is about 42 KB compact, about 17k tokens pretty-printed; that
  cost was accepted.
- **When the cap or `limit` does cut:** `meta` carries `truncated`, `total` and
  `limit_applied` (so `runToolForMcp` prints its NOTE line); `range.analyzed`
  names the first and last measure actually covered; `rollup.covers` says the
  rollup describes only those; `range.note` gives the `start_measure` for the
  next call. Truncation is judged from the exact count, never from
  `rows.length >= limit` (the `ken.ts` rule): exactly `limit` rows is complete.
- **`flagged_only`** (sixth param). The rollup is computed over EVERY analyzed
  measure first; only the returned rows are filtered. `rows.filter` reads
  `flagged_only` and `rows.note` says the rollup still covers all N measures.
  `meta` is the same as for the unfiltered read, since it describes the
  analyzed range.
- **Lean rows.** Returned per measure: `measure`, `notes_per_second`,
  `rh/lh_notes_per_beat`, `rh/lh_stack`, `rh/lh_stretch`, `rh/lh_jump`,
  `rhythm_variety`, `accidentals`, `flags`. `beats` and the onset counts are
  dropped: they are the inputs to the rates, and remain in the table.
- **Inline recompute.** The read calls `computeSongScores(ctx.db, song_id)`
  first. When fresh that is one cheap call (M4); when stale it recomputes and
  replaces the rows. `scores.status` reports `fresh`, `recomputed`,
  `no-measures` or `cleared`. **This is a `get_*` tool that writes**, which
  departs from the naming convention. The tool description says so up front:
  the rows are derived, the table's comment calls them safe to delete and
  recompute, and auditing is off, so the refresh leaves no audit trail. Stale
  scores are never returned silently.
- **The no-goal error path is tested in unit tests only.** `goal_bpm` is NOT
  NULL and the fill trigger sets it on insert, so no live song lacks a
  `goal_effective_bpm`. The code comment says the path guards a state the
  database currently prevents, so nobody deletes it as dead code.

**Design**
- Order: validate every argument (including `bpm`) → read `sam_songs`
  (`id, title, goal_effective_bpm` — the wrong tempo columns are not even
  selected) → resolve the tempo → `computeSongScores` → read `sam_song_scores`
  with `.eq/.gte/.lte/.order` then `.limit`, `count: "exact"` →
  `measureAtTempo` per row (the analyzer's own derivation, not a second copy)
  → rollup with the analyzer's `quantile` and `SUMMARY_METRICS` → filter rows
  if `flagged_only`.
- A bad argument, an unknown song or a missing tempo all fail BEFORE the
  freshness check, so none of them can trigger a write.
- Metric names in the response are snake_case. Fractional values (the rates,
  and the rollup) are rounded to 2 dp for display; flags and the rollup are
  computed from unrounded values. `thresholds` is included, with the flag
  codes spelled out.
- The logic lives in `_shared/samScoresRead.ts`, which imports neither Supabase
  nor the platform, so node:test drives it directly. The tool file only binds
  it to `ctx.db` and wraps the result in `envelope()`.

**Checks run here**
- `npm test` in sam-tools: 269 pass (17 new in `samScoresRead.test.js`):
  - flags, flagged list and every rollup stat equal the CLI's
    `analyzeSong(SLY, {bpm: 67})`; the rows equal the CLI per measure;
  - an explicit bpm (120) is used, labelled `argument`, and matches the CLI
    at 120;
  - the song select is exactly `id, title, goal_effective_bpm`;
  - no goal (null, undefined, 0) and no bpm: error, and the only call made is
    the song read; a bpm rescues it;
  - nine bad-argument cases fail before any call; an unknown song fails before
    freshness;
  - fresh: call order is song → freshness → scores, and nothing is written;
  - stale: song → freshness → song → measures → replace → scores, status
    `recomputed`;
  - a range: the query ops are `select, eq, gte, lte, order, limit` in that
    order; only m20–30 come back; rollup equals the CLI over that slice;
  - the default limit is 200, and `limit: 5000` clamps to 200;
  - a 160-row song is returned whole, not truncated;
  - `start_measure 11, limit 30`: `meta {truncated, total 72, limit_applied
    30}`, analyzed 11–40, the note names `start_measure=41`, and the rollup is
    labelled as covering only those 30 measures;
  - exactly `limit` rows is not truncated;
  - `flagged_only`: identical rollup and meta, rows equal the flagged list,
    and the note is present;
  - neither new `.ts` file mentions supabase-js or `createClient`.
- **Mutations**, both caught and reverted: computing the rollup over the
  filtered rows (fails the `flagged_only` test); ignoring `limit` in the query
  (fails the truncation test).
- `deno check --no-lock`: `samScoresRead.ts` and `tools/sam-scores.ts` clean
  (the tool file needs `--node-modules-dir=none` to resolve supabase-js
  through platform.ts). `mcp/index.ts` now reports 82 errors against 81 on
  the current base. The one new error is the new registration's `async
  (args)` callback: the same implicit-`any` as every other registration.

**Not verified here — needs Alex:** the deploy, and the live exit criteria in a
fresh claude.ai thread.
