-- Overwatch Step 27 check, after 177. Read-only. Paste back the single result cell.
-- Expected: the four rows at 03:30, 03:54, 04:20 and Monday (1) 04:35, all enabled, grace 6; the plan has every
-- setting the two prompts read (missing_settings empty), push_time 05:00 and weekly_day monday; CONFORMANT.
-- supabase/tests/overwatch-q4n/21_verify_schedules.sql

select json_build_object(
  'morning_schedules', (select coalesce(json_agg(t), '[]'::json) from (
      select app, job, cadence, day_of_week, expected_by, grace_hours, enabled
        from public.platform_schedules
       where (app, job) in (('dj', 'daily_history_sync'), ('drive_mix', 'daily_refresh'),
                            ('overwatch', 'nightly'), ('overwatch', 'weekly'))
       order by expected_by) t),
  'active_plan', (select coalesce(json_agg(t), '[]'::json) from (
      select id, settings ->> 'push_time' as push_time, settings ->> 'weekly_day' as weekly_day
        from public.overwatch_plans where active) t),
  'missing_settings', (select coalesce(json_agg(k order by k), '[]'::json) from unnest(array[
      'stall_days', 'waiting_on_alex_days', 'fading_days', 'overrun_factor', 'active_project_limit',
      'inbox_backlog_threshold', 'routing_low_confidence', 'overdue_days', 'pushes_per_day', 'push_time',
      'weekly_day', 'audit_every_weeks', 'friction_trigger_count', 'friction_window_days',
      'estimate_accuracy_min_shipped', 'estimate_correction_factor']) as k
      where not exists (select 1 from public.overwatch_plans p where p.active and p.settings ? k)),
  'conformance', (select public.platform_check_conformance())
) as result;
