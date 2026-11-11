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
- [x] s7c result: `3_queries_import_test.sql` passed 37/37. s7d: Checkpoint into main (merge 107cb01, commit 28666da); db claims released.
- [x] s8 (2026-11-10): HOMER_TOKEN was not set in the CLI's environment or the user registry, so the dry run did not run. The token mechanism was explained to Alex; he runs the dry run in his own terminal next.
- [x] s8b: Alex ran the import with `--apply`: 3 readers, 38 devices, 409 series, 1,221 books, 1,582 reads, 589 finished, 0 refused. Each finish was on one device only (all 11 He Who Fights with Monsters finishes went to Elise, none to Alex).
- [x] s9: finish rule changed in `scripts/lib/homer-import.mjs`: every device with ≥ 60% of the most-read device's hours and ≥ 1 h gets the finish, dated its own last read day; if none qualifies, the old one-finish rule applies. 15/15 Homer tests, 69/69 scripts tests. Offline plan: 717 finished reads (alex 220, elise 193, vasti 0, no reader 304), 589 books, 115 finished on 2+ devices. He Who Fights with Monsters: Elise 11, Alex 3 (books 2, 5, 6). The 60% share misses most of Alex's, since his hours run 40–60% of Elise's; 35% would credit him with books 1–3 and 5–10. Not re-imported yet.
- [x] s9b: Alex chose 35%. `FINISH_SHARE = 0.35`; the "just under" test moved to 34%. 15/15 Homer tests, 69/69 scripts tests. Offline plan: 776 finished reads (alex 254, elise 193, vasti 0, no reader 329), 589 books, 164 finished on 2+ devices, 0 unplaced, 7 batches. He Who Fights with Monsters: Alex books 1–3 and 5–10, Elise 1–3 and 5–12.
- [x] s9c: Alex re-ran `--apply` with the 35% rule: 1,582 reads, 776 finished (alex 254, elise 193, no reader 329). Checkpointed (c7e4d11).

