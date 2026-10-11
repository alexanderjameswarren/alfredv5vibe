-- Purpose: Restructure Phase 3, step 6 follow-up. Pending reminders follow their intention: two new cancel reasons (intent_status, intent_archived), and a trigger on intents that cancels scheduled reminders when the intention is archived and re-arms them (future ones only) when it is un-archived.
-- Kind: schema change (constraint, trigger function, trigger)
-- Applied: YES — confirmed 2026-10-11, CONFORMANT (60 tables)
--
-- Spec: docs/technical-spec-restructure_p3.md. Run as one block in the SQL editor.
-- Safe to re-run.
-- supabase/migrations/119_restructure_p3_reminders_follow_intent.sql

-- ============================================================================
-- 1. Allowed cancel reasons
-- ============================================================================
-- intent_status:   the app's Background / Closed question, answered "cancel".
-- intent_archived: the intention was archived (trigger below).
alter table public.reminders drop constraint if exists reminders_cancel_reason_check;
alter table public.reminders add constraint reminders_cancel_reason_check
  check (cancel_reason is null
         or cancel_reason in ('manual', 'inbox_discarded', 'intent_status', 'intent_archived'));

comment on column public.reminders.cancel_reason is
  'Why a cancelled reminder was cancelled: manual (update_reminder or the app), inbox_discarded (the linked inbox item was binned), intent_status (its intention moved to background or closed and the person chose to cancel), or intent_archived (its intention was archived; reminders_follow_intent_archive). Null unless state is cancelled. Each undo restores only its own reason''s rows still in the future, which is what this column exists to tell apart.';

comment on column public.reminders.state is
  'scheduled -> sent, or no_subscription when the user has no push_subscriptions row at due time. cancelled by update_reminder, the app, discarding the linked inbox item, or its intention leaving active or being archived (see cancel_reason). Same meanings as notification_steps.state, minus the chain-only states.';

-- ============================================================================
-- 2. Archive / un-archive trigger on intents
-- ============================================================================
-- SECURITY DEFINER so a shared intention's reminders are handled whoever owns
-- them (reminders RLS is owner-only). It touches only rows linked to this
-- intention, and only the two transitions below.
create or replace function public.reminders_follow_intent_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived is true and old.archived is not true then
    update public.reminders
       set state = 'cancelled', cancel_reason = 'intent_archived'
     where intent_id = new.id
       and state = 'scheduled';
  elsif new.archived is not true and old.archived is true then
    update public.reminders
       set state = 'scheduled', cancel_reason = null
     where intent_id = new.id
       and state = 'cancelled'
       and cancel_reason = 'intent_archived'
       and due_at > now();
  end if;
  return null;
end;
$$;

comment on function public.reminders_follow_intent_archive() is
  'Alfred: archiving an intention cancels its scheduled reminders (cancel_reason intent_archived); un-archiving re-arms only those intent_archived rows still in the future. Reminders cancelled for any other reason stay cancelled.';

revoke all on function public.reminders_follow_intent_archive() from public, anon;

drop trigger if exists reminders_follow_intent_archive on public.intents;
create trigger reminders_follow_intent_archive
  after update of archived on public.intents
  for each row
  when (old.archived is distinct from new.archived)
  execute function public.reminders_follow_intent_archive();

-- ============================================================================
-- 3. Conformance: must return CONFORMANT
-- ============================================================================
select public.platform_check_conformance();
