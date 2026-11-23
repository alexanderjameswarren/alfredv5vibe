-- 248, sb3_runner-r4q r7 (L1): the helper action kind sf_run, for the run pages (sb3_pages-h6v, Q5). Schema change.
-- Spec: switchboard repo docs/technical-spec-sb3_plumbing-n7c.md L1; the pages contract
-- docs/technical-spec-sb3_pages-h6v.md (parts 2, 4.5, 5: "Consume creates the helper action of plumbing's new kind").
-- Tables: switchboard_actions (kind check, two new checks, payload comment). Functions: switchboard_needs_click,
-- switchboard_actions_guard, switchboard_pickup_helper, switchboard_pickup_git (as in 247, with sf_run in c_all).
-- No data changes.
--
-- What sf_run is:
-- - Created by the pages' consume (switchboard_consume_run_link, a security definer function) or the service role,
--   already approved: the guard inserts it consumed, so its approval time is created_at (capped at now()). Alex's
--   click on the run page is the approval; there is no switchboard link (link_hash, link_used_at stay null).
--   switchboard_queue_helper still refuses the kind, and signed-in users have no insert on the table, so no other
--   path creates one.
-- - payload: a JSON object carrying link_id, the run page's link id (a uuid), which every result line uses, also for a
--   resend. Its other keys belong to the data runs thread.
-- - needs_click true, always (switchboard_actions_sf_run_click holds it too).
-- - Handed out by switchboard_pickup_helper only to a helper that names sf_run in p_kinds, never by default, within
--   15 minutes of created_at; after that the next pickup (either function) fails it with failure_reason
--   'expired_not_picked_up', which the pages read as "Not started. Nothing ran." (part 4.5).
-- - One running per project code, across every helper kind, as for the others.

-- ============================================================================
-- 1. The kind, its payload and its click.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_read', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs',
                  'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'));

alter table public.switchboard_actions
  add constraint switchboard_actions_sf_run_payload check (
    kind <> 'sf_run'
    or coalesce(jsonb_typeof(payload) = 'object'
                and jsonb_typeof(payload->'link_id') = 'string'
                and payload->>'link_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                and octet_length(payload::text) <= 200000, false)
  );
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_run_click check (kind <> 'sf_run' or needs_click);

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). sf_dataquery: {"alias", "org_type": "sandbox|production" (required on insert since dataquery_fixes-v3n), "repo", "run", "run_tag", "request_sha256"?, "queries": [{"step", "soql", "sha256", "file" | "label"}]} (docs/technical-spec-dataop_link-k7d.md). sf_run: {"link_id": "<run page link id, a uuid>", ...the data runs thread''s keys} (sb3_runner-r4q, for sb3_pages-h6v). Fixed after insert.';

-- ============================================================================
-- 2. needs_click: sf_run always. Otherwise as 245.
-- ============================================================================
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'sf_dataop' then true -- a production data run: always, by link only (D1). Never loosen this line.
    when p_kind = 'sf_dataquery' then true -- a production export or count: always, by link only. Never loosen this line.
    when p_kind = 'sf_datawrite' then true -- a data run's write link: always, by link only. Never loosen this line.
    when p_kind = 'sf_run' then true    -- a run page's run: approved by Alex's click on the page. Never loosen this line.
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sf_read' then true   -- every Salesforce read, by link (s89a, spec 10)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 10, 11.1, 11.4). Every kind does for now. sf_dataop (dataops_alfred-d4x, D1), sf_dataquery (dataop_link-k7d), sf_datawrite (dataop_write-j5w) and sf_run (sb3_runner-r4q; the click is on its run page) always do, whoever queued them, and their _click checks hold that too. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 3. The guard: as 244, plus one INSERT branch: a new sf_run starts consumed (approved by its page's click).
-- ============================================================================
create or replace function public.switchboard_actions_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- dataquery_fixes-v3n: required on a new row only, so older rows without it can still change status.
    if new.kind = 'sf_dataquery'
       and (jsonb_typeof(new.payload->'org_type') is distinct from 'string'
            or new.payload->>'org_type' not in ('sandbox', 'production')) then
      raise exception 'switchboard_actions: a new sf_dataquery needs payload.org_type, exactly "sandbox" or "production", as sb prints it.'
        using errcode = '23514';
    end if;
    new.fingerprint     := public.switchboard_fingerprint(new.payload);
    -- sb3_runner-r4q: an sf_run is created by its run page's consume, after Alex's click, so it is approved at insert.
    -- It has no switchboard link; its approval time is created_at, never later than now, so its 15 minutes can't be
    -- stretched (an earlier time only makes it expire sooner).
    new.status          := case when new.kind = 'sf_run' then 'consumed' else 'queued' end;
    if new.kind = 'sf_run' then
      new.created_at := least(coalesce(new.created_at, now()), now());
    end if;
    new.link_hash       := null;
    new.link_expires_at := null;
    new.link_used_at    := null;
    new.picked_up_at    := null;
    new.needs_click     := public.switchboard_needs_click(new.kind, new.payload, new.created_by);
    return new;
  end if;
  if new.payload is distinct from old.payload or new.fingerprint is distinct from old.fingerprint
     or new.kind is distinct from old.kind or new.headline is distinct from old.headline
     or new.needs_click is distinct from old.needs_click then
    raise exception 'switchboard_actions: payload, fingerprint, kind, headline and needs_click never change. Queue a new action.'
      using errcode = '23514';
  end if;
  if old.link_used_at is not null
     and (new.link_used_at is distinct from old.link_used_at or new.link_hash is distinct from old.link_hash
          or new.link_expires_at is distinct from old.link_expires_at) then
    raise exception 'switchboard_actions: a used link never changes.' using errcode = '23514';
  end if;
  if old.picked_up_at is not null and new.picked_up_at is distinct from old.picked_up_at then
    raise exception 'switchboard_actions: picked_up_at is set once.' using errcode = '23514';
  end if;
  new.id         := old.id;
  new.user_id    := old.user_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;