### Implied finishes and series availability (s10)
- [x] s10: wrote `_pending_homer-h4k_homer_implied_availability.sql`, which allows completion `implied`, adds 5 availability columns and their checks to `homer_series`, and replaces `homer_quiet_series` with `available_position`, `books_behind`, `is_caught_up`, `upcoming_*` and `availability_checked_on`. Wrote `4_implied_availability_test.sql` (20 checks). Implied finishes and owners-from-the-database are in the import script and lib. 20/20 Homer tests, 74/74 scripts tests. Offline: 1,320 finished reads (automatic 726, manual 50, implied 544); alex 395, elise 259, no reader 666; Alex's 45 still unfinished are 41 lone book 1s and 4 with no series. No SQL was run.
- [x] s10b: gitsync (341630c, switchboard2-h8r's 227 and runner; no drift). Claimed db:table:homer_reads, db:table:homer_series and db:fn:homer_quiet_series. Number **228** (`228_homer_implied_availability.sql`, db:migration:228). Alex chose **no exception for the book he's reading now**: an in-progress book in a series he's read 2+ books of stays marked finished (implied), as specified.
- [x] s10b2 (run tag s10c): wrote `228_homer_implied_availability.sql` (the draft plus a path line, checked with diff), deleted the draft, queued 228, action `7a0f11c8-ba0c-49cc-8b3e-5b525efe13a8`. Waiting for Alex to approve it.
- [x] 228 applied: run `4182adbb-e379-40e8-8006-d0a674077ca5`, CONFORMANT
- [x] s10d: queued `4_implied_availability_test.sql` with `--test`, action `590673ac-d494-4721-a35d-158abb8e78fc`. Waiting for Alex to approve it.
- [x] s10e: the test passed; Alex re-ran `--apply` (1,320 finished reads, 544 implied; Alex 395 of 440); Checkpoint 5db5800; db claims released
### D. MCP tools
- [x] mcp files claimed at s13 (2026-11-10 13:26)
- [x] s14: phase D plan (read-only). 23 tools, no migration and no new RPC. See "Phase D plan" in Notes.
- [x] s15: the 11 read tools in `supabase/functions/_shared/tools/homer.ts` + `homer.test.mjs` (13 tests); registered in `mcp/index.ts`; `EXPECTED_ADDED_HOMER_15` and the tool count 200 → 211 in `index.test.mjs`. homer 13/13, mcp index 48/48, tables 1/1, scripts 75/75. Not deployed. Small additions to the s14 plan: `get_homer_series` always returns the series `author` and `notes` (availability only on include) and takes `name`; `get_homer_reads` takes `reader: "any"` or `"none"`; `get_homer_quiet_series` takes `only_quiet` (what the tab shows); `get_homer_genres` and `get_homer_queue` take `include_archived` (Homer tables use `archived_at`, so the shared `archived` option doesn't apply); `search_homer_books` searches title and/or author.
- [x] s15b: the 12 write tools in `homer.ts` (14 more tests: homer 27/27), registered; `EXPECTED_ADDED_HOMER_15B` and the count 211 → 223. mcp index 48/48, tables 1/1, scripts 75/75. Not deployed. Differences from the s14 plan: (1) `update_homer_genre` adds series and changes `is_example` but doesn't remove one: link rows have no `archived_at`, and a tier-2 tool never hard-deletes. (2) `create_homer_read` refuses a second open **chat or clip** read only; an open export read is left alone, because the next import would overwrite a finish written onto it. (3) `update_homer_read` on an export read returns a note that the next import resets its dates. (4) `update_homer_series` dates the check today when an availability field changes. (5) `create_homer_book` references an existing series and never re-sends it, so a different spelling can't rename it. (6) A stored verdict can't be cleared back to the default (that would be a hard delete). Was planned as: the 12 write tools (incl. 2 tier 3 with `propose`) + tests; registered (≈50m). **Alex's decision (s15): `create_homer_never` also lifts a never**: it takes `lift: true` and the replacing verdict (loved, liked, tired or didnt_click), stays tier 3 with a readable `propose` (what is blocked now, what the verdict becomes), and writes `set_by = 'alex'` on his approval. Setting a never takes the subject (series, book or author) and a note.
- [x] s15c: skill to version 2026-11-10b (tool table as built, 23 tools by name and tier; `create_homer_book`; the never lift; recording reads in three steps; export reads reset by the import; known limits and what to tell Alex; plan v1 first, with the seed examples and starting settings as a checklist). Spec phase D: the tool table as built and the differences from the plan; phase E brought in line.
- [ ] s16 (stopped, not deployed): gitsync to d13e6ac, no drift under `supabase/functions/` (only this thread's own changes differ from main). Claimed db:deploy; homer 27/27 and mcp index 48/48 passed. `npx supabase functions deploy mcp` was **refused by the plan guard**: the scope said `deploy: supabase/functions/mcp`, and the guard matches the function name `mcp`. db:deploy released (no db: claims left). switchboard2-h8r is waiting on `mcp/index.ts` and `index.test.mjs`; both have changes, so they stay claimed until the Checkpoint.
- [x] s16b (2026-11-10 16:03): main unmoved (d13e6ac, local and origin). Claimed db:deploy; homer 27/27, mcp index 48/48; `npx supabase functions deploy mcp` deployed (bundle 4.0 MB). Live `tools/list`: **223 tools, all 23 homer tools by name**. A bad-token `tools/call` (get_apps) is refused ("Invalid JWT: expected 3 parts", isError); no token is 401. `check_platform_conformance`: CONFORMANT (115 tables). No Homer tool called. db:deploy released; no db: claims left. Seen while verifying (not new, not Homer's): a bad-token `tools/list` still answers 200 with the tool list; only calls check the token.
- [x] s16c (2026-11-11): Checkpoint landed (main 2b21d70, all 7 paths). `supabase/functions/mcp/index.ts` and `index.test.mjs` had no diff against main and were yielded to switchboard2-h8r, one at a time; `claims.cmd status` no longer shows them or the block. switchboard2-h8r runs gitsync before editing them.
- **Phase D done**: 23 tools live (mcp deployed at s16b), skill 2026-11-10b. Alex tests them from a new claude.ai thread.

### Follow-ups from the first live weekly clip (s17, 2026-11-11)
- [x] s17: **`create_homer_book` series bug fixed** (not deployed yet). A `series_name` without `series_asin` only searched series with no ASIN, and `homer_import_batch` also keys a name only among series with no ASIN, so "Street Cultivation" (ASIN B086YRRJ97) wasn't found and a second series was made (9c446b9a…). Now a name alone matches any of the user's series by name (case and surrounding spaces ignored): one match is referenced (by its ASIN when it has one), several are refused and named, none creates a new series. Test added (homer 28/28, tables 1/1). Skill to 2026-11-11a: the weekly clip method (the Content page, borrowed or acquired date as `started_on`, ASINs by web search, "Needs ASIN" queue items retried weekly, kept samples as `maybe_later`).
- [ ] s17b (2026-11-11): gitsync to 2b21d70; drift check clean (since d13e6ac only our own 8543fa3 touched `mcp/` or `_shared/`). **Deploy not done: db:deploy is held by switchboard2-h8r** (a block was recorded); the `create_homer_book` fix is still undeployed. Wrote `_pending_homer-h4k_fix_street_cultivation_series.sql` (the guarded fix), claimed db:table:homer_books and db:table:homer_series, numbered **232** (`232_fix_street_cultivation_series.sql`, db:migration:232). The import now closes open clip or chat reads after `--apply`: `readsToClose` and `planFinishes` in `scripts/lib/homer-import.mjs` (2 tests), and `closeOpenReads` in `scripts/homer-import.mjs` (reads and patches `homer_reads` with Alex's token; the dry run counts from the database plus this plan). A read started after the export finish is a re-read and stays open. No database function changed. import 23/23, scripts 77/77, homer tools 28/28.
- [ ] s17c (2026-11-11): wrote `232_fix_street_cultivation_series.sql` (the draft plus its path line, checked with diff), deleted the draft, queued 232 with `--expect 2,1`, **action `21b8a505-fc27-4e81-890e-b28701249df1`**, waiting for approval. **Deploy still blocked**: switchboard2-h8r still held db:deploy at 07:29, so this step stopped after the queue. Held: db:table:homer_books, db:table:homer_series, db:migration:232 (until 232 has run).
- [x] 232 applied: action `21b8a505-fc27-4e81-890e-b28701249df1`, run `4a6340a6-65fe-4c91-b21c-c4a28e917724` (2 books updated, 1 series deleted, CONFORMANT). s17d checked it read-only: B07W9J75R3, B086Q8ZGTD and B08NFJWWBF are all in f7ef6cb1… (Street Cultivation, B086YRRJ97) at positions 1, 2, 3, and 9c446b9a… is gone.
- [ ] s17d (2026-11-11 07:48): **deploy still blocked**: switchboard2-h8r has held db:deploy for 29 minutes (homer-h4k has waited 28). Stopped before the deploy; the `create_homer_book` fix is still not live.
- [x] **Data fix** (was: not queued at s17): the SQL file needs a create scope, and numbering needs gitsync. Planned SQL: move B086Q8ZGTD and B08NFJWWBF to series f7ef6cb1-ed94-4d5a-86f7-51810136e73b (only where they are in 9c446b9a-84a9-4208-b5c0-1c75b0a241b3), then delete 9c446b9a… only where no book, verdict, genre link, queue item or taste profile references it (verdicts, profiles and genre links cascade on delete; books and queue items set null). Triggers on both tables are only `updated_at` and the audit trigger, so both statements are allowed. `--expect 2,1`.
- **Clip read, then export read (s17, read-only finding).** The import keys reads by `import_key` (`export:<asin>:<device>`), and a clip read is `clip:<date>:<asin>` with no device; the one-per-book-per-device index only covers reads with a device. So **both stay**: the export read is inserted beside the clip read, nothing replaced, nothing refused. Counts don't double (`homer_series_verdicts` counts distinct books, the tab merges per book), but `get_homer_reads` shows two rows, and an **open** clip read stays open even after the export brings the finish, which then blocks a new clip read of that book. Recommendation: keep both rows (different evidence), and after each import close any open clip or chat read whose book now has a finished export read by the same reader (finished_on from the export read), in the import script or a small RPC.

### What's left
1. **Phase G** (data only, below): Alex adds the two recurring intentions in the app; a chat writes the homer `app_profiles` row (rhythm_days 7, an activity recipe counting clip reads).
2. **Phase H** (calibration in claude.ai, below): plan v1 first, then genres, taste profiles, suggestion rounds, device owners.
3. **Closeout**: Alex runs `gitpush` Finish for homer-h4k, which releases the file claims, removes the worktree and deletes the branch.

### E. Skill
- [x] s11 (was s13): wrote `.claude/skills/homer/SKILL.md` (Skill version 2026-11-10). Two gaps for phase D, not yet in the spec: (1) no tool writes series availability, so the skill names `update_homer_series` (tier 2: notes plus the 5 availability fields); (2) `create_homer_read` must accept a book Homer doesn't have yet (a new clip title), or there must be a way to add one.

### F. Homer tab
- [x] s12 (was s14): tried to claim `supabase/functions/mcp/index.ts` and `index.test.mjs`; refused (held by switchboard2-h8r), and the block was recorded so that thread is told. Built `src/homer/` (`HomerPage.jsx`, `homerApi.js`, `homerModel.js`, 3 test files), wired `homer` → `/homer` in `src/viewPaths.js` (+ test) and `src/Alfred.jsx`, and wrote `_pending_homer-h4k_homer_screen.sql`. 89/89 in the Homer and viewPaths tests; build compiled. Full app suite: 3,322 passed, 1 failed (`src/sam/SamPlayer.plan.test.jsx`, which passes 53/53 on its own: a load flake, not this change). Scripts suite 74/74. **Gap:** the nav button list is in `src/shared/AppChrome.jsx` (icon map in `src/shared/ObjectIcon.jsx`), not in scope, so the tab is reached by URL until those are added.
- [x] s12b: Alex checked the three empty states locally. Claimed `src/shared/AppChrome.jsx` and `src/shared/ObjectIcon.jsx`. Added Homer to `NAV_ITEMS` after Overwatch (now exported, for a test), with a `homer` icon (BookOpen). Added "Reading history" (series cards, Standalone last, collapsed, 20 then Show more) and a "Series" link on each quiet row. Homer, viewPaths and shared tests 420/420; build compiled. The nav test was blocked by the plan guard (new file `src/homer/homerNav.test.jsx`, not declared), so it is not written yet. Offline, Alex has 135 series cards plus Standalone (5 books). At the top: Street Cultivation, Level Up, The Coming of God of Death. The Primal Hunter is 40th, Mob Sorcery 51st and He Who Fights with Monsters 80th, all behind "Show more".
- [x] s12c: Alex checked s12b in Chrome (nav, history, links all work). Authors now show on history card headers, on a book line only when it differs from the series author (always on Standalone), and on quiet rows. Wrote `src/homer/homerNav.test.jsx`. Homer, nav, viewPaths and UnderlineTabs tests: 116/116; build compiled. Co-author check (read-only): 445 of 4,245 export ASINs have 2+ authors, 112 of them in Homer; the import keeps the first. Not changed.
- [x] s12d: Alex chose to keep every author, comma-separated in `homer_books.author` (no schema change). `authorsByAsin` in the import lib (file order, flipped, de-duplicated, joined ", "). History headers show the author union (series author first); a book line shows its authors only when its set differs; quiet rows use the header list. Import 21/21, scripts 75/75, Homer 21/21; build compiled. Offline: 112 books with 2+ authors (at most 3). Not re-imported: Alex runs `--apply`.
- [x] s12e: Checkpoint of the tab, nav, import authors, spec and progress into main (5b507d2): the Homer tab and nav button are live. Alex re-ran `--apply` with every author: 112 books now have 2 or more authors.
- [x] s13: gitsync fast-forwarded to 5b507d2 (no drift on `public.apps`). Claimed db:table:apps. Number **230** (`230_homer_screen.sql`, db:migration:230). Tried the mcp files again: **both were free and are now claimed by homer-h4k** (`supabase/functions/mcp/index.ts`, `index.test.mjs`), so phase D is unblocked.
- [x] s13b: wrote `230_homer_screen.sql` (the draft plus a path line, checked with diff), deleted the draft, queued 230 with `--expect 1`, action `1abf218f-ef54-4aca-a1b5-551b2e78fbe3`. Waiting for Alex to approve it; then the Checkpoint of 230 releases db:table:apps and db:migration:230.

### G. Keeping reads current (data only)
- [ ] Alex adds the two recurring intentions in the Alfred UI (weekly clip; Amazon export every 6 months)
- [ ] Chat writes the homer `app_profiles` row through `update_app_profile`: `rhythm_days` 7, and an `activity_recipe` saying "count homer_reads with source = 'clip' created in the window, from get_homer_reads (reader any, source clip)", so Overwatch flags a week with no clip

### H. Calibration (chat only)
- [ ] Propose genres from the series already read; Alex corrects them
- [ ] Plan v1 through `create_homer_plan`
- [ ] Taste profiles for the seed series
- [ ] Suggestion rounds; corrections become plan versions
- [ ] Propose owners for the older devices, newest first; Alex confirms

## Next step's scope (s17e, deploy mcp once switchboard2-h8r releases db:deploy)
- create: nothing
- update: docs/progress-homer-h4k.md
- delete: nothing
- deploy: mcp
- SQL: none

s17e runs once switchboard2-h8r has released db:deploy (and, if main has moved since 2b21d70, after Alex's gitsync and a drift check under `supabase/functions/`). It claims db:deploy, reruns homer.test.mjs and index.test.mjs, deploys mcp, checks the 23 Homer tools are live and conformance is CONFORMANT, and releases db:deploy. The Checkpoint can go before or after it: Checkpoint paths `supabase/functions/_shared/tools/homer.ts`, `supabase/functions/_shared/tools/homer.test.mjs`, `scripts/homer-import.mjs`, `scripts/lib/homer-import.mjs`, `scripts/lib/homer-import.test.mjs`, `supabase/migrations/232_fix_street_cultivation_series.sql`, `.claude/skills/homer/SKILL.md`, `docs/progress-homer-h4k.md`; it releases db:table:homer_books, db:table:homer_series and db:migration:232.

## Notes
- **Phase D plan (s14).** One file, `supabase/functions/_shared/tools/homer.ts` (+ `homer.test.mjs`, run with `node --experimental-strip-types --test`), registered in `supabase/functions/mcp/index.ts` (+ an `EXPECTED_ADDED_HOMER` list in `index.test.mjs`). Every tool goes through `defineTool`, with literal `tables`, through `ctx.db`; lists through `readTable`. Every tool takes `reader` (key, default `alex`) where it's per reader. All 11 tables and the 228 columns are in `schema-snapshot.sql`, so `tables.test.mjs` can check them. **No migration and no new RPC**: the validators (`homer_plan_settings_problem`, `homer_scores_problem`), `create_homer_plan`, `homer_series_verdicts`, `homer_quiet_series` and `homer_import_batch` are already granted to authenticated, and the guards are triggers. db items: only `db:deploy`, at s16.
  - Reads (tier 1): `get_homer_plan` (active; `history`; `plan_id`), `get_homer_readers`, `get_homer_devices` (owner key, proposed owner, status, hours, dates), `get_homer_books` (`ids`, `asin`, `series_id`), `search_homer_books` (title text), `get_homer_series` (RPC `homer_series_verdicts` via `finishRead`; filters `verdict`, `is_default`; `include`: `books`, `taste_profile`, `genres`, `availability` for calibration), `get_homer_reads` (reader, book, series, dates, source, finished), `get_homer_taste_profiles`, `get_homer_genres` (with series and examples), `get_homer_queue` (genre, status, archived), `get_homer_quiet_series` (RPC).
  - Writes: `create_homer_plan` (3; `propose` = a before-and-after against the active plan and an early refusal via `homer_plan_settings_problem`; the write is the `create_homer_plan` RPC). `update_homer_device` (2; `propose_owner` or `confirm_owner`, the trigger carries reads). `create_homer_book` (1, **new, not in the skill's table**: a book Homer doesn't know, plus its series if new, written through `homer_import_batch` with only series and books, so there is still one upsert path; refuses an ASIN that exists and returns it). `update_homer_series` (2; notes and the 5 availability fields). `create_homer_read` (1; source chat or clip, no device, `import_key` `clip:<date>:<asin>` or `chat:<date>:<asin>`; refuses an unknown ASIN, pointing to `create_homer_book`, and refuses a second open read of the same book, pointing to `update_homer_read`). `update_homer_read` (2; dates, hours, reader, completion manual). `update_homer_verdict` (2; loved, liked, tired, didnt_click and note, `set_by` claude; select then insert or update, since the unique indexes are partial; refuses never, and can't lift one, since the guard refuses). `create_homer_never` (3; `propose` names what it blocks; `set_by` alex). `update_homer_taste_profile` (2; description and scores; early refusal via `homer_scores_problem`; upsert on (reader_id, series_id)). `update_homer_genre` (2; create or edit by id or name, status, sort order, archive, and the series list with `is_example`; genre first, then its series). `create_homer_queue_items` (1; refuses without `verified_on`, or `on_kindle_unlimited` without `ku_checked_on`; position appended per genre). `update_homer_queue_item` (2; status, genre, move via `after_id`/`before_id` to a midpoint position, drop sets `archived_at`).
  - Differences and gaps: (1) `create_homer_book` is added; the skill's table gets it at s15c. (2) **Lifting a never** has no tool: the spec says only Alex lifts one, but no tool writes `set_by = 'alex'` except `create_homer_never`. Proposal: `create_homer_never` takes `lift: true` plus the new verdict, still tier 3. (3) Non-atomic writes: `update_homer_genre` (genre, then its series) and nothing else; a failure part-way is reported, not hidden.
- The import data stays in `C:\Users\Alex\Downloads\homer-analysis\` and never goes into git.
- The `apps` row `homer` already exists (migration 181, path null). Phase F only sets path and button_name.
- He Who Fights with Monsters (for phase H calibration): Alex says he got tired of it. He finished books 1–3 and 5–10; Elise went further, to book 12. Verdicts are per reader, so it is likely `tired` for Alex and not for Elise.
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
| s8 | Token check (not set; no dry run) | 10:11:57 | 10:12:30 | 0m33s |
| s9 | Finish rule, tests, offline plan, spec | 10:35:33 | 10:37:55 | 2m22s |
| s9b | Share 35%, tests, offline plan | 10:42:09 | 10:42:35 | 0m26s |
| s10 | Implied finishes, availability migration, 2 tests | 11:17:32 | 11:22:18 | 4m46s |
| s10b | Claim db items, number 228 | 11:26:31 | 11:26:56 | 0m25s |
| s10c | Write 228, delete draft, queue 228 | 12:00:14 | 12:00:39 | 0m25s |
| s10d | Queue 4_implied_availability_test | 12:03:01 | 12:03:21 | 0m20s |
| s11 | Homer skill | 12:09:07 | 12:10:49 | 1m42s |
| s12 | Homer tab, route, screen migration | 12:17:23 | 12:22:41 | 5m18s |
| s12b | Nav, reading history, series links | 12:35:09 | 12:38:22 | 3m13s |
| s12c | Authors, nav test, co-author check | 12:52:00 | 12:53:47 | 1m47s |
| s12d | Every author per book, author union on the tab | 13:12:47 | 13:14:48 | 2m01s |
| s13 | Claim apps, number 230, mcp claim | 13:26:01 | 13:26:35 | 0m34s |
| s13b | Write 230, delete draft, queue 230 | 13:29:35 | 13:30:24 | 0m49s |
| s14 | Phase D plan (read-only) | 14:54:53 | 14:57:06 | 2m13s |
| s15 | 11 read tools, tests, registration | 15:00:50 | 15:06:41 | 5m51s |
| s15b | 12 write tools, tests, registration | 15:08:55 | 15:14:59 | 6m04s |
| s15c | Skill 2026-11-10b and spec phase D/E | 15:37:04 | 15:39:11 | 2m07s |
| s16 | Deploy attempt (refused by the plan guard) | 15:54:14 | 15:55:15 | 1m01s |
| s16b | Deploy mcp, verify live | 16:02:47 | 16:04:42 | 1m55s |
| s16c | Yield the two mcp files (2026-11-11) | 06:42:36 | 06:43:21 | 0m45s |
| s17 | Series bug fix, skill clip method, import finding | 07:07:22 | 07:09:11 | 1m49s |
| s17b | Data fix numbered 232, close open reads; deploy blocked | 07:19:56 | 07:21:50 | 1m54s |
| s17c | Write and queue 232; deploy still blocked | 07:29:34 | 07:30:10 | 0m36s |
| s17d | Verify 232; deploy still blocked | 07:48:20 | 07:49:00 | 0m40s |
