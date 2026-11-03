-- Purpose: notification routing step 3. The signals table (what apps and tasks raise; the dispatcher decides what
-- reaches Alex), raise_signal(), and started_by and signal_id on claude_notifications, with log_claude_notification()
-- taking both.
-- Kind: schema change (one new table, three functions, one trigger function, two new columns) plus a backfill of
-- claude_notifications.started_by on the rows already logged
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md sections 4 and 8. Numbered and queued in step 3c, then run
-- supabase/tests/notification_routing-d7v/1_verify_signals.sql with --test.
-- Safe to re-run: creates are if-not-exists or create-or-replace, triggers and the old function signature are
-- dropped first, and the backfill only touches rows with no started_by.
-- supabase/migrations/_pending_notification_routing-d7v_signals.sql

begin;

-- ============================================================================
-- 1. started_by: who started a notification. alex, chat, or task:<job>.
-- ============================================================================
create or replace function public.started_by_valid(p text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p ~ '^(alex|chat|task:[a-z0-9][a-z0-9_-]{0,99})$'
$$;

comment on function public.started_by_valid(text) is
  'Shared: true when p is a started_by value: alex, chat, or task:<job> (lower case, digits, _ and -). Used by the '
  'signals and claude_notifications check constraints.';
-- Functions in check constraints run with the inserting user's rights.
revoke all on function public.started_by_valid(text) from public, anon;
grant execute on function public.started_by_valid(text) to authenticated, service_role;


-- ============================================================================
-- 2. signals
-- ============================================================================
create table if not exists public.signals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id),
  app             text not null references public.apps (id),
  job             text not null,
  severity        text not null,
  subject_key     text not null,
  title           text not null,
  body            text,
  link            text,
  started_by      text not null,
  source_ref      text,
  state           text not null default 'queued',
  outcome         text,
  reason          text,
  decided_at      timestamptz,
  decided_run_id  uuid references public.platform_runs (id) on delete set null,
  inbox_id        text references public.inbox (id) on delete set null,
  notification_id uuid references public.claude_notifications (id) on delete set null,
  merged_into     uuid references public.signals (id),
  bundle_id       uuid,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint signals_job_present check (length(btrim(job)) between 1 and 100),
  constraint signals_severity_values check (severity in ('low', 'normal', 'high', 'urgent')),
  constraint signals_subject_key_format check (subject_key ~ '^[a-z0-9][a-z0-9:_.-]{0,199}$'),
  constraint signals_title_present check (length(btrim(title)) between 1 and 200),
  constraint signals_link_path check (link is null or (link ~ '^/' and link !~ '^//' and link !~ '\s')),
  constraint signals_started_by_valid check (public.started_by_valid(started_by)),
  constraint signals_source_ref_present check (source_ref is null or length(btrim(source_ref)) between 1 and 300),
  constraint signals_state_values check (state in ('queued', 'held', 'delivered', 'merged', 'dropped', 'resolved')),
  constraint signals_outcome_values check (outcome is null or outcome in ('inbox', 'pop')),
  constraint signals_outcome_when_delivered check ((state = 'delivered') = (outcome is not null)),
  constraint signals_merged_has_target check ((state = 'merged') = (merged_into is not null)),
  constraint signals_details_object check (jsonb_typeof(details) = 'object')
);

create index if not exists signals_user_state_created on public.signals (user_id, state, created_at);
create index if not exists signals_user_subject_created on public.signals (user_id, subject_key, created_at desc);
create unique index if not exists signals_user_source_ref on public.signals (user_id, source_ref)
  where source_ref is not null;

comment on table public.signals is
  'SHARED. Something an app or task thinks is worth knowing, raised every time it happens. Apps never pick a channel '
  'or check for an existing inbox item: the dispatcher decides whether each signal is held, becomes an inbox item, '
  'pops (an Alfred push) or merges into one already delivered, under the delivery rules in Overwatch''s plan. What '
  'the sender wrote never changes; only the state columns do. Write through raise_signal().';
comment on column public.signals.id is 'Row id.';
comment on column public.signals.user_id is 'Owner. Owner RLS. Server senders under the service role pass it to raise_signal.';
comment on column public.signals.app is 'The app it is about (apps.id), e.g. warren_buffet.';
comment on column public.signals.job is 'What raised it, e.g. wb-sync, overwatch_nightly.';
comment on column public.signals.severity is 'low, normal, high or urgent. The delivery rules map each to a default outcome.';
comment on column public.signals.subject_key is
  'Ties repeats together, e.g. wb-sync:failure. Lower case; letters, digits, colon, underscore, dot, hyphen. '
  'Escalation and merging count by it.';
comment on column public.signals.title is 'Short title, as the sender wrote it.';
comment on column public.signals.body is 'The text, as the sender wrote it, or null.';
comment on column public.signals.link is 'An Alfred path, /<id>, or null.';
comment on column public.signals.started_by is 'Who started it: alex, chat, or task:<job>.';
comment on column public.signals.source_ref is
  'Optional idempotency key, unique per user: a retried run passing the same value cannot raise twice.';
