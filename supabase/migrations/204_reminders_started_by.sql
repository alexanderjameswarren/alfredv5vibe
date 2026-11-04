-- Purpose: notification routing step 6. started_by on reminders (who started it: alex, chat or task:<job>), checked
-- like claude_notifications.started_by, filled from created_by when the caller leaves it out, and backfilled the same
-- way (approximate: alex for app-made, chat for claude-made, including Overwatch's nudges).
-- Kind: schema change (one column, one constraint, one trigger function and trigger) plus a backfill of the existing
-- reminders rows
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md section 8. Needs 200_signals.sql (started_by_valid). Then
-- run supabase/tests/notification_routing-d7v/3_started_by_verify.sql with --test.
-- Deploy notify-dispatch and mcp only after this has run: both read reminders.started_by.
-- Safe to re-run: add column if not exists, the constraint and trigger are dropped first, the backfill only touches
-- rows with no started_by.
-- supabase/migrations/204_reminders_started_by.sql

begin;

alter table public.reminders add column if not exists started_by text;

comment on column public.reminders.started_by is
  'Who started it: alex, chat, or task:<job>. Filled from created_by when left out (app: alex, claude: chat). '
  'notify-dispatch copies it onto the claude_notifications row it logs for the push.';

-- Backfill without touching updated_at: the touch trigger is off for this one update.
alter table public.reminders disable trigger reminders_touch_updated_at;
update public.reminders
   set started_by = case when created_by = 'app' then 'alex' else 'chat' end
 where started_by is null;
alter table public.reminders enable trigger reminders_touch_updated_at;

alter table public.reminders alter column started_by set not null;

alter table public.reminders drop constraint if exists reminders_started_by_valid;
alter table public.reminders add constraint reminders_started_by_valid
  check (public.started_by_valid(started_by));

-- The app and create_reminder() do not pass it yet, so an insert without one takes it from created_by.
create or replace function public.reminders_default_started_by()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.started_by is null then
    new.started_by := case when new.created_by = 'app' then 'alex' else 'chat' end;
  end if;
  return new;
end;
$$;

comment on function public.reminders_default_started_by() is
  'Alfred: fills reminders.started_by from created_by (app: alex, claude: chat) when an insert leaves it out.';
revoke all on function public.reminders_default_started_by() from public, anon;

drop trigger if exists reminders_default_started_by on public.reminders;
create trigger reminders_default_started_by
  before insert on public.reminders
  for each row execute function public.reminders_default_started_by();

commit;

-- Result: must say CONFORMANT. Then run supabase/tests/notification_routing-d7v/3_started_by_verify.sql with --test.
select public.platform_check_conformance() as conformance;
