-- Purpose: Overwatch Step 8. Seed platform_schedules for the three Claude scheduled tasks that had no row, so a run that
-- silently stops is noticed: dj/daily_history_sync, drive_mix/daily_refresh and dj/weekly_review. Each task's prompt
-- writes platform_runs under the same app and job.
-- Kind: one-off data seed (three rows; no schema change)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 10, Phase 1. Pattern from 091: user_id from the Money context row,
-- so no id is hard-coded; expected_by is read in America/Los_Angeles. Run as one block in the SQL editor.
-- Safe to re-run: (user_id, app, job) is unique, and a re-run updates the definition rather than duplicating it.
-- supabase/migrations/168_overwatch_seed_schedules.sql

begin;

insert into public.platform_schedules
  (user_id, app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled, notes)
select c.user_id, s.app, s.job, 'claude', s.cadence, s.day_of_week, s.expected_by::time, 6, true, s.notes
from public.contexts c
cross join (values
  ('dj', 'daily_history_sync', 'daily', null::smallint, '04:30',
   'Claude scheduled task "DJ daily history sync", daily at 4:30 am Pacific, before the Drive Mix refresh. Prompt: '
   || 'docs/history/dj-daily-task-prompt.md. Opens a running platform_runs row first and closes it at the end, so a '
   || 'day with no row means the task never fired.'),
  ('drive_mix', 'daily_refresh', 'daily', null::smallint, '04:54',
   'Claude scheduled task "Drive Mix daily refresh", daily at 4:54 am Pacific: sweep, pick, replace the playlist, record '
   || 'the serving. Prompt lives only in the claude.ai task. Opens and closes a platform_runs row (Overwatch Step 8).'),
  ('dj', 'weekly_review', 'weekly', 5::smallint, '06:00',
   'Claude scheduled task "Weekly DJ review", Fridays at 13:00 UTC (6 am Pacific in summer, 5 am in winter). Prompt: '
   || 'docs/history/dj-weekly-review-prompt.md. Writes one inbox item and a platform_runs row (Overwatch Step 8).')
) as s(app, job, cadence, day_of_week, expected_by, notes)
where c.id = 'muvitejhrgt3rgi8t6q'
on conflict (user_id, app, job) do update
  set executor    = excluded.executor,
      cadence     = excluded.cadence,
      day_of_week = excluded.day_of_week,
      expected_by = excluded.expected_by,
      grace_hours = excluded.grace_hours,
      enabled     = excluded.enabled,
      notes       = excluded.notes;

commit;

-- Result: every schedule row, so the three new ones can be read next to the existing ones, and conformance.
select json_build_object(
  'schedules', (select coalesce(json_agg(t), '[]'::json) from (
      select app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled
        from public.platform_schedules order by app, job
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
