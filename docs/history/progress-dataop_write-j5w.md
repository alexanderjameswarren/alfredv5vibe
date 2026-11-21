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
| s8 | Checkpoint the migration, test script and functions (Alex); `claims.cmd status`; the two skills | ⛳ | 20m | done 2026-11-20: Checkpoint done, no db: claims left, main in HEAD; cli-workflow (the three datawrite lines, the v2 production reply) and salesforce-workflow (hard rule 1, the v2 write link section) updated, both at version 2026-11-20. Open: the name of the sb command s9 provides for the link's arguments |
| s10 | Switchboard's changes: the Id rule (200 per query, no link cap) in a `_pending_` migration, its `--test` script and the tool; the page's failure-file title and Id line for any query; extras, the link command, undo and sandbox in the spec and skills | ✱ | 35m | done 2026-11-20: `_pending_dataop_write-j5w_ids_rule.sql` and `2_verify_ids_rule.sql` written, not numbered, queued or run; switchboard.test.mjs 112 of 112; ApprovePage and ApproveFixture 95 of 95. Found: mcp/index.ts's tool description still states the old rule, and 1_verify's three Id refusals and two Id sentences are now stale (both for s11) |
| s11 | Database step for the Id rule: check, gitsync (Alex), drift check, claim, number; the tool description and 1_verify brought up to the rule | ✱ | 15m | done 2026-11-20: mcp tool description and 1_verify on the new rule (1_verify's three single-Id cases now accepted, its Id sentences and queue_helper check reworded); cli-workflow's v2 line says sb rehearse is the usual sandbox path, version 2026-11-20b; mcp/index.test 53 of 53, tables 1 of 1, switchboard.test 112 of 112. No drift: main (06e8fb0) brought in only this thread's own checkpoint (bad172c), and the tree differs from main only by s10's files. db:table:switchboard_actions, db:fn:switchboard_datawrite_payload_problem and db:deploy claimed; number **246**, `supabase/migrations/246_ids_rule.sql` (db:migration:246 and the file claimed); not written yet |
| s11b | Write 246 from the `_pending_` file, delete the `_pending_` one, queue it | ✱ | 5m | done 2026-11-20: `246_ids_rule.sql` written (differs from the `_pending_` file only in header lines 1 and 6); `_pending_` deleted; 246 the only file with the new rule (245 keeps its original); queued, action 36135bf4-1a9c-4521-9eb9-883f5cd55e1e; not applied until a run id shows it |
| s11c | Amend 246 before it runs: drop the exclude-rows rule (SQL and tool), runner confirmed, tests, spec; queue again | ✱ | 15m | done 2026-11-20: 246 and switchboard.ts drop "the exclude upload has fewer rows than expected"; core.ts unchanged (excluded is checked only through the sum), new core.test case (2 left out, 4 added, excluded 2, PASS); switchboard.test 112 of 112, core.test 107 of 107; 1_verify and 2_verify accept exclude rows = expected + 1; spec defines write.excluded as manifest records the gate left out; 246 queued again, action 72972fd8-1dd3-41a5-8029-550364d21426. The s11b action 36135bf4 is superseded, left queued and not to be approved |
| s11d | After 246 (72972fd8) has run: deploy mcp holding db:deploy, conformance, queue both `--test` scripts | ⚙ | 10m | done 2026-11-20: 246 ran (run 39246c00, CONFORMANT); switchboard.test 112, mcp/index.test 53, tables.test 1, core.test 107, none failed; mcp deployed ("Deployed Functions."); switchboard-runner not redeployed (core.ts unchanged); queued --test: 2_verify 7aa9a8ce-4e36-48ab-a0ed-38ba168674bd, 1_verify 62186f06-5152-47ec-9164-9fa283eab2c7, results not seen yet; db claims held for the Checkpoint |
| s12 | Read only: both skills checked against main (37e0961) and put in full in the report for the update cards | | 5m | done 2026-11-20: identical to main; both blocks checked identical to disk; tree clean; noted that salesforce-workflow's v2 section still says "only after a sandbox PASS" |
| s9 | Full suites, spec marked live; Finish is Alex's | | 10m | done 2026-11-20: switchboard.test 112, mcp/index.test 53, mcp/tables.test 1, core.test 106, ApprovePage and ApproveFixture 93; all pass, none fail; uncommitted: the two skills and this file only; both skills' full text in the s9 report, checked identical to disk. Finish is Alex's |

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

## Next step's scope

None: Finish is next, and it is Alex's (gitpush Finish for dataop_write-j5w).

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
| s8 | Claims check, both skills, progress file (06:54:31–06:55:18) | 0m47s |
| s9 | Tests, git status, both skills into the report, comparison (06:56:40–07:03:12) | 6m32s |
| s10 | Claim, rule in tool and SQL, tests, page, fixture, spec, skills, progress file (07:11:41–07:19:26) | 7m45s |
| s11 | Drift check, tool description, 1_verify, skill, tests, check, claim, number, progress file (07:31:53–07:34:01) | 2m08s |
| s11b | Write 246, compare, delete, check, queue, progress file (07:36:27–07:37:49) | 1m22s |
| s11c | Rule dropped in SQL and tool, runner check, tests, SQL tests, spec, queue, progress file (07:39:19–07:41:09) | 1m50s |
| s11d | Tests, deploy mcp, queue two test scripts, progress file (07:46:24–07:46:52) | 0m28s |
| s12 | Git checks, both skills into the report, comparison, progress file (07:53:55–08:00:07) | 6m12s |
