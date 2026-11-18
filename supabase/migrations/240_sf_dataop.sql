-- 240: dataops_alfred-d4x A1. The sf_dataop action kind, the production data run started only from an approval link
-- (switchboard spec D1), and an objects list on an sf_read at level metadata. Kind: schema change (constraints, one
-- new column, three functions replaced). Applied: NO (queued at s4b; only a run id shows it ran).
-- Spec: docs/technical-spec-dataops_alfred-d4x.md (the payload contract and the four layers).
-- Test: supabase/tests/dataops_alfred-d4x/1_verify_sf_dataop.sql (--test).
-- Tables touched: switchboard_actions (kind, payload checks, click check), switchboard_runs (pickup's run rows, no
-- schema change), switchboard_sf_read_log (new objects column).
-- Functions replaced: switchboard_needs_click, switchboard_queue_helper, switchboard_pickup_helper (dropped and
-- recreated with p_kinds). switchboard_issue_link and switchboard_stakes are unchanged (O5): the url carries
-- kind=sf_dataop, and stakes is change.
-- Deploy order: this migration first, then mcp and switchboard-runner (both write the read log's objects column).

-- ============================================================================
-- 1. The kind.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_read', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs',
                  'sf_dataop'));

-- ============================================================================
-- 2. The sf_dataop payload (the contract in the spec). Display keys are copies the helper checks against the stamped
--    plan; the stamp binds the click to the plan. Every non-scalar is checked behind a CASE, because - and
--    jsonb_array_length raise on the wrong type and AND is not ordered; the whole check is coalesced to false, since a
--    CHECK passes on NULL (the 207 lesson).
-- ============================================================================
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_dataop_payload check (
    kind <> 'sf_dataop'
    or coalesce((
      payload - array['alias', 'repo', 'plan', 'stamp', 'preflight_at', 'object', 'problem', 'expected', 'write', 'rows',
                      'rehearsal'] = '{}'::jsonb
      and length(payload::text) <= 16000
      and jsonb_typeof(payload->'alias') = 'string'
      and payload->>'alias' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
      -- repo: an absolute Windows path, as a gitnewtree's (222); plan: relative to it, a .json file.
      and jsonb_typeof(payload->'repo') = 'string'
      and length(payload->>'repo') <= 240
      and payload->>'repo' ~ '^[A-Za-z]:(\\[^\\/:*?"<>|[:cntrl:]]+)+$'
      and strpos(payload->>'repo', '..') = 0
      and jsonb_typeof(payload->'plan') = 'string'
      and length(payload->>'plan') <= 260
      and payload->>'plan' ~ '^[A-Za-z0-9_.-]+([\\/][A-Za-z0-9_.-]+)*\.json$'
      and strpos(payload->>'plan', '..') = 0
      and jsonb_typeof(payload->'stamp') = 'string'
      and payload->>'stamp' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(payload->'preflight_at') = 'string'
      and payload->>'preflight_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      and jsonb_typeof(payload->'object') = 'string'
      and payload->>'object' ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'
      and jsonb_typeof(payload->'problem') = 'string'
      and char_length(payload->>'problem') between 20 and 600
      and jsonb_typeof(payload->'expected') = 'number'
      and payload->>'expected' ~ '^[0-9]{1,9}$'
      and (payload->>'expected')::integer >= 1
      -- write: bulk with no class, or batch with its class.
      and case when jsonb_typeof(payload->'write') = 'object'
               then (payload->'write') - array['kind', 'class'] = '{}'::jsonb
                    and case payload->'write'->'kind'
                          when '"bulk"'::jsonb then not ((payload->'write') ? 'class')
                          when '"batch"'::jsonb then jsonb_typeof(payload->'write'->'class') = 'string'
                                                     and payload->'write'->>'class' ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'
                          else false end
               else false end
      -- rows: 1 to 40 of {label, before, goal, knock_on?}.
      and case when jsonb_typeof(payload->'rows') = 'array'
               then jsonb_array_length(payload->'rows') between 1 and 40
                    and jsonb_array_length(payload->'rows') = jsonb_array_length(jsonb_path_query_array(payload,
                          '$.rows[*] ? (@.type() == "object" && @.label.type() == "string" && @.label like_regex "^.{1,200}$"
                                        && @.before.type() == "number" && @.before >= 0 && @.before == @.before.floor()
                                        && @.goal.type() == "number" && @.goal >= 0 && @.goal == @.goal.floor()
                                        && (!exists(@.knock_on) || @.knock_on.type() == "boolean"))'))
                    and not coalesce(jsonb_path_exists(payload,
                          '$.rows[*].keyvalue() ? (!(@.key == "label" || @.key == "before" || @.key == "goal" || @.key == "knock_on"))',
                          '{}'::jsonb, true), true)
               else false end
      -- rehearsal: optional {sandbox, at}.
      and (not (payload ? 'rehearsal')
           or case when jsonb_typeof(payload->'rehearsal') = 'object'
                   then (payload->'rehearsal') - array['sandbox', 'at'] = '{}'::jsonb
                        and jsonb_typeof(payload->'rehearsal'->'sandbox') = 'string'
                        and payload->'rehearsal'->>'sandbox' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
                        and jsonb_typeof(payload->'rehearsal'->'at') = 'string'
                        and payload->'rehearsal'->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$'
                   else false end)
    ), false)
  );
comment on constraint switchboard_actions_sf_dataop_payload on public.switchboard_actions is
  'sf_dataop payload (docs/technical-spec-dataops_alfred-d4x.md, the contract): alias, repo, plan, stamp, preflight_at, object, problem, expected, write, rows, rehearsal (optional). Never Ids, SOQL or scripts: the stamp covers them.';

-- Layer 1 of the refusal of Claude-started production runs (D1): an sf_dataop always waits for Alex's click. The
-- guard trigger sets needs_click from switchboard_needs_click and refuses any later change to it; this holds even if
-- a later migration ever loosens either.
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_dataop_click check (kind <> 'sf_dataop' or needs_click);
comment on constraint switchboard_actions_sf_dataop_click on public.switchboard_actions is
  'An sf_dataop (a production data run) always needs Alex''s click by link (switchboard spec D1), whoever queued it.';

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). Fixed after insert.';

