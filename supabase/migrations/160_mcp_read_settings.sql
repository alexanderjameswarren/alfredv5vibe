-- Purpose: MCP read access S2 (Alex, 2026-10-23, run tag mcp_read_gaps-t8k-s5-n3qd; spec docs/technical-spec-mcp-read-access.md, decisions 1-2, 6-7, 10). Read settings in the platform registry: whether Claude may read a table (mcp_read), which columns are never returned (secret_columns), and which credential-looking names were reviewed and judged safe (cleared_columns). Columns are visible by default; there is no long-text declaration. register_table and a new set_read_settings take the settings; conformance flags a registered table with no setting, an unknown column name in either list, or a credential-looking column in neither. public.platform_read_settings() is what MCP tools read: the readable columns of every visible table (secrets removed), heavy jsonb columns (pg_stats avg_width over 1000 bytes) and whether the table has context_id, archived and status. Every registered table is backfilled visible; push_subscriptions.endpoint, p256dh and auth_key are secret; dj_tracks.match_key, drive_mix_songs.artist_key and sam_songs.key_signature are cleared.
-- Kind: schema change
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Run after 159.
-- Safe to run again from the top: every object is created or replaced, the columns use if not exists, and the backfill
-- only fills settings that are still null.
-- Re-registration keeps settings: register_table's three new params default to null, meaning "keep what the registry
-- has" (a new table gets visible and empty lists), so an old-style register_table call cannot wipe a secret.
-- supabase/migrations/160_mcp_read_settings.sql

begin;

-- ============================================================================
-- A. Registry columns
-- ============================================================================
alter table platform.registry
  add column if not exists mcp_read text,
  add column if not exists secret_columns text[] not null default '{}',
  add column if not exists cleared_columns text[] not null default '{}';

alter table platform.registry drop constraint if exists registry_mcp_read_check;
alter table platform.registry
  add constraint registry_mcp_read_check check (mcp_read in ('visible', 'hidden'));

comment on column platform.registry.mcp_read is
  'visible = MCP read tools (get_records and the shared read helper) may read this table, through RLS; hidden = they may not. Null = not yet decided, which conformance reports. New tables default to visible.';
comment on column platform.registry.secret_columns is
  'Columns never returned by any MCP read: platform_read_settings() leaves them out of the readable column list. Names only; values never leave the database.';
comment on column platform.registry.cleared_columns is
  'Columns whose names look like credentials (see platform.is_credential_name) but were reviewed and are not secret, e.g. sam_songs.key_signature.';

-- ============================================================================
-- B. Credential-name rule and the per-table read issue
-- ============================================================================
create or replace function platform.is_credential_name(p_column text)
returns boolean
language sql
immutable
as $$
  select exists (
           select 1 from unnest(string_to_array(lower(p_column), '_')) as part
            where part in ('token', 'tokens', 'secret', 'secrets', 'key', 'keys', 'password', 'passwords',
                           'endpoint', 'p256dh', 'auth'))
      or lower(p_column) like '%password%'
      or lower(p_column) like '%secret%';
$$;

comment on function platform.is_credential_name(text) is
  'True when a column name looks like a credential: any underscore-separated part is token, secret, key, password, endpoint, p256dh or auth (plurals too), or the name contains password or secret. Whole parts, so author and keyword pass. A flagged column must be declared secret or cleared in platform.registry.';

create or replace function platform.read_settings_issue(p_table text)
returns text
language sql
stable
as $$
  with r as (
    select * from platform.registry where table_name = p_table
  ),
  cols as (
    select a.attname::text as name
      from pg_attribute a
     where a.attrelid = to_regclass(p_table) and a.attnum > 0 and not a.attisdropped
  )
  select nullif(concat_ws('; ',
    case when r.mcp_read is null then
      'NO READ SETTINGS — pass p_mcp_read to register_table() or call platform.set_read_settings()' end,
    (select 'UNKNOWN COLUMN in secret_columns or cleared_columns: ' || string_agg(x, ', ' order by x)
       from unnest(r.secret_columns || r.cleared_columns) as x
      where x not in (select name from cols)),
    (select 'BOTH SECRET AND CLEARED: ' || string_agg(x, ', ' order by x)
       from unnest(r.secret_columns) as x
      where x = any(r.cleared_columns)),
    (select 'CREDENTIAL-LIKE COLUMN neither secret nor cleared: ' || string_agg(name, ', ' order by name)
       from cols
      where platform.is_credential_name(name)
        and name <> all(r.secret_columns || r.cleared_columns))
  ), '')
  from r;
