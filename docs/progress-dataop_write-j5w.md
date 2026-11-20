# Progress: dataop_write-j5w

Spec: [technical-spec-dataop_write-j5w.md](technical-spec-dataop_write-j5w.md). The flow is Data run v2, in
`C:\Users\Alex\projects\switchboard\docs\technical-spec-dataop_v2-m5j.md` ("A2"). Every step runs in the
dataop_write-j5w worktree.

**A2 must land before dataop_v2-m5j's s9** (the production runner). v1 `sf_dataop` is untouched.

Markers: ✱ a migration link, ⚙ a function deploy, ⛳ a checkpoint.

| Step | What | Marks | Estimate | Status |
|---|---|---|---|---|
| s1 | Plan (read only) | | 12m | done 2026-11-19 |
| s2 | Confirm and claim; this spec and progress file | | 20m | done 2026-11-19: 17 files and folders claimed |
| s3 | The `_pending_` migration (kind, payload function with the three writes, uploads, Id cap, waits; result check; needs_click, queue_helper, pickup_helper) and the `--test` script, written but not queued | | 50m | done 2026-11-19: spec updated with the Switchboard thread's six answers; migration and test script written, not numbered, queued or run (no database here, so the SQL is unchecked until s7). A second new function, `switchboard_datawrite_payload_problem`, gives the sentences; `_ok` wraps it |
| s4 | Queue tool `queue_switchboard_sf_datawrite`, its registration, and their tests | | 45m | done 2026-11-19: `sfDatawriteProblem` mirrors the SQL rule for rule with the same sentences; switchboard.test.mjs 112 of 112, mcp/index.test.mjs 53 of 53, mcp/tables.test.mjs 1 of 1; 230 tools registered; not deployed (s7) |
| s5 | Runner: seven kinds, the six kept, 4-hour limit, `/result` for `datawrite`; tests | | 30m | done 2026-11-19: spec has the fixed file titles (`dataop-exclude:<Class>`, `dataop-undo:<Class>`, failure file by job Id); core.test.mjs 105 of 105; the reply carries `line: "datawrite <id> done|failed"` for the helper; not deployed (s7) |
| s6 | Approve page (both banners, the three writes, uploads, Id line) and dev fixture; tests | | 40m | done 2026-11-19: the result line is now `done: PASS` / `done: FAIL` / `failed` (core.test.mjs 106 of 106); ApprovePage and ApproveFixture tests 91 of 91; fixture at /approve-fixture/sf_datawrite?sample=batch, bulk, undo; Alex looked (s6b's three fixes); the bulk exclusion title question is settled: a bulk write uploads nothing |
| s6b | Alex's look at the fixtures: a bulk write uploads nothing (SQL, tool, page, spec), exclude.csv once, "before the write" on a sandbox | | 25m | done 2026-11-19: switchboard.test.mjs 112 of 112; ApprovePage and ApproveFixture tests 93 of 93; the SQL test script has the new cases, not run (s7) |
| s7 | Database steps: check, gitsync (Alex), drift check, claim, number, queue the migration; after it's applied, deploy mcp and switchboard-runner, conformance, the `--test` script | ✱ ⚙ | 30m | |
| s7 (done) | Database steps 1 to 5: check, drift check, claim, number | | 5m | done 2026-11-20: all 8 db items free, then claimed; no drift (HEAD = main = origin/main = 34a6a3e, the commit this worktree began at; 242 to 244 were already read at s1); number **245**, `supabase/migrations/245_sf_datawrite.sql` (db:migration:245 and the file claimed); not written yet |
| s7b | Write 245 from the `_pending_` file, delete the `_pending_` one, queue 245 | ✱ | 5m | blocked 2026-11-20: 245 written (differs from the `_pending_` file only in header lines 1 and 4); the plan guard refused the delete, reading Remove-Item as an undeclared update of a file declared under delete; nothing queued; redo as s7c |
| s7c | The `_pending_` delete and the queueing, under a scope the guard accepts | ✱ | 5m | done 2026-11-20: `_pending_` file deleted (the guard allowed it with the file under update and delete); 245 is the only file defining `switchboard_datawrite_payload_problem`; 245 queued, action f8c9cd40-462c-4cc5-b48e-7c46a4b8b2e8 (describe shortened to fit the 300-character limit); not applied until a run id shows it |
| s7d | After 245 is applied: deploy mcp and switchboard-runner holding db:deploy, conformance, the `--test` script | ⚙ | 10m | done 2026-11-20: 245 ran (run 80a35541, CONFORMANT); function tests 272 of 272; mcp and switchboard-runner deployed ("Deployed Functions."); test script queued --test, action 2ed3e09c-0db9-4fce-8d23-3b1af692c95f, result not seen yet; db claims still held for the Checkpoint |
| s8 | Checkpoint the migration, test script and functions (Alex); `claims.cmd status`; the two skills | ⛳ | 20m | |
| s9 | Full suites, spec marked live; Finish is Alex's | | 10m | |

The total estimate is 4h17 (s1 to s9; s3 to s9 are 3h45).

## Files (claimed at s2)

- docs/technical-spec-dataop_write-j5w.md, docs/progress-dataop_write-j5w.md
- supabase/migrations/_pending_dataop_write-j5w_sf_datawrite.sql, supabase/tests/dataop_write-j5w/
- supabase/functions/_shared/tools/switchboard.ts and switchboard.test.mjs
- supabase/functions/mcp/index.ts and index.test.mjs
- supabase/functions/switchboard-runner/core.ts, core.test.mjs and index.ts
- src/switchboard/ApprovePage.jsx, ApprovePage.test.jsx, ApproveFixture.jsx, ApproveFixture.test.jsx
- .claude/skills/cli-workflow/SKILL.md, .claude/skills/salesforce-workflow/SKILL.md

## s7: database items (claimed at s7, after gitsync, never before)

- `db:table:switchboard_actions`, `db:table:switchboard_runs`
- `db:fn:switchboard_datawrite_payload_problem` (new, added at s3), `db:fn:switchboard_datawrite_payload_ok` (new),
  `db:fn:switchboard_needs_click`, `db:fn:switchboard_queue_helper`, `db:fn:switchboard_pickup_helper`
- `db:deploy` (mcp, switchboard-runner)

## Where the tool and the SQL could still disagree (s4)

`sfDatawriteProblem` (switchboard.ts) and `switchboard_datawrite_payload_problem` (the migration) are two copies of one
rule set, kept together by the same payload list in switchboard.test.mjs and the `--test` script. Known gaps:
- **Extra-key order** in "does not take a, b": SQL sorts by the database's collation, JS by code unit. Only the order
  of a list of two or more odd keys can differ; both refuse.
- **Payload length:** Postgres counts characters, `jsonbTextLength` UTF-16 units, so a character outside the BMP (an
  emoji) counts 2 in the tool and 1 in the database. Near the cap the tool can refuse what the database would take.
- **repo:** the database's `[:cntrl:]` may cover more control characters than the tool's `\x00-\x1f\x7f`
  (locale-dependent). The database then refuses, and the queue helper still gives its sentence.
- **Numbers:** jsonb tells `45` from `45.0`; JavaScript can't. The tool always sends `45`, so it can't arise from it.
- **zod enums** (org_type, write.kind, uploads.purpose, queries.step) refuse a wrong value at the MCP layer with
  zod's own message, before the handler's sentence. Extra keys pass through (`.passthrough()`) to the handler.

## Next step's scope (s8)

After the `--test` run (action 2ed3e09c) passes and Alex has run gitpush Checkpoint for this worktree with
supabase/migrations/245_sf_datawrite.sql, supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql,
supabase/functions/_shared/tools/switchboard.ts, switchboard.test.mjs, supabase/functions/mcp/index.ts,
index.test.mjs, supabase/functions/switchboard-runner/core.ts, core.test.mjs and index.ts.

```
Scope of this step:
- create: nothing
- update: .claude/skills/cli-workflow/SKILL.md, .claude/skills/salesforce-workflow/SKILL.md
- delete: nothing
- deploy: nothing
- SQL: nothing
Estimated run: 20m
```

## Timing log

| Step | Phase | Time |
|---|---|---|
| s1 | Read, claims check, report | 4m18s |
| s2 | Claim (13:51:47–13:51:57) | 0m10s |
| s2 | Spec and progress file (13:51:57–13:54:11) | 2m14s |
| s2 | Report (13:54:11–13:54:51) | 0m40s |
| s2 | Total | 3m04s |
| s3 | Read, spec answers, migration, test script (14:01:52–14:10:55) | 9m03s |
| s3 | Progress file and scope (14:10:55–14:11:14) | 0m19s |
| s3 | Report (from 14:11:26) | end not measured |
| s4 | Read, tool, registration, tests, test runs (14:13:58–14:18:29) | 4m31s |
| s4 | Progress file and scope (14:18:29–14:18:43) | 0m14s |
| s5 | Spec titles, runner, tests, test runs (14:19:55–14:22:41) | 2m46s |
| s5 | Progress file and scope (14:22:41–14:22:52) | 0m11s |
| s6 | Result line, spec, page, fixture, tests, test runs (15:21:24–15:26:25) | 5m01s |
| s6 | Progress file and scope (15:26:25–15:26:37) | 0m12s |
| s6b | SQL, tool, tests, page, spec, test runs (15:35:16–15:37:57) | 2m41s |
| s6b | Progress file and scope (15:37:57–15:37:59) | 0m02s |
| s7 | Check, drift check, claim, number (2026-11-19 15:41:34 – 2026-11-20 05:08:19) | 13h 26m 45s, nearly all of it the claim waiting on the db:deploy permission prompt; the db claims were taken at about 05:08 |
| s7 | Progress file and scope (05:08:19–05:08:20) | 0m01s |
| s7b | Write 245, compare, the blocked delete (05:11:11–05:13:32) | 2m21s |
| s7c | Delete, check, queue, progress file (06:44:40–06:45:06) | 0m26s |
| s7d | Function tests (06:47:22–06:47:22) | 0m00s |
| s7d | Deploy mcp (06:47:37–06:47:53) | 0m16s |
| s7d | Deploy switchboard-runner (06:47:58–06:48:04) | 0m06s |
| s7d | Queue the test script, progress file (06:48:04–06:48:26) | 0m22s |
