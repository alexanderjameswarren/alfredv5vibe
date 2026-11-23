-- sb3_pages-h6v B1: verify the run pages migration's shape: the four tables (owner RLS, registered, read-only for
-- authenticated, nothing for anon, the sample hidden and not audited), the ten functions and their grants, the prune's
-- added delete, and conformance. Read only; run after the migration through the queue with --test.
-- Result: one row, with all_passed, failed, errors and checks.
-- supabase/tests/sb3_pages-h6v/1_verify.sql

do $$
declare
  c_tables constant text[] := array['switchboard_run_requests', 'switchboard_run_links', 'switchboard_run_samples', 'switchboard_code_reviews'];
  c_user_fns constant text[] := array[
    'public.switchboard_queue_run_request(jsonb)',
    'public.switchboard_correct_run_request(uuid, text, jsonb, jsonb)',
    'public.switchboard_issue_run_link(uuid, uuid)',
    'public.switchboard_run_preview(text)',
    'public.switchboard_consume_run_link(text, text, jsonb, integer, text)',
    'public.switchboard_cancel_run_link(text, text)',
    'public.switchboard_retry_run(text, text, jsonb)',
    'public.switchboard_record_code_review(uuid, jsonb)'];
  c_service_fns constant text[] := array[
    'public.switchboard_store_run_sample(uuid, jsonb)',
    'public.switchboard_drop_run_sample(uuid)'];
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_conf   text;
  t        text;
  f        text;
begin
  begin
    foreach t in array c_tables loop
      v_checks := v_checks || jsonb_build_object(
        t || '_exists', to_regclass('public.' || t) is not null,
        t || '_rls', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.' || t)), false),
        t || '_auth_reads', has_table_privilege('authenticated', 'public.' || t, 'select'),
        t || '_auth_cannot_write', not has_table_privilege('authenticated', 'public.' || t, 'insert')
                                   and not has_table_privilege('authenticated', 'public.' || t, 'update')
                                   and not has_table_privilege('authenticated', 'public.' || t, 'delete'),
        t || '_service_writes', has_table_privilege('service_role', 'public.' || t, 'insert'),
        t || '_anon_nothing', not has_table_privilege('anon', 'public.' || t, 'select')
                              and not has_table_privilege('anon', 'public.' || t, 'insert'),
        t || '_has_comment', obj_description(to_regclass('public.' || t), 'pg_class') is not null);
    end loop;

    foreach f in array c_user_fns loop
      v_checks := v_checks || jsonb_build_object(
        f || '_authenticated', has_function_privilege('authenticated', f, 'execute'),
        f || '_not_anon', not has_function_privilege('anon', f, 'execute'),
        f || '_definer', coalesce((select prosecdef from pg_proc where oid = f::regprocedure), false));
    end loop;
    foreach f in array c_service_fns loop
      v_checks := v_checks || jsonb_build_object(
        f || '_service_role', has_function_privilege('service_role', f, 'execute'),
        f || '_not_authenticated', not has_function_privilege('authenticated', f, 'execute'),
        f || '_not_anon', not has_function_privilege('anon', f, 'execute'));
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'prune_not_authenticated', not has_function_privilege('authenticated', 'public.switchboard_prune_sf_results()', 'execute'),
      'prune_not_anon', not has_function_privilege('anon', 'public.switchboard_prune_sf_results()', 'execute'),
      'prune_deletes_samples', pg_get_functiondef('public.switchboard_prune_sf_results()'::regprocedure) like '%switchboard_run_samples%',
      'prune_still_deletes_sf_results', pg_get_functiondef('public.switchboard_prune_sf_results()'::regprocedure) like '%switchboard_sf_results%',
      -- The sample is client data: not audited (no copy outlives it) and hidden from MCP reads (Q4).
      'samples_not_audited', not exists (select 1 from pg_trigger where tgrelid = 'public.switchboard_run_samples'::regclass
                                                                     and tgname = 'audit_trigger'),
      'requests_audited', exists (select 1 from pg_trigger where tgrelid = 'public.switchboard_run_requests'::regclass
                                                             and tgname = 'audit_trigger'),
      -- switchboard_actions is not altered by this migration: 248's sf_run checks stand.
      'sf_run_payload_check_stands', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_run_payload'),
      'sf_run_click_check_stands', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_run_click'),
      'link_token_unique', exists (select 1 from pg_constraint where conrelid = 'public.switchboard_run_links'::regclass
                                                               and contype = 'u'),
      'sample_24_hours_check', exists (select 1 from pg_constraint where conrelid = 'public.switchboard_run_samples'::regclass
                                                                    and contype = 'c'
                                                                    and pg_get_constraintdef(oid) like '%24:00:00%'));

    v_conf := public.platform_check_conformance();
    v_checks := v_checks || jsonb_build_object('conformant', v_conf like 'CONFORMANT%');

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'conformance', v_conf,
      'checks', v_checks);
    raise exception 'switchboard_verify_undo';
  exception when others then
    if sqlerrm <> 'switchboard_verify_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('switchboard.verify_result', v_result::text, true);
end;
$$;

select current_setting('switchboard.verify_result')::jsonb as result;
