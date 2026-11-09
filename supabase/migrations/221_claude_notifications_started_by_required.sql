-- Purpose: notification routing step 13b, the cutover. claude_notifications.started_by becomes not null, and
--   log_claude_notification() refuses a missing p_started_by with a plain error instead of a not-null violation.
--   Every writer already passes it: signals.ts, notify-dispatch, wb-sync, and (from the mcp deploy that goes first)
--   send_alfred_push and log_claude_notification. On 2026-11-09 all 79 rows had started_by, so no backfill: the
--   first block stops the migration if a null row has appeared since.
-- Kind: schema change
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md section 11b. Needs 200_signals.sql. Deploy mcp first (its tools
-- then require started_by), then this, then supabase/tests/notification_routing-d7v/9_started_by_required_verify.sql
-- with --test.
-- Safe to re-run: set not null on a not-null column is a no-op, and the function is replaced whole.
-- supabase/migrations/221_claude_notifications_started_by_required.sql

begin;

-- 1. Refuse to go on if any row has no started_by.
do $$
declare
  v_nulls bigint;
begin
  select count(*) into v_nulls from public.claude_notifications where started_by is null;
  if v_nulls > 0 then
    raise exception 'started_by_required: % claude_notifications rows have no started_by; backfill them first.', v_nulls;
  end if;
end;
$$;

-- 2. The column.
alter table public.claude_notifications alter column started_by set not null;

comment on column public.claude_notifications.started_by is
  'Who started the notification: alex, chat, or task:<job>. Required since notification routing step 13b.';

-- 3. log_claude_notification: same signature (so every caller still resolves), but started_by is required.
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
  if nullif(btrim(p_started_by), '') is null then
    raise exception 'log_claude_notification: started_by is required: "alex", "chat" or "task:<job>".'
      using errcode = '22023';
  end if;

  insert into claude_notifications (app, job, kind, channel, title, body, link, local_date, dedupe_key,
                                    delivery_status, delivery_detail, started_by, signal_id)
  values (p_app, btrim(p_job), p_kind, p_channel, btrim(p_title), nullif(btrim(p_body), ''), nullif(btrim(p_link), ''),
          coalesce(p_local_date, (now() at time zone 'America/Los_Angeles')::date), btrim(p_dedupe_key),
          coalesce(p_delivery_status, 'pending'), coalesce(p_delivery_detail, '{}'::jsonb),
          btrim(p_started_by), p_signal_id)
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
  'notification must not be sent. local_date defaults to today in Pacific time. started_by (required) is alex, chat or '
  'task:<job>; signal_id the signal it delivers. Called by the log_claude_notification and send_alfred_push tools, '
  'the dispatcher and wb-sync.';
revoke all on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)
  from public, anon;
grant execute on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)
  to authenticated, service_role;

commit;

select public.platform_check_conformance() as conformance;