comment on function public.switchboard_actions_guard() is
  'Switchboard: before insert or update on switchboard_actions. An insert gets its fingerprint and needs_click (switchboard_needs_click) and starts queued with no link, except an sf_run, which starts consumed with created_at at most now(): its run page''s consume creates it after Alex''s click (sb3_runner-r4q). A new sf_dataquery must have payload.org_type "sandbox" or "production" (dataquery_fixes-v3n). An update cannot change what will run or whether it needs a click, reopen a used link, or change picked_up_at once set, whoever makes it.';
-- A trigger function needs no execute grant to fire; these keep the grants it already had.
revoke all on function public.switchboard_actions_guard() from public, anon;
grant execute on function public.switchboard_actions_guard() to authenticated, service_role;

-- ============================================================================
-- 4. switchboard_pickup_helper: as 247, with sf_run in c_all. It goes only to a caller that names it, like the
--    production kinds; it is consumed at insert, so the 15-minute rule counts from created_at.
-- ============================================================================
create or replace function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'];
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
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop, sf_dataquery, sf_datawrite and sf_run only when named), that is ready to run: clicked within 15 minutes, or queued and needing no click. An sf_dataop, sf_dataquery or sf_datawrite only when consumed by Alex''s click on its link; an sf_run is consumed at insert by its run page''s consume, so its 15 minutes count from created_at. Any helper action approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} and failure_reason expired_not_picked_up (sb3_runner-r4q r2; O6). A queued no-click action over 10 minutes old is marked failed the same way, without the reason. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run is open returns the same action and run. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x; dataop_link-k7d; dataop_write-j5w; sb3_runner-r4q).';
revoke all on function public.switchboard_pickup_helper(uuid, text[], uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[], uuid) to service_role;

-- ============================================================================
-- 5. switchboard_pickup_git: as 247, with sf_run in c_all, so it too fails an sf_run past its 15 minutes.
-- ============================================================================
create or replace function public.switchboard_pickup_git(p_user uuid, p_pickup_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'];
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
  'Switchboard: hand the helper the oldest git action of p_user that is ready to run: clicked within 15 minutes, or queued and needing no click. One at a time per project code. Any helper action, of any kind (sf_run included), approved (consumed) over 15 minutes ago, by coalesce(link_used_at, created_at), and never picked up is marked failed first, with a finished run, result {ok: false, expired: true, reason: expired_not_picked_up} and failure_reason expired_not_picked_up (sb3_runner-r4q r2). Sets picked_up_at, marks it consumed and opens a real run row. With p_pickup_id the run row carries result {pickup_id} until the helper''s result replaces it, and a repeat with the same id while that run is open returns the same action and run. Returns {action_id, run_id, project_code, payload, fingerprint, headline, chat_url}, or null when nothing is ready. Called by switchboard-runner with the service role after it checks the pickup key; no other role can call it.';
revoke all on function public.switchboard_pickup_git(uuid, uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_git(uuid, uuid) to service_role;

-- ============================================================================
-- 6. Result: must say CONFORMANT. Then run supabase/tests/sb3_runner-r4q/2_verify_sf_run.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
