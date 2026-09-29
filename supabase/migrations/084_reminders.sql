-- Purpose: Standalone reminders, step 1. Create public.reminders (a one-off push at a fixed time, always backed by an inbox item or an intention) and public.create_reminder, which creates the backing inbox row and the reminder in one transaction.
-- Kind: schema change (new table, new function)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Spec: docs/technical-spec-reminders.md. Run as one block in the SQL editor.
-- supabase/migrations/084_reminders.sql

-- ============================================================================
-- 1. Table
-- ============================================================================
create table if not exists public.reminders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete restrict,
  text          text not null,
  due_at        timestamptz not null,
  state         text not null default 'scheduled',
  cancel_reason text,
  sent_at       timestamptz,
  inbox_id      text references public.inbox(id) on delete set null,
  intent_id     text,
  created_by    text not null default 'app',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint reminders_state_check
    check (state in ('scheduled', 'sent', 'cancelled', 'no_subscription')),
  constraint reminders_cancel_reason_check
    check (cancel_reason is null or cancel_reason in ('manual', 'inbox_discarded')),
  constraint reminders_cancel_reason_needs_cancelled
    check (cancel_reason is null or state = 'cancelled'),
  constraint reminders_created_by_check
    check (created_by in ('app', 'claude')),
  constraint reminders_one_link
    check (num_nonnulls(inbox_id, intent_id) <= 1)
);

comment on table public.reminders is
  'ALFRED. Standalone reminders: one push notification at a fixed time, independent of any execution. Separate from notification_steps on purpose, which is chain-shaped (seq, offsets, waiting). Every reminder should be backed by something visible in Alfred, an inbox item or an intention, because Android notifications are easily suppressed or dismissed; create_reminder creates the inbox item when no link is given. Sent by the notify-dispatch Edge Function once a minute.';

comment on column public.reminders.id is
  'Surrogate key. Machine-generated, so uuid rather than Alfred''s legacy text ids.';
comment on column public.reminders.user_id is
  'Owner. The service-role dispatcher finds push_subscriptions by this column, and it is the whole of the authorisation there. Set explicitly when inserting from the SQL editor, where auth.uid() is null.';
comment on column public.reminders.text is
  'Notification body. Copied at creation, so the reminder still fires with sensible text if the linked inbox item or intention changes or disappears.';
comment on column public.reminders.due_at is
  'Absolute time to fire. The dispatcher sends a scheduled row once due_at <= now(). Changing it resets state to scheduled and clears sent_at and cancel_reason.';
comment on column public.reminders.state is
  'scheduled -> sent, or no_subscription when the user has no push_subscriptions row at due time. cancelled by update_reminder or by discarding the linked inbox item. Same meanings as notification_steps.state, minus the chain-only states.';
comment on column public.reminders.cancel_reason is
  'Why a cancelled reminder was cancelled: manual (update_reminder or the app) or inbox_discarded (the linked inbox item was binned). Null unless state is cancelled. Reversing a discard restores only inbox_discarded rows still in the future, which is what this column exists to tell apart.';
comment on column public.reminders.sent_at is
  'Set by the dispatcher on delivery. With state sent, it is what stops the row firing again on the next pass.';
comment on column public.reminders.inbox_id is
  'The inbox item backing this reminder, or null. ON DELETE SET NULL like source_inbox_id on items/intents/events: inbox rows are archived on triage, not deleted, so the link normally survives processing. Cleared when the item is processed into an intention (intent_id takes over). At most one of inbox_id and intent_id is set.';
comment on column public.reminders.intent_id is
  'The intention backing this reminder, or null. text, matching Alfred''s legacy ids. No FK: intents is a legacy table, as with notification_steps.execution_id. At most one of inbox_id and intent_id is set.';
comment on column public.reminders.created_by is
  'Who created the row: app or claude (through the create_reminder MCP tool).';
comment on column public.reminders.created_at is
  'Row creation.';
