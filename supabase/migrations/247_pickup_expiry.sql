-- 247, sb3_runner-r4q r2: the 15-minute rule for every helper kind, and an idempotent pickup. Schema change (functions).
-- Spec: switchboard repo docs/technical-spec-sb3_plumbing-n7c.md, A2 (server, r2) and M.
-- Functions: switchboard_pickup_helper (last defined in 245_sf_datawrite.sql), switchboard_pickup_git (206).
-- Tables written by the functions: switchboard_actions, switchboard_runs. One table change: the column
-- switchboard_runs.failure_reason (s1b), which only the 15-minute expiry writes. No data changes here.
--
-- 1. Every approved (consumed) helper action not picked up within 15 minutes of coalesce(link_used_at, created_at)
--    is failed at the next pickup, by either function, whatever kind it is, with a finished run whose result is
--    {"ok": false, "expired": true, "reason": "expired_not_picked_up"} and failure_reason 'expired_not_picked_up'
--    (which outlasts the 30-day pruning of result). Neither function ever hands one out.
--    Before: only sf_dataop, sf_dataquery and sf_datawrite, only in switchboard_pickup_helper.
-- 2. p_pickup_id (default null: today's behaviour). The run row opened by a pickup with an id carries
--    result {"pickup_id": "<id>"} until the helper's result replaces it. A repeat pickup with the same id, while that
--    run is open, returns the same action and run instead of the next one, so a retry after a lost reply never
--    strands an action as picked. Senders: the runner passes the helper's /pickup body pickup_id (alfred-v5 r4); the
--    helper makes one uuid per approve click and sends it on every retry of that pickup (switchboard repo, A2).
-- Everything else is as before: the 10-minute rule for queued no-click actions (pickup_helper only), a production
-- kind only by a click within 15 minutes, one running per project code, the default kinds, the return shapes.
-- The signatures gain a parameter, so the old ones are dropped first (an added default would make an overload that
-- leaves a one-argument call ambiguous). switchboard-runner calls both by named arguments, so its calls still work.

drop function if exists public.switchboard_pickup_helper(uuid, text[]);
drop function if exists public.switchboard_pickup_git(uuid);

-- ============================================================================
-- 0. switchboard_runs.failure_reason: why a run failed, kept when result is pruned after 30 days (s1b).
-- ============================================================================
alter table public.switchboard_runs add column if not exists failure_reason text;
comment on column public.switchboard_runs.failure_reason is
  'Why the run failed, in a fixed word, kept when result is pruned. Only ''expired_not_picked_up'' so far: written by switchboard_pickup_helper and switchboard_pickup_git when an approved action was not picked up within 15 minutes (sb3_runner-r4q). Null for every other run, other failures and cancels included.';
-- authenticated reads the whole table and service_role has all; claude_reader is granted column by column.
grant select (failure_reason) on table public.switchboard_runs to claude_reader;

-- ============================================================================
-- 1. switchboard_pickup_helper
-- ============================================================================
create function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  v_kinds  text[];
  v_action public.switchboard_actions;
  v_run    uuid;
  v_again  uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_helper: no user.' using errcode = '22004';
  end if;
  if p_kinds is null then
    v_kinds := array['git', 'sf_check', 'sf_read', 'sb_setup'];
  elsif cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null or not (p_kinds <@ c_all) then
    raise exception 'switchboard_pickup_helper: p_kinds must list helper kinds only (%).', array_to_string(c_all, ', ')
      using errcode = '22023';
  else
    v_kinds := p_kinds;
  end if;

  -- A no-click action must not run long after it was queued: past 10 minutes it fails, with a run saying why.
  with expired as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'queued' and not needs_click
       and picked_up_at is null and created_at < now() - interval '10 minutes'
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired before the helper picked it up: queued over 10 minutes ago, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from expired;

  -- r2: an approved action of any helper kind not picked up within 15 minutes of its approval never runs. A production
  -- kind consumed without a click is failed at once, as before (O6).
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'consumed' and picked_up_at is null
       and (coalesce(link_used_at, created_at) < now() - interval '15 minutes'
            or (kind = any(c_prod) and link_used_at is null))
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
  select p_user, id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now()
    from stale;

  -- r2: a repeat of a pickup whose reply was lost gets the same action and run, while that run is open. A repeat
  -- sent while the first is still running waits for it here, so it sees the first one's run.
  if p_pickup_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('switchboard_pickup:' || p_pickup_id::text, 0));
    select r.id, a.id into v_run, v_again
      from public.switchboard_runs r
      join public.switchboard_actions a on a.id = r.action_id
     where r.user_id = p_user and r.finished_at is null and r.mode = 'real'
       and r.result is not null and r.result->>'pickup_id' = p_pickup_id::text
       and a.user_id = p_user and a.kind = any(v_kinds) and a.status = 'consumed' and a.picked_up_at is not null
     order by r.started_at desc
     limit 1;
    if v_again is not null then
      select * into v_action from public.switchboard_actions where id = v_again;
      return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                                'project_code', v_action.project_code, 'payload', v_action.payload,
                                'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
    end if;
  end if;

  -- Ready: clicked (consumed) within 15 minutes, or queued and needing no click. A production kind only clicked, by
  -- its link. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = any(v_kinds) and a.picked_up_at is null
     and ((a.status = 'consumed' and coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')
          or (a.status = 'queued' and not a.needs_click))
     and (not (a.kind = any(c_prod))
          or (a.status = 'consumed' and a.needs_click and a.link_used_at is not null
              and a.link_used_at >= now() - interval '15 minutes'))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind = any(c_all)
                        and b.project_code = a.project_code
                        and b.picked_up_at is not null and b.status = 'consumed')
   order by a.created_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  update public.switchboard_actions
     set picked_up_at = now(), status = 'consumed'
   where id = v_action.id;
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
  values (p_user, v_action.id, 'real', 'picked up by the helper',
          case when p_pickup_id is null then null else jsonb_build_object('pickup_id', p_pickup_id) end)
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                            'project_code', v_action.project_code, 'payload', v_action.payload,
                            'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_helper(uuid, text[], uuid) is
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop, sf_dataquery and sf_datawrite only when named), that is ready to run: clicked within 15 minutes, or queued and needing no click. An sf_dataop, sf_dataquery or sf_datawrite only when consumed by Alex''s click on its link. Any helper action approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} (sb3_runner-r4q r2; O6). A queued no-click action over 10 minutes old is marked failed the same way, without the reason. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run is open returns the same action and run. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x; dataop_link-k7d; dataop_write-j5w; sb3_runner-r4q).';
revoke all on function public.switchboard_pickup_helper(uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[], uuid) to service_role;

