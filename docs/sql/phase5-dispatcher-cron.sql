-- Phase 5 — schedule the dispatcher.
--
-- Run in the Supabase SQL editor AFTER `notify-dispatch` is deployed and the
-- verify_jwt re-check has passed. Both gates are already proven, so this adds
-- only the real job.
--
-- ⚠️ THE SECRET IS WRITTEN INTO THE CRON COMMAND, which is stored in cron.job
-- in plain text and readable by anyone who can read that table. That is the
-- accepted trade for a database-triggered call; it is the same shape Supabase's
-- own docs use. Substitute the real value below before running, and do not
-- paste the result anywhere.

-- ── 1. Schedule it, every minute ───────────────────────────────────────────
select cron.schedule(
  'notify-dispatch-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://zuqjyfqnvhddnchhpbcz.supabase.co/functions/v1/notify-dispatch',
    headers := jsonb_build_object(
      'Content-Type',       'application/json',
      'x-dispatch-secret',  'PASTE_NOTIFY_DISPATCH_SECRET_HERE'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- ── 2. VERIFY — did cron fire, and did the FUNCTION answer? ────────────────
--
-- These are two different questions and pg_net makes the distinction matter:
-- net.http_post is ASYNCHRONOUS. It returns a request id immediately and the
-- response lands in net._http_response later. A cron run marked 'succeeded'
-- means only that the POST was QUEUED — not that the dispatcher ran, not that
-- it returned 200, and not that anything was sent.

-- 2a. Cron fired (this only proves the request was queued).
select jobid, runid, status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'notify-dispatch-every-minute')
order by start_time desc
limit 5;

-- 2b. THE ONE THAT MATTERS — what the dispatcher actually answered.
--     status_code 200 = ran. 401 = the secret is wrong or the header was not
--     sent. 503 = NOTIFY_DISPATCH_SECRET is not set on the function.
--     Read `body` for the per-step, per-endpoint detail.
select id,
       status_code,
       timed_out,
       error_msg,
       left(content, 800) as body
from net._http_response
order by id desc
limit 5;

-- 2c. Just the summary counts, one row per run, newest first.
select id,
       status_code,
       (content::jsonb ->> 'due')::int              as due,
       (content::jsonb ->> 'skipped_inactive')::int as skipped_inactive,
       (content::jsonb ->> 'sent')::int             as sent,
       (content::jsonb ->> 'failed')::int           as failed,
       content::jsonb ->> 'checked_at'              as checked_at
from net._http_response
where status_code = 200
  and content is not null
  and left(content, 1) = '{'
order by id desc
limit 15;

-- 2d. Steps that were actually dispatched.
select id, execution_id, seq, text, state, due_at, sent_at
from public.notification_steps
where state = 'sent'
order by sent_at desc
limit 10;

-- ── 3. net._http_response growth ───────────────────────────────────────────
-- One row per minute is ~1,440/day. pg_net prunes on its own in recent
-- versions, but that is unproven here. Check after a day; if it is unbounded,
-- add a retention job rather than solving it now.
select count(*)               as responses,
       min(created)           as oldest,
       max(created)           as newest,
       pg_size_pretty(pg_total_relation_size('net._http_response')) as size
from net._http_response;

-- ── 4. Control ─────────────────────────────────────────────────────────────
-- Pause without deleting (useful while debugging):
--   update cron.job set active = false where jobname = 'notify-dispatch-every-minute';
--   update cron.job set active = true  where jobname = 'notify-dispatch-every-minute';
--
-- Remove entirely:
--   select cron.unschedule('notify-dispatch-every-minute');
--
-- Rotate the secret: set it in Supabase secrets, redeploy the function, then
-- unschedule and re-run step 1 with the new value. The job and the function
-- must change together or every call 401s.
