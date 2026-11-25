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
| B1 (s10, s10b) | Migration, tests, queue, conformance, Checkpoint | 2 | s10: drift check passed; migration and both tests drafted and cold-reviewed; 15 db items claimed; numbered 250 (db:migration:250). s10b: 250_run_pages.sql written, _pending_ deleted, queued (action 9f97e4f0-7206-4b38-8155-2bd5a48d2af3); waiting for Alex's approval, then the two --test scripts |
| B1 | (see above) | | done: live, verify 69/69, failure tests 62/62, on main at 1d12214 |
| B2 (s11) | switchboard-run-pages function; deploy | 2 | built (22 tests), deployed, unauthenticated smoke test passed; the preview-with-JWT smoke test is Alex's; one 250 gap open for a follow-up migration (spec 10b) |
| B2 follow-up (s12, s12b) | The correction gap and switchboard_record_run_evidence (migration 251); helper routes removed | - | s12: drafted, cold-reviewed, db items claimed, numbered 251. s12b: 251 written with option A (pre_check_request_id), _pending_ deleted, the reruns line, cold-reviewed, queued (action 170f9522-95c9-43ea-b9bd-da761ce30633, never applied). s12c (blocked) and s12d: sample moves with the copy, correction kinds held to their rows, pre_check_request_id fixed, /approve reruns line; requeued (action b32ebcc8-313e-418a-b85b-d88780f69dc2). s12e: 251 live; 3_followup_test queued (action 566672f2-7d2d-4ecc-99c5-0b8b9319b502); switchboard-run-pages redeployed, smoke test passed. Next: read the test result, then the Checkpoint |
| B3 (s13, s13b) | MCP tools; deploy | 2 | s13 stopped (runContract not loadable). s13b: four tools, runContract shared, git keys and strict schema, tests, cold review; deploy waits for a gitsync (main moved: 268f2e2, 509bb49). s13c: synced, deployed, strict refusal confirmed live; the tool listing shows after a connector reconnect |
| B3 follow-up (s14, s14b) | Migration 252: a write's correction gets its own steps back; a sandbox can be added | - | s14: drafted, cold-reviewed, db items claimed, numbered 252. s14b: 252_correction_steps.sql written (plus the queue's base_steps refusal), _pending_ deleted, queued (action af4a4305-53dd-4d48-b23c-e0733ea127cc). s14c: 252 live; 4_correction_steps_test queued (action 9283ede0-b2a8-4e95-bc02-db205f724c5c). Next: read its result, then the Checkpoint |
| B4 (s15, s15b) | Real source; live routes; end to end on a sandbox | 1 | s15 stopped (new files undeclared). s15b: liveSource.js, LiveRunRoute.jsx, the /run/ and /review/ routes, status from the evidence, the function's lines; tests, build, cold review; Alex's screen tests passed. s16: the count (the preview's total_count, migration 253 drafted and numbered, 5_preview_count_test written; a write page whose shown count differs offers no Approve) and the error boundary; db:fn:switchboard_run_preview and db:migration:253 held. s16b: 253_preview_count.sql written, _pending_ deleted, App.js wraps the lazy routes in RunErrorBoundary, 253 queued (action 6b041669-0b30-4a6a-9eef-069205953db1). s16c: 253 live (run b11a37fb-4495-4e4d-8dfa-c0f63888d9a6, CONFORMANT); 5_preview_count_test queued (action 756bd1ca-160b-465c-8fd0-123fc42a9536). Next: read its result, then the Checkpoint |
| B4 follow-up (s17) | Migration 254: the write's outcome on its request | - | B4 and 253 committed on the branch (bfb2e49), not yet on main. s17: 254 drafted (columns, switchboard_record_run_outcome, preview), 6_run_outcome_test (29 checks), the page's outcome display, cold-reviewed; db:table:switchboard_run_requests, db:fn:switchboard_record_run_outcome and db:migration:254 claimed. s17b: Alex chose A (no correction once a write ran); 254 adds the correction refusal, written, _pending_ deleted, queued (action 274a4371-64e1-46b8-b085-87c674e219d3); test 36 checks; db:fn:switchboard_correct_run_request claimed. s17c: 254 live (run fb4a48a5-051e-412a-acd4-b5b5ca632651, CONFORMANT); 6_run_outcome_test queued (action d9f8a2cc-1258-409c-9030-8555fc451d0c). Next: read its result, then the Checkpoint |
| C | Switch-over (separate approval) | 2 | s18: plan written (spec 14), read only: C1 look and heading (safe now, 1), C2 retire sf_dataop and sf_datawrite (gated on the client runs, the runner and L3, 1); C3 cleanup optional. s19: Alex approved all five; C1 built (format.js, ApprovePage on look.js, no heading, marks pinned), tests and build pass, cold-reviewed. s19b: screen test 2's bar-after-Approve is from before C1 (spec 14.6, fix proposed as its own step); 5 of 6 passed. s19c: the bar fixed (only while an Approve is on offer); C1 and the fix checkpointed. s20: the extension's marks on real /run/ and /review/ pages (spec 14.7): line and link id on every result line, running and action id on the run page; tests, cold review. Next: its Checkpoint, then C2 |

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

s20's Checkpoint (gitpush Checkpoint, this worktree), so plumbing's L3 can read the marks live. Paths: src/switchboard/runs/look.js src/switchboard/runs/RunPage.jsx src/switchboard/runs/CodeReviewPage.jsx src/switchboard/runs/pageMarks.test.jsx docs/technical-spec-sb3_pages-h6v.md docs/progress-sb3_pages-h6v.md

Then C2, once its gates are met (spec 14.2): Common Defense Fix D and iwh_ab_codefix-p8v finished, the end-to-end sandbox test passed, and plumbing's L3 reinstall.

Run tag: sb3_pages-h6v-s21-<4>, C2: retire sf_dataop and sf_datawrite (they refuse with a pointer to the run request tools)

Scope of this step:
- create: nothing
- update: supabase/functions/_shared/tools/switchboard.ts, supabase/functions/_shared/tools/switchboard.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs, docs/technical-spec-sb3_pages-h6v.md
- delete: nothing
- deploy: mcp (db:deploy, with main's commits present)
- SQL: switchboard_actions (one read-only check that no old data run action is open)
Estimated run: 20m

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
| s9 | Yield and report | 14:07:40 | 14:08:11 | 0m31s |
| s10 | Drift check and draft | 14:12:29 | 14:19:51 | 7m22s |
| s10 | Cold review and fixes | 14:19:51 | 14:28:33 | 8m42s |
| s10 | Claims, number and report | 14:28:33 | 14:29:30 | 0m57s |
| s10b | Write 250, delete _pending_, queue | 14:42:17 | 14:44:40 | 2m23s |
| s10b | Notes and report | 14:44:40 | 14:45:50 | 1m10s |
| s10c | Queue tests, notes and report | 14:50:00 | 14:50:40 | 0m40s |
| s10d | Diagnose, fix test, requeue, report | 14:56:55 | 14:57:40 | 0m45s |
| s11 | Build and tests | 15:10:55 | 15:15:16 | 4m21s |
| s11 | Cold review and fixes, then waiting overnight on the db:deploy approval | 15:15:16 | 09:16:17 (next day) | 18h01m (mostly the wait) |
| s11 | Deploy, smoke test, notes and report | 09:16:17 | 09:18:00 | 1m43s |
| s12 | Migration, test, route removal | 09:22:38 | 09:28:44 | 6m06s |
| s12 | Cold review and fixes | 09:28:44 | 09:35:15 | 6m31s |
| s12 | Claims, number and report | 09:35:15 | 09:36:30 | 1m15s |
| s12b | Claim, 251, test, reruns line, spec | 20:05:00 | 20:12:36 | 7m36s |
| s12b | Cold review, fixes, full suites | 20:12:36 | 20:17:59 | 5m23s |
| s12b | Queue and report | 20:17:59 | 20:19:30 | 1m31s |
| s12c | Claim, sample move; blocked by the plan guard | 20:20:25 | 20:23:10 | 2m45s |
| s12d | Correction function, tests, /approve line, spec | 20:23:48 | 20:25:53 | 2m05s |
| s12d | Cold review and fixes, queue | 20:25:53 | 20:29:23 | 3m30s |
| s12d | Report | 20:29:23 | 20:30:30 | 1m07s |
| s12e | Queue test, deploy, smoke test | 20:32:03 | 20:32:40 | 0m37s |
| s12e | Notes and report | 20:32:40 | 20:33:40 | 1m00s |
| s13 | Claim, read, stop | 20:37:56 | 20:40:10 | 2m14s |
| s13b | Shared runContract, tools, schema, tests, build | 20:40:41 | 20:45:28 | 4m47s |
| s13b | Cold review, fixes, spec | 20:45:28 | 20:51:18 | 5m50s |
| s13b | Deploy check (stopped: main moved), report | 20:51:18 | 20:52:30 | 1m12s |
| s13c | Sync check, tests, deploy, smoke test | 20:53:51 | 20:56:40 | 2m49s |
| s13c | Notes and report | 20:56:40 | 20:57:30 | 0m50s |
| s14 | Draft 252, test, spec | 21:03:12 | 21:07:28 | 4m16s |
| s14 | Cold review and fixes | 21:07:28 | 21:12:30 | 5m02s |
| s14 | Claims, number and report | 21:12:30 | 21:13:30 | 1m00s |
| s14b | Claim, write 252, test, spec | 21:14:55 | 21:17:52 | 2m57s |
| s14b | Cold review, queue, report | 21:17:52 | 21:20:30 | 2m38s |
| s14c | Queue test, notes, report | 21:21:59 | 21:23:00 | 1m01s |
| s15 | Read, statusFromEvidence (stopped: new files) | 21:25:16 | 21:28:40 | 3m24s |
| s15b | Data layer, routes, pages, tests, build | 21:29:20 | 21:34:37 | 5m17s |
| s15b | Cold review, fixes, suites, spec | 21:34:37 | 21:39:48 | 5m11s |
| s15b | Report | 21:39:48 | 21:41:30 | 1m42s |
| s16 | Migration, test, page fixes and tests | 05:21:13 | 05:25:37 | 4m24s |
| s16 | Cold review, count-mismatch fix, suites, build, spec, number | 05:25:37 | 05:30:36 | 4m59s |
| s16 | Report | 05:30:36 | 05:31:01 | 0m25s |
| s16b | 253 written, App.js boundary | 05:35:22 | 05:36:07 | 0m45s |
| s16b | Suites, build, spec, queue | 05:36:07 | 05:37:01 | 0m54s |
| s16b | Report | 05:37:01 | 05:37:15 | 0m14s |
| s16c | Queue test, spec, report | 05:40:22 | 05:41:00 | 0m38s |
| s17 | Main's status, migration, test, page, tests | 05:48:10 | 05:53:38 | 5m28s |
| s17 | Cold review, fixes, suites, build, spec, claim, number | 05:53:38 | 06:00:15 | 6m37s |
| s17 | Report | 06:00:15 | 06:00:49 | 0m34s |
| s17b | Claim, 254 with the correction refusal, test | 06:04:08 | 06:08:30 | 4m22s |
| s17b | Cold review, fixes, spec, queue, report | 06:08:30 | 06:11:44 | 3m14s |
| s17c | Queue test, spec, report | 06:14:16 | 06:14:50 | 0m34s |
| s18 | Read pages, tools, extension, skills | 06:23:19 | 06:24:47 | 1m28s |
| s18 | Plan (spec 14), progress, report | 06:24:47 | 06:26:20 | 1m33s |
| s19 | Claim, pin marks, move, look, tests | 06:29:51 | 06:34:31 | 4m40s |
| s19 | Cold review, fixes, suites, build, spec, report | 06:34:31 | 06:37:20 | 2m49s |
| s19b | Compare with HEAD, pin the bar, spec, suites, build, report | 06:47:43 | 06:48:59 | 1m16s |
| s19c | Bar fix, flipped tests, spec, suites, build, report | 07:40:46 | 07:44:00 | 3m14s |
| s20 | Marks, tests, spec, suites, build | 09:41:13 | 09:45:24 | 4m11s |
| s20 | Cold review, fixes, suites again, report | 09:45:24 | 09:47:44 | 2m20s |
