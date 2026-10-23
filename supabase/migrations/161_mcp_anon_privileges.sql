-- Purpose: MCP read access S2b (Alex, 2026-10-23, run tag mcp_read_gaps-t8k-s6-h5tx; spec docs/technical-spec-mcp-read-access.md decision 13; Alfred intentions mvleha5g3w4i21aovjn "stop new functions and views being granted to anon by default" and mvjx48agc7a04lgc1ne "Add Supabase table grants to the standard migration pattern before October 30"). Three things:
--   1. Anon. Default privileges stop giving anon (and PUBLIC) anything new in public. Every existing public function, table,
--      view and sequence loses its anon and PUBLIC grants; authenticated and service_role keep exactly what they could do
--      before, made explicit first, and the transaction aborts if either loses anything. No anon caller exists (checked
--      2026-10-23: the app reads allowed_emails only once signed in; the extension posts to clip-capture with its own secret;
--      push-send and sam-song-scores forward the user's token), so platform.anon_access starts empty and anon keeps nothing.
--      platform.anon_exposure lists whatever anon can still reach without a decision there; check_conformance fails on it.
--   2. Explicit grants. register_table now also grants service_role and the table's own sequences, so a new table no longer
--      leans on default privileges; the contract text says every new view and function grants explicitly too.
--   3. Heavy jsonb (S2 follow-up). 160's heavy_columns came back empty: ANALYZE records a TOASTed value at its pointer size
--      (about 18 bytes), so pg_stats.avg_width never sees large jsonb, and it needs ANALYZE to have run at all. Now
--      platform.heavy_jsonb_columns samples up to 200 stored values per jsonb column with pg_column_size: heavy when the
--      average is over 500 bytes or any sampled value is over 2000. No pg_stats.
-- Kind: schema change (grants, default privileges, platform functions and views)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Run after 160. Safe to run again from the top.
-- wb_subscription_overview, named in the request, is already security_invoker (as are all 14 public views); only its anon
-- grant changes here.
-- supabase/migrations/161_mcp_anon_privileges.sql

begin;

-- ============================================================================
-- 0. What authenticated and service_role can do now. Checked again before commit.
-- ============================================================================
create temp table _grants_before on commit drop as
  select 'function'::text as kind, p.oid, rl.role, 'EXECUTE'::text as priv
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   cross join (values ('authenticated'), ('service_role')) as rl(role)
   where n.nspname = 'public' and has_function_privilege(rl.role, p.oid, 'EXECUTE')
  union all
  select 'relation', c.oid, rl.role, pv.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('authenticated'), ('service_role')) as rl(role)
   cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as pv(priv)
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege(rl.role, c.oid, pv.priv)
  union all
  select 'sequence', c.oid, rl.role, pv.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('authenticated'), ('service_role')) as rl(role)
   cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as pv(priv)
   where n.nspname = 'public' and c.relkind = 'S'
     and has_sequence_privilege(rl.role, c.oid, pv.priv);

-- ============================================================================
-- A. The decision table: every deliberate anon grant, with why
-- ============================================================================
create table if not exists platform.anon_access (
  object_kind text not null
    check (object_kind in ('function', 'table', 'view', 'materialized view', 'sequence')),
  object_name text not null,
  reason      text not null,
  decided_by  text not null default 'alex',
  decided_at  timestamptz not null default now(),
  primary key (object_kind, object_name)
);

comment on table platform.anon_access is
  'Every object in public (or platform) that anon may reach on purpose, with the reason. object_name is schema.name for relations and schema.name(identity args) for functions, as platform.anon_exposure prints it. Anything anon can reach that is not here fails check_conformance. Empty since migration 161: no Alfred caller runs as anon.';

-- ============================================================================
-- B. Default privileges: nothing new in public reaches anon or PUBLIC
-- ============================================================================
-- PUBLIC's EXECUTE on new functions is a global default, so it can only be revoked globally (a per-schema entry can only
-- add). The anon entries are per-schema. authenticated and service_role keep their defaults, so the app keeps working,
-- but the contract still asks every migration to grant them explicitly.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- ============================================================================
-- C. Existing objects: make authenticated and service_role explicit, then revoke PUBLIC and anon
-- ============================================================================
do $$
declare
  r record;
  v_role text;
  v_priv text;
