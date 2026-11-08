-- Switchboard 2.0 s86b: helper kinds. sf_check (read-only sandbox checks, no click) and sb_setup (sb client start
-- and sb org add answers, always a click) join git as actions the desktop helper runs.
-- Spec: docs/technical-spec-switchboard2-h8r.md 11.4-11.7. Tables touched: switchboard_actions, switchboard_runs.

-- 1. The new kinds.
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs'));

-- A CHECK passes on NULL (the 207 bug), and ->, ->> and jsonb_typeof give NULL for a missing key. So every
-- condition below is coalesced to false: a missing key fails it rather than slipping through.

-- 2. An sf_check: one of the six checks, an alias, a metadata type only for metadata, and no other key.
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_check_payload check (
    kind <> 'sf_check'
    or (coalesce(payload->>'check', '') in ('org-verify', 'limits', 'metadata-types', 'metadata', 'retrieve-preview', 'deploy-preview')
        and coalesce(jsonb_typeof(payload->'alias') = 'string', false)
        and coalesce(payload->>'alias' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$', false)
        and case when payload->>'check' = 'metadata'
                 then coalesce(jsonb_typeof(payload->'metadata_type') = 'string', false)
                      and coalesce(payload->>'metadata_type' ~ '^[A-Za-z]{1,80}$', false)
                 else not coalesce(payload ? 'metadata_type', false) end
        and coalesce(payload - array['check', 'alias', 'metadata_type'] = '{}'::jsonb, false))
  );

-- 3. An sb_setup, with Alex's D2 limits held here too: sandboxes only, level objects or metadata, and no contract
--    flag anywhere. Every org must pass, so the count of passing orgs must equal the count of orgs. The array
--    lengths sit behind a CASE, because jsonb_array_length raises on a non-array and AND is not ordered.
alter table public.switchboard_actions
  add constraint switchboard_actions_sb_setup_payload check (
    kind <> 'sb_setup'
    or (coalesce(payload->>'command', '') in ('client start', 'org add')
        and coalesce(payload->>'client', '') ~ '^[a-z0-9][a-z0-9_-]{0,40}$'
        and coalesce(payload - array['command', 'client', 'repo', 'adopt', 'from_sandbox', 'project', 'name', 'sandboxes',
                                     'integration_ok', 'orgs'] = '{}'::jsonb, false)
        and case when coalesce(jsonb_typeof(payload->'orgs') = 'array', false)
                 then jsonb_array_length(payload->'orgs') between 1 and 10
                      and jsonb_array_length(payload->'orgs') = jsonb_array_length(jsonb_path_query_array(payload,
                            '$.orgs[*] ? (@.alias like_regex "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$"
                                          && (@."type" == "developer" || @."type" == "developer_pro" || @."type" == "partial" || @."type" == "full")
                                          && (@.level == "objects" || @.level == "metadata"))'))
                 else false end
        and not coalesce(jsonb_path_exists(payload,
              '$.orgs[*].keyvalue() ? (!(@.key == "alias" || @.key == "type" || @.key == "level" || @.key == "login"
                                         || @.key == "cli_deploy" || @.key == "shared"))', '{}'::jsonb, true), true))
  );

-- 4. The click rules: a sandbox check runs with no click (D3); an sb setup always waits for one.
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click for the first two weeks
    when p_kind = 'sf_check' then false -- read-only, on a sandbox the helper proves first (spec 11.4)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 11.1, 11.4). git always does for now; sf_check never does; sb_setup always does; everything else does. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- 5. Queueing any helper kind as the signed-in caller. Authenticated cannot insert into switchboard_actions (189).
create or replace function public.switchboard_queue_helper(p_kind text, p_project_code text, p_payload jsonb,
                                                           p_headline text, p_chat_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'switchboard_queue_helper: no signed-in user.' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('git', 'sf_check', 'sb_setup') then
    raise exception 'switchboard_queue_helper: % is not a helper kind (git, sf_check, sb_setup).', coalesce(p_kind, 'null')
      using errcode = '23514';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'switchboard_queue_helper: the payload must be a JSON object.' using errcode = '23514';
  end if;
  if p_headline is null or btrim(p_headline) = '' then
    raise exception 'switchboard_queue_helper: a headline is required.' using errcode = '23514';
  end if;

  -- The guard trigger sets fingerprint, status and needs_click; the table's checks refuse a bad code or payload.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, chat_url, created_by)
  values (v_user, p_kind, p_project_code, p_payload, btrim(p_headline), p_chat_url, 'claude')
  returning id into v_id;
  return jsonb_build_object('action_id', v_id);
end;
$$;
comment on function public.switchboard_queue_helper(text, text, jsonb, text, text) is
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check or sb_setup) for the signed-in caller, as created_by claude, and return {action_id}. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 11.3-11.6).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- 6. switchboard_queue_git keeps its signature and behaviour, through the helper queue.
create or replace function public.switchboard_queue_git(p_project_code text, p_payload jsonb, p_headline text, p_chat_url text default null)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.switchboard_queue_helper('git', p_project_code, p_payload, p_headline, p_chat_url);
$$;
comment on function public.switchboard_queue_git(text, jsonb, text, text) is
  'Switchboard: queue a git action for the signed-in caller and return {action_id}: switchboard_queue_helper with kind git. Called by the queue_switchboard_git tool (spec 11.3).';
revoke all on function public.switchboard_queue_git(text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_git(text, jsonb, text, text) to authenticated;

-- 7. The helper's pickup for every helper kind: the oldest ready action, one running at a time per project, any kind.
create or replace function public.switchboard_pickup_helper(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action public.switchboard_actions;
  v_run    uuid;
begin
  if p_user is null then
    raise exception 'switchboard_pickup_helper: no user.' using errcode = '22004';
  end if;

  -- A no-click action must not run long after it was queued: past 10 minutes it fails, with a run saying why.
  with expired as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind in ('git', 'sf_check', 'sb_setup') and status = 'queued' and not needs_click
       and picked_up_at is null and created_at < now() - interval '10 minutes'
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired before the helper picked it up: queued over 10 minutes ago, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from expired;

  -- Ready: clicked (consumed), or queued and needing no click. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind in ('git', 'sf_check', 'sb_setup') and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind in ('git', 'sf_check', 'sb_setup')
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
  insert into public.switchboard_runs (user_id, action_id, mode, summary)
  values (p_user, v_action.id, 'real', 'picked up by the helper')
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                            'project_code', v_action.project_code, 'payload', v_action.payload,
                            'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_helper(uuid) is
  'Switchboard: hand the helper the oldest action of p_user, of kind git, sf_check or sb_setup, that is ready to run: clicked, or queued and needing no click. A queued no-click action over 10 minutes old is marked failed first, with a run whose summary says it expired, and is never run. One running at a time per project code, across those kinds. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key. switchboard_pickup_git stays until the runner moves over (s86c).';
revoke all on function public.switchboard_pickup_helper(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid) to service_role;

-- 8. The payload column says what each helper kind holds.
comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...} (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], ...} (spec 11.5). Fixed after insert.';
