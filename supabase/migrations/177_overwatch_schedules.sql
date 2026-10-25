-- Purpose: Overwatch Phase 5. Seed platform_schedules for Overwatch's two Claude scheduled tasks, so a run that
-- silently stops is noticed: overwatch/nightly (daily, 4:20 am Pacific) and overwatch/weekly (Mondays, 4:35 am
-- Pacific). Each task's prompt opens and closes a platform_runs row under the same app and job. Also moves the two
-- rows 168 seeded to the new morning times (Alex moved both tasks on 2026-10-25, so everything lands before 5 am):
-- dj/daily_history_sync 04:30 to 03:30, drive_mix/daily_refresh 04:54 to 03:54.
-- Kind: one-off data seed (two new rows, two rows updated; no schema change)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 6. Pattern from 168: user_id from the Money context row, so no
-- id is hard-coded; expected_by is read in America/Los_Angeles; day_of_week 1 is Monday (0 is Sunday). The weekly
-- row's day must match the plan's weekly_day and the claude.ai task's day. Run as one block in the SQL editor.
-- Safe to re-run: (user_id, app, job) is unique, so the insert updates rather than duplicates, and the two updates
-- set fixed values.
-- supabase/migrations/177_overwatch_schedules.sql

begin;

-- ============================================================================
-- 1. Overwatch's two schedules
-- ============================================================================
insert into public.platform_schedules
  (user_id, app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled, notes)
select c.user_id, s.app, s.job, 'claude', s.cadence, s.day_of_week, s.expected_by::time, 6, true, s.notes
from public.contexts c
cross join (values
  ('overwatch', 'nightly', 'daily', null::smallint, '04:20',
   'Claude scheduled task "Overwatch nightly", daily at 4:20 am Pacific, after the DJ sync (3:30) and the Drive Mix '
   || 'refresh (3:54), before push_time. Prompt: docs/overwatch-nightly-task-prompt.md. Opens a running platform_runs '
   || 'row first and closes it at the end.'),
  ('overwatch', 'weekly', 'weekly', 1::smallint, '04:35',
   'Claude scheduled task "Overwatch weekly", Mondays at 4:35 am Pacific, after the nightly run. Its day must match '
   || 'the plan''s weekly_day. Prompt: docs/overwatch-weekly-task-prompt.md. Opens and closes a platform_runs row.')
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

-- ============================================================================
-- 2. The DJ sync and the Drive Mix refresh moved an hour earlier
-- ============================================================================
update public.platform_schedules s
   set expected_by = '03:30'::time,
       notes = 'Claude scheduled task "DJ daily history sync", daily at 3:30 am Pacific (4:30 until 2026-10-25), '
               || 'before the Drive Mix refresh. Prompt: docs/history/dj-daily-task-prompt.md. Opens a running '
               || 'platform_runs row first and closes it at the end, so a day with no row means the task never fired.'
  from public.contexts c
 where c.id = 'muvitejhrgt3rgi8t6q' and s.user_id = c.user_id and s.app = 'dj' and s.job = 'daily_history_sync';

update public.platform_schedules s
   set expected_by = '03:54'::time,
       notes = 'Claude scheduled task "Drive Mix daily refresh", daily at 3:54 am Pacific (4:54 until 2026-10-25): '
               || 'sweep, pick, replace the playlist, record the serving. Prompt lives only in the claude.ai task. '
               || 'Opens and closes a platform_runs row (Overwatch Step 8).'
  from public.contexts c
 where c.id = 'muvitejhrgt3rgi8t6q' and s.user_id = c.user_id and s.app = 'drive_mix' and s.job = 'daily_refresh';

commit;

-- Result: every schedule row, so the changed ones can be read next to the rest, and conformance.
select json_build_object(
  'schedules', (select coalesce(json_agg(t), '[]'::json) from (
      select app, job, executor, cadence, day_of_week, expected_by, grace_hours, enabled
        from public.platform_schedules order by app, job
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
