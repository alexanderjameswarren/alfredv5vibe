-- Job health job_health-t4m s9/s9b: the Job health check's schedule row, and claude_reader's read access (O7).
-- Kind: data insert (one platform_schedules row) plus read grants. Applied: NO (queued at s9b; only a run id shows it ran).
-- Spec: docs/technical-spec-job_health-t4m.md 8.2, 11 (O7). Test: supabase/tests/job_health-t4m/3_health_check_schedule_test.sql.
-- Tables touched: platform_schedules (one row; claude_reader's column grants), job_health_state (claude_reader's grants).
--
-- 1. alfred/job_health_check: the Claude scheduled task "Job health check", every 2 hours from 6 AM to 8 PM Pacific
--    (docs/claude-health-check-task-prompt.md). Due by 06:00 with 2 hours' grace. max_run_minutes 10, so a stuck run is
--    swept. catch_up null: a missed check is not made up, and it is not checked for missed runs. failure_subject and
--    failure_severity null: it raises no signals; its final message is the alert.
-- 2. O7: claude_reader (get_sql_read) reads by column grant, given by platform.apply_reader_access when a table is
--    registered (migration 192). A column added later stays unreadable until the helper runs for its table again, so
--    237's six platform_schedules columns were refused. Running the helper again covers them; it grants exactly what
--    platform_read_settings lists, nothing wider. job_health_state was covered by register_table in 238 (its first
--    s8 read only looked empty because the watchdog had not ticked yet); it is run again here so the test can rely on it.
-- supabase/migrations/239_health_check_schedule.sql

-- ── 1. The schedule row ──────────────────────────────────────────────────────
insert into public.platform_schedules
  (user_id, app, job, executor, cadence, expected_by, grace_hours, enabled,
   max_run_minutes, catch_up, failure_subject, failure_severity, started_by, notes)
select c.user_id, 'alfred', 'job_health_check', 'claude', 'daily', time '06:00', 2, true,
       10, null, null, null, 'task:job-health-check',
       'Claude scheduled task "Job health check", every 2 hours 6 AM to 8 PM Pacific, prompt '
         || 'docs/claude-health-check-task-prompt.md (PROMPT VERSION 2026-11-17a). It alerts only when Claude cannot '
         || 'reach Alfred or the watchdog is down, through its own Claude notification; it raises no signals. '
         || 'No catch_up: a missed check is not made up.'
from public.contexts c
where c.id = 'muvitejhrgt3rgi8t6q'
on conflict (user_id, app, job) do update
  set executor         = excluded.executor,
      cadence          = excluded.cadence,
      expected_by      = excluded.expected_by,
      grace_hours      = excluded.grace_hours,
      enabled          = excluded.enabled,
      max_run_minutes  = excluded.max_run_minutes,
      catch_up         = excluded.catch_up,
      failure_subject  = excluded.failure_subject,
      failure_severity = excluded.failure_severity,
      started_by       = excluded.started_by,
      notes            = excluded.notes;

-- ── 2. claude_reader's read access (O7). Each returns 'covered'. ─────────────
select platform.apply_reader_access('public.platform_schedules'::regclass) as platform_schedules_reader;
select platform.apply_reader_access('public.job_health_state'::regclass) as job_health_state_reader;

-- ── 3. Conformance (mcp-platform Rule 5): expect CONFORMANT ──────────────────
select public.platform_check_conformance() as conformance;
