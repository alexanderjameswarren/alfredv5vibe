-- 242: dataop_link-k7d A1. The sf_dataquery action kind: production bulk exports or SELECT COUNT() queries for Data run v2,
-- started only from Alex's click on its approval link; only whole-number counts and a pass flag come back.
-- Kind: schema change (constraints, one new function, three functions replaced). Applied: NO (queued at s7b; only a run id shows it ran).
-- Spec: docs/technical-spec-dataop_link-k7d.md (parts 2 to 6).
-- Test: supabase/tests/dataop_link-k7d/1_verify_sf_dataquery.sql (--test).
-- Tables touched: switchboard_actions (kind, payload and click checks), switchboard_runs (a result check).
-- Functions: switchboard_dataquery_payload_ok (new); switchboard_needs_click, switchboard_queue_helper and
-- switchboard_pickup_helper replaced, same signatures. switchboard_issue_link and switchboard_stakes are unchanged (the
-- url carries kind=sf_dataquery; stakes is change). sf_dataop and every other kind behave exactly as before.
-- The 4-hour limit on a picked run is switchboard-runner's (stalePicks), not the database's.
-- Deploy order: this migration first, then mcp and switchboard-runner.

-- ============================================================================
-- 1. The kind.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_read', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs',
                  'sf_dataop', 'sf_dataquery'));