-- ============================================================================
-- 2. switchboard_pickup_git: the same 15-minute rule, for every helper kind, and the same pickup id.
-- ============================================================================
create function public.switchboard_pickup_git(p_user uuid, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery', 'sf_datawrite'];
  v_action public.switchboard_actions;
  v_run    uuid;
  v_again  uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_git: no user.' using errcode = '22004';
  end if;

  -- r2: an approved action of any helper kind not picked up within 15 minutes of its approval never runs.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_all) and status = 'consumed' and picked_up_at is null
       and (coalesce(link_used_at, created_at) < now() - interval '15 minutes'
            or (kind = any(c_prod) and link_used_at is null))
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
  select p_user, id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true, 'reason', 'expired_not_picked_up'), 'expired_not_picked_up', now()
    from stale;

  -- r2: a repeat of a pickup whose reply was lost gets the same action and run, while that run is open. A repeat
  -- sent while the first is still running waits for it here, so it sees the first one's run.
  if p_pickup_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('switchboard_pickup:' || p_pickup_id::text, 0));
    select r.id, a.id into v_run, v_again
      from public.switchboard_runs r
      join public.switchboard_actions a on a.id = r.action_id
     where r.user_id = p_user and r.finished_at is null and r.mode = 'real'
       and r.result is not null and r.result->>'pickup_id' = p_pickup_id::text
       and a.user_id = p_user and a.kind = 'git' and a.status = 'consumed' and a.picked_up_at is not null
     order by r.started_at desc
     limit 1;
    if v_again is not null then
      select * into v_action from public.switchboard_actions where id = v_again;
      return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'project_code', v_action.project_code,
                                'payload', v_action.payload, 'fingerprint', v_action.fingerprint,
                                'headline', v_action.headline, 'chat_url', v_action.chat_url);
    end if;
  end if;

  -- Ready: clicked (consumed) within 15 minutes, or queued and needing no click. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = 'git' and a.picked_up_at is null
     and ((a.status = 'consumed' and coalesce(a.link_used_at, a.created_at) >= now() - interval '15 minutes')
          or (a.status = 'queued' and not a.needs_click))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind = 'git' and b.project_code = a.project_code
                        and b.picked_up_at is not null and b.status = 'consumed')
   order by a.created_at, a.id
   limit 1
   for update skip locked;
  if not found then
    return null;
  end if;

  update public.switchboard_actions
     set picked_up_at = now(), status = 'consumed'
   where id = v_action.id;
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
  values (p_user, v_action.id, 'real', 'picked up by the helper',
          case when p_pickup_id is null then null else jsonb_build_object('pickup_id', p_pickup_id) end)
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'project_code', v_action.project_code,
                            'payload', v_action.payload, 'fingerprint', v_action.fingerprint,
                            'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_git(uuid, uuid) is
  'Switchboard: hand the helper the oldest git action of p_user that is ready to run: clicked within 15 minutes, or queued and needing no click. One at a time per project code. Any helper action, of any kind, approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed first, with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} (sb3_runner-r4q r2). Sets picked_up_at, marks it consumed and opens a real run row. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run is open returns the same action and run. Returns {action_id, run_id, project_code, payload, fingerprint, headline, chat_url}, or null when nothing is ready. Called by switchboard-runner with the service role after it checks the pickup key; no other role can call it.';
revoke all on function public.switchboard_pickup_git(uuid, uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_git(uuid, uuid) to service_role;

-- ============================================================================
-- 3. Result: must say CONFORMANT. Then run supabase/tests/sb3_runner-r4q/1_verify_pickup_expiry.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
