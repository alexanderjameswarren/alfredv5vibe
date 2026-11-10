# Homer (homer-h4k): progress

Spec: `docs/homer-spec-homer-h4k.md`. Worktree: `homer-h4k`. Steps are numbered by run tag (s1, s2, …).

## Steps

### Before the project
- [x] s1: analysed the Kindle export into `C:\Users\Alex\Downloads\homer-analysis\` (read-only)
- [x] s2: plan, plus a claims check. Conflict: `supabase/functions/mcp/index.ts` and `index.test.mjs` are held by switchboard2-h8r

### A. Spec
- [x] s3: 17 paths claimed; spec and progress written

### B. Schema
- [x] s4: wrote `_pending_homer-h4k_homer_core.sql` (11 tables, `create_homer_plan`, 2 validators, 5 trigger functions) and tests `1_verify.sql`, `2_guards_test.sql` (19 verify checks, 52 guard checks). Not run.
- [x] s5: gitsync (up to date, no drift); 19 db items claimed; number 224 (db:migration:224)
- [x] s5b: wrote `224_homer_core.sql` (identical to the draft plus a path line); deleted the draft; brought the spec in line with the s4 changes; queued 224, action `837b3c95-72bb-4456-946a-1b87cce918cb`. Waiting for Alex to approve it.
- [x] 224 applied: run `d19e7153-3498-44c1-b4d9-aaf1e72723ae`, all 11 tables registered, CONFORMANT (114 tables)
- [x] s5c: `1_verify.sql` and all 52 guard checks in `2_guards_test.sql` passed
- [x] s5d: Checkpoint of 224 and its tests into main (merge fa3e14f); db claims released

### B (queries) and C (import), written together at s6
- [x] s6: wrote `_pending_homer-h4k_homer_queries.sql` (`homer_series_verdicts`, `homer_quiet_series`), `_pending_homer-h4k_homer_import.sql` (`homer_import_batch`), `scripts/homer-import.mjs`, `scripts/lib/homer-import.mjs`, `scripts/lib/homer-import.test.mjs` (11 tests, passing) and `supabase/tests/homer-h4k/3_queries_import_test.sql` (36 checks). No SQL was run. An offline plan from the real files gives 3 readers, 38 devices, 409 series, 1,221 books and 1,582 reads, in 7 batches of at most 500.
- [x] s7: gitsync (3 commits from main, no drift); 10 db items claimed; numbers 225 (`225_homer_queries.sql`) and 226 (`226_homer_import.sql`). The mcp files are still held by switchboard2-h8r.
- [x] s7b: wrote `225_homer_queries.sql` and `226_homer_import.sql` (each the draft plus a path line); deleted both drafts; brought the spec in line with the s6 changes; queued 225 (action `2405daac-3287-4908-8afd-806efcab75ae`) and 226 (action `26d8c4c2-043d-453e-92a4-705948b542e8`). Waiting for Alex to approve both.
- [x] 225 applied: run `50d66bae-cfd0-4ea9-9a43-c5f2818c9aa8`; 226 applied: run `18f6678b-311c-4158-bef0-856fad909c86`; both CONFORMANT
- [x] s7c: queued `3_queries_import_test.sql` with `--test`, action `f74e0ba9-25c8-418f-ab0d-1515b8a87466`. Waiting for Alex to approve it.
- [ ] s7d: Checkpoint of both migrations, `supabase/tests/homer-h4k/`, `scripts/homer-import.mjs` and `scripts/lib/homer-import*.mjs`
- [ ] s8: Alex sets HOMER_TOKEN and runs `node scripts/homer-import.mjs` (dry run), then `--apply`; then verify the counts against the plan

### D. MCP tools
- [ ] s11: claim `supabase/functions/mcp/index.ts` and `index.test.mjs` (stop if still held); write `_shared/tools/homer.ts` and its test; register the tools
- [ ] s12: deploy mcp, `check_platform_conformance`, call each read tool once

### E. Skill
- [ ] s13: `.claude/skills/homer/SKILL.md`

### F. Homer tab
- [ ] s14: `src/homer/` page, api, model and tests; `src/Alfred.jsx`, `src/viewPaths.js` and its test; `_pending_homer-h4k_homer_screen.sql`
- [ ] s15: db step for the screen migration; Alex checks the tab

### G. Keeping reads current (data only)
- [ ] Alex adds the two recurring intentions in the Alfred UI (weekly clip; Amazon export every 6 months)
- [ ] Chat writes the homer `app_profiles` row through `update_app_profile` (rhythm_days 7, activity recipe)

### H. Calibration (chat only)
- [ ] Propose genres from the series already read; Alex corrects them
- [ ] Plan v1 through `create_homer_plan`
- [ ] Taste profiles for the seed series
- [ ] Suggestion rounds; corrections become plan versions
- [ ] Propose owners for the older devices, newest first; Alex confirms

## Next step's scope (s7d)
- create: nothing
- update: docs/progress-homer-h4k.md
- delete: nothing
- deploy: nothing
- SQL: none

s7d runs once the test passes. Alex runs `gitpush` Checkpoint for homer-h4k with these paths: `supabase/migrations/225_homer_queries.sql`, `supabase/migrations/226_homer_import.sql`, `supabase/tests/homer-h4k/3_queries_import_test.sql`, `scripts/homer-import.mjs`, `scripts/lib/homer-import.mjs`, `scripts/lib/homer-import.test.mjs`, `docs/homer-spec-homer-h4k.md` and `docs/progress-homer-h4k.md`. The Checkpoint releases the db claims. Then the thread checks `claims.cmd status`, and Alex sets HOMER_TOKEN and runs `node scripts/homer-import.mjs` (a dry run, no `--apply`), pasting back the counts and any refused rows. The dry run writes nothing. Its counts are checked against the plan: 3 readers, 38 devices, 409 series, 1,221 books, 1,582 reads, 7 batches.

## Notes
- The import data stays in `C:\Users\Alex\Downloads\homer-analysis\` and never goes into git.
- The `apps` row `homer` already exists (migration 181, path null). Phase F only sets path and button_name.
- Dungeon Crawler Carl: "didn't click" is Alex's verdict. The export shows 7 books finished on Elise's devices. Verdicts are per reader.
- db items: claimed at their db step, never before.
- s6 changed the design from the spec. These changes were folded into the spec at s7b.
  1. `homer_import_batch(p_batch jsonb, p_dry_run boolean default true)` takes one object of arrays `{readers, devices, series, books, reads}`, as the s6 prompt asked. It replaces the spec's `(p_kind, p_rows, p_dry_run)`. It is granted to authenticated only (no service_role), because only Alex's token calls it.
  2. Batches are **self-contained**: each carries the readers, devices, series and books its reads need, so every batch dry-runs on its own before anything is applied. Shared rows repeat, and come back "unchanged" once applied. A dry run counts them as new in each batch.
  3. With `--apply`, each batch is dry-run first and applied only if nothing was refused (`--allow-refused` overrides). The flag is `--apply`, not the spec's `--confirm`.
  4. An export read is kept for a (book, device) pair with **30 minutes or more** of reading (the s1 "started" threshold), or for the pair that holds the finish. Shorter pairs are left out as noise.
  5. A book finished twice on one device keeps the later date: 593 finish rows become 589 finished reads.
  6. A device owner in a batch is set (and may replace a different one); a batch without an owner never clears one.
  7. `homer_quiet_series` returns every liked, loved and tired series with an `is_quiet` flag, not only the quiet ones, plus `tired_gap_passed` and the next book the library holds.
  8. With no active plan, default verdicts are null, so the quiet list is empty until plan v1 exists (phase H).
- s4 changed the design from the spec. These changes were folded into the spec at s5b.
  1. Taste scores are checked by a **trigger** (`homer_taste_scores_check`), not only by an RPC, so every write path is checked. A shared validator, `homer_scores_problem`, lets the tools' tier-2 checks and the trigger agree. It is still not a check constraint.
  2. A new validator, `homer_plan_settings_problem`, is used by `create_homer_plan` and by a check constraint on `homer_plans.settings`, so a direct insert can't store bad settings either.
  3. `homer_devices` gains `proposed_reader_id`. `owner_status` is a generated column (confirmed / proposed / unknown), so it can never disagree with the ids.
  4. Carrying the owner onto a device's reads moved from the `update_homer_device` tool into the database: `homer_devices_carry_reader` (on an owner change) and `homer_reads_fill_reader` (on insert). A reader set on a read by hand is kept.
  5. A new guard, `homer_verdicts_guard`: only Alex can lift a "never", as well as set one.
  6. A series name is unique only when the series has no series ASIN, so two series that share a name don't collide.
  7. `homer_queue_items`: `verified_on` is required (not null); `genre_id` may be null (not sorted yet); one live item per reader per ASIN.
  8. `homer_genre_series` has its own `id` and `user_id`, for owner RLS and fetching by id.
  9. A read needs a reader or a device. Export reads are one per book per device (a partial unique index); clip and chat reads have no device.

## Timing log
| Step | Phase | Start | End | Duration |
|---|---|---|---|---|
| s1 | Analysis | 13:36:03 | 13:39:30 | ~3m27s |
| s2 | Plan | 14:21:54 | 14:24:40 | ~2m46s |
| s3 | Claims + spec + progress | 14:27:41 | 14:29:46 | 2m05s |
| s4 | Core migration + 2 tests | 14:37:34 | 14:43:39 | 6m05s |
| s5 | Claim db items, number | 14:51:19 | 14:51:38 | 0m19s |
| s5b | Numbered file, spec, queue 224 | 14:57:58 | 15:01:19 | 3m21s |
| s5c | Queue 2 tests | 15:07:07 | 15:07:41 | 0m34s |
| s6 | Queries + import RPC + script + tests | 15:14:45 | 15:21:03 | 6m18s |
| s7 | Claim db items, number 225 and 226 | 09:51:41 | 09:52:12 | 0m31s |
| s7b | Numbered files, spec, queue 225 and 226 | 09:57:25 | 10:00:00 | 2m35s |
| s7c | Queue 3_queries_import_test | 10:06:25 | 10:06:42 | 0m17s |
