# Progress: Switchboard 3 run and code review pages (sb3_pages-h6v)

Spec: docs/technical-spec-sb3_pages-h6v.md. Plan agreed at s1 (sb3_pages-h6v-s1-m2p7): 18 CLI steps (Phase A 11,
Phase B 7), the switch-over (C, 2) later and approved separately. At double the estimate, stop and ask.

## Steps

| Step | What | Est. | State |
|---|---|---|---|
| s1 | Read-only plan | - | done |
| A1 (s2) | Claim; spec; progress; look.js; runContract.js and its test | 1 | done (33 tests) |
| A2 (s3) | RunPage parts 1-16; pre-check and data operation update pages; simulation.js; /run-sim route | 2 | done in one step (64 tests); Alex's screen tests passed; committed 62dbca2 |
| A3 (s4, s4b) | desktopCheck and its states; s4b: the "Desktop not ready" section, and the plumbing proposal moved into spec part 2 | 1 + follow-up | done (109 tests); Alex's screen tests passed |
| A4 (s5) | Insert, upsert, delete, undelete, multi-object pages; undo page; focus; plumbing agreement in spec 4.5 | 2 | done in one step (148 tests); Alex's screen tests passed (undo-closed still needs a screenshot) |
| A5 (s6, s6b) | s6 fixes; correction page; not started and Try again; checks expired and the rerun; check what happened; used link and rerun waiting. s6b: the dev server's lint error, a render test of every scenario, the stuck-run rerun path, the undo's triggers-and-flows step | 2 + follow-up | done (265 tests); awaiting Alex's screen tests |
| A6 (s7) | Code review page; `diff` 5.2.0; acks, notes, superseded; s7 field-correction rule | 2 | done in one step; Alex's screen tests passed |
| A7 (s8, s8b) | The A7 list below, the other correction scenarios, and the A6 testing fixes. s8b: the closed undo's status line, the field correction reruns the sample, new-file notes at the top | 1 + follow-up | done (351 tests in the runs folder); awaiting Alex's s8b screen tests. Phase A: 11 planned, 11 run (with 4 follow-ups) |
| B1 | Migration, tests, queue, conformance, Checkpoint (waits on plumbing's helper kind) | 2 | |
| B2 | switchboard-run-pages function; deploy | 2 | |
| B3 | MCP tools; deploy | 2 | |
| B4 | Real source; live routes; end to end on a sandbox | 1 | |
| C | Switch-over (separate approval) | 2 | |

## A7: fixes from Alex's testing (recorded at s7, all built at s8)

- The closed undo (undo-closed): the status line says "Undo: not offered, the deadline has passed", and "This run
  will:" is left out.
- A delete's undo: "Confirm the login can still restore Gift records", not "delete".
- A used link (run-picked-up, run-finished): the status line says the data operation is running or finished, not
  waiting.
- "Check what happened": drop "No checks have passed yet, so nothing expires."
- The other correction scenarios (value, records, sandbox filter, code).
- correction-field: add save_backup to its steps and void its backup evidence, so "Still valid" drops Backup (the s7
  rule: a field edit reruns the backup). Its RunPage.test.jsx assertions change with it; that file was outside s7's
  scope, so the scenario still shows the old rule.

## Claimed (s2)

docs/technical-spec-sb3_pages-h6v.md, docs/progress-sb3_pages-h6v.md, src/switchboard/runs/, src/App.js, package.json,
package-lock.json, supabase/functions/switchboard-run-pages/, supabase/config.toml,
supabase/functions/_shared/tools/switchboard-runs.ts, supabase/functions/_shared/tools/switchboard-runs.test.mjs,
supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs,
supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql, supabase/tests/sb3_pages-h6v/. No db: items (claimed at B1).

## Next step's scope

Run tag: sb3_pages-h6v-s9-<4>, B1 (the migration: four tables, ten functions and one added delete in switchboard_prune_sf_results, grants, register_table; verification and failure tests; queue; conformance; Checkpoint)

Scope of this step:
- create: supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql (renamed to its number at the numbering step), supabase/tests/sb3_pages-h6v/1_verify.sql, supabase/tests/sb3_pages-h6v/2_failure_test.sql
- update: docs/technical-spec-sb3_pages-h6v.md
- delete: supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql, after `claims.cmd number-migration` writes the numbered file
- deploy: nothing (the migration and tests are queued with scripts/sql-queue.mjs; Alex approves by link)
- SQL: the numbered migration (schema), 1_verify.sql and 2_failure_test.sql (--test)
- db items, claimed at the database step, after gitsync and the drift check, never before: db:table:switchboard_run_requests, db:table:switchboard_run_links, db:table:switchboard_run_samples, db:table:switchboard_code_reviews, db:table:switchboard_actions, db:fn:switchboard_queue_run_request, db:fn:switchboard_correct_run_request, db:fn:switchboard_issue_run_link, db:fn:switchboard_run_preview, db:fn:switchboard_consume_run_link, db:fn:switchboard_cancel_run_link, db:fn:switchboard_retry_run, db:fn:switchboard_record_code_review, db:fn:switchboard_store_run_sample, db:fn:switchboard_drop_run_sample, db:fn:switchboard_prune_sf_results (all free at s8)
- Before it starts: plumbing's helper kind (proposed sf_run) has landed on main (spec part 2, Q5); A6 and A7 committed; Alex runs gitsync in this worktree; then the drift check on what came in
Estimated run: 30m

## Timing log

| Step | Phase | Start | End | Time |
|---|---|---|---|---|
| s1 | Research | 16:30:47 | 16:35:20 | 4m33s |
| s1 | Draft and cold review | 16:35:20 | 16:40:16 | 4m56s |
| s1 | Fixes and report | 16:40:16 | 16:40:46 | 0m30s |
| s2 | Claim and build | 07:10:36 | 07:15:26 | 4m50s |
| s2 | Cold review and fixes | 07:15:26 | 07:19:35 | 4m09s |
| s2 | Full suites and report | 07:19:35 | 07:20:02 | 0m27s |
| s3 | Build | 07:41:09 | 07:47:20 | 6m11s (paused for a usage reset in between) |
| s3 | Cold review and fixes | 07:47:20 | 07:50:22 | 3m02s |
| s3 | Full suites and report | 07:50:22 | 07:50:40 | 0m18s |
| s4 | Build | 10:10:22 | 10:14:01 | 3m39s |
| s4 | Cold review and fixes | 10:14:01 | 10:17:17 | 3m16s |
| s4 | Full suites and report | 10:17:17 | 10:18:07 | 0m50s |
| s4b | Build | 10:26:09 | 10:27:55 | 1m46s |
| s4b | Cold review and fixes | 10:27:55 | 10:30:19 | 2m24s |
| s4b | Full suites and report | 10:30:19 | 10:31:03 | 0m44s |
| s5 | Build | 10:38:26 | 10:43:00 | 4m34s |
| s5 | Cold review and fixes | 10:43:00 | 10:47:49 | 4m49s |
| s5 | Full suites and report | 10:47:49 | 10:48:33 | 0m44s |
| s6 | Build | 11:28:38 | 11:34:01 | 5m23s |
| s6 | Cold review and fixes | 11:34:01 | 11:38:57 | 4m56s |
| s6 | Full suites and report | 11:38:57 | 11:39:39 | 0m42s |
| s6b | Fix and build | 11:58:41 | 12:01:42 | 3m01s |
| s6b | Cold review and fixes | 12:01:42 | 12:05:21 | 3m39s |
| s6b | Full suites and report | 12:05:21 | 12:06:04 | 0m43s |
| s7 | Install, fixes and build | 12:28:46 | 12:34:29 | 5m43s |
| s7 | Cold review and fixes | 12:34:29 | 12:38:14 | 3m45s |
| s7 | Full suites and report | 12:38:14 | 12:39:08 | 0m54s |
| s8 | Build | 13:02:27 | 13:06:07 | 3m40s |
| s8 | Cold review and fixes | 13:06:07 | 13:11:48 | 5m41s |
| s8 | Full suites, B1 check and report | 13:11:48 | 13:12:53 | 1m05s |
| s8b | Fixes | 13:22:26 | 13:24:11 | 1m45s |
| s8b | Cold review and fixes | 13:24:11 | 13:26:00 | 1m49s |
| s8b | Full suites and report | 13:26:00 | 13:26:40 | 0m40s |
