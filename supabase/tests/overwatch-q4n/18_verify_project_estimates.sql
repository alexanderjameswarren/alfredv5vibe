-- Overwatch Step 21 check, after 175 and the test. Read-only. Paste back the single result cell.
-- Expected: overwatch_history initial 40 then scope_increase 44; current_estimate 44; scope_adjusted 44; test_rows_left 0;
-- functions with anon false and authenticated true; conformance CONFORMANT.
-- supabase/tests/overwatch-q4n/18_verify_project_estimates.sql

select json_build_object(
  'overwatch_history', (select coalesce(json_agg(t), '[]'::json) from (
      select kind, estimate, cli_estimate, steps_added, at_step, reason, created_at
        from public.project_estimates where group_id = 'mvnv8pa2v6zip3xnpm' order by created_at) t),
  'current_estimate', (select effort_estimate from public.project_plans where group_id = 'mvnv8pa2v6zip3xnpm'),
  -- Original plus every steps_added: what accuracy is judged against after scope changes.
  'scope_adjusted', (select max(estimate) filter (where kind = 'initial') + coalesce(sum(steps_added), 0)
                       from public.project_estimates where group_id = 'mvnv8pa2v6zip3xnpm'),
  'test_rows_left', (select count(*) from public.project_estimates where group_id like 'test-ow21-%'),
  'functions', (select coalesce(json_agg(t), '[]'::json) from (
      select p.oid::regprocedure::text as signature,
             has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
        from pg_proc p where p.proname in ('record_project_estimate', 'project_estimates_guard') order by 1) t),
  'conformance', (select public.platform_check_conformance())
) as result;
