-- Switchboard 2.0 s89a: Salesforce reads by link (kind sf_read). Claude queues one read; Alex approves it by a link; the
-- desktop helper runs it with GET requests only, after checking the org, and posts the rows back. The rows live only in
-- switchboard_sf_results, for at most 10 minutes, and are deleted when Claude takes them. Never in switchboard_runs.result
-- (kept 30 days), and not encrypted for now (Alex, 2026-11-11). The read log keeps what was asked and the row count,
-- never rows. Kind: schema change (two new tables, registered). Spec: docs/technical-spec-switchboard2-h8r.md 10.
-- Tables touched: switchboard_actions, switchboard_runs (pickup's run rows), switchboard_settings, switchboard_sf_results,
-- switchboard_sf_read_log.

-- ============================================================================
-- 1. The kind. sf_read_prod_data (189, never used) stays allowed and unused: production is a payload flag instead.
-- ============================================================================
alter table public.switchboard_actions drop constraint switchboard_actions_kind_valid;
alter table public.switchboard_actions
  add constraint switchboard_actions_kind_valid
  check (kind in ('sql', 'git', 'sf_check', 'sb_setup', 'sf_read', 'sf_deploy', 'sf_test', 'sf_read_prod_data', 'docs'));

-- 2. The payload. Never SOQL text: the helper builds the query from these keys.
--    alias       the org alias.
--    production  whether Claude says it is production; the helper refuses when Salesforce or orgs.json disagrees, so
--                the approve page can show PRODUCTION FULL DATA before the click.
--    level       objects (the object list), metadata (one describe), ids or data (rows or a count).
--    object      an API name, letters, digits and _ (so no relationship path). Not for objects.
--    count       true: SELECT COUNT(), with no fields and no limit. ids and data only.
--    fields      1 to 50 API names; at ids only Id, CreatedDate and LastModifiedDate. With limit, 1 to 1000.
--    filters     0 to 10 of {field, op, value}: op =, !=, <, <=, >, >= with a scalar, or in with 1 to 100 scalars; at
--                ids the field is one of the three too. ANDed together by the helper.
-- The whole check is coalesced to false, since a CHECK passes on NULL (the 207 bug). Array lengths sit behind a CASE,
-- because jsonb_array_length raises on a non-array and AND is not ordered.
alter table public.switchboard_actions
  add constraint switchboard_actions_sf_read_payload check (
    kind <> 'sf_read'
    or coalesce((
      payload - array['alias', 'production', 'level', 'object', 'count', 'fields', 'filters', 'limit'] = '{}'::jsonb
      and length(payload::text) <= 8000
      and jsonb_typeof(payload->'alias') = 'string'
      and payload->>'alias' ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$'
      and jsonb_typeof(payload->'production') = 'boolean'
      and coalesce(payload->>'level', '') in ('objects', 'metadata', 'ids', 'data')
      -- objects: nothing else.
      and (payload->>'level' <> 'objects' or not (payload ?| array['object', 'count', 'fields', 'filters', 'limit']))
      -- metadata, ids, data: one object.
      and (payload->>'level' = 'objects'
           or (jsonb_typeof(payload->'object') = 'string' and payload->>'object' ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'))
      -- metadata: the object only.
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
        -- ids: only the three fields, in fields and in filters.
        and (payload->>'level' = 'data' or (
          not coalesce(jsonb_path_exists(payload,
                '$.fields[*] ? (!(@ == "Id" || @ == "CreatedDate" || @ == "LastModifiedDate"))', '{}'::jsonb, true), true)
          and not coalesce(jsonb_path_exists(payload,
                '$.filters[*] ? (!(@.field == "Id" || @.field == "CreatedDate" || @.field == "LastModifiedDate"))', '{}'::jsonb, true), true)))
      ))
    ), false)
  );

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object", "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). Fixed after insert.';