$$;

comment on function platform.read_settings_issue(text) is
  'The read-settings problem for one registered table (schema-qualified name), or null. Feeds platform.conformance.read_issue.';

-- ============================================================================
-- C. register_table takes the read settings; set_read_settings changes them alone
-- ============================================================================
-- A new parameter list is a new signature, so the old function is dropped first; otherwise both would exist and a
-- named call would be ambiguous. Nothing depends on it and it has no grants (platform is not exposed to anon).
drop function if exists platform.register_table(regclass, text, boolean, boolean, text);

create or replace function platform.register_table(
  p_table           regclass,
  p_policy_mode     text    default 'owner',
  p_audited         boolean default true,
  p_exempt          boolean default false,
  p_notes           text    default null,
  p_mcp_read        text    default null,
  p_secret_columns  text[]  default null,
  p_cleared_columns text[]  default null)
returns text
language plpgsql
security definer
as $$
declare
  v_schema   text;
  v_name     text;
  v_full     text;
  v_uid_type text;
  v_expr     text;
  v_policy   text;
  v_bad      text;
begin
  if p_policy_mode not in ('owner', 'none') then
    raise exception 'register_table: policy_mode must be ''owner'' or ''none'', got %', p_policy_mode;
  end if;
  if p_mcp_read is not null and p_mcp_read not in ('visible', 'hidden') then
    raise exception 'register_table: mcp_read must be ''visible'' or ''hidden'', got %', p_mcp_read;
  end if;

  select n.nspname, c.relname
    into v_schema, v_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  if v_schema is null then
    raise exception 'register_table: could not resolve %', p_table;
  end if;

  v_full := v_schema || '.' || v_name;

  select string_agg(x, ', ') into v_bad
    from unnest(coalesce(p_secret_columns, '{}') || coalesce(p_cleared_columns, '{}')) as x
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = p_table and a.attname = x and a.attnum > 0 and not a.attisdropped);
  if v_bad is not null then
    raise exception 'register_table: % has no column(s) % (named in p_secret_columns or p_cleared_columns)', v_full, v_bad;
  end if;

  -- (a) RLS always on
  execute format('alter table %I.%I enable row level security', v_schema, v_name);

  -- (b) Standard owner policy, type-aware
  if p_policy_mode = 'owner' then
    select atttypid::regtype::text
      into v_uid_type
      from pg_attribute
     where attrelid = p_table and attname = 'user_id'
       and attnum > 0 and not attisdropped;

    if v_uid_type is null then
      raise exception
        'register_table: % has no user_id column. Use policy_mode => ''none'' and write RLS by hand.',
        v_full;
    end if;

    v_expr := case when v_uid_type = 'uuid'
                   then 'user_id = auth.uid()'
                   else 'user_id = (auth.uid())::text' end;
    v_policy := v_name || '_owner_access';

    execute format('drop policy if exists %I on %I.%I', v_policy, v_schema, v_name);
    execute format(
      'create policy %I on %I.%I for all to authenticated using (%s) with check (%s)',
      v_policy, v_schema, v_name, v_expr, v_expr);
  end if;

  -- (c) Grants: authenticated gets DML; anon is explicitly stripped so a table
  --     can never ship publicly writable even if default privileges drift.
  execute format(
    'grant select, insert, update, delete on %I.%I to authenticated', v_schema, v_name);
  execute format('revoke all on %I.%I from anon', v_schema, v_name);

  -- (d) Audit trigger
  execute format('drop trigger if exists audit_trigger on %I.%I', v_schema, v_name);
  if p_audited then
    execute format(
      'create trigger audit_trigger after insert or update or delete on %I.%I
         for each row execute function platform.audit_row()', v_schema, v_name);
  end if;

  -- (e) Record it. Null read settings keep what is recorded; a new row gets visible and empty lists.
  insert into platform.registry
    (table_name, policy_mode, audited, exempt, contract_version, notes, registered_at,
     mcp_read, secret_columns, cleared_columns)
  values
    (v_full, p_policy_mode, p_audited, p_exempt, 1, p_notes, now(),
     coalesce(p_mcp_read, 'visible'), coalesce(p_secret_columns, '{}'), coalesce(p_cleared_columns, '{}'))
  on conflict (table_name) do update set
    policy_mode      = excluded.policy_mode,
    audited          = excluded.audited,
    exempt           = excluded.exempt,
    contract_version = excluded.contract_version,
    notes            = coalesce(excluded.notes, platform.registry.notes),
    registered_at    = now(),
    mcp_read         = coalesce(p_mcp_read, platform.registry.mcp_read, 'visible'),
    secret_columns   = coalesce(p_secret_columns, platform.registry.secret_columns),
    cleared_columns  = coalesce(p_cleared_columns, platform.registry.cleared_columns);

  return format('registered %s (policy=%s, audited=%s, exempt=%s, anon stripped, mcp_read=%s)',
                v_full, p_policy_mode, p_audited, p_exempt,
                (select mcp_read from platform.registry where table_name = v_full));
end;
$$;

comment on function platform.register_table(regclass, text, boolean, boolean, text, text, text[], text[]) is
'THE PAVED PATH. Every new table''s migration must end with a call to this.
Enables RLS, creates the type-aware owner policy, grants DML to authenticated,
STRIPS ALL privileges from anon, attaches the audit trigger, and records the
table in platform.registry with its MCP read settings.

  select platform.register_table(''public.ken_items'');
  select platform.register_table(''public.items'', ''none'');
  select platform.register_table(''public.allowed_emails'', ''none'', false, true);
  select platform.register_table(''public.push_subscriptions'',
           p_secret_columns => array[''endpoint'', ''p256dh'', ''auth_key'']);

Read settings: p_mcp_read (''visible'' or ''hidden''), p_secret_columns (never
returned by MCP reads) and p_cleared_columns (credential-looking names judged
safe). Null keeps what the registry already has; a new table is visible with
empty lists. Every column is readable unless declared secret.

If a table genuinely needs pre-auth anon SELECT (like allowed_emails), grant it
explicitly AFTER registering — register_table always removes anon access first.';

create or replace function platform.set_read_settings(
  p_table           regclass,
  p_mcp_read        text   default null,
  p_secret_columns  text[] default null,
  p_cleared_columns text[] default null)
returns text
language plpgsql
security definer
as $$
declare
  v_full text;
  v_bad  text;
begin
  select n.nspname || '.' || c.relname into v_full
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  if not exists (select 1 from platform.registry where table_name = v_full) then
    raise exception 'set_read_settings: % is not registered; call platform.register_table() first', v_full;
  end if;
  if p_mcp_read is not null and p_mcp_read not in ('visible', 'hidden') then
    raise exception 'set_read_settings: mcp_read must be ''visible'' or ''hidden'', got %', p_mcp_read;
  end if;

  select string_agg(x, ', ') into v_bad
    from unnest(coalesce(p_secret_columns, '{}') || coalesce(p_cleared_columns, '{}')) as x
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = p_table and a.attname = x and a.attnum > 0 and not a.attisdropped);
  if v_bad is not null then
    raise exception 'set_read_settings: % has no column(s) %', v_full, v_bad;
  end if;

  update platform.registry
     set mcp_read        = coalesce(p_mcp_read, mcp_read, 'visible'),
         secret_columns  = coalesce(p_secret_columns, secret_columns),
         cleared_columns = coalesce(p_cleared_columns, cleared_columns)
   where table_name = v_full;

  return format('read settings for %s: %s', v_full,
    (select format('mcp_read=%s secret=%s cleared=%s', mcp_read, secret_columns, cleared_columns)
       from platform.registry where table_name = v_full));
