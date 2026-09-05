-- Phase 5b — add the `no_subscription` step state.
--
-- A due step whose user has no push_subscriptions row was staying `scheduled`
-- and being retried every minute forever. With a 200-step-per-run cap, a
-- household member who never subscribes accumulates a permanent backlog that
-- crowds out real steps.
--
-- `no_subscription` is out of the send queue but deliberately NOT terminal:
--   - the dispatcher only reads `scheduled`, so it is never retried;
--   - completion still ticks straight through it, so the chain still advances;
--   - closing an execution still cancels it, like any other non-terminal row.
-- In every code path it behaves exactly like `sent`; only the reason differs.
--
-- ⚠️ Deploy notify-dispatch AFTER running this. The function writes the new
-- value, and until the constraint allows it every such write fails.

-- ── 1. Widen the state constraint ──────────────────────────────────────────
alter table public.notification_steps
  drop constraint if exists notification_steps_state_check;

alter table public.notification_steps
  add constraint notification_steps_state_check check (
    state in ('waiting','scheduled','sent','done','skipped','cancelled','no_subscription')
  );

-- ── 2. Update the column comment (it is the authoritative description) ─────
comment on column public.notification_steps.state is
  'waiting -> scheduled -> sent -> done. Also skipped (advances the chain like '
  'done), cancelled (terminal; set for all remaining rows when an execution '
  'closes), and no_subscription (the step came due but the user has no '
  'push_subscriptions row). no_subscription is out of the dispatcher''s queue '
  'but is NOT terminal: ticking the step still marks it done and still '
  'schedules the next one. Subscribing a device later does not resurrect it — '
  'set it back to scheduled by hand to retry.';

-- ── 3. Optional: retire steps already stuck in the retry loop ─────────────
-- Only rows whose owner has no subscription at all. Safe to re-run.
-- update public.notification_steps ns
--    set state = 'no_subscription'
--  where ns.state = 'scheduled'
--    and ns.due_at <= now()
--    and not exists (
--          select 1 from public.push_subscriptions ps where ps.user_id = ns.user_id
--        );

-- ── 4. Verify ──────────────────────────────────────────────────────────────
select state, count(*)
from public.notification_steps
group by state
order by state;

-- Recover one deliberately, once a device has subscribed:
--   update public.notification_steps
--      set state = 'scheduled', due_at = now()
--    where id = '<STEP_ID>';
