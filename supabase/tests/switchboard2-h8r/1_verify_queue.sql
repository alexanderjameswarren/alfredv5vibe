-- Switchboard 2.0 step 2.3: verify the queue migration, on throwaway rows. Run whole in the SQL editor, after the
-- migration. It ENDS IN A DELIBERATE ERROR so everything rolls back. The error message is the result: copy the JSON
-- after "SWITCHBOARD_VERIFY_RESULT" and paste it back.
--
-- Expected: all_passed true and failed []. `checks` lists every check by name; `conformance` says CONFORMANT.
-- supabase/tests/switchboard2-h8r/1_verify_queue.sql

do $$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_other constant uuid := '00000000-0000-4000-8000-000000000001';
  c_alex_claims  constant text := json_build_object('sub', c_alex, 'role', 'authenticated')::text;
  c_other_claims constant text := json_build_object('sub', c_other, 'role', 'authenticated')::text;
  v_checks jsonb := '{}'::jsonb;
  v_a uuid; v_b uuid; v_run uuid; v_old_run uuid;
  v_fp_a text; v_fp_b text;
  v_link jsonb; v_t1 text; v_t2 text; v_t3 text;
  v_ok boolean; v_n integer; v_failed jsonb; v_conf text; v_read jsonb;
begin
  -- As the SQL editor's role: make two actions and two runs. Existing real rows are left out of the counts below.
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, fingerprint, status)
    values (c_alex, 'sql', 'switchboard2-h8r', jsonb_build_object('sql', E'select 1;\r\n'), 'TEST A', 'forged', 'succeeded')
    returning id, fingerprint into v_a, v_fp_a;
  insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
    values (c_alex, 'sql', 'switchboard2-h8r', jsonb_build_object('sql', 'select 2;'), 'TEST B')
    returning id, fingerprint into v_b, v_fp_b;

  v_checks := v_checks
    || jsonb_build_object('insert_ignores_a_forged_fingerprint', v_fp_a = public.switchboard_fingerprint('{"sql":"select 1;"}'))
    || jsonb_build_object('insert_always_starts_queued', (select status = 'queued' from public.switchboard_actions where id = v_a))
    || jsonb_build_object('fingerprint_ignores_line_endings',
         public.switchboard_fingerprint(jsonb_build_object('sql', E'  select 1;\r\n')) = public.switchboard_fingerprint(jsonb_build_object('sql', 'select 1;')))
    || jsonb_build_object('fingerprint_changes_with_the_sql', v_fp_a <> v_fp_b);

  begin
    update public.switchboard_actions set payload = '{"sql":"select 99"}' where id = v_a;
    v_ok := false;
  exception when others then v_ok := true; end;
  v_checks := v_checks || jsonb_build_object('payload_never_changes', v_ok);

  insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
    values (c_alex, v_a, 'dry_run', 'test', '{"rows":1}') returning id into v_run;
  insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at)
    values (c_alex, v_a, 'real', 'old test', '{"rows":2}', now() - interval '31 days') returning id into v_old_run;
  perform public.switchboard_prune_runs();
  v_checks := v_checks
    || jsonb_build_object('prune_clears_an_old_result_and_keeps_the_row',
         (select result is null and result_pruned_at is not null from public.switchboard_runs where id = v_old_run))
    || jsonb_build_object('prune_keeps_a_recent_result',
         (select result is not null from public.switchboard_runs where id = v_run));

  -- Act as Alex: auth.uid() reads the claims, and the authenticated role makes RLS apply as it does for the tools.
  perform set_config('request.jwt.claims', c_alex_claims, true);
  perform set_config('role', 'authenticated', true);

  v_link := public.switchboard_issue_link(v_a);
  v_t1 := substring(v_link->>'url' from '/approve/([0-9a-f]+)$');
  v_checks := v_checks
    || jsonb_build_object('issue_returns_a_url_on_the_base_address',
         v_t1 is not null and length(v_t1) = 64 and v_link->>'url' like (select link_base_url from public.switchboard_settings where user_id = c_alex) || '/approve/%')
    || jsonb_build_object('issue_expires_in_30_minutes',
         (v_link->>'expires_at')::timestamptz between now() + interval '29 minutes' and now() + interval '31 minutes');

  begin perform public.switchboard_issue_link(v_b); v_ok := false;
  exception when others then v_ok := sqlerrm like '%another link is live%'; end;
  v_checks := v_checks || jsonb_build_object('second_live_link_refused', v_ok);

  begin perform public.switchboard_issue_link(v_a); v_ok := false;
  exception when others then v_ok := sqlerrm like '%another link is live%'; end;
  v_checks := v_checks || jsonb_build_object('second_link_for_the_same_action_refused', v_ok);

  begin perform public.switchboard_consume_link(v_t1, v_fp_b); v_ok := false;
  exception when others then v_ok := sqlerrm like '%does not match%'; end;
  v_checks := v_checks || jsonb_build_object('wrong_fingerprint_refused', v_ok);

  begin perform public.switchboard_consume_link('not-a-token', v_fp_a); v_ok := false;
  exception when others then v_ok := sqlerrm like '%no such link%'; end;
  v_checks := v_checks || jsonb_build_object('unknown_token_refused', v_ok);

  -- Direct writes are closed to authenticated, whatever RLS would say.
  begin
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'sql', 'switchboard2-h8r', '{"sql":"select 3"}', 'TEST C');
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; end;
  v_checks := v_checks || jsonb_build_object('authenticated_cannot_insert_an_action', v_ok);

  begin
    update public.switchboard_actions set link_used_at = null, link_expires_at = now() + interval '1 year' where id = v_a;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; end;
  v_checks := v_checks || jsonb_build_object('authenticated_cannot_update_an_action', v_ok);

  begin
    delete from public.switchboard_runs where id = v_run;
    v_ok := false;
  exception when insufficient_privilege then v_ok := true; end;
  v_checks := v_checks || jsonb_build_object('authenticated_cannot_delete_a_run', v_ok);

  -- Run history and links belong to their owner.
  select count(*) into v_n from public.switchboard_runs where id in (v_run, v_old_run);
  v_checks := v_checks || jsonb_build_object('owner_sees_its_runs', v_n = 2);

  perform set_config('request.jwt.claims', c_other_claims, true);
  select count(*) into v_n from public.switchboard_runs where id in (v_run, v_old_run);
  v_checks := v_checks || jsonb_build_object('another_user_sees_no_runs', v_n = 0);
  select count(*) into v_n from public.switchboard_actions where id in (v_a, v_b);
  v_checks := v_checks || jsonb_build_object('another_user_sees_no_actions', v_n = 0);
  select count(*) into v_n from public.switchboard_settings where user_id = c_alex;
  v_checks := v_checks || jsonb_build_object('another_user_sees_no_settings', v_n = 0);
  begin perform public.switchboard_consume_link(v_t1, v_fp_a); v_ok := false;
  exception when others then v_ok := sqlerrm like '%no such link%'; end;
  v_checks := v_checks || jsonb_build_object('another_user_cannot_consume', v_ok);
  begin perform public.switchboard_issue_link(v_b); v_ok := false;
  exception when others then v_ok := sqlerrm like '%no such action%'; end;
  v_checks := v_checks || jsonb_build_object('another_user_cannot_issue', v_ok);
  perform set_config('request.jwt.claims', c_alex_claims, true);

  -- The right token and fingerprint work once.
  v_link := public.switchboard_consume_link(v_t1, v_fp_a);
  v_checks := v_checks || jsonb_build_object('consume_succeeds', (v_link->>'action_id')::uuid = v_a);
  begin perform public.switchboard_consume_link(v_t1, v_fp_a); v_ok := false;
  exception when others then v_ok := sqlerrm like '%already been used%'; end;
  v_checks := v_checks || jsonb_build_object('second_use_refused', v_ok);
  begin perform public.switchboard_issue_link(v_a); v_ok := false;
  exception when others then v_ok := sqlerrm like '%cannot have a new link%'; end;
  v_checks := v_checks || jsonb_build_object('consumed_action_gets_no_new_link', v_ok);

  -- With no live link, the next action can have one; once expired it is refused and can be replaced.
  v_t2 := substring(public.switchboard_issue_link(v_b)->>'url' from '/approve/([0-9a-f]+)$');
  perform set_config('role', 'none', true);
  update public.switchboard_actions set link_expires_at = now() - interval '1 second' where id = v_b;
  perform set_config('role', 'authenticated', true);
  begin perform public.switchboard_consume_link(v_t2, v_fp_b); v_ok := false;
  exception when others then v_ok := sqlerrm like '%has expired%'; end;
  v_checks := v_checks || jsonb_build_object('expired_link_refused', v_ok);

  v_t3 := substring(public.switchboard_issue_link(v_b)->>'url' from '/approve/([0-9a-f]+)$');
  begin perform public.switchboard_consume_link(v_t2, v_fp_b); v_ok := false;
  exception when others then v_ok := sqlerrm like '%no such link%'; end;
  v_checks := v_checks
    || jsonb_build_object('replacing_an_expired_link_kills_the_old_token', v_ok)
    || jsonb_build_object('replacement_link_consumes',
         (public.switchboard_consume_link(v_t3, v_fp_b)->>'action_id')::uuid = v_b);

  -- Back as the editor's role: a used link cannot be reopened by anyone, and the catalog is as it should be.
  perform set_config('role', 'none', true);
  begin
    update public.switchboard_actions set link_used_at = null where id = v_a;
    v_ok := false;
  exception when others then v_ok := true; end;
  v_checks := v_checks || jsonb_build_object('used_link_cannot_be_reopened', v_ok);

  v_read := public.platform_read_settings('switchboard_actions')->0;
  v_checks := v_checks
    || jsonb_build_object('token_is_not_stored',
         not exists (select 1 from public.switchboard_actions where link_hash in (v_t1, v_t2, v_t3)))
    || jsonb_build_object('rls_on_all_three',
         (select bool_and(c.relrowsecurity) and count(*) = 3 from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname in ('switchboard_actions', 'switchboard_runs', 'switchboard_settings')))
    || jsonb_build_object('no_anon_on_tables',
         not (has_table_privilege('anon', 'public.switchboard_actions', 'select')
           or has_table_privilege('anon', 'public.switchboard_runs', 'select')
           or has_table_privilege('anon', 'public.switchboard_settings', 'select')))
    || jsonb_build_object('no_anon_on_functions',
         not (has_function_privilege('anon', 'public.switchboard_issue_link(uuid)', 'execute')
           or has_function_privilege('anon', 'public.switchboard_consume_link(text,text)', 'execute')
           or has_function_privilege('anon', 'public.switchboard_fingerprint(jsonb)', 'execute')
           or has_function_privilege('anon', 'public.switchboard_prune_runs()', 'execute')))
    || jsonb_build_object('prune_closed_to_api_roles',
         not (has_function_privilege('authenticated', 'public.switchboard_prune_runs()', 'execute')
           or has_function_privilege('service_role', 'public.switchboard_prune_runs()', 'execute')))
    || jsonb_build_object('link_functions_for_authenticated',
         has_function_privilege('authenticated', 'public.switchboard_issue_link(uuid)', 'execute')
         and has_function_privilege('authenticated', 'public.switchboard_consume_link(text,text)', 'execute'))
    || jsonb_build_object('authenticated_can_flip_the_kill_switch',
         has_column_privilege('authenticated', 'public.switchboard_settings', 'reads_enabled', 'update'))
    || jsonb_build_object('alex_has_a_settings_row_with_reads_on',
         (select reads_enabled from public.switchboard_settings where user_id = c_alex))
    || jsonb_build_object('link_hash_hidden_from_mcp',
         v_read->'secret_columns' ? 'link_hash'
         and not exists (select 1 from jsonb_array_elements(v_read->'columns') c where c->>'name' = 'link_hash'))
    || jsonb_build_object('runs_not_audited',
         (select not audited from platform.registry where table_name = 'public.switchboard_runs'))
    || jsonb_build_object('prune_job_scheduled',
         exists (select 1 from cron.job where jobname = 'switchboard-prune-runs' and active));

  v_conf := public.platform_check_conformance();
  select coalesce(jsonb_agg(key), '[]'::jsonb) into v_failed
    from jsonb_each(v_checks) where value is distinct from 'true'::jsonb;

  raise exception 'SWITCHBOARD_VERIFY_RESULT %', jsonb_build_object(
    'all_passed', v_failed = '[]'::jsonb and v_conf like 'CONFORMANT%',
    'failed', v_failed,
    'conformance', v_conf,
    'checks', v_checks)::text;
end
$$;
