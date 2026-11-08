-- Switchboard 2.0 s86h: setup without a project code, and the folder sb client start --from-sandbox writes into.
-- Spec: docs/technical-spec-switchboard2-h8r.md 11.4-11.5. Tables touched: switchboard_actions.
--
-- Setup is per client and a sandbox check finds its repo from the alias, so neither needs a project code. The row
-- still has one: switchboard_queue_helper derives it when none is given, sf-<alias> for an sf_check and sb-<client>
-- for an sb_setup. project_code stays NOT NULL, and switchboard_issue_link and switchboard_pickup_helper are unchanged:
-- one live link per client, one running per alias. A derived code that collides with another (two aliases folding to
-- the same one, a long name cut at 40) only makes those limits stricter, never looser.

-- 1. switchboard_queue_helper: same signature and grants; the derived code when p_project_code is null or blank.
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

  -- Only the strings the payload checks accept are used; anything else leaves the code null and is refused below.
  if v_code is null and p_kind = 'sf_check' and jsonb_typeof(p_payload->'alias') = 'string' then
    v_code := 'sf-' || left(regexp_replace(lower(p_payload->>'alias'), '[^a-z0-9_-]', '_', 'g'), 37);
  elsif v_code is null and p_kind = 'sb_setup' and jsonb_typeof(p_payload->'client') = 'string' then
    v_code := 'sb-' || left(p_payload->>'client', 37);
  end if;
  if v_code is null then
    raise exception 'switchboard_queue_helper: % needs a project code (sf_check and sb_setup derive one from the alias or client).',
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
  'Switchboard: queue an action the desktop helper runs (kind git, sf_check or sb_setup) for the signed-in caller, as created_by claude, and return {action_id, project_code}. git needs p_project_code; with none, an sf_check uses sf-<alias> and an sb_setup sb-<client>, so the one-live-link and one-running limits hold per alias and per client. The guard trigger sets fingerprint, status and needs_click; the payload checks refuse what the kind does not allow. A link, where the kind needs a click, is issued separately by switchboard_issue_link (spec 11.3-11.6).';
revoke all on function public.switchboard_queue_helper(text, text, jsonb, text, text) from public, anon;
grant execute on function public.switchboard_queue_helper(text, text, jsonb, text, text) to authenticated;

-- 2. The sb_setup check from 218, unchanged except that "folder" joins the key list. Every row still meets it.
alter table public.switchboard_actions drop constraint switchboard_actions_sb_setup_payload;
alter table public.switchboard_actions
  add constraint switchboard_actions_sb_setup_payload check (
    kind <> 'sb_setup'
    or (coalesce(payload->>'command', '') in ('client start', 'org add')
        and coalesce(payload->>'client', '') ~ '^[a-z0-9][a-z0-9_-]{0,40}$'
        and coalesce(payload - array['command', 'client', 'repo', 'adopt', 'from_sandbox', 'folder', 'project', 'name',
                                     'sandboxes', 'integration_ok', 'orgs'] = '{}'::jsonb, false)
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

-- 3. The folder: present exactly when the row is a client start from a sandbox, and then a folder strictly inside
--    C:\Users\Alex\projects\, with no "..", no forbidden character and no trailing backslash. NOT VALID because one
--    cancelled client start from_sandbox predates it, queued with no folder; every new or changed row must meet it.
alter table public.switchboard_actions
  add constraint switchboard_actions_sb_setup_folder check (
    kind <> 'sb_setup'
    or (coalesce(payload ? 'folder', false)
          = coalesce(payload->>'command' = 'client start' and payload ? 'from_sandbox', false)
        and (not coalesce(payload ? 'folder', false)
             or (coalesce(jsonb_typeof(payload->'folder') = 'string', false)
                 and coalesce(length(payload->>'folder') <= 240, false)
                 and coalesce(payload->>'folder' ~* '^c:\\users\\alex\\projects(\\[^\\/:*?"<>|[:cntrl:]]+)+$', false)
                 and coalesce(strpos(payload->>'folder', '..') = 0, false))))
  ) not valid;

comment on column public.switchboard_actions.project_code is
  'The project that queued it, e.g. switchboard2-h8r. With none given, an sf_check has sf-<alias> and an sb_setup sb-<client>, derived by switchboard_queue_helper.';
comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...} (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). Fixed after insert.';
