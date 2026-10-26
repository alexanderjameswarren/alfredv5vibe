-- Overwatch Step 33 check, after the tab views migration and its test. Read-only. Paste back the single result cell.
-- Expected: one row per app with its newest activity; the Overwatch project with first_report_at before
-- last_report_at; icon TowerControl; anon false, authenticated true on both; CONFORMANT.
-- supabase/tests/overwatch-q4n/23_verify_tab_views.sql

select json_build_object(
  'app_last_activity', (select coalesce(json_agg(t), '[]'::json) from (
      select app_id, last_occurred_at, rows_logged from public.overwatch_app_last_activity order by last_occurred_at desc) t),
  'overwatch_project', (select coalesce(json_agg(t), '[]'::json) from (
      select name, steps_used, reports, first_report_at, last_report_at
        from public.overwatch_project_progress(null, array['mvnv8pa2v6zip3xnpm'])) t),
  'overwatch_icon', (select icon from public.apps where id = 'overwatch'),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select 'view' as object,
             has_table_privilege('anon', 'public.overwatch_app_last_activity', 'select') as anon,
             has_table_privilege('authenticated', 'public.overwatch_app_last_activity', 'select') as authenticated
      union all
      select 'function',
             has_function_privilege('anon', 'public.overwatch_project_progress(text[], text[])', 'execute'),
             has_function_privilege('authenticated', 'public.overwatch_project_progress(text[], text[])', 'execute')) t),
  'conformance', (select public.platform_check_conformance())
) as result;