-- ============================================================================
-- 3. sf_read: an objects list (1 to 20 names) at level metadata, instead of object. 235's check otherwise unchanged.
--    It only loosens, so every existing row still meets it. The helper (switchboard salesforce/read/plan.mjs, d4x s6)
--    also refuses a name listed twice.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_sf_read_payload;
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_read_payload check (
    kind <> 'sf_read'
    or coalesce((
      payload - array['alias', 'production', 'level', 'object', 'objects', 'count', 'fields', 'filters', 'limit'] = '{}'::jsonb
      and length(payload::text) <= 8000
      and jsonb_typeof(payload->'alias') = 'string'
      and payload->>'alias' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
      and jsonb_typeof(payload->'production') = 'boolean'
      and coalesce(payload->>'level', '') in ('objects', 'metadata', 'ids', 'data')
      -- objects: nothing else.
      and (payload->>'level' <> 'objects' or not (payload ?| array['object', 'objects', 'count', 'fields', 'filters', 'limit']))
      -- metadata, ids, data: one object; or, at metadata only, an objects list instead.
      and (payload->>'level' = 'objects'
           or case when payload ? 'objects'
                   then payload->>'level' = 'metadata' and not (payload ? 'object')
                        and case when jsonb_typeof(payload->'objects') = 'array'
                                 then jsonb_array_length(payload->'objects') between 1 and 20
                                      and jsonb_array_length(payload->'objects') = jsonb_array_length(jsonb_path_query_array(payload,
                                            '$.objects[*] ? (@.type() == "string" && @ like_regex "^[A-Za-z][A-Za-z0-9_]{0,79}$")'))
                                 else false end
                   else jsonb_typeof(payload->'object') = 'string' and payload->>'object' ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'
              end)
      -- metadata: the object (or objects) only.
      and (payload->>'level' <> 'metadata' or not (payload ?| array['count', 'fields', 'filters', 'limit']))
      -- ids, data: a count, or fields with a row cap; filters optional.
      and (payload->>'level' not in ('ids', 'data') or (
        case when payload ? 'count'
             then payload->'count' = 'true'::jsonb and not (payload ?| array['fields', 'limit'])
             else case when jsonb_typeof(payload->'limit') = 'number'
                       then (payload->>'limit') ~ '^[0-9]+$' and (payload->>'limit')::numeric between 1 and 1000
                       else false end
                  and case when jsonb_typeof(payload->'fields') = 'array'
                           then jsonb_array_length(payload->'fields') between 1 and 50
                                and jsonb_array_length(payload->'fields') = jsonb_array_length(jsonb_path_query_array(payload,
                                      '$.fields[*] ? (@.type() == "string" && @ like_regex "^[A-Za-z][A-Za-z0-9_]{0,79}$")'))
                           else false end
        end
        and (not (payload ? 'filters')
             or case when jsonb_typeof(payload->'filters') = 'array'
                     then jsonb_array_length(payload->'filters') between 1 and 10
                          and jsonb_array_length(payload->'filters') = jsonb_array_length(jsonb_path_query_array(payload,
                                '$.filters[*] ? (@.type() == "object" && @.field.type() == "string"
                                                 && @.field like_regex "^[A-Za-z][A-Za-z0-9_]{0,79}$"
                                                 && ((@.op == "=" || @.op == "!=" || @.op == "<" || @.op == "<=" || @.op == ">" || @.op == ">=")
                                                     && (@.value.type() == "string" || @.value.type() == "number"
                                                         || @.value.type() == "boolean" || @.value.type() == "null")
                                                     || @.op == "in" && @.value.type() == "array"
                                                        && @.value.size() >= 1 && @.value.size() <= 100))'))
                     else false end)
        and not coalesce(jsonb_path_exists(payload,
              '$.filters[*].keyvalue() ? (!(@.key == "field" || @.key == "op" || @.key == "value"))', '{}'::jsonb, true), true)
        and not coalesce(jsonb_path_exists(payload,
              '$.filters[*] ? (@.op == "in").value[*] ? (@.type() == "object" || @.type() == "array")', '{}'::jsonb, true), true)
        -- ids: only the three fields come back. Filters may name any field; the helper applies the contract's limit.
        and (payload->>'level' = 'data' or
          not coalesce(jsonb_path_exists(payload,
                '$.fields[*] ? (!(@ == "Id" || @ == "CreatedDate" || @ == "LastModifiedDate"))', '{}'::jsonb, true), true))
      ))
    ), false)
  );
comment on constraint switchboard_actions_sf_read_payload on public.switchboard_actions is
  'sf_read payload (spec 10): alias, production, level, object (or objects, 1 to 20, at metadata only), count or fields with limit, filters; never SOQL. At ids only Id, CreatedDate and LastModifiedDate come back; ids filters may name any field, and the desktop helper limits them to those three unless the org''s contractAllowsClaude is on (switchboard_prod-w3k spec 7).';

-- ============================================================================
-- 4. The read log keeps an objects list (O4). The table is already registered; a new column needs no grant.
-- ============================================================================
alter table public.switchboard_sf_read_log add column if not exists objects jsonb;
alter table public.switchboard_sf_read_log
  add constraint switchboard_sf_read_log_objects_array check (objects is null or jsonb_typeof(objects) = 'array');
comment on column public.switchboard_sf_read_log.objects is
  'The objects asked for by a metadata read of several objects, a json array of API names; null otherwise (object holds a single one).';

-- ============================================================================
-- 5. An sf_dataop always waits for the click, whoever queued it. Otherwise as 233.
-- ============================================================================
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'sf_dataop' then true -- a production data run: always, by link only (D1). Never loosen this line.
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sf_read' then true   -- every Salesforce read, by link (s89a, spec 10)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 10, 11.1, 11.4). Every kind does for now. sf_dataop always does, whoever queued it (dataops_alfred-d4x, D1), and switchboard_actions_sf_dataop_click holds that too. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 6. switchboard_queue_helper takes sf_dataop, which needs its project code (none is derived). Same signature.
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
  if p_kind is null or p_kind not in ('git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop') then
    raise exception 'switchboard_queue_helper: % is not a helper kind (git, sf_check, sf_read, sb_setup, sf_dataop).', coalesce(p_kind, 'null')
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
    raise exception 'switchboard_queue_helper: % needs a project code (sf_check, sf_read and sb_setup derive one from the alias or client; git and sf_dataop never do).',
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
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check, sf_read, sb_setup or sf_dataop) for the signed-in caller, as created_by claude, and return {action_id, project_code}. git and sf_dataop need p_project_code; with none, an sf_check or sf_read uses sf-<alias> and an sb_setup sb-<client>, so the one-live-link and one-running limits hold per alias and per client. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 10, 11.3-11.6; dataops_alfred-d4x).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- ============================================================================
-- 7. switchboard_pickup_helper takes the kinds the helper runs (O3). With none, today's four, so the runner deployed
--    now (which passes only p_user) keeps working and never hands out an sf_dataop. An sf_dataop goes out only when
--    the caller named it, it was consumed by Alex's click on its link, and the click was under 15 minutes ago; past
--    that it is failed, with a run saying why (O6, sf_dataop only). The one-running-per-project rule now counts
--    sf_dataop too, so nothing else of the helper's runs in that project during a production data run.
--    A new argument changes the signature, so the old function is dropped first (create or replace would add an
--    overload). The runner calls it by name with p_user, which resolves to this one through the default.
-- ============================================================================
drop function if exists public.switchboard_pickup_helper(uuid);
create or replace function public.switchboard_pickup_helper(p_user uuid, p_kinds text[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop'];
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

  -- O6: an approved production data run not picked up within 15 minutes of the click never runs.
  with stale as (
    update public.switchboard_actions
       set status = 'failed'
     where user_id = p_user and kind = 'sf_dataop' and status = 'consumed' and picked_up_at is null
       and (link_used_at is null or link_used_at < now() - interval '15 minutes')
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired: approved over 15 minutes ago and never picked up, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from stale;

  -- Ready: clicked (consumed), or queued and needing no click. An sf_dataop only clicked, by its link. Not while that
  -- project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind = any(v_kinds) and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
     and (a.kind <> 'sf_dataop'
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
  'Switchboard: hand the helper the oldest action of p_user, of a kind in p_kinds (default git, sf_check, sf_read, sb_setup; sf_dataop only when named), that is ready to run: clicked, or queued and needing no click. An sf_dataop only when consumed by Alex''s click on its link, within 15 minutes of the click; one approved longer ago is marked failed with a run saying it expired (O6). A queued no-click action over 10 minutes old is marked failed the same way. One running at a time per project code, across every helper kind. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key (dataops_alfred-d4x).';
revoke all on function public.switchboard_pickup_helper(uuid, text[]) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid, text[]) to service_role;

-- ============================================================================
-- 8. Result: must say CONFORMANT. Then run supabase/tests/dataops_alfred-d4x/1_verify_sf_dataop.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
