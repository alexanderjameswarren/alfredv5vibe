-- Switchboard 2.0 step 2.10: what Claude's read-only queries run as. Spec: docs/technical-spec-switchboard2-h8r.md 8.
--
-- claude_reader is its own login, because a query can raise a role back to the session user (spike 2, run
-- a992aa41-766e-45cd-95a9-e99ea2531d5e), and that session user must therefore be claude_reader itself. Every read rule
-- names Alex's id rather than auth.uid(), because a query can forge its claims; so the role needs nothing from auth.
--
-- 🛑 NO PASSWORD HERE. The role can't log in until Alex sets one, by hand, outside the queue and git.
-- The caller (the 2.11 tool) still sets read only and the limits each time; the role's own settings are a backstop.
-- Column grants are per column, so a column added later stays unreadable until the helper runs for its table again.

begin;

-- ============================================================================
-- 1. The role.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'claude_reader') then
    create role claude_reader login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 5;
  end if;
end $$;
comment on role claude_reader is
  'Switchboard: the login Claude''s read-only queries run as. Member of nothing. Reads only what platform.apply_reader_access grants, and only Alex''s rows. Its password is set by hand and is in no file.';
alter role claude_reader set default_transaction_read_only = on;
alter role claude_reader set statement_timeout = '10s';
alter role claude_reader set lock_timeout = '1s';
alter role claude_reader set idle_in_transaction_session_timeout = '15s';
grant usage on schema public to claude_reader;

-- ============================================================================
-- 2. The log: every read, kept by the 2.11 tool. Append-only for the signed-in user.
-- ============================================================================
create table if not exists public.switchboard_read_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id),
  query_text  text not null,
  ok          boolean not null,
  row_count   integer,
  truncated   boolean not null default false,
  error       text,
  took_ms     integer,
  created_at  timestamptz not null default now()
);
comment on table public.switchboard_read_log is
  'SWITCHBOARD. One row per read-only query Claude ran: what it asked and how it went, never the rows it got. Written by get_sql_read; append-only, so authenticated can read and add but not change or remove. Spec: docs/technical-spec-switchboard2-h8r.md 8.';
comment on column public.switchboard_read_log.id is 'Row id.';
comment on column public.switchboard_read_log.user_id is 'Owner. Owner RLS.';
comment on column public.switchboard_read_log.query_text is 'The statement as Claude sent it.';
comment on column public.switchboard_read_log.ok is 'False when Postgres refused it or it timed out.';
comment on column public.switchboard_read_log.row_count is 'Rows returned, after the cap. Null when it failed.';
comment on column public.switchboard_read_log.truncated is 'True when the 1000-row cap cut the answer.';
comment on column public.switchboard_read_log.error is 'Postgres''s message when it failed.';
comment on column public.switchboard_read_log.took_ms is 'How long it took.';
comment on column public.switchboard_read_log.created_at is 'When it ran.';

-- ============================================================================
-- 3. The helper: one table's grants and read rule, from the current settings.
-- ============================================================================
create or replace function platform.apply_reader_access(p_table regclass)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_alex constant text := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_schema   text;
  v_name     text;
  v_kind     char;
  v_uid_type text;
  v_settings jsonb;
  v_cols     text;
begin
  select n.nspname, c.relname, c.relkind
    into v_schema, v_name, v_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;
  if v_schema is null then
    raise exception 'apply_reader_access: could not resolve %', p_table;
  end if;

  -- From nothing each time, so a column that turned secret or a table that turned hidden loses access.
  -- Revoking on the table takes its column grants with it.
  execute format('revoke all on %I.%I from claude_reader', v_schema, v_name);
  if v_kind in ('r', 'p') then
    execute format('drop policy if exists claude_reader_read on %I.%I', v_schema, v_name);
  else
    return 'left out: not a table (a view or similar)';
  end if;
  if v_schema <> 'public' then
    return 'left out: not in public';
  end if;

  select a.atttypid::regtype::text into v_uid_type
    from pg_attribute a
   where a.attrelid = p_table and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped;
  if v_uid_type is null then
    return 'left out: no user_id column';
  end if;

  v_settings := public.platform_read_settings(v_name);
  if jsonb_array_length(v_settings) = 0 then
    return 'left out: hidden from MCP reads';
  end if;
  select string_agg(format('%I', col ->> 'name'), ', ') into v_cols
    from jsonb_array_elements(v_settings -> 0 -> 'columns') col;

  execute format('grant select (%s) on %I.%I to claude_reader', v_cols, v_schema, v_name);
  execute format('create policy claude_reader_read on %I.%I for select to claude_reader using (user_id = %L::%s)',
                 v_schema, v_name, c_alex, v_uid_type);
  return 'covered';
end;
$$;
comment on function platform.apply_reader_access(regclass) is
  'Switchboard: gives claude_reader one table''s readable columns and a rule naming Alex''s id, or takes them away. Called by register_table and set_read_settings. Returns "covered" or "left out: why".';
revoke all on function platform.apply_reader_access(regclass) from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. register_table and set_read_settings call it. Otherwise unchanged.
-- ============================================================================
create or replace function platform.register_table(
  p_table regclass,
  p_policy_mode text default 'owner',
  p_audited boolean default true,
  p_exempt boolean default false,
  p_notes text default null,
  p_mcp_read text default null,
  p_secret_columns text[] default null,
  p_cleared_columns text[] default null
) returns text
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

  -- (f) What Claude's read-only queries may see of it.
  perform platform.apply_reader_access(p_table);

  return format('registered %s (policy=%s, audited=%s, exempt=%s, granted authenticated + service_role, anon stripped, mcp_read=%s)',
                v_full, p_policy_mode, p_audited, p_exempt,
                (select mcp_read from platform.registry where table_name = v_full));
end;
$$;

create or replace function platform.set_read_settings(
  p_table regclass,
  p_mcp_read text default null,
  p_secret_columns text[] default null,
  p_cleared_columns text[] default null
) returns text
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

  perform platform.apply_reader_access(p_table);

  return format('read settings for %s: %s', v_full,
    (select format('mcp_read=%s secret=%s cleared=%s', mcp_read, secret_columns, cleared_columns)
       from platform.registry where table_name = v_full));
end;
$$;

-- ============================================================================
-- 5. Register the log (which applies the helper to it), then every table already registered.
-- ============================================================================
select platform.register_table(
  'public.switchboard_read_log',
  p_policy_mode => 'owner',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'Switchboard: every read-only query Claude ran. Append-only. Not audited: the row is itself the record.'
);
revoke update, delete on public.switchboard_read_log from authenticated;

commit;

-- ============================================================================
-- 6. Result: every registered table, covered or left out and why. The grants are made here.
-- ============================================================================
select jsonb_build_object(
    'covered', coalesce(jsonb_agg(t.table_name order by t.table_name) filter (where t.outcome = 'covered'), '[]'::jsonb),
    'left_out', coalesce(jsonb_object_agg(t.table_name, t.outcome) filter (where t.outcome <> 'covered'), '{}'::jsonb)
  ) as reader_access
  from (
    select r.table_name,
           case when to_regclass(r.table_name) is null then 'left out: table no longer exists'
                else platform.apply_reader_access(to_regclass(r.table_name)) end as outcome
      from platform.registry r
  ) t;

-- ============================================================================
-- 7. Must say CONFORMANT.
-- ============================================================================
select public.platform_check_conformance() as conformance;