end;
$$;

comment on function platform.set_read_settings(regclass, text, text[], text[]) is
  'Change a registered table''s MCP read settings without re-running register_table''s RLS, grant and audit work. Null keeps the current value. Raises on an unregistered table or a column name that does not exist.';

-- ============================================================================
-- D. Conformance: read_issue on platform.conformance, issue_read on the failures view
-- ============================================================================
-- Columns are appended at the end, which create or replace view allows while
-- platform.conformance_failures depends on platform.conformance.
create or replace view platform.conformance as
 select (n.nspname::text || '.' || c.relname::text) as table_name,
    c.relrowsecurity as rls_enabled,
    (exists (select 1
           from pg_trigger tg
          where tg.tgrelid = c.oid and tg.tgname = 'audit_trigger'::name and not tg.tgisinternal)) as audited,
    has_table_privilege('authenticated'::name, c.oid, 'SELECT'::text) as granted_select,
    has_table_privilege('authenticated'::name, c.oid, 'INSERT'::text) as granted_insert,
    (select count(*) as count
           from pg_policies p
          where p.schemaname = n.nspname and p.tablename = c.relname) as policy_count,
    (obj_description(c.oid, 'pg_class'::name) is not null) as documented,
    (r.table_name is not null) as registered,
    coalesce(r.exempt, false) as exempt,
    r.audited as declared_audited,
    r.policy_mode as declared_policy_mode,
    r.contract_version,
    case when r.table_name is not null then platform.read_settings_issue(r.table_name) end as read_issue
   from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join platform.registry r on r.table_name = (n.nspname::text || '.' || c.relname::text)
  where n.nspname = 'public'::name and c.relkind = 'r'::"char";

