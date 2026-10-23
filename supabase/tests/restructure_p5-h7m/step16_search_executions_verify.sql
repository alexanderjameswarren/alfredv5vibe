-- Restructure P5 Step 16: verify migration 157 (platform_search_executions with p_item_id).
-- Read-only; run whole, paste back the one result cell.
-- Expect: conformant true; exactly one platform_search_executions, with 6 arguments,
-- SECURITY INVOKER; the Spanish Rice item filter returns rows (total >= 0) whose keys
-- include group_id and parent_execution_id; the 5-argument call shape still works.
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'versions', (select coalesce(json_agg(t), '[]'::json) from (
    select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
      from pg_proc p where p.proname = 'platform_search_executions' and p.pronamespace = 'public'::regnamespace) t),
  'rice_total', (select (public.platform_search_executions(p_item_id => 'msxevimvbf9lk6jghk8', p_limit => 5) -> 'total')),
  'rice_first_row_keys', (select coalesce(json_agg(k), '[]'::json) from (
    select jsonb_object_keys(public.platform_search_executions(p_item_id => 'msxevimvbf9lk6jghk8', p_limit => 1) -> 'rows' -> 0) as k) t(k)),
  'old_call_shape_total', (select (public.platform_search_executions(null, null, null, null, 5) -> 'total'))
) as result;
