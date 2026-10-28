-- Overwatch Step 53: read-only check after the portfolio plans migration and its test. Paste back the single result
-- cell. Expected: four tables registered and audited, every column commented, RLS on, no rows yet (the tools come in
-- Step 54), the guards on all three version tables, create_portfolio_plan executable by authenticated and
-- service_role but not anon, the three new apps with no screen, CONFORMANT.
-- supabase/tests/overwatch-q4n/27_verify_portfolio_plans.sql

select json_build_object(
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read
        from platform.registry
       where table_name in ('public.portfolios', 'public.portfolio_plans', 'public.portfolio_lanes',
                            'public.portfolio_slices')
       order by table_name
    ) t),
  'uncommented_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name, a.attname as column_name
        from pg_attribute a join pg_class c on c.oid = a.attrelid
       where a.attrelid in ('public.portfolios'::regclass, 'public.portfolio_plans'::regclass,
                            'public.portfolio_lanes'::regclass, 'public.portfolio_slices'::regclass)
         and a.attnum > 0 and not a.attisdropped and col_description(a.attrelid, a.attnum) is null
    ) t),
  'rls_enabled', (select coalesce(json_agg(t), '[]'::json) from (
      select relname as table_name, relrowsecurity as rls
        from pg_class where oid in ('public.portfolios'::regclass, 'public.portfolio_plans'::regclass,
                                    'public.portfolio_lanes'::regclass, 'public.portfolio_slices'::regclass)
    ) t),
  'row_counts', (select coalesce(json_agg(t), '[]'::json) from (
      select 'portfolios' as table_name, count(*) as n from public.portfolios
      union all select 'portfolio_plans', count(*) from public.portfolio_plans
      union all select 'portfolio_lanes', count(*) from public.portfolio_lanes
      union all select 'portfolio_slices', count(*) from public.portfolio_slices
    ) t),
  'guard_triggers', (select coalesce(json_agg(t), '[]'::json) from (
      select tgrelid::regclass::text as table_name, tgname as trigger_name, tgfoid::regproc::text as function_name
        from pg_trigger
       where not tgisinternal and tgname in ('portfolio_plans_guard', 'portfolio_slices_guard')
       order by 1
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role,
             has_function_privilege(r, 'public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb)',
                                    'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'new_apps', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, icon, path, button_name from public.apps where id in ('homer', 'guy', 'handyman') order by id
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