begin
  -- Every routine kind (ON ROUTINE covers functions, procedures, aggregates and window functions). Extension members are
  -- left alone; none live in public today.
  for r in
    select p.oid,
           format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig,
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as ident
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    foreach v_role in array array['authenticated', 'service_role'] loop
      if has_function_privilege(v_role, r.oid, 'EXECUTE') then
        execute format('grant execute on routine %s to %I', r.sig, v_role);
      end if;
    end loop;
    if not exists (select 1 from platform.anon_access a
                    where a.object_kind = 'function' and a.object_name = r.ident) then
      execute format('revoke all on routine %s from public, anon', r.sig);
    end if;
  end loop;

  -- Tables, views, materialized views, foreign tables.
  for r in
    select c.oid, c.relkind, format('%I.%I', n.nspname, c.relname) as sig, n.nspname || '.' || c.relname as ident,
           case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    foreach v_role in array array['authenticated', 'service_role'] loop
      foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
        if has_table_privilege(v_role, r.oid, v_priv) then
          execute format('grant %s on table %s to %I', v_priv, r.sig, v_role);
        end if;
      end loop;
    end loop;
    if not exists (select 1 from platform.anon_access a
                    where a.object_kind = r.kind and a.object_name = r.ident) then
      execute format('revoke all on table %s from public, anon', r.sig);
    end if;
  end loop;

  -- Sequences.
  for r in
    select c.oid, format('%I.%I', n.nspname, c.relname) as sig, n.nspname || '.' || c.relname as ident
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'S'
  loop
    foreach v_role in array array['authenticated', 'service_role'] loop
      foreach v_priv in array array['USAGE', 'SELECT', 'UPDATE'] loop
        if has_sequence_privilege(v_role, r.oid, v_priv) then
          execute format('grant %s on sequence %s to %I', v_priv, r.sig, v_role);
        end if;
      end loop;
    end loop;
    if not exists (select 1 from platform.anon_access a
                    where a.object_kind = 'sequence' and a.object_name = r.ident) then
      execute format('revoke all on sequence %s from public, anon', r.sig);
    end if;
  end loop;
end;
$$;

-- ============================================================================
-- D. platform.anon_exposure: what anon can reach without a decision
-- ============================================================================
create or replace view platform.anon_exposure as
with reach as (
  select 'function'::text as kind,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object_name,
         'EXECUTE'::text as privileges
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'platform')
     and has_schema_privilege('anon', n.oid, 'USAGE')
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end,
         n.nspname || '.' || c.relname,
         array_to_string(array_remove(array[
           case when has_table_privilege('anon', c.oid, 'SELECT')     then 'SELECT' end,
           case when has_table_privilege('anon', c.oid, 'INSERT')     then 'INSERT' end,
           case when has_table_privilege('anon', c.oid, 'UPDATE')     then 'UPDATE' end,
           case when has_table_privilege('anon', c.oid, 'DELETE')     then 'DELETE' end,
           case when has_table_privilege('anon', c.oid, 'TRUNCATE')   then 'TRUNCATE' end,
           case when has_table_privilege('anon', c.oid, 'REFERENCES') then 'REFERENCES' end,
           case when has_table_privilege('anon', c.oid, 'TRIGGER')    then 'TRIGGER' end,
           case when has_table_privilege('anon', c.oid, 'MAINTAIN')   then 'MAINTAIN' end], null), ', ')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'platform')
     and has_schema_privilege('anon', n.oid, 'USAGE')
     and c.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'sequence',
         n.nspname || '.' || c.relname,
         array_to_string(array_remove(array[
           case when has_sequence_privilege('anon', c.oid, 'USAGE')  then 'USAGE' end,
           case when has_sequence_privilege('anon', c.oid, 'SELECT') then 'SELECT' end,
           case when has_sequence_privilege('anon', c.oid, 'UPDATE') then 'UPDATE' end], null), ', ')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'platform')
     and has_schema_privilege('anon', n.oid, 'USAGE')
     and c.relkind = 'S'
)
select r.kind, r.object_name, r.privileges
  from reach r
 where r.privileges <> ''
   and not exists (select 1 from platform.anon_access a
                    where a.object_kind = r.kind and a.object_name = r.object_name);

