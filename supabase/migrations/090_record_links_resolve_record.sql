-- Purpose: Record links Step 2. public.record_lookup_tables() and public.resolve_record(p_id text), so https://alfredv5vibe.vercel.app/<id> can find which registered table holds a row and return {table, row, match_count}, or null.
-- Kind: schema change (two new functions)
-- Applied: NO — awaiting Alex.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
-- Progress: docs/progress-record_links-r7k.md.
-- Run as one block in the SQL editor.
-- supabase/migrations/090_record_links_resolve_record.sql

-- Table list only. SECURITY DEFINER because authenticated has no access to the
-- platform schema, and is deliberately not given any.
create or replace function public.record_lookup_tables()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select c.relname::text
    from platform.registry r
    join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(r.table_name::text)
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_attribute a
      on a.attrelid = c.oid and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
   where not r.exempt
     and n.nspname = 'public'
   order by c.relname;
$$;

revoke all on function public.record_lookup_tables() from public;
revoke all on function public.record_lookup_tables() from anon;
grant execute on function public.record_lookup_tables() to authenticated;

-- SECURITY INVOKER: every lookup runs as the caller, so RLS decides. A row the
-- caller cannot see, or a table it has no SELECT on, simply does not match.
create or replace function public.resolve_record(p_id text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tbl       text;
  v_rel       regclass;
  v_is_uuid   boolean;
  v_uuid      uuid;
  v_row       jsonb;
  v_first     jsonb;
  v_table     text;
  v_count     int := 0;
begin
  if p_id is null or btrim(p_id) = '' then
    return null;
  end if;

  -- uuid columns are compared as uuid so their primary-key index is used;
  -- a non-uuid id cannot be in a uuid column, so those tables are skipped.
  if p_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_uuid := p_id::uuid;
  end if;

  for v_tbl in select * from public.record_lookup_tables()
  loop
    v_rel := pg_catalog.to_regclass(format('public.%I', v_tbl));
    if v_rel is null then
      continue;
    end if;

    select a.atttypid = 'uuid'::regtype into v_is_uuid
      from pg_catalog.pg_attribute a
     where a.attrelid = v_rel and a.attname = 'id' and not a.attisdropped;

    if v_is_uuid and v_uuid is null then
      continue;
    end if;
    if not pg_catalog.has_table_privilege(v_rel, 'SELECT') then
      continue;
    end if;

    v_row := null;
    begin
      if v_is_uuid then
        execute format('select pg_catalog.to_jsonb(x) from %s x where x.id = $1 limit 1', v_rel)
          into v_row using v_uuid;
      else
        execute format('select pg_catalog.to_jsonb(x) from %s x where x.id::text = $1 limit 1', v_rel)
          into v_row using p_id;
      end if;
    exception when insufficient_privilege then
      v_row := null;
    end;

    if v_row is not null then
      v_count := v_count + 1;
      if v_first is null then
        v_first := v_row;
        v_table := v_tbl;
      end if;
    end if;
  end loop;

  if v_first is null then
    return null;
  end if;

  return jsonb_build_object('table', v_table, 'row', v_first, 'match_count', v_count);
end;
$$;

revoke all on function public.resolve_record(text) from public;
revoke all on function public.resolve_record(text) from anon;
grant execute on function public.resolve_record(text) to authenticated;

-- After running: check_platform_conformance (or select * from platform.conformance_failures;
-- expect no rows), then the combined smoke-test query in the Step 2 report.