comment on column public.reminders.updated_at is
  'Last change. Stamped by the reminders_touch_updated_at trigger.';

-- ============================================================================
-- 2. Indexes
-- ============================================================================
create index if not exists reminders_state_due_idx
  on public.reminders (state, due_at);

create index if not exists reminders_inbox_idx
  on public.reminders (inbox_id) where inbox_id is not null;

create index if not exists reminders_intent_idx
  on public.reminders (intent_id) where intent_id is not null;

-- ============================================================================
-- 3. updated_at trigger
-- ============================================================================
create or replace function public.reminders_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.reminders_touch_updated_at() is 'Alfred: stamps reminders.updated_at.';

drop trigger if exists reminders_touch_updated_at on public.reminders;
create trigger reminders_touch_updated_at
  before update on public.reminders
  for each row execute function public.reminders_touch_updated_at();

-- ============================================================================
-- 4. create_reminder
-- ============================================================================
-- One transaction, so an unlinked reminder and its backing inbox row land
-- together or not at all. SECURITY INVOKER: RLS and the audit actor apply as
-- they would to direct inserts.
--
-- A due_at with no UTC offset is rejected by the MCP tool, not here: by the time
-- a string reaches a timestamptz parameter Postgres has already read it in the
-- session time zone.
create or replace function public.create_reminder(
  p_text       text,
  p_due_at     timestamptz,
  p_inbox_id   text default null,
  p_intent_id  text default null,
  p_created_by text default 'app'
)
returns public.reminders
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_text     text := btrim(coalesce(p_text, ''));
  v_inbox_id text := p_inbox_id;
  v_row      public.reminders;
begin
  if v_uid is null then
    raise exception 'create_reminder: not authenticated';
  end if;
  if v_text = '' then
    raise exception 'create_reminder: text is required';
  end if;
  if p_due_at is null then
    raise exception 'create_reminder: due_at is required';
  end if;
  if p_due_at <= now() then
    raise exception 'create_reminder: due_at % is in the past', p_due_at;
  end if;
  if p_inbox_id is not null and p_intent_id is not null then
    raise exception 'create_reminder: give inbox_id or intent_id, not both';
  end if;

  -- Under RLS a row the caller cannot see is simply absent; say so rather than
  -- link to nothing.
  if p_inbox_id is not null
     and not exists (select 1 from public.inbox where id = p_inbox_id) then
    raise exception 'create_reminder: inbox item % not found', p_inbox_id
      using errcode = 'P0002';
  end if;
  if p_intent_id is not null
     and not exists (select 1 from public.intents where id = p_intent_id) then
    raise exception 'create_reminder: intention % not found', p_intent_id
      using errcode = 'P0002';
  end if;

  if p_inbox_id is null and p_intent_id is null then
    insert into public.inbox (id, captured_text, source_type)
    values (
      gen_random_uuid()::text,
      v_text,
      case when p_created_by = 'claude' then 'mcp' else 'manual' end
    )
    returning id into v_inbox_id;
  end if;

  insert into public.reminders (user_id, text, due_at, inbox_id, intent_id, created_by)
  values (v_uid, v_text, p_due_at, v_inbox_id, p_intent_id, p_created_by)
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.create_reminder(text, timestamptz, text, text, text) is
  'Alfred: create a standalone reminder. With neither p_inbox_id nor p_intent_id, first creates a backing inbox item (captured_text = text) in the same transaction, so every reminder is visible in Alfred. Rejects blank text, a past due_at, both links at once, and links the caller cannot see. Returns the reminders row.';

revoke all on function public.create_reminder(text, timestamptz, text, text, text) from public, anon;
grant execute on function public.create_reminder(text, timestamptz, text, text, text) to authenticated;

-- ============================================================================
-- 5. Register with the platform — last, per the contract
-- ============================================================================
select platform.register_table(
  'public.reminders',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred. Standalone one-off push reminders, each backed by an inbox item or an intention. Sent by notify-dispatch.'
);