-- ============================================================================
-- 2. The payload (spec parts 2 to 4). A function, because each query's SHA-256 is checked against its SOQL's bytes and
--    a CHECK cannot loop. Never raises: anything wrong, or unexpected, is false.
-- ============================================================================
create or replace function public.switchboard_dataquery_payload_ok(p_payload jsonb, p_project_code text)
returns boolean
language plpgsql
stable  -- not immutable: convert_to is stable
set search_path = public, pg_temp
as $$
declare
  c_keys   constant text[] := array['alias', 'repo', 'run', 'run_tag', 'request_sha256', 'queries'];
  c_qkeys  constant text[] := array['step', 'soql', 'sha256', 'file', 'label'];
  v_code   text := p_project_code;
  v_run    text;
  v_tag    text;
  v_q      jsonb;
  v_soql   text;
  v_step   text;
  v_first  text;
  v_labels text[] := '{}';
  v_label  text;
  v_any_label boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or v_code is null or v_code !~ '^[a-z0-9][a-z0-9_-]{1,40}$' then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(p_payload) k where not (k = any(c_keys))) then return false; end if;
  if length(p_payload::text) > 220000 then return false; end if;

  if jsonb_typeof(p_payload->'alias') is distinct from 'string'
     or p_payload->>'alias' !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' then
    return false;
  end if;
  -- repo: as sf_dataop's (240).
  if jsonb_typeof(p_payload->'repo') is distinct from 'string' or length(p_payload->>'repo') > 240
     or p_payload->>'repo' !~ '^[A-Za-z]:(\\[^\\/:*?"<>|[:cntrl:]]+)+$' or strpos(p_payload->>'repo', '..') > 0 then
    return false;
  end if;
  -- run: data-ops/<this action's project code>/<one folder>, / or \.
  v_run := p_payload->>'run';
  if jsonb_typeof(p_payload->'run') is distinct from 'string' or length(v_run) > 200 or strpos(v_run, '..') > 0
     or left(v_run, 9) not in ('data-ops/', 'data-ops\')
     or substr(v_run, 10, length(v_code)) <> v_code
     or substr(v_run, 10 + length(v_code)) !~ '^[\\/][A-Za-z0-9_.-]{1,80}$'
     or substr(v_run, 10 + length(v_code)) ~ '^[\\/]\.+$' then
    return false;
  end if;
  -- run_tag: <code>-s<n>[letters]-<4>, 234's pattern.
  v_tag := p_payload->>'run_tag';
  if jsonb_typeof(p_payload->'run_tag') is distinct from 'string' or length(v_tag) > 60
     or left(v_tag, length(v_code) + 2) <> v_code || '-s'
     or substr(v_tag, length(v_code) + 3) !~ '^[0-9]+[a-z]*-[a-z0-9]{4}$' then
    return false;
  end if;
  if p_payload ? 'request_sha256'
     and (jsonb_typeof(p_payload->'request_sha256') is distinct from 'string' or p_payload->>'request_sha256' !~ '^[0-9a-f]{64}$') then
    return false;
  end if;

  if jsonb_typeof(p_payload->'queries') is distinct from 'array'
     or jsonb_array_length(p_payload->'queries') not between 1 and 40 then
    return false;
  end if;

  for v_q in select value from jsonb_array_elements(p_payload->'queries') loop
    if jsonb_typeof(v_q) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v_q) k where not (k = any(c_qkeys))) then return false; end if;
    v_step := case when jsonb_typeof(v_q->'step') = 'string' then v_q->>'step' end;
    if v_step is null or v_step not in ('manifest', 'before', 'undo', 'preflight-counts', 'rules') then return false; end if;
    -- All exports (manifest, before, undo) or all counts of one step.
    if v_first is null then
      v_first := v_step;
    elsif (v_first in ('manifest', 'before', 'undo')) <> (v_step in ('manifest', 'before', 'undo'))
          or (v_step not in ('manifest', 'before', 'undo') and v_step <> v_first) then
      return false;
    end if;

    if jsonb_typeof(v_q->'soql') is distinct from 'string' then return false; end if;
    v_soql := v_q->>'soql';
    if strpos(v_soql, ';') > 0 then return false; end if;
    if jsonb_typeof(v_q->'sha256') is distinct from 'string'
       or v_q->>'sha256' <> encode(sha256(convert_to(v_soql, 'UTF8')), 'hex') then
      return false;
    end if;

    -- Blank space (spaces, tabs, newlines) may come before SELECT; the sha256 above covers it as sent. Blank space is
    -- [ \t\r\n] exactly, not \s, so the queue tool's JavaScript patterns match these character for character.
    if v_step in ('manifest', 'before', 'undo') then
      if char_length(v_soql) > 100000
         or v_soql !~* '^[ \t\r\n]*SELECT[ \t\r\n]+Id([ \t\r\n]*,|[ \t\r\n]+FROM[ \t\r\n])'
         or v_soql ~* 'COUNT[ \t\r\n]*\(' then
        return false;
      end if;
    else
      if char_length(v_soql) > 8000
         or v_soql !~* '^[ \t\r\n]*SELECT[ \t\r\n]+COUNT\(\)[ \t\r\n]+FROM[ \t\r\n]+[A-Za-z][A-Za-z0-9_]*[ \t\r\n]+WHERE[ \t\r\n]'
         or v_soql ~* 'GROUP[ \t\r\n]+BY' then
        return false;
      end if;
    end if;

    -- Exactly one of file and label.
    if (v_q ? 'file') = (v_q ? 'label') then return false; end if;
    if v_q ? 'file' then
      if jsonb_typeof(v_q->'file') <> 'string' or v_q->>'file' !~ '^[A-Za-z0-9_.-]{1,80}\.soql$' then return false; end if;
    else
      v_label := case when jsonb_typeof(v_q->'label') = 'string' then v_q->>'label' end;
      if v_label is null or char_length(v_label) not between 1 and 200 or btrim(v_label) = ''
         or v_label ~ '[\r\n]' or v_label = any(v_labels) then
        return false;
      end if;
      v_labels := v_labels || v_label;
      v_any_label := true;
    end if;
  end loop;

  -- A query built from request.json is tied to it by the request's hash (spec part 3).
  if v_any_label and not (p_payload ? 'request_sha256') then return false; end if;
  return true;
exception when others then
  return false;
end;
$$;
comment on function public.switchboard_dataquery_payload_ok(jsonb, text) is
  'Switchboard: whether an sf_dataquery payload meets docs/technical-spec-dataop_link-k7d.md parts 2 to 4 for the action''s project code: alias, repo, run (data-ops/<code>/<run>), run_tag, request_sha256 (needed with any label), and 1 to 40 queries, all exports (manifest, before, undo) or all counts of one step (preflight-counts, rules); each {step, soql, sha256, file | label}, sha256 the SHA-256 of soql''s UTF-8 bytes, no semicolon; blank space allowed before SELECT; counts SELECT COUNT() FROM <object> WHERE ..., no GROUP BY, at most 8,000 characters; exports SELECT Id ..., no COUNT(, at most 100,000; the payload at most 220,000. Never raises. Used by switchboard_actions_sf_dataquery_payload.';