-- ============================================================================
-- 3. Every read waits for Alex's click.
-- ============================================================================
create or replace function public.switchboard_needs_click(p_kind text, p_payload jsonb, p_created_by text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_kind = 'git' and p_payload->>'command' in ('gitpush', 'gitnewtree') then true  -- touches main: always
    when p_kind = 'git' then true       -- gitcom, gitsync: a click until the no-click project
    when p_kind = 'sf_check' then true  -- a link for now (s86pa); read-only, on a sandbox the helper proves first
    when p_kind = 'sf_read' then true   -- every Salesforce read, by link (s89a, spec 10)
    when p_kind = 'sb_setup' then true  -- writes Switchboard's config: always
    else true                           -- sql, docs and the rest of Salesforce: a click until their own steps say otherwise
  end;
$$;
comment on function public.switchboard_needs_click(text, jsonb, text) is
  'Switchboard: whether an action waits for Alex''s click, from its kind, payload and who queued it (spec 10, 11.1, 11.4). Every kind does for now: git, sf_check (by link since s86pa), sf_read (always), sb_setup and the rest. Called by the guard trigger, so a caller never sets needs_click.';
revoke all on function public.switchboard_needs_click(text, jsonb, text) from public, anon;
grant execute on function public.switchboard_needs_click(text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 4. switchboard_queue_helper takes sf_read, deriving sf-<alias> as for an sf_check. Same signature and grants.
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
  if p_kind is null or p_kind not in ('git', 'sf_check', 'sf_read', 'sb_setup') then
    raise exception 'switchboard_queue_helper: % is not a helper kind (git, sf_check, sf_read, sb_setup).', coalesce(p_kind, 'null')
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
    raise exception 'switchboard_queue_helper: % needs a project code (sf_check, sf_read and sb_setup derive one from the alias or client).',
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
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check, sf_read or sb_setup) for the signed-in caller, as created_by claude, and return {action_id, project_code}. git needs p_project_code; with none, an sf_check or sf_read uses sf-<alias> and an sb_setup sb-<client>, so the one-live-link and one-running limits hold per alias and per client. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 10, 11.3-11.6).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- ============================================================================
-- 5. switchboard_pickup_helper hands out sf_read too. Otherwise as 218.
-- ============================================================================
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
     where user_id = p_user and kind in ('git', 'sf_check', 'sf_read', 'sb_setup') and status = 'queued' and not needs_click
       and picked_up_at is null and created_at < now() - interval '10 minutes'
    returning id
  )
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
  select p_user, id, 'real', 'expired before the helper picked it up: queued over 10 minutes ago, never run',
         jsonb_build_object('ok', false, 'expired', true), now()
    from expired;

  -- Ready: clicked (consumed), or queued and needing no click. Not while that project has one running.
  select a.* into v_action from public.switchboard_actions a
   where a.user_id = p_user and a.kind in ('git', 'sf_check', 'sf_read', 'sb_setup') and a.picked_up_at is null
     and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click))
     and not exists (select 1 from public.switchboard_actions b
                      where b.user_id = p_user and b.kind in ('git', 'sf_check', 'sf_read', 'sb_setup')
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
  'Switchboard: hand the helper the oldest action of p_user, of kind git, sf_check, sf_read or sb_setup, that is ready to run: clicked, or queued and needing no click. A queued no-click action over 10 minutes old is marked failed first, with a run whose summary says it expired, and is never run. One running at a time per project code, across those kinds. Sets picked_up_at, marks it consumed and opens a real run row. Returns {action_id, run_id, kind, project_code, payload, fingerprint, headline, chat_url}, or null. Called by switchboard-runner with the service role after it checks the pickup key.';
revoke all on function public.switchboard_pickup_helper(uuid) from public, anon, authenticated;
grant execute on function public.switchboard_pickup_helper(uuid) to service_role;

-- ============================================================================
-- 6. The kill switch for Salesforce reads.
-- ============================================================================
alter table public.switchboard_settings add column if not exists sf_reads_enabled boolean not null default true;
comment on column public.switchboard_settings.sf_reads_enabled is
  'The kill switch for Salesforce reads (spec 10). False refuses every sf_read at queue time, and the runner takes no result. reads_enabled is the Supabase one.';

-- ============================================================================
-- 7. switchboard_sf_results: one read's rows, for at most 10 minutes.
-- ============================================================================
create table if not exists public.switchboard_sf_results (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users (id),
  action_id            uuid        not null references public.switchboard_actions (id) on delete cascade,
  rows                 jsonb       not null default '[]'::jsonb,
  row_count            integer     not null,
  truncated            boolean     not null default false,
  production_full_data boolean     not null default false,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null default now() + interval '10 minutes',

  constraint switchboard_sf_results_one_per_action unique (action_id),
  constraint switchboard_sf_results_rows_array check (jsonb_typeof(rows) = 'array'),
  constraint switchboard_sf_results_rows_cap check (case when jsonb_typeof(rows) = 'array' then jsonb_array_length(rows) <= 1000 else false end),
  constraint switchboard_sf_results_count check (row_count >= 0),
  constraint switchboard_sf_results_ten_minutes check (expires_at <= created_at + interval '10 minutes')
);

comment on table public.switchboard_sf_results is
  'SWITCHBOARD. The rows of one Salesforce read (kind sf_read), held briefly: written by switchboard-runner (service role) '
  'from the desktop helper, deleted when Claude takes them (switchboard_take_sf_result) and in any case once expired, by '
  'the cron job switchboard-prune-sf-results each minute. Never copied to switchboard_runs or the audit log. Not '
  'encrypted for now (Alex, 2026-11-11). Spec: docs/technical-spec-switchboard2-h8r.md 10.';
comment on column public.switchboard_sf_results.id is 'Row id.';
comment on column public.switchboard_sf_results.user_id is
  'Owner. Set explicitly by switchboard-runner, which writes with the service role. Owner RLS scopes every read.';
comment on column public.switchboard_sf_results.action_id is 'The sf_read action these rows answer. One result per action.';
comment on column public.switchboard_sf_results.rows is
  'The rows, a json array of objects holding only the asked-for fields, at most 1000. Empty for a count. The object '
  'list and a describe are stored as rows too: one per object, or one per field.';
comment on column public.switchboard_sf_results.row_count is
  'Rows returned after the cap, or the count for a count read.';
comment on column public.switchboard_sf_results.truncated is 'True when the row cap cut the answer.';
comment on column public.switchboard_sf_results.production_full_data is
  'True when the helper stamped the result PRODUCTION FULL DATA: level data on an org Salesforce says is production.';
comment on column public.switchboard_sf_results.created_at is 'When the runner stored it.';
comment on column public.switchboard_sf_results.expires_at is
  'When it goes: at most 10 minutes after created_at. An expired row is never returned and is deleted by the next take '
  'or the minute''s prune.';

-- Not audited: the audit log would keep a copy of the rows past their 10 minutes. Hidden from the generic MCP readers,
-- so only switchboard_take_sf_result hands rows out. The conformance contract needs authenticated SELECT (owner RLS
-- still scopes it); authenticated never writes, since only the runner adds rows and only the take and prune remove them.
select platform.register_table(
  'public.switchboard_sf_results',
  p_audited => false,
  p_mcp_read => 'hidden'
);
revoke insert, update, delete on public.switchboard_sf_results from authenticated;

-- ============================================================================
-- 8. switchboard_sf_read_log: every read asked for, never its rows.
-- ============================================================================
create table if not exists public.switchboard_sf_read_log (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  action_id   uuid        references public.switchboard_actions (id) on delete set null,
  stage       text        not null,
  org_alias   text        not null,
  level       text,
  object      text,
  fields      jsonb,
  filters     jsonb,
  query_text  text,
  row_count   integer,
  error       text,
  created_at  timestamptz not null default now(),

  constraint switchboard_sf_read_log_stage check (stage in ('queued', 'refused', 'ran', 'failed')),
  constraint switchboard_sf_read_log_alias_length check (length(org_alias) between 1 and 80),
  constraint switchboard_sf_read_log_level check (level is null or level in ('objects', 'metadata', 'ids', 'data')),
  constraint switchboard_sf_read_log_fields_array check (fields is null or jsonb_typeof(fields) = 'array'),
  constraint switchboard_sf_read_log_filters_array check (filters is null or jsonb_typeof(filters) = 'array'),
  constraint switchboard_sf_read_log_query_length check (query_text is null or length(query_text) <= 20000),
  constraint switchboard_sf_read_log_count check (row_count is null or row_count >= 0)
);

comment on table public.switchboard_sf_read_log is
  'SWITCHBOARD. One row per step of a Salesforce read: queued or refused (by the queue tool, which counts the budget '
  'from here) and ran or failed (by switchboard-runner). What was asked and how many rows came back, never the rows. '
  'Append-only: authenticated can read and add, not change or remove. Spec: docs/technical-spec-switchboard2-h8r.md 10.';
comment on column public.switchboard_sf_read_log.id is 'Row id.';
comment on column public.switchboard_sf_read_log.user_id is 'Owner. Owner RLS; the runner sets it explicitly.';
comment on column public.switchboard_sf_read_log.action_id is 'The sf_read action, when one was queued; null for a refusal before queueing.';
comment on column public.switchboard_sf_read_log.stage is
  'queued or refused at queue time; ran or failed when the helper''s result came back.';
comment on column public.switchboard_sf_read_log.org_alias is 'The org alias asked for.';
comment on column public.switchboard_sf_read_log.level is 'objects, metadata, ids or data, as asked.';
comment on column public.switchboard_sf_read_log.object is 'The object, for every level but objects.';
comment on column public.switchboard_sf_read_log.fields is 'The fields asked for, a json array of API names; null for a count, describe or list.';
comment on column public.switchboard_sf_read_log.filters is 'The filters asked for, a json array of {field, op, value}.';
comment on column public.switchboard_sf_read_log.query_text is 'The SOQL the helper built and ran, when it ran one.';
comment on column public.switchboard_sf_read_log.row_count is 'Rows returned, or the count; null until it ran.';
comment on column public.switchboard_sf_read_log.error is 'Why it was refused or failed, with ids and emails already blanked.';
comment on column public.switchboard_sf_read_log.created_at is 'When this step was logged.';

select platform.register_table('public.switchboard_sf_read_log');
revoke update, delete on public.switchboard_sf_read_log from authenticated;

-- ============================================================================
-- 9. Taking a result: once, unexpired, deleted as it is returned.
-- ============================================================================
create or replace function public.switchboard_take_sf_result(p_action_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_out  jsonb;
begin
  if v_user is null then
    raise exception 'switchboard_take_sf_result: no signed-in user.' using errcode = '28000';
  end if;
  -- The sweep first, in case the cron job has stopped: nothing expired survives a take.
  delete from public.switchboard_sf_results where expires_at <= now();
  delete from public.switchboard_sf_results
   where action_id = p_action_id and user_id = v_user and expires_at > now()
  returning jsonb_build_object('action_id', action_id, 'rows', rows, 'row_count', row_count, 'truncated', truncated,
                               'production_full_data', production_full_data, 'created_at', created_at, 'expires_at', expires_at)
    into v_out;
  return v_out;
end;
$$;
comment on function public.switchboard_take_sf_result(uuid) is
  'Switchboard: return the rows of the signed-in caller''s sf_read p_action_id and delete them in the same statement, so '
  'they come back once; null when there are none, they were taken, or they expired. Every expired result, anyone''s, is '
  'deleted first. Called by the Salesforce read fetch tool (spec 10).';
revoke all on function public.switchboard_take_sf_result(uuid) from public, anon;
grant execute on function public.switchboard_take_sf_result(uuid) to authenticated;

-- ============================================================================
-- 10. The prune, every minute.
-- ============================================================================
create or replace function public.switchboard_prune_sf_results()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.switchboard_sf_results where expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function public.switchboard_prune_sf_results() is
  'Switchboard: delete every Salesforce read result past its expires_at. Returns how many. Run each minute by the cron '
  'job switchboard-prune-sf-results; no API role can call it.';
revoke all on function public.switchboard_prune_sf_results() from public, anon, authenticated, service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'switchboard-prune-sf-results';
select cron.schedule('switchboard-prune-sf-results', '* * * * *', 'select public.switchboard_prune_sf_results()');

-- ============================================================================
-- 11. Result: must say CONFORMANT. Then run supabase/tests/switchboard2-h8r/15_verify_sf_reads.sql.
-- ============================================================================
select public.platform_check_conformance() as conformance;