comment on column public.signals.state is
  'queued (waiting for the dispatcher), held (silenced, counted for escalation), delivered, merged, dropped, or '
  'resolved (a marker that the subject is healthy again, resetting its escalation count).';
comment on column public.signals.outcome is 'inbox or pop when delivered; null otherwise.';
comment on column public.signals.reason is 'The rule that decided, in plain words.';
comment on column public.signals.decided_at is 'When the dispatcher (or Alex) decided.';
comment on column public.signals.decided_run_id is 'The dispatcher''s platform_runs row that decided, or null.';
comment on column public.signals.inbox_id is 'The inbox item it became or merged into, or null.';
comment on column public.signals.notification_id is 'The claude_notifications row of its pop, or null.';
comment on column public.signals.merged_into is 'The signal it was merged into. Set exactly when state is merged.';
comment on column public.signals.bundle_id is 'Shared by the signals delivered together in one digest pop, or null.';
comment on column public.signals.details is 'Anything else the sender wants kept. An object.';
comment on column public.signals.created_at is 'When it was raised.';
comment on column public.signals.updated_at is 'Last state change. Stamped by the guard trigger.';

create or replace function public.signals_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.id, new.user_id, new.app, new.job, new.severity, new.subject_key, new.title, new.body, new.link,
      new.started_by, new.source_ref, new.details, new.created_at)
     is distinct from
     (old.id, old.user_id, old.app, old.job, old.severity, old.subject_key, old.title, old.body, old.link,
      old.started_by, old.source_ref, old.details, old.created_at) then
    raise exception 'signals: only the state columns may change. Raise a new signal instead.' using errcode = '23514';
  end if;
  if old.state in ('delivered', 'merged', 'dropped', 'resolved') and new.state is distinct from old.state then
    raise exception 'signals: a % signal is final; its state cannot change to %.', old.state, new.state
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.signals_guard_update() is
  'Shared: what a signal''s sender wrote never changes, and delivered, merged, dropped and resolved are final. '
  'Stamps updated_at.';
revoke all on function public.signals_guard_update() from public, anon;

drop trigger if exists signals_guard_update on public.signals;
create trigger signals_guard_update
  before update on public.signals
  for each row execute function public.signals_guard_update();


-- ============================================================================
-- 3. raise_signal — insert one signal; a repeated source_ref is refused
-- ============================================================================
create or replace function public.raise_signal(
  p_app         text,
  p_job         text,
  p_severity    text,
  p_subject_key text,
  p_title       text,
  p_started_by  text,
  p_body        text  default null,
  p_link        text  default null,
  p_source_ref  text  default null,
  p_details     jsonb default null,
  p_user_id     uuid  default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user     uuid;
  v_id       uuid;
  v_existing public.signals%rowtype;
begin
  -- Only a server sender (the service role, no auth.uid()) names the user; anyone else is themselves.
  if current_user = 'service_role' then
    v_user := p_user_id;
    if v_user is null then
      raise exception 'raise_signal: p_user_id is required under the service role.' using errcode = '22023';
    end if;
  else
    v_user := auth.uid();
    if v_user is null then
      raise exception 'raise_signal: not authenticated.';
    end if;
    if p_user_id is not null and p_user_id <> v_user then
      raise exception 'raise_signal: p_user_id is for the service role only.' using errcode = '22023';
    end if;
  end if;
  if not exists (select 1 from apps where id = p_app) then
    raise exception 'raise_signal: unknown app "%". Use an id from get_apps.', p_app using errcode = '22023';
  end if;

  insert into signals (user_id, app, job, severity, subject_key, title, body, link, started_by, source_ref, details)
  values (v_user, p_app, btrim(p_job), p_severity, btrim(p_subject_key), btrim(p_title), nullif(btrim(p_body), ''),
          nullif(btrim(p_link), ''), btrim(p_started_by), nullif(btrim(p_source_ref), ''),
          coalesce(p_details, '{}'::jsonb))
  on conflict (user_id, source_ref) where source_ref is not null do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('created', true, 'id', v_id);
  end if;

  select * into v_existing from signals where user_id = v_user and source_ref = btrim(p_source_ref);
  return jsonb_build_object('created', false, 'id', v_existing.id, 'duplicate_of', jsonb_build_object(
    'created_at', v_existing.created_at, 'title', v_existing.title, 'state', v_existing.state));
end;
$$;

comment on function public.raise_signal(text, text, text, text, text, text, text, text, text, jsonb, uuid) is
  'Shared: raise one signal. Returns {created: true, id}, or {created: false, id, duplicate_of} when the user already '
  'has a signal with this source_ref, in which case nothing is written. p_user_id is required under the service role '
  '(server senders such as wb-sync) and refused for anyone else. Called by the raise_signal tool.';
revoke all on function public.raise_signal(text, text, text, text, text, text, text, text, text, jsonb, uuid)
  from public, anon;
grant execute on function public.raise_signal(text, text, text, text, text, text, text, text, text, jsonb, uuid)
  to authenticated, service_role;


-- ============================================================================
-- 4. claude_notifications: started_by and signal_id
-- ============================================================================
-- started_by stays nullable until every sender passes it (made required at cutover, step 13).
alter table public.claude_notifications add column if not exists started_by text;
alter table public.claude_notifications add column if not exists signal_id uuid references public.signals (id);

alter table public.claude_notifications drop constraint if exists claude_notifications_started_by_valid;
alter table public.claude_notifications add constraint claude_notifications_started_by_valid
  check (started_by is null or public.started_by_valid(started_by));

create index if not exists claude_notifications_signal on public.claude_notifications (signal_id)
  where signal_id is not null;

comment on column public.claude_notifications.started_by is
  'Who started it: alex, chat, or task:<job>. Null only on rows from senders not yet passing it.';
comment on column public.claude_notifications.signal_id is 'The signal this notification delivered, or null.';

-- Both are fixed after insert, like everything but the delivery columns.
create or replace function public.claude_notifications_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.id, new.user_id, new.app, new.job, new.kind, new.channel, new.title, new.body, new.link, new.local_date,
      new.dedupe_key, new.created_at, new.started_by, new.signal_id)
     is distinct from
     (old.id, old.user_id, old.app, old.job, old.kind, old.channel, old.title, old.body, old.link, old.local_date,
      old.dedupe_key, old.created_at, old.started_by, old.signal_id) then
    raise exception 'claude_notifications: only delivery_status and delivery_detail may change. Log a new notification instead.'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Backfill the rows logged so far. The guard would refuse it, so it is off for this one update.
