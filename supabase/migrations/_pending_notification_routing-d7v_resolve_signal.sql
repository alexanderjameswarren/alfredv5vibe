-- Purpose: notification routing step 7. resolve_signal(): records that a subject (or every subject under a prefix,
-- e.g. wb-sync:failure covers wb-sync:failure:<error_key>) is healthy again, so the dispatcher's escalation count for
-- it starts over. Queued signals for a resolved subject are dropped: the problem went away before Alex was told.
-- Kind: schema change (one function)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md sections 4.2 and 6. Numbered and queued in step 7b, then run
-- supabase/tests/notification_routing-d7v/4_resolve_signal_verify.sql with --test. Deploy wb-sync after this.
-- Safe to re-run: create or replace.
-- supabase/migrations/_pending_notification_routing-d7v_resolve_signal.sql

begin;

create or replace function public.resolve_signal(
  p_app         text,
  p_subject_key text,
  p_started_by  text,
  p_user_id     uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user     uuid;
  v_subjects text[];
  v_dropped  int;
begin
  -- The same rule as raise_signal: only the service role names the user.
  if current_user = 'service_role' then
    v_user := p_user_id;
    if v_user is null then
      raise exception 'resolve_signal: p_user_id is required under the service role.' using errcode = '22023';
    end if;
  else
    v_user := auth.uid();
    if v_user is null then
      raise exception 'resolve_signal: not authenticated.';
    end if;
    if p_user_id is not null and p_user_id <> v_user then
      raise exception 'resolve_signal: p_user_id is for the service role only.' using errcode = '22023';
    end if;
  end if;
  if p_subject_key is null or btrim(p_subject_key) !~ '^[a-z0-9][a-z0-9:_.-]{0,199}$' then
    raise exception 'resolve_signal: subject_key must be a subject key or a prefix of one, e.g. wb-sync:failure.'
      using errcode = '22023';
  end if;

  -- Subjects with anything since their last resolved: those are the ones to reset. Already-resolved ones are left.
  select coalesce(array_agg(distinct sg.subject_key), '{}') into v_subjects
    from signals sg
   where sg.user_id = v_user and sg.app = p_app and sg.state <> 'resolved'
     and (sg.subject_key = btrim(p_subject_key) or starts_with(sg.subject_key, btrim(p_subject_key) || ':'))
     and sg.created_at > coalesce((select max(rs.created_at) from signals rs
                                    where rs.user_id = v_user and rs.subject_key = sg.subject_key
                                      and rs.state = 'resolved'), '-infinity'::timestamptz);

  update signals set state = 'dropped', reason = 'resolved before it was delivered', decided_at = now()
   where user_id = v_user and state = 'queued' and subject_key = any (v_subjects);
  get diagnostics v_dropped = row_count;

  insert into signals (user_id, app, job, severity, subject_key, title, started_by, state)
  select v_user, p_app, 'resolve_signal', 'low', k, 'Resolved', btrim(p_started_by), 'resolved'
    from unnest(v_subjects) k;

  return jsonb_build_object('resolved', to_jsonb(v_subjects), 'dropped', v_dropped);
end;
$$;

comment on function public.resolve_signal(text, text, text, uuid) is
  'Shared: mark a subject healthy again. p_subject_key is a subject or a prefix of subjects (before a ":"). Every '
  'matching subject with signals since its last resolved gets a resolved row, which resets its escalation count, and '
  'its queued signals are dropped. Returns {resolved: [subject keys], dropped: n}. p_user_id is required under the '
  'service role (wb-sync) and refused for anyone else. Called by the resolve_signal tool.';
revoke all on function public.resolve_signal(text, text, text, uuid) from public, anon;
grant execute on function public.resolve_signal(text, text, text, uuid) to authenticated, service_role;

commit;

-- Result: must say CONFORMANT (check_platform_conformance, step 7b). Then run
-- supabase/tests/notification_routing-d7v/4_resolve_signal_verify.sql with --test.
select public.platform_check_conformance() as conformance;
