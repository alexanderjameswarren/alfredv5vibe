# Job health — Progress

Spec: `docs/technical-spec-job_health-t4m.md`
Code: `job_health-t4m` (this worktree).

## Steps

Each database step runs the CLAUDE.md sequence: check, gitsync, drift check, claim, number, queue, verify, Checkpoint. It may split into lettered sub-steps (s5b, s5c), which count with their step. `db:` items are claimed at their own step, never before.

| # | step | what | files | db items | estimate | status |
|---|---|---|---|---|---|---|
| 1 | s1 | Read-only plan | none | none | 12m | done (s1-q8vd) |
| 2 | s2 | Claim; spec and progress | docs/technical-spec-job_health-t4m.md, docs/progress-job_health-t4m.md | none | 10m | done (s2-m3zk) |
| 3 | s3 | **Part A.** Weekly Step 9: plan_change and direct_writes → `normal`; PROMPT VERSION 2026-11-16a; hand the text over; Checkpoint this one file | docs/overwatch-weekly-task-prompt.md | none | 8m | done (s3-w7hn): Step 9's plan_change and direct_writes are normal, with the "Severity decides whether Alex's phone buzzes" line; only the Step 10 failure signal stays high; PROMPT VERSION 2026-11-16a in all 5 places. Next: Alex pastes the text into the task, then a Checkpoint of this one file |
| 4 | s4 | **Part B, wb-sync.** Settle open item O1 first. 60 s `AbortSignal.timeout` on the SimpleFIN fetch → `RunFailure` kind `timeout`; constant and tests; deploy wb-sync; Checkpoint | supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs | `db:deploy` | 15m | stopped before the deploy (s4-c5rp). Built: the fetch timeout (`withTimeout`, `FETCH_TIMEOUT_MS` 60 000 as asked), the 120 s time budget (`TIME_BUDGET_MS`, kind `time_budget`), the stage log, and 8 tests; wb-sync-core.test.mjs 54 of 54; `deno check` clean. **Not deployed:** 60 s would fail nearly every run (O5); db:deploy not claimed. The weekly prompt text was pushed as its own clip (a4bb77f2, md5 98b9a0b3…) |
| — | s4b (counts with s4) | `FETCH_TIMEOUT_MS` 105 s (O5); 14-day window cap with `window_gap` recorded; delete deno.lock; deploy wb-sync | supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs, docs/technical-spec-job_health-t4m.md, supabase/functions/wb-sync/deno.lock (deleted) | `db:deploy` | 12m | done (s4b-n6tq): 58 of 58 tests; `deno check --no-lock` clean; deployed wb-sync v17 at 08:05; db:deploy released. Next: read the Nov 18 run's stage log; Checkpoint of the wb-sync files |
| — | s4c (counts with s4) | Per-bank parallel SimpleFIN calls (`account=` filters), merged into one body; partial run with `failed_institutions` and a `kind:partial` signal; tests; deploy | supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs, docs/technical-spec-job_health-t4m.md | `db:deploy` | 15m | done (s4c-h2vb): rate limit checked (24 a day expected; we make 4); 65 of 65 tests; `deno check --no-lock` clean; deployed wb-sync v18 at 08:16; db:deploy released. Next: read the Nov 18 run's per-bank fetch log; Checkpoint of the wb-sync files |
| — | s4d (counts with s4) | One real wb-sync run, triggered by Alex from the cron command | none | none | 5m | done (s4d-r8kx, then Alex at 11:15 Pacific): ok in 8.7 s; every bank 2.5–4.4 s; txn_new 16, processed 19; hidden City National accounts no error |
| 5 | s5 | **Part B/E, schedules.** Migration: the six new `platform_schedules` columns with checks and comments, the values on the 13 rows (spec §4; job_health_check row moves to s9); test script; number | supabase/migrations/_pending_job_health-t4m_schedule_limits.sql, supabase/tests/job_health-t4m/1_schedule_limits_test.sql | `db:table:platform_schedules` | 10m | done (s5-v3fd): drafted; drift check clean; numbered **237** (`db:migration:237` and `supabase/migrations/237_schedule_limits.sql` claimed); nothing queued |
| — | s5b, s5c (count with s5) | Write 237 from the pending file, delete the pending file; claim `db:table:platform_schedules`; queue the migration (expect 13) and the test (--test); conformance | supabase/migrations/237_schedule_limits.sql, supabase/migrations/_pending_job_health-t4m_schedule_limits.sql (delete) | `db:table:platform_schedules` | 8m | queued (s5b-p9gm wrote 237 and claimed the table; the plan guard refused an `rm` chained after a `diff` as an "undeclared update"; s5c-k4wj deleted it with a lone `rm`). Migration action 9454fb2f-5077-4e4b-a32d-6efafed77b51; test action 8cce6afb-7cd1-4d99-8fd0-54e16f2f5871. **Queued, not applied.** `db:table:platform_schedules` and `db:migration:237` held until the migration runs and the test passes; then Checkpoint 237 and the test |
| 6 | s6 | **Parts B, C, E, watchdog.** Migration: `job_health_state` (register_table), `job_health_missed_runs`, `job_health_watchdog` (sweep, heartbeat, recovery, direct inbox and reminders, F wording), `get_job_health` RPC, pg_cron `job-health-every-15-min` (open item O3); test script; queue; conformance | supabase/migrations/_pending_job_health-t4m_watchdog.sql, supabase/tests/job_health-t4m/ | `db:table:job_health_state`, `db:table:inbox`, `db:table:reminders`, `db:table:signals`, `db:table:platform_runs`, `db:fn:job_health_watchdog`, `db:fn:job_health_missed_runs`, `db:fn:get_job_health` | 30m | todo |
| 7 | s7 | **Verify live.** The cron is ticking; `job_health_state` is updating; f847a5cd is marked failed (no signal, older than 24 h); test scripts for the outage and recovery paths; Checkpoint s5 and s6 | supabase/tests/job_health-t4m/ | none | 12m | todo |
| 8 | s8 | **Part D, tool.** Claim mcp/index.ts and index.test.mjs (wait for warren_buffet_p4-r6d); `get_job_health` tool and its test; registration; tables test; mcp deploy; conformance; Checkpoint | supabase/functions/_shared/tools/job-health.ts, supabase/functions/_shared/tools/job-health.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs | `db:deploy` | 15m | todo; blocked until r6d releases the mcp files |
| 9 | s9 | **Part D, task.** Settle open item O2 first. The health-check prompt (task-prompts skeleton, spec §8.2, §9.4); the task-prompts exception (spec §10); hand it over so Alex creates the task | docs/claude-health-check-task-prompt.md, .claude/skills/task-prompts/SKILL.md | none | 15m | todo |
| 10 | s10 | **Parts E and F, skills.** The overwatch "review missed jobs since <time>" flow; the alert-wording rule in both skills; the Step 8b judgment line; version bumps | .claude/skills/overwatch/SKILL.md, .claude/skills/task-prompts/SKILL.md | none | 12m | todo |
| 11 | s11 | Closeout: estimate against actual, gitpush Finish request. Alex turns off Claude's notification on every task except the health check (by hand) | docs/progress-job_health-t4m.md | none | 6m | todo |