revoke all on function public.switchboard_dataquery_payload_ok(jsonb, text) from public, anon;
grant execute on function public.switchboard_dataquery_payload_ok(jsonb, text) to authenticated, service_role;

alter table public.switchboard_actions
  add constraint switchboard_actions_sf_dataquery_payload check (
    kind <> 'sf_dataquery' or coalesce(public.switchboard_dataquery_payload_ok(payload, project_code), false)
  );
comment on constraint switchboard_actions_sf_dataquery_payload on public.switchboard_actions is
  'sf_dataquery payload (docs/technical-spec-dataop_link-k7d.md parts 2 to 4), checked by switchboard_dataquery_payload_ok against the action''s project code.';

-- An sf_dataquery always waits for Alex's click, whoever queued it, as sf_dataop.
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_dataquery_click check (kind <> 'sf_dataquery' or needs_click);
comment on constraint switchboard_actions_sf_dataquery_click on public.switchboard_actions is
  'An sf_dataquery (a production export or count) always needs Alex''s click by link, whoever queued it.';

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). sf_dataquery: {"alias", "repo", "run", "run_tag", "request_sha256"?, "queries": [{"step", "soql", "sha256", "file" | "label"}]} (docs/technical-spec-dataop_link-k7d.md). Fixed after insert.';

