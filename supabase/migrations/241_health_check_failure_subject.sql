-- health_alerts-v7p s4: the Job health check's schedule row for PROMPT VERSION 2026-11-19a.
-- Kind: data update (one platform_schedules row). Applied: NO (only a run id shows it ran).
-- Spec: docs/history/technical-spec-job_health-t4m.md 8.2 (Superseded by health_alerts-v7p). Progress:
-- docs/progress-health_alerts-v7p.md. Test: supabase/tests/health_alerts-v7p/1_schedule_row_test.sql.
-- Tables touched: platform_schedules (one row). No new table, view or function, so no grants and no register_table.
--
-- The task's push is now off, and the task raises its own high failure signal when the watchdog is down, so the
-- row gets a failure subject and severity. A stuck health-check run now gets the watchdog's stuck signal too
-- (subject alfred:job_health_check:failure:stuck), which 237's checks accept. Everything else stays as 239 set it.
-- supabase/migrations/241_health_check_failure_subject.sql

update public.platform_schedules s
set failure_subject  = 'alfred:job_health_check:failure:{kind}',
    failure_severity = 'high',
    notes = 'Claude scheduled task "Job health check" (trig_01ChrFRk3HUwXvDpYR9kdtpW), every 2 hours 6 AM to 8 PM '
         || 'Pacific at :07, prompt docs/claude-health-check-task-prompt.md (PROMPT VERSION 2026-11-19a). Push is off '
         || 'on the task. When the watchdog is down (Case B) it raises one high failure signal, '
         || 'alfred:job_health_check:failure:watchdog_down, which the hourly dispatcher pops. When Claude cannot '
         || 'reach Alfred (Case A) it can write nothing and relies on job_health_watchdog''s outage alert. '
         || 'No catch_up: a missed check is not made up.'
from public.contexts c
where c.id = 'muvitejhrgt3rgi8t6q'
  and s.user_id = c.user_id
  and s.app = 'alfred'
  and s.job = 'job_health_check';

-- Conformance (mcp-platform Rule 5): expect CONFORMANT.
select public.platform_check_conformance() as conformance;
