-- Overwatch Step 43: read-only check after the platform inventory migration and its test. Paste back the single
-- result cell. Expected: three tables registered (finish_summaries audited, the other two not), every column
-- commented, no rows yet (nothing sends until Step 45), the function executable by service_role only, CONFORMANT.
-- supabase/tests/overwatch-q4n/25_verify_platform_inventory.sql

select json_build_object(
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read
        from platform.registry
       where table_name in ('public.platform_inventory', 'public.platform_open_work', 'public.finish_summaries')
       order by table_name
    ) t),
  'uncommented_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name, a.attname as column_name
        from pg_attribute a join pg_class c on c.oid = a.attrelid
       where a.attrelid in ('public.platform_inventory'::regclass, 'public.platform_open_work'::regclass,
                            'public.finish_summaries'::regclass)
         and a.attnum > 0 and not a.attisdropped and col_description(a.attrelid, a.attnum) is null
    ) t),
  'row_counts', (select coalesce(json_agg(t), '[]'::json) from (
      select 'platform_inventory' as table_name, count(*) as n from public.platform_inventory
      union all select 'platform_open_work', count(*) from public.platform_open_work
      union all select 'finish_summaries', count(*) from public.finish_summaries
    ) t),
  'rls_enabled', (select coalesce(json_agg(t), '[]'::json) from (
      select relname as table_name, relrowsecurity as rls
        from pg_class where oid in ('public.platform_inventory'::regclass, 'public.platform_open_work'::regclass,
                                    'public.finish_summaries'::regclass)
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role,
             has_function_privilege(r, 'public.replace_platform_inventory(uuid, jsonb, jsonb)', 'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
