-- Phase 5 GATE — does pg_cron actually fire?
--
-- Run in the Supabase SQL editor. Nothing here touches notification_steps and
-- nothing sends a notification. The only question is whether a scheduled job
-- runs at all, so that "cron never ran" is distinguishable from "the dispatcher
-- logic is wrong" later.
--
-- Steps 1-4 set it up. Step 5 is what you check after a few minutes.
-- Step 6 tears it down once the answer is known.

-- ── 1. Extensions ──────────────────────────────────────────────────────────
-- pg_net is not needed by the probe itself; it is enabled here because the
-- dispatcher will need it, and finding out it is unavailable now costs nothing
-- whereas finding out after the function is written costs a rebuild.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── 2. Scratch table ───────────────────────────────────────────────────────
-- `user_id` is present and nullable purely because platform.register_table
-- introspects pg_attribute for it to choose the policy expression. Cron has no
-- user, so it stays null; pg_cron runs as a superuser role and is not subject
-- to RLS.
create table if not exists public.cron_probe (
  id        bigint generated always as identity primary key,
  user_id   uuid,
  fired_at  timestamptz not null default now(),
  note      text
);

comment on table  public.cron_probe            is 'Phase 5 gate: proves pg_cron fires. Temporary — drop once the dispatcher is verified.';
comment on column public.cron_probe.id         is 'Surrogate key.';
comment on column public.cron_probe.user_id    is 'Always null. Present so register_table can pick a policy expression; cron has no user.';
comment on column public.cron_probe.fired_at   is 'When the scheduled job inserted this row.';
comment on column public.cron_probe.note       is 'Free text marking which probe wrote the row.';

-- ── 3. Register (Rule 2 — or conformance goes red) ─────────────────────────
select platform.register_table(
  'public.cron_probe',
  p_policy_mode => 'owner',
  p_audited     => false,   -- a once-a-minute heartbeat is exactly the high-volume case audit is not for
  p_exempt      => false,
  p_notes       => 'Alfred: temporary pg_cron liveness probe for notification chains Phase 5.'
);

-- ── 4. Schedule it, every minute ───────────────────────────────────────────
select cron.schedule(
  'cron-probe-every-minute',
  '* * * * *',
  $$insert into public.cron_probe (note) values ('tick')$$
);

-- ── 5. VERIFY — run these a few minutes later ──────────────────────────────

-- 5a. The job exists and is active.
select jobid, schedule, jobname, active, command
from cron.job
where jobname = 'cron-probe-every-minute';

-- 5b. Did it RUN, and did it succeed? This is the one that matters — a job can
--     exist and still never fire, and a job can fire and still fail.
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'cron-probe-every-minute')
order by start_time desc
limit 10;

-- 5c. The rows themselves. Expect roughly one per minute.
select id, fired_at, note
from public.cron_probe
order by fired_at desc
limit 10;

-- 5d. Gaps, if any. Consecutive rows should be ~60s apart.
select fired_at,
       fired_at - lag(fired_at) over (order by fired_at) as gap
from public.cron_probe
order by fired_at desc
limit 10;

-- ── 6. TEARDOWN — only after the gate has passed ───────────────────────────
-- select cron.unschedule('cron-probe-every-minute');
-- drop table public.cron_probe;
-- (If register_table has an inverse, call it before the drop — see the note in
--  docs/progress-notification-chains.md. Re-run check_platform_conformance
--  after teardown either way.)

-- ── 7. Conformance, per Rule 5 ─────────────────────────────────────────────
-- Expect CONFORMANT. Run after step 3, and again after teardown.
