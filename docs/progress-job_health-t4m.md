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
| 4 | s4 | **Part B, wb-sync.** Settle open item O1 first. 60 s `AbortSignal.timeout` on the SimpleFIN fetch → `RunFailure` kind `timeout`; constant and tests; deploy wb-sync; Checkpoint | supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs | `db:deploy` | 15m | todo |
| 5 | s5 | **Part B/E, schedules.** Migration: the six new `platform_schedules` columns with checks, the values per schedule (spec §4), the `alfred/job_health_check` row; test script; queue; Checkpoint | supabase/migrations/_pending_job_health-t4m_schedule_limits.sql, supabase/tests/job_health-t4m/ | `db:table:platform_schedules` | 20m | todo |
| 6 | s6 | **Parts B, C, E, watchdog.** Migration: `job_health_state` (register_table), `job_health_missed_runs`, `job_health_watchdog` (sweep, heartbeat, recovery, direct inbox and reminders, F wording), `get_job_health` RPC, pg_cron `job-health-every-15-min` (open item O3); test script; queue; conformance | supabase/migrations/_pending_job_health-t4m_watchdog.sql, supabase/tests/job_health-t4m/ | `db:table:job_health_state`, `db:table:inbox`, `db:table:reminders`, `db:table:signals`, `db:table:platform_runs`, `db:fn:job_health_watchdog`, `db:fn:job_health_missed_runs`, `db:fn:get_job_health` | 30m | todo |
| 7 | s7 | **Verify live.** The cron is ticking; `job_health_state` is updating; f847a5cd is marked failed (no signal, older than 24 h); test scripts for the outage and recovery paths; Checkpoint s5 and s6 | supabase/tests/job_health-t4m/ | none | 12m | todo |
| 8 | s8 | **Part D, tool.** Claim mcp/index.ts and index.test.mjs (wait for warren_buffet_p4-r6d); `get_job_health` tool and its test; registration; tables test; mcp deploy; conformance; Checkpoint | supabase/functions/_shared/tools/job-health.ts, supabase/functions/_shared/tools/job-health.test.mjs, supabase/functions/mcp/index.ts, supabase/functions/mcp/index.test.mjs | `db:deploy` | 15m | todo; blocked until r6d releases the mcp files |
| 9 | s9 | **Part D, task.** Settle open item O2 first. The health-check prompt (task-prompts skeleton, spec §8.2, §9.4); the task-prompts exception (spec §10); hand it over so Alex creates the task | docs/claude-health-check-task-prompt.md, .claude/skills/task-prompts/SKILL.md | none | 15m | todo |
| 10 | s10 | **Parts E and F, skills.** The overwatch "review missed jobs since <time>" flow; the alert-wording rule in both skills; the Step 8b judgment line; version bumps | .claude/skills/overwatch/SKILL.md, .claude/skills/task-prompts/SKILL.md | none | 12m | todo |
| 11 | s11 | Closeout: estimate against actual, gitpush Finish request. Alex turns off Claude's notification on every task except the health check (by hand) | docs/progress-job_health-t4m.md | none | 6m | todo |

Build estimate, s3 to s11: 133m across 9 steps, plus about 22m spent on s1 and s2.

## Open items

- **O1 (before s4).** Confirm the wb-sync cause from the Edge Function logs around 13:00 UTC Nov 16. If it was the wall-clock limit, s4 also has to bring the sync's run time down.
- **O2 (answered s3, test at s9).** The scheduled-task tool documents that a task's push fires "when a run finishes with something noteworthy", as the server judges it, not on every run. So healthy one-line runs should stay quiet. s9 tests it with one healthy run and one forced alert. The spec's §8.2 and §11 still carry the old question; update them at s9, when the spec is in scope.
- **O3 (at s6).** If the runner refuses `cron.schedule`, that statement goes to the SQL editor. It holds no secret.
- **O4 (agreed s3).** A stuck dispatcher run gets a direct inbox item and push (spec §5.1).

## Next step's scope (s4, wb-sync timeout; O1 is still open)

- create: nothing
- update: supabase/functions/wb-sync/index.ts, supabase/functions/_shared/wb-sync-core.ts, supabase/functions/_shared/wb-sync-core.test.mjs
- delete: nothing
- deploy: wb-sync (`db:deploy`, claimed at the step)
- SQL: none
- First: O1. Confirm the Nov 16 cause from the wb-sync Edge logs around 13:00 UTC. If it was the wall clock, s4 widens to cutting the run time.
