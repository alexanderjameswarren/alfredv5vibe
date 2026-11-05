-- Purpose: notification routing step 10h. Give Arnold's hourly task one name in the notification log: started_by
-- becomes task:claude-hourly-notifications for
--   (a) the rows it logged with no started_by on its old prompt, after step 3's backfill (2 on 2026-11-05: Nov 4,
--       c7ba30d5-363e-40e7-9e76-3a79f73a6ffb and 871c8e24-3d75-40be-9af1-2c9d79091f16), and
--   (b) the rows step 3's backfill spelled task:claude_hourly_notifications from the job name (13 on 2026-11-05).
-- Nothing else changes. task:arnold_morning_review (2 rows) is left as it is.
-- Kind: one-off data repair (one update, 15 rows expected)
-- Applied: NO
--
-- The guard trigger refuses any change to started_by, so it is off for this one update only, as in 200_signals.sql.
-- Then re-run supabase/tests/notification_routing-d7v/1_verify_signals.sql with --test.
-- supabase/migrations/210_backfill_claude_notifications_started_by.sql

begin;

alter table public.claude_notifications disable trigger claude_notifications_guard_update;

update public.claude_notifications
   set started_by = 'task:claude-hourly-notifications'
 where (started_by is null and job = 'claude_hourly_notifications')
    or started_by = 'task:claude_hourly_notifications';

alter table public.claude_notifications enable trigger claude_notifications_guard_update;

commit;
