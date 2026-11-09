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
- [ ] s5c: queued `1_verify.sql` (action `0defa8c2-aab4-499f-9985-dda0a97c7c83`) and `2_guards_test.sql` (action `2d02e768-d196-49e0-bec7-bf3ea0bfe71f`) with `--test`. Both need Alex's click; results not in yet.
- [ ] s5d: Checkpoint (gitpush) with `supabase/migrations/224_homer_core.sql` and `supabase/tests/homer-h4k/`; check the db claims are released
- [ ] s6: write `_pending_homer-h4k_homer_queries.sql` (`homer_series_verdicts`, `homer_quiet_series`) and `3_queries_test.sql`
- [ ] s7: db step for queries (as in s5)

### C. Import
- [ ] s8: write `_pending_homer-h4k_homer_import.sql` (`homer_import_batch`), `scripts/homer-import.mjs`, `scripts/lib/homer-import.mjs` and its test, and `4_import_test.sql`
- [ ] s9: db step for `homer_import_batch`
- [ ] s10: Alex runs the dry run, then `--confirm`, kind by kind; then verify the counts against summary.json

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

## Next step's scope (s5c)
- create: nothing
- update: docs/progress-homer-h4k.md
- delete: nothing
- deploy: nothing
- SQL: homer_plans, homer_readers, homer_devices, homer_series, homer_books, homer_reads, homer_verdicts, homer_taste_profiles, homer_genres, homer_genre_series, homer_queue_items

Run s5c only after Alex has approved 224. The db claims stay held until the s5d Checkpoint.

## Notes
- The import data stays in `C:\Users\Alex\Downloads\homer-analysis\` and never goes into git.
- The `apps` row `homer` already exists (migration 181, path null). Phase F only sets path and button_name.
- Dungeon Crawler Carl: "didn't click" is Alex's verdict. The export shows 7 books finished on Elise's devices. Verdicts are per reader.
- db items: claimed at their db step, never before.
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
