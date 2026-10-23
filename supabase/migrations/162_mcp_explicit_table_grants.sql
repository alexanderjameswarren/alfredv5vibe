-- Purpose: MCP read access S2c (Alex, 2026-10-23, run tag mcp_read_gaps-t8k-s7-b2kf; Alfred intention mvjx48agc7a04lgc1ne). From 2026-10-30 Supabase gives new public tables no automatic Data API access, and a local db reset counts every table as new. So the grants no longer come from default privileges anywhere: platform.grant_table() states them for a table or view (select, insert, update, delete to authenticated and service_role; usage on the table's own sequences; nothing for anon or PUBLIC), register_table calls it, and this migration applies it to every registered table and every public view, so a replay of the folder ends with the same grants as live. Alex's decision overrides the intention's "select to anon": anon gets nothing.
-- Kind: schema change (grants and platform functions)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Run after 161. Safe to run again from the top: grants are
-- idempotent and every function is create or replace.
-- On live this changes nothing anyone can do today: authenticated and service_role already hold these grants (161 made them
-- explicit) and anon holds none. It matters for a fresh database, where the defaults will no longer grant them.
-- supabase/migrations/162_mcp_explicit_table_grants.sql

begin;

-- ============================================================================
-- A. platform.grant_table: the explicit grants for one table or view
-- ============================================================================
create or replace function platform.grant_table(p_table regclass)
returns text
language plpgsql
security definer
as $$
declare
  v_kind char;
  v_rel  text;
  v_seq  text;
begin
  select c.relkind, format('%I.%I', n.nspname, c.relname)
    into v_kind, v_rel
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  if v_kind is null then
    raise exception 'grant_table: could not resolve %', p_table;
  end if;
  if v_kind not in ('r', 'p', 'f', 'v', 'm') then
    raise exception 'grant_table: % is not a table or view (relkind %)', v_rel, v_kind;
  end if;

  if v_kind = 'm' then
    -- A materialized view can only be read.
    execute format('grant select on %s to authenticated, service_role', v_rel);
  else
    -- Views get DML too, as default privileges gave them; security_invoker views and RLS still decide the rows.
    execute format('grant select, insert, update, delete on %s to authenticated, service_role', v_rel);
  end if;
  execute format('revoke all on %s from public, anon', v_rel);

  -- The table's own sequences (serial or identity columns).
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

  return format('granted %s to authenticated + service_role, anon and PUBLIC stripped', v_rel);
end;
$$;

comment on function platform.grant_table(regclass) is
  'Explicit grants for one table or view, independent of default privileges (Supabase stops granting new tables from 2026-10-30): select, insert, update, delete to authenticated and service_role (select only for a materialized view), usage and select on the table''s own sequences, everything revoked from anon and PUBLIC. register_table calls it; a migration creating a view calls it directly after the create.';

-- ============================================================================
-- B. register_table uses it
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

  -- (c) Grants, explicit: see platform.grant_table.
  perform platform.grant_table(p_table);

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
-- C. Apply it to every registered table and every public view
-- ============================================================================
select platform.grant_table(to_regclass(r.table_name))
  from platform.registry r
 where to_regclass(r.table_name) is not null;

select platform.grant_table(c.oid::regclass)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('v', 'm');

-- ============================================================================
-- D. Check: every registered table and public view is readable and writable by authenticated and service_role
-- ============================================================================
do $$
declare
  v_missing text;
begin
  select string_agg(format('%s %s %s', rl.role, pv.priv, c.oid::regclass::text), E'\n')
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('authenticated'), ('service_role')) as rl(role)
   cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as pv(priv)
   where n.nspname = 'public'
     and (c.relkind in ('v') or (c.relkind = 'm' and pv.priv = 'SELECT')
          or exists (select 1 from platform.registry r where to_regclass(r.table_name) = c.oid))
     and not has_table_privilege(rl.role, c.oid, pv.priv);
  if v_missing is not null then
    raise exception E'162 aborted: grants still missing:\n%', v_missing;
  end if;
end;
$$;

commit;

-- ============================================================================
-- Result: expect conformance to start with CONFORMANT and anon_can_still_reach to be [].
-- ============================================================================
select json_build_object(
  'conformance', platform.check_conformance(),
  'anon_can_still_reach', (select coalesce(json_agg(t), '[]'::json) from (
      select * from platform.anon_exposure order by kind, object_name) t),
  'tables_and_views_granted', (select coalesce(json_agg(t), '[]'::json) from (
      select case c.relkind when 'v' then 'view' when 'm' then 'materialized view' else 'table' end as kind, count(*) as n
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege('authenticated', c.oid, 'SELECT')
         and has_table_privilege('service_role', c.oid, 'SELECT')
       group by 1 order by 1) t)
) as result;
