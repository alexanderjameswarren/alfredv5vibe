# Progress: dataops_alfred-d4x

Spec: [technical-spec-dataops_alfred-d4x.md](technical-spec-dataops_alfred-d4x.md). The overall flow is in `C:\Users\Alex\projects\switchboard\docs\technical-spec-switchboard_dataops-d4x.md`. Every step runs in the dataops_alfred-d4x worktree.

**A1 reaches main today (Nov 18) at s5, without waiting for A2 or A3.** A2 and A3 land before Fix C on Nov 19. Switchboard s8 needs A1 and A2.

Markers: ✱ a migration link, ⚙ a function deploy, ⛳ a checkpoint.

| Step | Part | What | Marks | Estimate | Status |
|---|---|---|---|---|---|
| s1 | | Plan (read only) | | 10m | done 2026-11-18 |
| s2 | | Confirm and claim; this spec and progress file | | 10m | done 2026-11-18 |
| s3 | A1 | Code and tests: runner, queue tool, sf_read objects, mcp registration; the `_pending_` migration and the test script, written but not queued | | 45m | blocked by the plan guard (switchboard_runs not in SQL); redone as s3b |
| s3b | A1 | s3 with switchboard_runs in SQL, plus the 4-hour limit (O10) | | 45m | done 2026-11-18; mcp/index.test.mjs needs 2 updates (s3c) |
| s3c | A1 | `supabase/functions/mcp/index.test.mjs`: the sf_read schema gains `objects`; the registered-tool count goes from 227 to 228, with the new tool named | | 5m | done 2026-11-18 |
| s4 | A1 | db check, gitsync (Alex), drift check, claim the db items, `claims.cmd number-migration` | | 10m | done 2026-11-18: no drift; all 7 db items claimed; migration **240** |
| s4b | A1 | Write `supabase/migrations/240_sf_dataop.sql` and delete the `_pending_` one; queue the migration | ✱ | 10m | done 2026-11-18: action 0d35e304, applied as run 2609b53a-4eb3-48c2-9c9e-28df756a0233 (CONFORMANT) |
| s4c | A1 | After 240 is applied: queue the test script (`--test`), deploy mcp and switchboard-runner, conformance, verify | ⚙ | 15m | done 2026-11-18: both deployed; /queue gives 401; CONFORMANT; test queued as action 9cebb5d4-25e0-4944-b690-953ad5cb201d, result pending |
| s5 | A1 | Checkpoint A1 to main, then `claims.cmd status` | ⛳ | 5m | done 2026-11-18: checkpoint 5113c35 (run 2a9dcb6e); test 9cebb5d4 passed 56 of 56; every db: claim released (confirmed at s6) |
| s6 | A2 | The approve page for sf_dataop | ⛳ | 30m | built 2026-11-18; 60 switchboard app tests pass; Alex's look waits on s6b |
| s6b | A2 | A dev-only fixture route so Alex can see the sf_dataop page with a sample payload, nothing queued | | 20m | done 2026-11-18: `/approve-fixture/sf_dataop` on the dev server only; 65 switchboard and 3,352 app tests pass; the build has no fixture code; Alex's A2 tests passed; A2 in main by checkpoint 4b67587 and live |
| s7 | A3 | Full A3 (O9): salesforce-workflow and cli-workflow | ⛳ | 45m | written 2026-11-18, both at Skill version 2026-11-18; checkpoint pending |
| s8 | | Full suites and Finish | | 10m | |

The total estimate is 3h10 (s3c and s4b added).

## s4: database items (claimed at s4, after gitsync, never before)

- `db:table:switchboard_actions`
- `db:table:switchboard_runs` (pickup writes its rows; no schema change)
- `db:table:switchboard_sf_read_log`
- `db:fn:switchboard_needs_click`
- `db:fn:switchboard_queue_helper`
- `db:fn:switchboard_pickup_helper`
- `db:deploy` (mcp and switchboard-runner)

## s5: the checkpoint path list