Build estimate, s3 to s11: 133m across 9 steps, plus about 22m spent on s1 and s2.

## Open items

- **O1 (answered s4).** The worker hung after the context stage and was killed at 150 s, before close or catch ran (spec §11).
- **O5 (answered s4b).** 105 s, deployed with the 14-day window cap. Filling a recorded `window_gap` is a later item (spec §5.2).
- **O6 (open, from s4c).** New accounts at a bank are not discovered by the per-bank calls; decide after a week of fetch logs (spec §11).
- **O2 (answered s3, test at s9).** A task's push fires only "when a run finishes with something noteworthy". s9 tests it. Spec §11 now says so. §8.2 is updated at s9.
- **O3 (at s6).** If the runner refuses `cron.schedule`, that statement goes to the SQL editor. It holds no secret.
- **O4 (agreed s3).** A stuck dispatcher run gets a direct inbox item and push (spec §5.1).

## Next step's scope (s6, the watchdog)

- create: supabase/migrations/_pending_job_health-t4m_watchdog.sql, supabase/tests/job_health-t4m/2_watchdog_test.sql
- update: docs/technical-spec-job_health-t4m.md
- delete: nothing
- deploy: nothing
- SQL: none until the draft is approved. The migration covers `job_health_state` (register_table), `job_health_missed_runs`, `job_health_watchdog` (sweep, heartbeat, missed runs, recovery, direct inbox and reminders, Part F wording), `get_job_health`, and the pg_cron job `job-health-every-15-min`. Its db items (`db:table:job_health_state`, `db:table:inbox`, `db:table:reminders`, `db:table:signals`, `db:table:platform_runs`, `db:fn:job_health_watchdog`, `db:fn:job_health_missed_runs`, `db:fn:get_job_health`) are claimed at the queueing step, after 237 has run, gitsync and the drift check