-- ============================================================================
-- 3. The run's result for an sf_dataquery (spec part 5): {ok, exit_code?, query_counts, pass}. Keyed on query_counts,
--    which no other kind writes (an sql run's result already has its own "counts"), so every existing row meets it.
--    That the counts match the payload's queries, by position, is switchboard-runner's check.
-- ============================================================================
alter table public.switchboard_runs
  add constraint switchboard_runs_dataquery_result check (
    result is null or not (result ? 'query_counts')
    or coalesce((
      result - array['ok', 'exit_code', 'query_counts', 'pass'] = '{}'::jsonb
      and jsonb_typeof(result->'ok') = 'boolean'
      and (not (result ? 'exit_code') or jsonb_typeof(result->'exit_code') = 'number')
      and (not (result ? 'pass') or jsonb_typeof(result->'pass') = 'boolean')
      and (result->'ok' = 'false'::jsonb or result ? 'pass')
      and case when jsonb_typeof(result->'query_counts') = 'array'
               then jsonb_array_length(result->'query_counts') between 1 and 40
                    and jsonb_array_length(result->'query_counts') = jsonb_array_length(jsonb_path_query_array(result,
                          '$.query_counts[*] ? (@.type() == "number" && @ >= 0 && @ <= 999999999 && @ == @.floor())'))
               else false end
    ), false)
  );
comment on constraint switchboard_runs_dataquery_result on public.switchboard_runs is
  'An sf_dataquery run''s result (docs/technical-spec-dataop_link-k7d.md part 5): only ok, exit_code, query_counts (1 to 40 whole numbers, one per query in payload order) and pass (required when ok). No rows, Ids or output.';

-- ============================================================================
-- 4. needs_click: sf_dataquery always. Otherwise as 240.
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
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sf_read' then true   -- every Salesforce read, by link (s89a, spec 10)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 10, 11.1, 11.4). Every kind does for now. sf_dataop (dataops_alfred-d4x, D1) and sf_dataquery (dataop_link-k7d) always do, whoever queued them, and their _click checks hold that too. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 5. switchboard_queue_helper takes sf_dataquery, which needs its project code (none is derived). Same signature.
-- ============================================================================
create or replace function public.switchboard_queue_helper(p_kind text, p_project_code text, p_payload jsonb,
                                                           p_headline text, p_chat_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_code text := nullif(btrim(coalesce(p_project_code, '')), '');
  v_id   uuid;
begin
  if v_user is null then
    raise exception 'switchboard_queue_helper: no signed-in user.' using errcode = '28000';
  end if;
  if p_kind is null or p_kind not in ('git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery') then
    raise exception 'switchboard_queue_helper: % is not a helper kind (git, sf_check, sf_read, sb_setup, sf_dataop, sf_dataquery).', coalesce(p_kind, 'null')
      using errcode = '23514';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'switchboard_queue_helper: the payload must be a JSON object.' using errcode = '23514';
  end if;
  if p_headline is null or btrim(p_headline) = '' then
    raise exception 'switchboard_queue_helper: a headline is required.' using errcode = '23514';
  end if;

  -- Only the strings the payload checks accept are used; anything else leaves the code null and is refused below.
  if v_code is null and p_kind in ('sf_check', 'sf_read') and jsonb_typeof(p_payload->'alias') = 'string' then
    v_code := 'sf-' || left(regexp_replace(lower(p_payload->>'alias'), '[^a-z0-9_-]', '_', 'g'), 37);
  elsif v_code is null and p_kind = 'sb_setup' and jsonb_typeof(p_payload->'client') = 'string' then
    v_code := 'sb-' || left(p_payload->>'client', 37);
  end if;
  if v_code is null then
    raise exception 'switchboard_queue_helper: % needs a project code (sf_check, sf_read and sb_setup derive one from the alias or client; git, sf_dataop and sf_dataquery never do).',
      p_kind using errcode = '23514';
  end if;

  -- The guard trigger sets fingerprint, status and needs_click; the table's checks refuse a bad code or payload.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, chat_url, created_by)
  values (v_user, p_kind, v_code, p_payload, btrim(p_headline), p_chat_url, 'claude')
  returning id into v_id;
  return jsonb_build_object('action_id', v_id, 'project_code', v_code);
end;
$$;
comment on function public.switchboard_queue_helper(text, text, jsonb, text, text) is
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check, sf_read, sb_setup, sf_dataop or sf_dataquery) for the signed-in caller, as created_by claude, and return {action_id, project_code}. git, sf_dataop and sf_dataquery need p_project_code; with none, an sf_check or sf_read uses sf-<alias> and an sb_setup sb-<client>, so the one-live-link and one-running limits hold per alias and per client. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 10, 11.3-11.6; dataops_alfred-d4x; dataop_link-k7d).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- ============================================================================
-- 6. switchboard_pickup_helper: c_all gains sf_dataquery; the default stays today's four, so neither production kind
--    goes to a caller that did not name it. sf_dataquery gets sf_dataop's rules unchanged: handed out only consumed by
--    the click on its link, within 15 minutes of the click, and failed unrun past that (O6). Same signature, so create
--    or replace keeps the one function.
-- ============================================================================
create or replace function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery'];
  c_prod   constant text[] := array['sf_dataop', 'sf_dataquery'];
  v_kinds  text[];
  v_action public.switchboard_actions;
  v_run    uuid;
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

  -- O6: an approved production data run, export or count not picked up within 15 minutes of the click never runs.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = any(c_prod) and status = 'consumed' and picked_up_at is null
       and (link_used_at is null or link_used_at < now() - interval '15 minutes')
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from stale;

  -- Ready: clicked (consumed), or queued and needing no click. A production kind only clicked, by its link. Not while
  -- that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = any(v_kinds) and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
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
  insert into public.switchboard_runs (user_id, action_id, mode, summary)
  values (p_user, v_action.id, 'real', 'picked up by the helper')
  returning id into v_run;

  return jsonb_build_object('action_id', v_action.id, 'run_id', v_run, 'kind', v_action.kind,
                            'project_code', v_action.project_code, 'payload', v_action.payload,
                            'fingerprint', v_action.fingerprint, 'headline', v_action.headline, 'chat_url', v_action.chat_url);
end;
$$;
comment on function public.switchboard_pickup_helper(uuid, text[]) is
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop and sf_dataquery only when named), that is ready to run: clicked, or queued and needing no click. An sf_dataop or sf_dataquery only when consumed by Alex''s click on its link, within 15 minutes of the click; one approved longer ago is marked failed with a run saying it expired (O6). A queued no-click action over 10 minutes old is marked failed the same way. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x; dataop_link-k7d).';
revoke all on function public.switchboard_pickup_helper(uuid, text[]) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[]) to service_role;

-- ============================================================================
-- 7. Result: must say CONFORMANT. Then run supabase/tests/dataop_link-k7d/1_verify_sf_dataquery.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
