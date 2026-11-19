-- 244: dataquery_fixes-v3n fix 2. An sf_dataquery says its org's type: payload.org_type, exactly "sandbox" or
-- "production" (sb prints it from orgs.json; the helper refuses a mismatch, dataop_v2-m5j s8).
-- Kind: schema change (two functions replaced, same signatures; one column comment). Applied: NO (queued at s4; only a run id shows it ran).
-- Spec: docs/technical-spec-dataquery_fixes-v3n.md (Fix 2).
-- Test: supabase/tests/dataquery_fixes-v3n/1_verify_org_type.sql (--test).
-- switchboard_dataquery_payload_ok accepts org_type MISSING (rows from before this, re-checked by the CHECK on every
-- update) and refuses any other value. switchboard_actions_guard's INSERT branch requires it on a new sf_dataquery.
-- Every other kind, and every update, behave exactly as before.
-- Deploy order: this migration, then mcp straight after (the old tool strips org_type, which this guard refuses).

-- ============================================================================
-- 1. The payload check: as 242, plus org_type (optional here; required on insert by the guard below).
-- ============================================================================
create or replace function public.switchboard_dataquery_payload_ok(p_payload jsonb, p_project_code text)
returns boolean
language plpgsql
stable  -- not immutable: convert_to is stable
set search_path = public, pg_temp
as $$
declare
  c_keys   constant text[] := array['alias', 'org_type', 'repo', 'run', 'run_tag', 'request_sha256', 'queries'];
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
  -- org_type (dataquery_fixes-v3n): missing is allowed here, for rows from before it; present, exactly one of two.
  if p_payload ? 'org_type'
     and (jsonb_typeof(p_payload->'org_type') is distinct from 'string'
          or p_payload->>'org_type' not in ('sandbox', 'production')) then
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
  'Switchboard: whether an sf_dataquery payload meets docs/technical-spec-dataop_link-k7d.md parts 2 to 4 for the action''s project code: alias, org_type (dataquery_fixes-v3n: "sandbox" or "production"; may be missing here, for rows from before it, and switchboard_actions_guard requires it on insert), repo, run (data-ops/<code>/<run>), run_tag, request_sha256 (needed with any label), and 1 to 40 queries, all exports (manifest, before, undo) or all counts of one step (preflight-counts, rules); each {step, soql, sha256, file | label}, sha256 the SHA-256 of soql''s UTF-8 bytes, no semicolon; blank space allowed before SELECT; counts SELECT COUNT() FROM <object> WHERE ..., no GROUP BY, at most 8,000 characters; exports SELECT Id ..., no COUNT(, at most 100,000; the payload at most 220,000. Never raises. Used by switchboard_actions_sf_dataquery_payload.';
revoke all on function public.switchboard_dataquery_payload_ok(jsonb, text) from public, anon;
grant execute on function public.switchboard_dataquery_payload_ok(jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 2. The guard: as before, plus one INSERT-only rule: a new sf_dataquery must say its org's type.
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
    new.status          := 'queued';
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
  'Switchboard: before insert or update on switchboard_actions. An insert gets its fingerprint and needs_click (switchboard_needs_click) and starts queued with no link; a new sf_dataquery must have payload.org_type "sandbox" or "production" (dataquery_fixes-v3n). An update cannot change what will run or whether it needs a click, reopen a used link, or change picked_up_at once set, whoever makes it.';
-- A trigger function needs no execute grant to fire; these keep the grants it already had.
revoke all on function public.switchboard_actions_guard() from public, anon;
grant execute on function public.switchboard_actions_guard() to authenticated, service_role;

comment on column public.switchboard_actions.payload is
  'What will run. sql: {"sql": "..."}. git: {"command": "gitcom|gitsync|gitnewtree|gitpush", ...}, and a gitnewtree may name its "repo", an absolute path (spec 11.3). sf_check: {"check", "alias", "metadata_type" for metadata} (spec 11.4). sb_setup: {"command": "client start|org add", "client", "orgs": [...], "folder" with from_sandbox, ...} (spec 11.5). sf_read: {"alias", "production", "level": "objects|metadata|ids|data", "object" (or "objects", 1 to 20, at metadata), "count" or "fields" with "limit", "filters"}, never SOQL text (spec 10). sf_dataop: {"alias", "repo", "plan", "stamp", "preflight_at", "object", "problem", "expected", "write", "rows", "rehearsal"?} (docs/technical-spec-dataops_alfred-d4x.md). sf_dataquery: {"alias", "org_type": "sandbox|production" (required on insert since dataquery_fixes-v3n), "repo", "run", "run_tag", "request_sha256"?, "queries": [{"step", "soql", "sha256", "file" | "label"}]} (docs/technical-spec-dataop_link-k7d.md). Fixed after insert.';

-- ============================================================================
-- 3. Result: must say CONFORMANT. Then deploy mcp, and run supabase/tests/dataquery_fixes-v3n/1_verify_org_type.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
