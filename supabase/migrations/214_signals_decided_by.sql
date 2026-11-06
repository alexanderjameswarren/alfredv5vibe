-- Purpose: notification routing step 11. Who decided a signal: signals.decided_by.
--   Alex's own actions on a signal (hold, drop, deliver now, through update_signal in chat or the Dispatcher
--   screen) record who did it; the dispatcher's decisions leave it null. No function is needed for the actions:
--   owner RLS already lets Alex update his own signals, and signals_guard_update lets the state columns change
--   (decided_by is not one of the sender's columns, so it may change too) and keeps delivered, merged and dropped
--   final.
-- Kind: schema change (one new column with a check)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md sections 4.1 and 4.3. Then run
-- supabase/tests/notification_routing-d7v/7_update_signal_verify.sql with --test.
-- Safe to re-run: if not exists, and the constraint is dropped first.
-- supabase/migrations/214_signals_decided_by.sql

begin;

alter table public.signals add column if not exists decided_by text;

alter table public.signals drop constraint if exists signals_decided_by_valid;
alter table public.signals add constraint signals_decided_by_valid
  check (decided_by is null or public.started_by_valid(decided_by));

comment on column public.signals.decided_by is
  'Who decided this signal by hand: alex (the Dispatcher screen), chat (Claude for Alex, update_signal). '
  'Null means the dispatcher decided it. Set with decided_at.';

commit;