create or replace view platform.conformance_failures as
 select table_name,
        case
            when not registered then 'NOT REGISTERED — migration did not call platform.register_table()'::text
            else null::text
        end as issue_registry,
        case
            when not rls_enabled then 'RLS DISABLED — table is wide open'::text
            else null::text
        end as issue_rls,
        case
            when policy_count = 0 then 'NO RLS POLICIES — RLS on but nothing defined, table is unreadable'::text
            else null::text
        end as issue_policy,
        case
            when not granted_select then 'MISSING GRANT — authenticated role cannot SELECT (Oct-2026 requirement)'::text
            else null::text
        end as issue_grant,
        case
            when registered and declared_audited and not audited then 'AUDIT DRIFT — registered as audited but audit_trigger is missing'::text
            when registered and not declared_audited and audited then 'AUDIT DRIFT — registered as NOT audited but audit_trigger exists'::text
            when not registered and not audited then 'NOT AUDITED — no audit_trigger and no registry declaration'::text
            else null::text
        end as issue_audit,
        case
            when not documented then 'UNDOCUMENTED — no COMMENT ON TABLE; Claude cannot see design intent'::text
            else null::text
        end as issue_docs,
        read_issue as issue_read
   from platform.conformance
  where not exempt
    and (not registered or not rls_enabled or policy_count = 0 or not granted_select or not documented
         or (registered and declared_audited and not audited)
         or (registered and not declared_audited and audited)
         or (not registered and not audited)
         or read_issue is not null);

comment on view platform.conformance_failures is
'Violations of the platform contract, one row per offending table with a
human-readable reason per column. EMPTY RESULT = FULLY CONFORMANT.

Audit status is checked against the registry declaration, so a table registered
with audited => false (high-volume telemetry) is conformant while unaudited, and
would become non-conformant if a trigger appeared on it. issue_read reports
missing MCP read settings, unknown column names in them, and credential-looking
columns that are neither secret nor cleared. Run after every migration and in
post-deploy CI.';

create or replace function platform.check_conformance()
returns text
language plpgsql
as $$
declare
  v_fail  int;
  v_total int;
  v_out   text;
begin
  perform platform.maybe_prune();   -- opportunistic housekeeping, ~1% of calls

  select count(*) into v_total from platform.conformance where not exempt;
  select count(*) into v_fail  from platform.conformance_failures;

  if v_fail = 0 then
    return format('CONFORMANT — all %s non-exempt public tables satisfy platform contract v1.', v_total);
  end if;

  select string_agg(
           format('  %s: %s', table_name,
             concat_ws('; ', issue_registry, issue_rls, issue_policy,
                             issue_grant, issue_audit, issue_docs, issue_read)),
           E'\n' order by table_name)
    into v_out
    from platform.conformance_failures;

  return format('NON-CONFORMANT — %s of %s tables violate platform contract v1:%s%s',
                v_fail, v_total, E'\n', v_out);
end;
$$;

-- ============================================================================
-- E. Backfill: every registered table visible; the secrets and clears Alex confirmed
-- ============================================================================
update platform.registry set mcp_read = 'visible' where mcp_read is null;

select platform.set_read_settings('public.push_subscriptions',
         p_secret_columns => array['endpoint', 'p256dh', 'auth_key']);
