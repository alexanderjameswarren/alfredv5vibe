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
| A6 | Code review page; `diff`; acks, notes, superseded | 2 | |
| A7 | Alex tests in desktop Chrome; fixes | 1 | |
| B1 | Migration, tests, queue, conformance, Checkpoint (waits on plumbing's helper kind) | 2 | |
| B2 | switchboard-run-pages function; deploy | 2 | |
| B3 | MCP tools; deploy | 2 | |
| B4 | Real source; live routes; end to end on a sandbox | 1 | |
| C | Switch-over (separate approval) | 2 | |

## Claimed (s2)

docs/technical-spec-sb3_pages-h6v.md, docs/progress-sb3_pages-h6v.md, src/switchboard/runs/, src/App.js, package.json,
package-lock.json, supabase/functions/switchboard-run-pages/, supabase/config.toml,
supabase/functions/_shared/tools/switchboard-runs.ts, supabase/functions/_shared/tools/switchboard-runs.test.mjs,
supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs,
supabase/migrations/_pending_sb3_pages-h6v_run_pages.sql, supabase/tests/sb3_pages-h6v/. No db: items (claimed at B1).

## Next step's scope

Run tag: sb3_pages-h6v-s7-<4>, A6 (the code review page on sample data: findings with acknowledge ticks and notes, inline diffs with jsdiff, Claude's notes, superseded state, the three buttons and their result lines)

Scope of this step:
- create: src/switchboard/runs/CodeReviewPage.jsx, src/switchboard/runs/CodeReviewPage.test.jsx, src/switchboard/runs/codeDiff.js, src/switchboard/runs/codeDiff.test.js
- update: docs/technical-spec-sb3_pages-h6v.md, package.json, package-lock.json, src/App.js, src/switchboard/runs/RunSimulation.jsx, src/switchboard/runs/runContract.js, src/switchboard/runs/runContract.test.js, src/switchboard/runs/simulation.js, src/switchboard/runs/simulation.test.js, src/switchboard/runs/look.js
- delete: nothing
- deploy: nothing
- SQL: none
- npm install of `diff` at an exact version: approved by Alex as part of A6's prompt (it writes package.json and package-lock.json from the shell).
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