alter table public.claude_notifications disable trigger claude_notifications_guard_update;
update public.claude_notifications
   set started_by = case when job = 'arnold_v1_test' then 'chat' else 'task:' || job end
 where started_by is null;
alter table public.claude_notifications enable trigger claude_notifications_guard_update;


-- ============================================================================
-- 5. log_claude_notification takes p_started_by and p_signal_id
-- ============================================================================
-- Both are new trailing defaults, so a caller passing the old named arguments still resolves to this function.
drop function if exists public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb);

create or replace function public.log_claude_notification(
  p_app             text,
  p_job             text,
  p_kind            text,
  p_channel         text,
  p_title           text,
  p_dedupe_key      text,
  p_body            text  default null,
  p_link            text  default null,
  p_local_date      date  default null,
  p_delivery_status text  default 'pending',
  p_delivery_detail jsonb default null,
  p_started_by      text  default null,
  p_signal_id       uuid  default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_existing public.claude_notifications%rowtype;
begin
  if auth.uid() is null then
    raise exception 'log_claude_notification: not authenticated.';
  end if;
  if not exists (select 1 from apps where id = p_app) then
    raise exception 'log_claude_notification: unknown app "%". Use an id from get_apps.', p_app using errcode = '22023';
  end if;

  insert into claude_notifications (app, job, kind, channel, title, body, link, local_date, dedupe_key,
                                    delivery_status, delivery_detail, started_by, signal_id)
  values (p_app, btrim(p_job), p_kind, p_channel, btrim(p_title), nullif(btrim(p_body), ''), nullif(btrim(p_link), ''),
          coalesce(p_local_date, (now() at time zone 'America/Los_Angeles')::date), btrim(p_dedupe_key),
          coalesce(p_delivery_status, 'pending'), coalesce(p_delivery_detail, '{}'::jsonb),
          nullif(btrim(p_started_by), ''), p_signal_id)
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('created', true, 'id', v_id);
  end if;

  select * into v_existing from claude_notifications where user_id = auth.uid() and dedupe_key = btrim(p_dedupe_key);
  return jsonb_build_object('created', false, 'id', v_existing.id, 'duplicate_of', jsonb_build_object(
    'created_at', v_existing.created_at, 'channel', v_existing.channel, 'title', v_existing.title,
    'delivery_status', v_existing.delivery_status));
end;
$$;

comment on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid) is
  'Shared: log one notification in claude_notifications. Returns {created: true, id} for a new row, or {created: false, '
  'id, duplicate_of} when the caller already has a row with this dedupe_key, in which case nothing is written and the '
  'notification must not be sent. local_date defaults to today in Pacific time. started_by is alex, chat or '
  'task:<job>; signal_id the signal it delivers. Called by the log_claude_notification and send_alfred_push tools.';
revoke all on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)
  from public, anon;
grant execute on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)
  to authenticated, service_role;


-- ============================================================================
-- 6. Register signals: owner RLS, explicit grants (no anon), audited. subject_key and source_ref are not credentials.
-- ============================================================================
select platform.register_table(
  'public.signals',
  p_policy_mode     => 'owner',
  p_audited         => true,
  p_exempt          => false,
  p_notes           => 'Shared. What apps and tasks raise for the dispatcher; one row per signal. Written by raise_signal (tier 1); state set by the dispatcher.',
  p_cleared_columns => array['subject_key', 'source_ref']
);

commit;

-- ============================================================================
-- 7. Result: must say CONFORMANT (check_platform_conformance, step 3c). Then run
--    supabase/tests/notification_routing-d7v/1_verify_signals.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