select platform.set_read_settings('public.dj_tracks',       p_cleared_columns => array['match_key']);
select platform.set_read_settings('public.drive_mix_songs', p_cleared_columns => array['artist_key']);
select platform.set_read_settings('public.sam_songs',       p_cleared_columns => array['key_signature']);

-- ============================================================================
-- F. public.platform_read_settings(): what MCP read tools read
-- ============================================================================
create or replace function public.platform_read_settings(p_table text default null)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'platform', 'pg_temp'
as $$
  select coalesce(jsonb_agg(t.obj order by t.name), '[]'::jsonb)
    from (
      select c.relname::text as name,
             jsonb_build_object(
               'table', c.relname::text,
               'columns', (
                 select coalesce(jsonb_agg(jsonb_build_object(
                          'name', a.attname::text, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum), '[]'::jsonb)
                   from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and a.attname <> all(r.secret_columns)),
               'secret_columns', to_jsonb(r.secret_columns),
               'heavy_columns', (
                 select coalesce(jsonb_agg(a.attname::text order by a.attnum), '[]'::jsonb)
                   from pg_attribute a
                   join pg_stats s
                     on s.schemaname = n.nspname and s.tablename = c.relname
                    and s.attname = a.attname and not s.inherited
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and a.atttypid = 'jsonb'::regtype
                    and s.avg_width > 1000
                    and a.attname <> all(r.secret_columns)),
               'has_context_id', exists (select 1 from pg_attribute a
                                          where a.attrelid = c.oid and a.attname = 'context_id'
                                            and a.attnum > 0 and not a.attisdropped),
               'has_archived', exists (select 1 from pg_attribute a
                                        where a.attrelid = c.oid and a.attname = 'archived'
                                          and a.attnum > 0 and not a.attisdropped),
               'has_status', exists (select 1 from pg_attribute a
                                      where a.attrelid = c.oid and a.attname = 'status'
                                        and a.attnum > 0 and not a.attisdropped)
             ) as obj
        from platform.registry r
        join pg_class c on c.oid = to_regclass(r.table_name)
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where r.mcp_read = 'visible'
         and (p_table is null or c.relname = p_table)
    ) t;
$$;

comment on function public.platform_read_settings(text) is
  'MCP read access (spec docs/technical-spec-mcp-read-access.md): for every visible registered public table, or the one named, the readable columns (secret columns removed), secret_columns, heavy_columns (jsonb with pg_stats avg_width over 1000 bytes: left out of list reads, returned by ids) and has_context_id / has_archived / has_status. Reads the catalog and pg_stats only, never row data, so it reveals nothing RLS hides. Security definer because PostgREST does not expose the platform schema.';

revoke all on function public.platform_read_settings(text) from public, anon;
grant execute on function public.platform_read_settings(text) to authenticated, service_role;

-- ============================================================================
-- G. get_platform_contract shows the read settings
-- ============================================================================
create or replace function public.get_platform_contract()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'platform'
as $$
begin
  return jsonb_build_object(
    'platform_schema_comment',
      obj_description('platform'::regnamespace::oid, 'pg_namespace'),
    'registered_tables', (
      select coalesce(jsonb_agg(jsonb_build_object(
                'table',           r.table_name,
                'policy_mode',     r.policy_mode,
                'audited',         r.audited,
                'exempt',          r.exempt,
                'mcp_read',        r.mcp_read,
                'secret_columns',  r.secret_columns,
                'cleared_columns', r.cleared_columns,
                'notes',           r.notes
              ) order by r.table_name), '[]'::jsonb)
        from platform.registry r
    ),
    'conformance', platform.check_conformance()
  );
end;
$$;

-- ============================================================================
-- H. The contract text gains the read-settings rule
-- ============================================================================
comment on schema platform is 'Platform contract v1 — shared infrastructure for all MCP-backed apps (Alfred, SAM, Ken, ...).

RULES FOR ANY NEW TABLE:
  1. Every migration that creates a table MUST end with a schema-qualified call:
       select platform.register_table(''public.my_table'');
     This enables RLS, creates the owner policy, issues the grants required by
     Supabase from Oct-2026 onward, strips all privileges from anon, attaches the
     audit trigger, and records the table in platform.registry.
  2. Full signature (all params p_-prefixed):
       select platform.register_table(
         ''public.my_table'',
         p_policy_mode     => ''owner'',  -- ''none'' when the table has no user_id column
         p_audited         => true,       -- false ONLY for high-volume append-only telemetry
         p_exempt          => false,      -- true only for contract-exempt tables (e.g. allowed_emails)
         p_notes           => ''App: what this table is'',
         p_mcp_read        => ''visible'', -- ''hidden'' keeps MCP read tools out; null keeps the current setting
         p_secret_columns  => null,       -- columns MCP reads never return (credentials)
         p_cleared_columns => null        -- credential-looking names that are not secrets
       );
     Pass ''public.'' explicitly — the param is regclass and an unqualified name
     resolves via search_path, which works in the SQL editor but drifts elsewhere.
  3. p_policy_mode => ''owner'' generates a user_id = auth.uid() policy, type-aware
     (uuid vs text). Use ''none'' in two cases: (a) the table has custom RLS such as
     Alfred''s shared contexts, or (b) the table has NO user_id column and reaches
     ownership through a parent (SAM''s per-song child tables). For (b), register with
     ''none'' then write the parent-scoped policy yourself, mirroring sam_song_lyrics:
       exists (select 1 from parent p where p.id = child.parent_id and p.user_id = auth.uid())
     register_table still enables RLS, grants, anon-strip, and audit — only the
     policy is yours.
  4. MCP read settings. Every column is readable by Claude unless declared secret.
     A column whose name looks like a credential (a part named token, secret, key,
     password, endpoint, p256dh or auth) must be in p_secret_columns or
     p_cleared_columns, or conformance fails. Long text needs no declaration: list
     reads preview it, and heavy jsonb is returned only when records are fetched by
     ids. Change settings later with platform.set_read_settings().

RULES FOR ANY NEW MCP TOOL:
  1. Build it with defineTool() from _shared/platform.ts. Never import the Supabase
     client directly in a tool file — ctx.db is the only DB path.
  2. Declare a write tier (blast radius, not read-vs-write):
       tier 1 = append-only insert, or update to own progress/state  -> no gate, audited
       tier 2 = update to an existing row                            -> audited, reversible
       tier 3 = destructive, superseding, or semantically significant-> requires confirmed=true
  3. Every list tool clamps limit (default 20, cap 50) with schema/handler param parity.
     Push every filter into the query before LIMIT. Exclude heavy jsonb from list reads.
     Tags are text[] (filter with .overlaps()); jsonb tags are legacy-Alfred only.
  4. Emit bare envelope.data as the MCP payload. Guardrail denials keep their verbatim
     do-not-retry wording; operational errors must not borrow it.
  5. Actor attribution rides the x-actor request header (PostgREST request.headers),
     NOT a set_config() RPC — supabase-js runs each call in its own transaction.

VERIFY WITH: select * from platform.conformance_failures;  -- empty = conformant
Run check_platform_conformance as the final step of every migration block.

When you mention any Alfred, SAM, Ken, DJ or Warren Buffet record, link it as https://alfredv5vibe.vercel.app/<id> using its id, instead of describing where to find it.';

commit;

-- ============================================================================
-- Result: the one cell the SQL editor shows. Expect conformance to start with
-- CONFORMANT, settings_not_default to list push_subscriptions and the three
-- cleared tables, and heavy_columns to name the big jsonb columns.
-- ============================================================================
select json_build_object(
  'conformance', platform.check_conformance(),
  'tables_by_mcp_read', (select coalesce(json_agg(t), '[]'::json) from (
      select mcp_read, count(*) as tables from platform.registry group by mcp_read order by mcp_read) t),
  'settings_not_default', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, mcp_read, secret_columns, cleared_columns
        from platform.registry
       where secret_columns <> '{}' or cleared_columns <> '{}' or mcp_read is distinct from 'visible'
       order by table_name) t),
  'heavy_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select x->>'table' as table_name, x->'heavy_columns' as heavy_columns
        from jsonb_array_elements(public.platform_read_settings()) x
       where jsonb_array_length(x->'heavy_columns') > 0
       order by 1) t),
  'push_subscriptions_columns_returned', (select x->'columns'
        from jsonb_array_elements(public.platform_read_settings('push_subscriptions')) x),
  'credential_rule_spot_check', (select coalesce(json_agg(t), '[]'::json) from (
      select v as name, platform.is_credential_name(v) as flagged
        from unnest(array['api_token', 'auth_key', 'author', 'keyword', 'key_signature', 'client_secret']) v) t)
) as result;