comment on view platform.anon_exposure is
  'Everything anon can reach in a schema it has USAGE on (public; platform only if anon ever gets USAGE) that platform.anon_access does not record as decided: functions it can EXECUTE, relations with any privilege, sequences. EMPTY = nothing reaches anon by accident. check_conformance fails while this has rows.';

-- ============================================================================
-- E. check_conformance: tables AND anon exposure
-- ============================================================================
create or replace function platform.check_conformance()
returns text
language plpgsql
as $$
declare
  v_fail     int;
  v_total    int;
  v_anon     int;
  v_out      text;
  v_anon_out text;
begin
  perform platform.maybe_prune();   -- opportunistic housekeeping, ~1% of calls

  select count(*) into v_total from platform.conformance where not exempt;
  select count(*) into v_fail  from platform.conformance_failures;
  select count(*) into v_anon  from platform.anon_exposure;

  if v_fail = 0 and v_anon = 0 then
    return format('CONFORMANT — all %s non-exempt public tables satisfy platform contract v1, and anon reaches nothing undecided.', v_total);
  end if;

  select string_agg(
           format('  %s: %s', table_name,
             concat_ws('; ', issue_registry, issue_rls, issue_policy,
                             issue_grant, issue_audit, issue_docs, issue_read)),
           E'\n' order by table_name)
    into v_out
    from platform.conformance_failures;

  select string_agg(format('  %s %s (%s)', kind, object_name, privileges), E'\n' order by kind, object_name)
    into v_anon_out
    from platform.anon_exposure;

  return concat_ws(E'\n',
    format('NON-CONFORMANT — %s of %s tables violate platform contract v1; anon can reach %s object(s) not decided in platform.anon_access.',
           v_fail, v_total, v_anon),
    v_out,
    case when v_anon > 0 then E'ANON EXPOSURE (revoke, or record in platform.anon_access with a reason):\n' || v_anon_out end);
end;
$$;

comment on function platform.check_conformance() is
'Human/model-readable conformance report. Surfaced as the check_platform_conformance
MCP tool and run as the final step of every migration block. Fails on any row in
platform.conformance_failures (tables) or platform.anon_exposure (anything anon can
reach without a decision in platform.anon_access).';

-- ============================================================================
-- F. register_table grants explicitly: authenticated AND service_role, and the table's own sequences
-- ============================================================================
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
  v_seq      text;
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

  -- (c) Grants, explicit (Supabase stops granting new tables by default from 2026-10-30): authenticated and service_role
  --     get DML, the table's own sequences (serial or identity) get usage; anon and PUBLIC are stripped.
  execute format(
    'grant select, insert, update, delete on %I.%I to authenticated, service_role', v_schema, v_name);
  execute format('revoke all on %I.%I from public, anon', v_schema, v_name);
  for v_seq in
    select format('%I.%I', sn.nspname, s.relname)
      from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S'
      join pg_namespace sn on sn.oid = s.relnamespace
     where d.classid = 'pg_class'::regclass and d.refobjid = p_table and d.deptype in ('a', 'i')
  loop
    execute format('grant usage, select on sequence %s to authenticated, service_role', v_seq);
    execute format('revoke all on sequence %s from public, anon', v_seq);
  end loop;

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

  return format('registered %s (policy=%s, audited=%s, exempt=%s, granted authenticated + service_role, anon stripped, mcp_read=%s)',
                v_full, p_policy_mode, p_audited, p_exempt,
                (select mcp_read from platform.registry where table_name = v_full));
end;
$$;

-- ============================================================================
-- G. Heavy jsonb without pg_stats
-- ============================================================================
create or replace function platform.heavy_jsonb_columns(p_table regclass)
returns text[]
language plpgsql
stable
as $$
declare
  v_rel text;
  v_col text;
  v_avg numeric;
  v_max int;
  v_out text[] := '{}';
begin
  select format('%I.%I', n.nspname, c.relname) into v_rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  for v_col in
    select a.attname::text
      from pg_attribute a
     where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped
       and a.atttypid in ('jsonb'::regtype, 'json'::regtype)
     order by a.attnum
  loop
    -- pg_column_size is the stored size, read from the TOAST pointer for big values without decompressing them.
    execute format(
      'select avg(w), max(w) from (select pg_column_size(%1$I) as w from %2$s where %1$I is not null limit 200) s',
      v_col, v_rel)
      into v_avg, v_max;
    if v_avg > 500 or v_max > 2000 then
      v_out := v_out || v_col;
    end if;
  end loop;
  return v_out;
