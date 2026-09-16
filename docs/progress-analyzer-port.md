# Progress: Difficulty Analyzer in Supabase (Phase 3)

## Status: Not Started

Spec: `docs/technical-spec-analyzer-port.md`

Stop after each milestone and wait for verification. Work on a branch.

---

### M1 — Port the analyzer to Deno

- [ ] `measureBeats` added to `supabase/functions/_shared/durations.ts`
- [ ] `analyze.js` ported to `_shared/` as TypeScript
- [ ] Parity test extended to every exported function across all four copies
      (`tools/sam-tools/lib`, `src/sam/lib`, `tools/sam-tools/vendor`,
      `_shared/durations.ts`) — currently it compares only the `BASE` map, and
      nothing tests `tools/sam-tools/lib/durations.js` at all

**Exit criteria**
- [ ] Ported analyzer output is byte-identical to the CLI on all four reference
      songs: Someone Like You (82), Say It Ain't So (160), The Entertainer
      (152), The Scientist (73)
- [ ] Compared NUMERICALLY, per measure, per metric — not by eye
- [ ] Tuplet beat math matches (Someone Like You has 22 tuplet groups)

---

### M2 — Label unclosed tie starts

- [ ] Unclosed starts carry `seam` / `orphan` the way unmatched ends already do
- [ ] Preferred: reuse `validate.js`'s `volta_seam_tie` rule rather than writing
      a second one. If not cleanly extractable, treat a non-numeric
      `sourceMeasure` on either side of a pair as a seam, and say which you did

**Exit criteria**
- [ ] The Entertainer's 5 unclosed starts all labelled `seam`
      (rh m67 E4/C5, rh m151 E4/G4/C5)
- [ ] Someone Like You's 1 at rh m77 A3 labelled `seam`
- [ ] A synthetic orphan away from any seam still labelled `orphan`
- [ ] No unexplained orphan anywhere in the corpus

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