Alex runs gitpush in **Checkpoint** mode for this worktree, with these paths. The payload contract reaches main with A1.

- `supabase/migrations/240_sf_dataop.sql`
- `supabase/functions/switchboard-runner/core.ts`
- `supabase/functions/switchboard-runner/index.ts`
- `supabase/functions/switchboard-runner/core.test.mjs`
- `supabase/functions/_shared/tools/switchboard.ts`
- `supabase/functions/_shared/tools/switchboard.test.mjs`
- `supabase/functions/mcp/index.ts`
- `supabase/tests/dataops_alfred-d4x/`
- `docs/technical-spec-dataops_alfred-d4x.md`
- `docs/progress-dataops_alfred-d4x.md`

## s3b result

- `supabase/migrations/_pending_dataops_alfred-d4x_sf_dataop.sql`:
  - the kind;
  - the sf_dataop payload check, and `kind <> 'sf_dataop' or needs_click`;
  - the sf_read objects list (1 to 20, metadata only);
  - `switchboard_sf_read_log.objects`;
  - `switchboard_needs_click`, `switchboard_queue_helper`, and `switchboard_pickup_helper(uuid, text[] default null)`, each with explicit grants;
  - conformance at the end.

  Its regexes and jsonpath were checked read-only with get_sql_read on a good and a bad payload. Not applied.
- `supabase/tests/dataops_alfred-d4x/1_verify_sf_dataop.sql`: 56 checks, undone, one result row.
- Runner: `sf_dataop` is a helper kind; `p_kinds` is passed only for a helper naming all five; a picked sf_dataop gets 4 hours (O10); `/result` keeps the summary only; `/sf-result` logs `objects`. 87 tests pass (81 before).
- Tool: `queue_switchboard_sf_dataop` (tier 2), and `objects` on `queue_switchboard_sf_read`; both registered in mcp. 94 tests pass. tables.test passes.
- `mcp/index.test.mjs`: 2 tests now fail, both because of this change, and the file was not in scope (s3c).

## s3c scope

- create: nothing
- update: supabase/functions/mcp/index.test.mjs
- delete: nothing
- deploy: nothing
- SQL: none
- Estimated run: 5m

## s4 scope

- create: nothing (the numbered migration is s4b's, once its number is known)
- update: nothing
- delete: nothing
- deploy: nothing
- SQL: none. Check and claim db:table:switchboard_actions, db:table:switchboard_runs, db:table:switchboard_sf_read_log, db:fn:switchboard_needs_click, db:fn:switchboard_queue_helper, db:fn:switchboard_pickup_helper and db:deploy; then `claims.cmd number-migration`.
- Estimated run: 10m

## Later

- The 15-minute pickup expiry (O6) should eventually cover every action kind, because of Alfred bug e12efcee (https://alfredv5vibe.vercel.app/e12efcee), where an approved git link that never ran stayed live. For now it applies to `sf_dataop` only.

## Timing log

| Step | Estimate | Actual | Note |
|---|---|---|---|
| s1 | 10m | 4m | plan; every item free |
| s2 | 10m | 5m | 14 claimed; spec and progress written |
| s3 | 45m | 4m | blocked: switchboard_runs not in SQL |
| s3b | 45m | 9m | migration, test script, runner, tool, tests; index.test.mjs out of scope |
| s3c | 5m | 2m | index.test.mjs: 51 pass; all s3b suites pass |
| s4 | 10m | 2m | sync brought nothing (HEAD = main = origin/main e0b9d2a); 7 db claims; number 240 |
| s4b | 10m | 2m | 240 written (body identical to the _pending_ file), _pending_ deleted, queued |
| s4c | 15m | 2m | mcp and switchboard-runner deployed; 401 and CONFORMANT; test queued |
| s6 | 30m | 6m | sf_dataop page: orange banner, count, problem, facts, stamp, rows; 6 new tests |
| s6b | 20m | 4m | fixture, App.js dev route, runner and session props; 5 new tests; full app suite and build |
| s7 | 45m | 4m | both skills for the dataops flow; finish by link with no window step |
