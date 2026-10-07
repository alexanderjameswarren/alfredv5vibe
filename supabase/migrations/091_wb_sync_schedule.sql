-- Purpose: Warren Buffet Step 4. Schedule the wb-sync Edge Function daily with pg_cron (0 13 * * * UTC = 5 AM PST / 6 AM PDT) and register it in platform_schedules for staleness.
-- Kind: scheduling change (one cron job) + data insert (one platform_schedules row)
-- Applied: YES — 2026-10-07 by Alex (cron job id 4). Verified: wb-sync-daily active at 0 13 * * *, secret header present, placeholder gone, timeout set; platform_schedules row warren_buffet / wb-sync / alfred / daily / 06:00 / 6 / enabled.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-warren_buffet-w7b.md section 7. Mirrors
-- 033_phase5_dispatcher_cron.sql (notify-dispatch) exactly.
--
-- ⚠️ THE SECRET IS WRITTEN INTO THE CRON COMMAND, which is stored in cron.job in
-- plain text, readable by anyone who can read that table. Same accepted trade as
-- notify-dispatch. Replace PASTE_WB_SYNC_SECRET_HERE in the SQL EDITOR ONLY,
-- run it, and never save this file with the real value in it.
-- supabase/migrations/091_wb_sync_schedule.sql

-- ── 1. The daily job ───────────────────────────────────────────────────────
-- Idempotent: drop a previous definition first, so re-running replaces it.
select cron.unschedule(jobid) from cron.job where jobname = 'wb-sync-daily';

select cron.schedule(
  'wb-sync-daily',
  '0 13 * * *',
  $$
  select net.http_post(
    url     := 'https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/wb-sync',
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'x-wb-sync-secret', 'PASTE_WB_SYNC_SECRET_HERE'
    ),
    body    := '{}'::jsonb,
    -- pg_net's default is 5 s; a sync takes longer, and a dropped connection
    -- must not be what decides whether it finishes.
    timeout_milliseconds := 120000
  );
  $$
);

-- ── 2. Staleness definition ────────────────────────────────────────────────
-- user_id from the Money context row, so no id is hard-coded. expected_by is
-- read in America/Los_Angeles: due by 06:00, stale after noon.
insert into public.platform_schedules (user_id, app, job, executor, cadence, expected_by, grace_hours, enabled, notes)
select
  c.user_id,
  'warren_buffet',
  'wb-sync',
  'alfred',
  'daily',
  '06:00',
  6,
  true,
  'Edge function wb-sync, fired daily at 13:00 UTC by pg_cron job "wb-sync-daily". '
    || 'Pulls SimpleFIN into the wb_ tables and writes a platform_runs row every run '
    || '(ok, partial on blocking SimpleFIN errors, failed). A blocking error raises one '
    || 'Alfred inbox item per distinct problem. A day with no run means cron, pg_net or '
    || 'the function is broken.'
from public.contexts c
where c.id = 'muvitejhrgt3rgi8t6q'
on conflict (user_id, app, job) do update
  set executor    = excluded.executor,
      cadence     = excluded.cadence,
      expected_by = excluded.expected_by,
      grace_hours = excluded.grace_hours,
      enabled     = excluded.enabled,
      notes       = excluded.notes;
