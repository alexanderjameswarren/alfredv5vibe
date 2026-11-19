# Progress — health_alerts-v7p (Job health: alerts only)

Spec: `docs/history/technical-spec-job_health-t4m.md` (the "Superseded by health_alerts-v7p" notes in 8.2, 9.4, 10).
Prompt: `docs/claude-health-check-task-prompt.md`, PROMPT VERSION 2026-11-19a.

**Why:** the Job health check task's push notification fired on every finished run, healthy ones included.
Alex wants a notification only when something is wrong.

## Steps

| # | step | what | status |
|---|---|---|---|
| s1 | plan (read-only) | files, Case A/B checks, draft prompt | [x] done (s1-q8zd) |
| s2 | claim | 7 files | [x] done (s2-m3rk) |
| s3 | docs and skills | prompt 2026-11-19a; task-prompts and overwatch skills 2026-11-19a; spec notes; this file | [x] done (s3-w5jn) |
| s4 | database | drift check (none: HEAD = main = origin/main 332b956); claimed db:table:platform_schedules; wrote the _pending_ migration and the test; numbered **241** (db:migration:241 claimed) | [x] done (s4-c2hy) |
| s4b | number and queue | wrote 241_health_check_failure_subject.sql (identical to the _pending_ file apart from its path line); deleted the _pending_ file and the retired supabase/tests/job_health-t4m/3_health_check_schedule_test.sql; queued 241 `--expect 1`, action c1055f78-00ca-4b31-a37f-de72d60becd9. **241 applied:** run 0356586b-ab9e-47ff-986a-96da17ac6568, 1 row updated, CONFORMANT | [x] done (s4b-t9fe) |
| s5 | verify and Checkpoint | test queued `--test`, action 61a41fd6-a01c-448c-acfd-bcf2d16e5751 (Alex runs it); then gitpush Checkpoint of 241, the new test and the retired old test | [ ] in progress (s5-k4vb) |
| s6 | hand-over and Finish | Alex pastes 2026-11-19a into the task, turns its push OFF, Run now; check the run; gitpush Finish | [ ] |

## Decisions (Alex, s2)

1. **Q1, the version:** build 2026-11-19a from the live 17b text (read with the trigger API at s3). 17b only steered the push, which is now off, so none of it carries over.
2. **Q2, the Supabase-down gap:** accepted. Alex subscribes to status.supabase.com email alerts (Alfred is in us-west-2). The spec and the overwatch skill document it as a third path.
3. **Q3, the spec:** edit `docs/history/technical-spec-job_health-t4m.md` in place, with Superseded notes and the path fixes. The old path stays in code comments and applied migrations.
4. **Q4, the schedule row:** yes. See s4.

## s4 plan

- **File:** `supabase/migrations/_pending_health_alerts-v7p_health_check_failure_subject.sql`, numbered at s4 with `claims.cmd number-migration`.
- **The change:** one update of `platform_schedules` where `app = 'alfred' and job = 'job_health_check'`, expect 1 row:
  - `failure_subject = 'alfred:job_health_check:failure:{kind}'`;
  - `failure_severity = 'high'`;
  - `notes` rewritten: the Claude scheduled task "Job health check", every 2 hours 6 AM to 8 PM Pacific at :07, prompt `docs/claude-health-check-task-prompt.md` (PROMPT VERSION 2026-11-19a); push off; it raises one high failure signal only when the watchdog is down; no catch_up.
- **Test:** `supabase/tests/health_alerts-v7p/1_schedule_row_test.sql` (`--test`). It checks:
  - the row's values;
  - that the subject passes the signals format with `{kind}` set to `stuck`;
  - that the notes name 19a.
- **Database item:** `db:table:platform_schedules`, claimed at s4 after a gitsync and the drift check.

## Next step's scope

Run tag: health_alerts-v7p-s5b-<new> (after Alex runs test action 61a41fd6)
- create: nothing
- update: docs/progress-health_alerts-v7p.md
- delete: nothing
- deploy: nothing
- SQL: none (read the test's result; check the row with get_platform_schedules)
- then: ask Alex for gitpush Checkpoint of supabase/migrations/241_health_check_failure_subject.sql, supabase/tests/health_alerts-v7p/1_schedule_row_test.sql and the deleted supabase/tests/job_health-t4m/3_health_check_schedule_test.sql; after it, claims.cmd status to confirm the db: claims went

Estimated run: 5m
