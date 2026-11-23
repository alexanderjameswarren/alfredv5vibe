# Progress: Switchboard 3 run and code review pages (sb3_pages-h6v)

Spec: docs/technical-spec-sb3_pages-h6v.md. Plan agreed at s1 (sb3_pages-h6v-s1-m2p7): 18 CLI steps (Phase A 11,
Phase B 7), the switch-over (C, 2) later and approved separately. At double the estimate, stop and ask.

## Steps

| Step | What | Est. | State |
|---|---|---|---|
| s1 | Read-only plan | - | done |
| A1 (s2) | Claim; spec; progress; look.js; runContract.js and its test | 1 | done (33 tests) |
| A2 (s3) | RunPage parts 1-16; pre-check and data operation update pages; simulation.js; /run-sim route | 2 | done in one step (64 tests); awaiting Alex's screen tests |
| A3 | desktopCheck and its states | 1 | |
| A4 | Insert, upsert, delete, undelete, multi-object pages; undo page | 2 | |
| A5 | Correction page; not started and Try again; checks expired; check what happened | 2 | |
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

Run tag: sb3_pages-h6v-s4-<4>, A3 (the desktop check and its states)

Scope of this step:
- create: src/switchboard/runs/desktopCheck.js, src/switchboard/runs/desktopCheck.test.js
- update: src/switchboard/runs/RunPage.jsx, src/switchboard/runs/RunPage.test.jsx, src/switchboard/runs/simulation.js, src/switchboard/runs/simulation.test.js, src/switchboard/runs/RunSimulation.jsx, src/switchboard/runs/look.js
- delete: nothing
- deploy: nothing
- SQL: none
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