end;
$$;

comment on function platform.heavy_jsonb_columns(regclass) is
  'jsonb/json columns of a table that MCP list reads leave out (returned only when records are fetched by ids): over up to 200 sampled non-null stored values (pg_column_size), the average is over 500 bytes or one value is over 2000. Needs no ANALYZE; pg_stats.avg_width cannot be used because it records a TOASTed value at its pointer size. Reads sizes only, never values.';

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
                 select coalesce(jsonb_agg(h.col order by h.ord), '[]'::jsonb)
                   from unnest(platform.heavy_jsonb_columns(c.oid::regclass)) with ordinality as h(col, ord)
                  where h.col <> all(r.secret_columns)),
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
  'MCP read access (spec docs/technical-spec-mcp-read-access.md): for every visible registered public table, or the one named, the readable columns (secret columns removed), secret_columns, heavy_columns (platform.heavy_jsonb_columns: left out of list reads, returned by ids) and has_context_id / has_archived / has_status. Reads the catalog and stored sizes only, never values, so it reveals nothing RLS hides beyond how big a column tends to be. Security definer because PostgREST does not expose the platform schema.';

-- Section C revoked PUBLIC from every public function, this one included; restate its grants explicitly.
revoke all on function public.platform_read_settings(text) from public, anon;
grant execute on function public.platform_read_settings(text) to authenticated, service_role;

-- ============================================================================
-- H. The contract text: explicit grants for every new table, view and function
-- ============================================================================
comment on schema platform is 'Platform contract v1 — shared infrastructure for all MCP-backed apps (Alfred, SAM, Ken, ...).

RULES FOR ANY NEW TABLE:
  1. Every migration that creates a table MUST end with a schema-qualified call:
       select platform.register_table(''public.my_table'');
     This enables RLS, creates the owner policy, grants DML to authenticated AND
     service_role explicitly (and usage on the table''s own sequences), strips all
     privileges from anon and PUBLIC, attaches the audit trigger, and records the
     table in platform.registry.
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

RULES FOR ANY NEW VIEW OR FUNCTION (explicit grants, same migration):
  1. Supabase stops granting new objects by default from 2026-10-30, and this project
     no longer gives anon or PUBLIC anything by default. Every new view and function
     states its grants in the migration that creates it:
       create view public.my_view with (security_invoker = true) as ...;
       revoke all on public.my_view from public, anon;
       grant select on public.my_view to authenticated;           -- and service_role if a server job reads it
       revoke all on function public.my_fn(int) from public, anon;
       grant execute on function public.my_fn(int) to authenticated;  -- and/or service_role, as its callers need
     Views are security_invoker, so the caller''s RLS applies.
  2. anon gets nothing. If something genuinely must work before sign-in, grant it and
     record why in platform.anon_access (object_kind, object_name, reason) in the same
     migration; otherwise platform.anon_exposure lists it and conformance fails.

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

VERIFY WITH: select platform.check_conformance();  -- tables: platform.conformance_failures; anon: platform.anon_exposure
Run check_platform_conformance as the final step of every migration block.

When you mention any Alfred, SAM, Ken, DJ or Warren Buffet record, link it as https://alfredv5vibe.vercel.app/<id> using its id, instead of describing where to find it.';

-- ============================================================================
-- I. Nothing authenticated or service_role could do is lost. Aborts (rolls back everything) if it is.
-- ============================================================================
do $$
declare
  v_lost text;
begin
  select string_agg(format('%s %s %s on %s', b.role, b.priv, b.kind,
                           coalesce((select p.oid::regprocedure::text from pg_proc p where p.oid = b.oid and b.kind = 'function'),
                                    b.oid::regclass::text)), E'\n')
    into v_lost
    from _grants_before b
   where not case b.kind
               when 'function' then has_function_privilege(b.role, b.oid, 'EXECUTE')
               when 'relation' then has_table_privilege(b.role, b.oid, b.priv)
               else has_sequence_privilege(b.role, b.oid, b.priv)
             end;
  if v_lost is not null then
    raise exception E'161 aborted: these grants would be lost:\n%', v_lost;
  end if;
end;
$$;

commit;

-- ============================================================================
-- Result: the one cell the SQL editor shows. Expect conformance to start with CONFORMANT, anon_can_still_reach and
-- anon_access_decisions to be [], and heavy_columns to name items.elements, sam_songs.measures and friends.
-- ============================================================================
select json_build_object(
  'conformance', platform.check_conformance(),
  'anon_can_still_reach', (select coalesce(json_agg(t), '[]'::json) from (
      select * from platform.anon_exposure order by kind, object_name) t),
  'anon_access_decisions', (select coalesce(json_agg(t), '[]'::json) from (
      select * from platform.anon_access order by object_kind, object_name) t),
  'authenticated_reach_now', (select coalesce(json_agg(t), '[]'::json) from (
      select 'functions executable' as what, count(*) as n
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'EXECUTE')
      union all
      select 'relations selectable', count(*)
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege('authenticated', c.oid, 'SELECT')) t),
  'default_privileges_now', (select coalesce(json_agg(t), '[]'::json) from (
      select pg_get_userbyid(d.defaclrole) as owner_role, coalesce(n.nspname, '(all schemas)') as schema,
             d.defaclobjtype as kind, d.defaclacl::text as acl
        from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
       where d.defaclnamespace = 0 or n.nspname in ('public', 'platform')
       order by 1, 2, 3) t),
  'heavy_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select x->>'table' as table_name, x->'heavy_columns' as heavy_columns
        from jsonb_array_elements(public.platform_read_settings()) x
       where jsonb_array_length(x->'heavy_columns') > 0
       order by 1) t),
  'heavy_diagnosis', (select coalesce(json_agg(t), '[]'::json) from (
      select 'items.elements' as col,
             (select avg_width from pg_stats where schemaname = 'public' and tablename = 'items' and attname = 'elements') as pg_stats_avg_width,
             (select round(avg(pg_column_size(v))) from (select elements as v from public.items where elements is not null limit 200) s) as sampled_stored_bytes,
             (select round(avg(octet_length(v::text))) from (select elements as v from public.items where elements is not null limit 200) s) as sampled_text_chars,
             (select greatest(last_analyze, last_autoanalyze) from pg_stat_user_tables where schemaname = 'public' and relname = 'items') as last_analyzed
      union all
      select 'sam_songs.measures',
             (select avg_width from pg_stats where schemaname = 'public' and tablename = 'sam_songs' and attname = 'measures'),
             (select round(avg(pg_column_size(v))) from (select measures as v from public.sam_songs where measures is not null limit 200) s),
             (select round(avg(octet_length(v::text))) from (select measures as v from public.sam_songs where measures is not null limit 200) s),
             (select greatest(last_analyze, last_autoanalyze) from pg_stat_user_tables where schemaname = 'public' and relname = 'sam_songs')
      union all
      select 'sam_song_measures.rh',
             (select avg_width from pg_stats where schemaname = 'public' and tablename = 'sam_song_measures' and attname = 'rh'),
             (select round(avg(pg_column_size(v))) from (select rh as v from public.sam_song_measures where rh is not null limit 200) s),
             (select round(avg(octet_length(v::text))) from (select rh as v from public.sam_song_measures where rh is not null limit 200) s),
             (select greatest(last_analyze, last_autoanalyze) from pg_stat_user_tables where schemaname = 'public' and relname = 'sam_song_measures')
      union all
      select 'wb_transactions.raw',
             (select avg_width from pg_stats where schemaname = 'public' and tablename = 'wb_transactions' and attname = 'raw'),
             (select round(avg(pg_column_size(v))) from (select raw as v from public.wb_transactions where raw is not null limit 200) s),
             (select round(avg(octet_length(v::text))) from (select raw as v from public.wb_transactions where raw is not null limit 200) s),
             (select greatest(last_analyze, last_autoanalyze) from pg_stat_user_tables where schemaname = 'public' and relname = 'wb_transactions')) t),
  'intention_mvjx48agc7a04lgc1ne_description', (select description from public.intents where id = 'mvjx48agc7a04lgc1ne')
) as result;
