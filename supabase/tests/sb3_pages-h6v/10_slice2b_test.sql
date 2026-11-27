-- sb3_pages-h6v s35: the slice 2b migration (spec 17.1, 17.2, 17.7). Acting as Alex (auth.uid() from the JWT claims)
-- for the page functions; outcome and switchboard_record_kept_test_records are called as this test's role, as the
-- runner's service role would. Runs, links and approvals are made by hand or through the functions; nothing is picked
-- up. Covers:
--   O18: keep_test_records accepted on a pre-check with a rehearsal sandbox and keep_test; refused off a pre-check, not
--     true, with no rehearsal sandbox, with delete_test, without keep_test, and keep_test without it; kept sets
--     recorded on a pass and on a FAIL at the rehearsal, each once, two and three summed, also after a correction
--     (unlike evidence); refused for ok false, a FAIL not at the rehearsal, every malformed shape, another sandbox, a
--     request that keeps nothing, a delete page's run, a pretend/real mismatch, an unfinished or unknown run; a pretend
--     pre-check's pretend run recorded; preview's two keys, and neither on a request or run without them; a correction
--     never drops keep_test_records nor swaps keep_test for delete_test, and keeps keep_test on a rehearsal rerun;
--   O24: the delete page queued with every kept set summed and their run ids kept; refused for counts.total, no
--     count, test_data_of elsewhere, a production or second org, a non-delete kind, a bad, upper-case or unknown id, a
--     data operation, another project, a simulation or pretend mismatch, another run tag, nothing kept, the wrong sum,
--     another sandbox, and a second page while one runs; consume refuses the wrong count, a stale sum, another
--     sandbox and another org, then approves; retry resends, and refuses a stale sum, another sandbox and another org;
--     a failed run marks nothing, a pass marks exactly its sets deleted, and a later page counts only what is left;
--     a correction changes only its wording, never test_data_of, and nothing once its write ran;
--   the constraints and the column check; 256, 257 and 258's rules still holding; grants; conformance.
-- Three refusals are not reached, as in the migration's smoke check: the new function's not-sf_run and no-link
-- refusals, and the second-delete-page refusal in consume and retry, which the project lock always refuses first.
-- Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/10_slice2b_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_why    constant jsonb := '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_sbt    constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "target"}';
  c_tag    constant text  := 'h6v-s2b-a-s1-ab12';
  c_steps4 constant jsonb := '[{"code": "find_kept_test"}, {"code": "type_count"}, {"code": "delete_kept_test"}, {"code": "confirm_gone"}]';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_keep   jsonb;
  v_dbase  jsonb;
  v_out    jsonb;
  v_tok    text;
  v_tokd   text;
  v_p      jsonb;
  v_pre    uuid;
  v_dop    uuid;
  v_plain  uuid;
  v_ppre   uuid;
  v_del    uuid;
  v_del2   uuid;
  v_del4   uuid;
  v_cid    uuid;
  v_act    uuid;
  v_act2   uuid;
  v_act3   uuid;
  v_pact   uuid;
  v_run    uuid;
  v_run2   uuid;
  v_case   record;
  v_kept   jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_keep := jsonb_build_object(
      'page', 'precheck', 'headline', 'H6V TEST: SLICE 2B', 'project_code', 'h6v-s2b-a', 'run_tag', c_tag, 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'keep_test_records', true,
      'steps', '[{"code": "create_test"}, {"code": "rehearse_operation"}, {"code": "keep_test"}]'::jsonb);

    -- ---- 0. grants, columns, constraints, comments ----
    v_checks := v_checks || jsonb_build_object(
      'kept_fn_service_role_only', has_function_privilege('service_role', 'public.switchboard_record_kept_test_records(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_record_kept_test_records(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_record_kept_test_records(uuid)', 'execute'),
      'page_fns_authenticated_not_anon', (select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
        from unnest(array['public.switchboard_queue_run_request(jsonb)', 'public.switchboard_consume_run_link(text, text, jsonb, integer, text)',
                          'public.switchboard_retry_run(text, text, jsonb)', 'public.switchboard_correct_run_request(uuid, text, jsonb, jsonb)',
                          'public.switchboard_run_preview(text)']) f),
      'outcome_service_role_only', has_function_privilege('service_role', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute'),
      'columns_with_comments', (select count(*) = 2 from pg_attribute a where a.attrelid = 'public.switchboard_run_requests'::regclass
        and a.attname in ('kept_test_records', 'test_run_ids') and col_description(a.attrelid, a.attnum) is not null),
      'constraints_name_the_page', (select count(*) = 2 from pg_constraint where conrelid = 'public.switchboard_run_requests'::regclass
        and conname in ('switchboard_run_requests_page_check', 'switchboard_run_requests_base_page_check')
        and pg_get_constraintdef(oid) like '%delete_test_data%'));

    -- ---- 1. queue, O18 ----
    for v_case in select * from (values
      ('keep_off_precheck_refused', v_keep || '{"page": "dataop"}'::jsonb, '%only a pre-check keeps its TEST records%'),
      ('keep_false_refused', v_keep || '{"keep_test_records": false}'::jsonb, '%keep_test_records is true, or left out%'),
      ('keep_string_true_refused', v_keep || '{"keep_test_records": "true"}'::jsonb, '%keep_test_records is true, or left out%'),
      ('keep_no_rehearsal_refused', v_keep || jsonb_build_object('orgs', jsonb_build_array(c_prod)), '%needs the rehearsal sandbox%'),
      ('keep_rehearsal_not_sandbox_refused', v_keep || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb || '{"org_type": "production"}'::jsonb)), '%needs the rehearsal sandbox%'),
      ('keep_rehearsal_alias_of_target_refused', v_keep || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb || '{"alias": "test-prod"}'::jsonb)), '%needs the rehearsal sandbox%'),
      ('keep_malformed_step_refused', v_keep || '{"steps": [{"code": "create_test"}, 5]}'::jsonb, '%lists keep_test, not delete_test%'),
      ('keep_with_delete_test_refused', v_keep || '{"steps": [{"code": "create_test"}, {"code": "keep_test"}, {"code": "delete_test"}]}'::jsonb, '%lists keep_test, not delete_test%'),
      ('keep_without_keep_test_refused', v_keep || '{"steps": [{"code": "create_test"}]}'::jsonb, '%lists keep_test, not delete_test%'),
      ('keep_test_without_keep_refused', v_keep - 'keep_test_records', '%keep_test needs keep_test_records true%'),
      ('keep_test_on_dataop_refused', (v_keep - 'keep_test_records') || '{"page": "dataop"}'::jsonb, '%keep_test needs keep_test_records true%')
    ) t(name, req, words) loop
      v_msg := null;
      begin perform public.switchboard_queue_run_request(v_case.req); exception when others then v_msg := sqlerrm; end;
      v_checks := v_checks || jsonb_build_object(v_case.name, coalesce(v_msg like v_case.words, false));
    end loop;
    v_pre := (public.switchboard_queue_run_request(v_keep)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('keep_accepted',
      (select request->'keep_test_records' = 'true'::jsonb and kept_test_records is null and test_run_ids is null from public.switchboard_run_requests where id = v_pre));
    v_dop := (public.switchboard_queue_run_request((v_keep - 'keep_test_records') || '{"page": "dataop", "steps": [{"code": "write"}]}'::jsonb)->>'request_id')::uuid;
    v_plain := (public.switchboard_queue_run_request((v_keep - 'keep_test_records')
                 || '{"project_code": "h6v-s2b-c", "steps": [{"code": "create_test"}, {"code": "delete_test"}]}'::jsonb)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('plain_precheck_unchanged', v_plain is not null);

    -- ---- 2. queue, O24, before anything is kept ----
    v_dbase := jsonb_build_object(
      'page', 'delete_test_data', 'headline', 'H6V TEST: DELETE TEST DATA', 'project_code', 'h6v-s2b-a', 'run_tag', 'h6v-s2b-a-s2-cd34',
      'simulation', false, 'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_sbt),
      'operation', '{"kind": "delete", "object": "Gift__c", "object_label": "Gift"}'::jsonb,
      'counts', '{"expected": 9}'::jsonb, 'test_data_of', jsonb_build_object('request_id', v_pre, 'run_tag', c_tag), 'steps', c_steps4);
    for v_case in select * from (values
      ('del_total_refused', v_dbase || '{"counts": {"expected": 9, "total": 9}}'::jsonb, '%leave counts.total out%'),
      ('del_no_count_refused', v_dbase - 'counts', '%add counts.total (or expected%'),
      ('del_count_not_whole_refused', v_dbase || '{"counts": {"expected": 1.5}}'::jsonb, '%add counts.total (or expected%'),
      ('test_data_of_off_delete_refused', v_keep || jsonb_build_object('test_data_of', v_dbase->'test_data_of'), '%only a delete page names the pre-check%'),
      ('del_production_org_refused', v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_prod)), '%a delete page runs on one sandbox only%'),
      ('del_two_orgs_refused', v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_sbt, c_sb)), '%a delete page runs on one sandbox only%'),
      ('del_rehearsal_role_refused', v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_sb)), '%a delete page runs on one sandbox only%'),
      ('del_not_delete_refused', v_dbase || '{"operation": {"kind": "update", "object": "Gift__c"}}'::jsonb, '%operation kind is delete%'),
      ('del_no_test_data_of_refused', v_dbase - 'test_data_of', '%add test_data_of%'),
      ('del_bad_id_refused', jsonb_set(v_dbase, '{test_data_of,request_id}', '"not-a-uuid"'), '%add test_data_of%'),
      ('del_upper_id_refused', jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(upper(v_pre::text))), '%add test_data_of%'),
      ('del_no_run_tag_refused', v_dbase #- '{test_data_of,run_tag}', '%add test_data_of%'),
      ('del_dataop_refused', jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(v_dop::text)), '%names the pre-check whose TEST records this deletes%'),
      ('del_other_project_refused', v_dbase || '{"project_code": "h6v-s2b-b"}'::jsonb, '%in its own project%'),
      ('del_sim_mismatch_refused', v_dbase || '{"simulation": true}'::jsonb, '%must both be simulations, or neither%'),
      ('del_pretend_on_real_refused', v_dbase || '{"simulation": true, "pretend": {"scenario": "x"}}'::jsonb, '%must both be simulations, or neither%'),
      ('del_other_run_tag_refused', jsonb_set(v_dbase, '{test_data_of,run_tag}', '"h6v-s2b-a-s9-zz99"'), '%is not the pre-check''s run tag%'),
      ('del_nothing_kept_refused', v_dbase, '%no kept TEST records left to delete%')
    ) t(name, req, words) loop
      v_msg := null;
      begin perform public.switchboard_queue_run_request(v_case.req); exception when others then v_msg := sqlerrm; end;
      v_checks := v_checks || jsonb_build_object(v_case.name, coalesce(v_msg like v_case.words, false));
    end loop;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_dbase, '{test_data_of,request_id}', to_jsonb(gen_random_uuid()::text)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_unknown_id_refused', coalesce(v_msg like '%no such pre-check request%for test_data_of.request_id%', false));

    -- ---- 3. switchboard_record_kept_test_records ----
    v_tok := substring(public.switchboard_issue_run_link(v_pre)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    for v_case in select * from (values
      ('kept_ok_false_refused', '{"ok": false, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}'::jsonb, '%kept only on a pass%'),
      ('kept_fail_not_rehearsal_refused', '{"ok": true, "pass": false, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}'::jsonb, '%kept only on a pass%'),
      ('kept_fail_other_check_refused', '{"ok": true, "pass": false, "failed_check": "count", "kept_test_records": {"count": 4, "sandbox": "test-sb"}}'::jsonb, '%kept only on a pass%'),
      ('kept_missing_refused', '{"ok": true, "pass": true}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_count_zero_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 0, "sandbox": "test-sb"}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_count_too_big_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 1000000000, "sandbox": "test-sb"}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_count_fraction_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 2.5, "sandbox": "test-sb"}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_count_string_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": "4", "sandbox": "test-sb"}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_extra_key_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-sb", "ids": []}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_no_sandbox_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 4}}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_not_object_refused', '{"ok": true, "pass": true, "kept_test_records": [4]}'::jsonb, '%is exactly {"count", "sandbox"}%'),
      ('kept_other_sandbox_refused', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-prod"}}'::jsonb, '%not the request''s rehearsal sandbox%')
    ) t(name, res, words) loop
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
      values (c_alex, v_act, 'real', 'test', v_case.res, now()) returning id into v_run;
      v_msg := null;
      begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
      v_checks := v_checks || jsonb_build_object(v_case.name, coalesce(v_msg like v_case.words, false));
    end loop;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result) values (c_alex, v_act, 'real', 'test', '{"ok": true}') returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_unfinished_refused', coalesce(v_msg like '%the run has not finished%', false));
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(gen_random_uuid()); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_unknown_run_refused', coalesce(v_msg like '%no such run%', false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_pretend_on_real_refused', coalesce(v_msg like '%a pretend run records only on a pretend request%', false));
    v_checks := v_checks || jsonb_build_object('kept_refusals_store_nothing',
      (select kept_test_records is null from public.switchboard_run_requests where id = v_pre));
    -- A pass: recorded, the entry exactly as specified; the same run again: already; a FAIL at the rehearsal: a second set.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    select kept_test_records into v_kept from public.switchboard_run_requests where id = v_pre;
    v_checks := v_checks || jsonb_build_object('kept_pass_recorded', (v_out->>'recorded')::boolean and (v_out->>'kept')::integer = 4
      and jsonb_array_length(v_kept) = 1 and v_kept->0->>'run_id' = v_run::text and v_kept->0->>'run_tag' = c_tag
      and v_kept->0->'count' = '4'::jsonb and v_kept->0->>'sandbox' = 'test-sb' and v_kept->0 ? 'recorded_at'
      and v_kept->0->'deleted_by' = 'null'::jsonb and ((v_kept->0) - array['run_id', 'run_tag', 'count', 'sandbox', 'recorded_at', 'deleted_by']) = '{}'::jsonb);
    v_out := public.switchboard_record_kept_test_records(v_run);
    v_checks := v_checks || jsonb_build_object('kept_repeat_already', (v_out->>'already')::boolean and not (v_out->>'recorded')::boolean
      and (select jsonb_array_length(kept_test_records) = 1 from public.switchboard_run_requests where id = v_pre));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}], "kept_test_records": {"count": 3, "sandbox": "test-sb"}}',
            now() + interval '1 minute', now() + interval '1 minute') returning id into v_run2;
    v_out := public.switchboard_record_kept_test_records(v_run2);
    v_checks := v_checks || jsonb_build_object('kept_rehearsal_fail_second_set', (v_out->>'recorded')::boolean and (v_out->>'kept')::integer = 7);
    -- The preview: the sets, and the newest run's kept_test_records; neither on a request or run without them.
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object('preview_kept_keys', jsonb_array_length(v_p->'request'->'kept_test_records') = 2
      and v_p->'run'->'kept_test_records' = '{"count": 3, "sandbox": "test-sb"}'::jsonb);
    -- A pre-check that keeps nothing: refused; its preview has neither key.
    v_tokd := substring(public.switchboard_issue_run_link(v_plain)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    v_act2 := (public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act2;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'real', 'test', '{"ok": true, "pass": true, "checks": []}', now()) returning id into v_run;
    v_p := public.switchboard_run_preview(v_tokd);
    v_checks := v_checks || jsonb_build_object('preview_no_kept_keys', not ((v_p->'request') ? 'kept_test_records') and not ((v_p->'run') ? 'kept_test_records'));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_on_plain_precheck_refused', coalesce(v_msg like '%the request does not keep its TEST records%', false));

    -- ---- 4. correct, O18 ----
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_pre, 'wording', (v_keep - 'keep_test_records') || '{"headline": "Y"}'::jsonb, c_why); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_never_drops_keep', coalesce(v_msg like '%it changed keep_test_records%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_pre, 'value', v_keep || '{"steps": [{"code": "create_test"}, {"code": "rehearse_operation"}, {"code": "delete_test"}]}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_never_swaps_to_delete_test', coalesce(v_msg like '%so its rehearsal lists keep_test, not delete_test%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_dop, 'value', (v_keep - 'keep_test_records') || '{"page": "dataop", "steps": [{"code": "keep_test"}]}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_keep_test_without_keep_refused', coalesce(v_msg like '%keep_test needs keep_test_records true, which this request does not have%', false));
    -- A value edit that reruns the rehearsal with keep_test: made, a correction page, version 2.
    v_out := public.switchboard_correct_run_request(v_pre, 'value',
               jsonb_set(v_keep, '{operation,value}', '"Y"') || '{"steps": [{"code": "create_test"}, {"code": "rehearse_operation"}, {"code": "keep_test"}]}'::jsonb, c_why);
    v_checks := v_checks || jsonb_build_object('correct_rerun_with_keep_test_made', (v_out->>'version')::integer = 2
      and (select page = 'correction' and request->'keep_test_records' = 'true'::jsonb from public.switchboard_run_requests where id = v_pre));
    -- A run of the used version-1 link, finished before the correction: still recorded (the records exist), unlike evidence.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 2, "sandbox": "test-sb"}}', now() - interval '1 minute', now() - interval '1 minute')
    returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    v_checks := v_checks || jsonb_build_object('kept_after_correction_recorded', (v_out->>'recorded')::boolean and (v_out->>'kept')::integer = 9);

    -- ---- 5. queue, O24, with three kept sets ----
    for v_case in select * from (values
      ('del_wrong_sum_refused', v_dbase || '{"counts": {"expected": 7}}'::jsonb, '%counts.expected (7) is not the TEST records the pre-check kept and has not deleted (9, in 3 sets)%'),
      ('del_other_sandbox_refused', v_dbase || jsonb_build_object('orgs', jsonb_build_array(c_sbt || '{"alias": "test-other"}'::jsonb)), '%kept in another sandbox than this page''s org%')
    ) t(name, req, words) loop
      v_msg := null;
      begin perform public.switchboard_queue_run_request(v_case.req); exception when others then v_msg := sqlerrm; end;
      v_checks := v_checks || jsonb_build_object(v_case.name, coalesce(v_msg like v_case.words, false));
    end loop;
    v_del := (public.switchboard_queue_run_request(v_dbase)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('del_accepted_three_sets', (select total_count = 9 and base_page = 'delete_test_data'
      and (select array_agg(x order by x) from unnest(test_run_ids) x)
          = (select array_agg((e->>'run_id')::uuid order by (e->>'run_id')::uuid) from jsonb_array_elements((select kept_test_records from public.switchboard_run_requests where id = v_pre)) e)
      from public.switchboard_run_requests where id = v_del));

    -- ---- 6. correct, O24 ----
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_del, 'records', v_dbase || '{"counts": {"expected": 8}}'::jsonb, c_why); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_correct_records_refused', coalesce(v_msg like '%a delete page changes only its wording, so a records edit is refused%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_del, 'wording', jsonb_set(v_dbase, '{test_data_of,run_tag}', '"h6v-s2b-a-s9-zz99"'), c_why); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_correct_test_data_of_refused', coalesce(v_msg like '%it changed test_data_of%', false));
    v_out := public.switchboard_correct_run_request(v_del, 'wording', v_dbase || '{"headline": "H6V TEST: DELETE, REWORDED"}'::jsonb, c_why);
    v_checks := v_checks || jsonb_build_object('del_correct_wording_made', (v_out->>'version')::integer = 1
      and (select request->>'headline' = 'H6V TEST: DELETE, REWORDED' and total_count = 9 and cardinality(test_run_ids) = 3 from public.switchboard_run_requests where id = v_del));

    -- ---- 7. consume, O24 ----
    v_tokd := substring(public.switchboard_issue_run_link(v_del)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 7); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('consume_del_wrong_count_refused', coalesce(v_msg like '%the count approved (7) is not the request''s count (9)%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, null); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('consume_del_no_count_refused', coalesce(v_msg like '%the count approved (<NULL>) is not the request''s count (9)%', false));
    -- A fourth set kept after the page was queued: stale.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 1, "sandbox": "test-sb"}}', now()) returning id into v_run;
    perform public.switchboard_record_kept_test_records(v_run);
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 9); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('consume_del_stale_refused', coalesce(v_msg like '%changed since this delete page was queued (10 now, 9 on the page)%', false)
      and (select used_at is null from public.switchboard_run_links where request_id = v_del));
    v_del2 := (public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 10}}'::jsonb)->>'request_id')::uuid;
    v_tokd := substring(public.switchboard_issue_run_link(v_del2)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tokd);
    update public.switchboard_run_requests set kept_test_records = jsonb_set(kept_test_records, '{0,sandbox}', '"test-x"') where id = v_pre;
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 10); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('consume_del_other_sandbox_refused', coalesce(v_msg like '%switchboard_consume_run_link: the TEST records were kept in another sandbox%', false));
    update public.switchboard_run_requests set kept_test_records = jsonb_set(kept_test_records, '{0,sandbox}', '"test-sb"') where id = v_pre;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt, c_prod)) where id = v_del2;
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tokd, public.switchboard_run_preview(v_tokd)->>'fingerprint', c_ready, 10); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('consume_del_other_org_refused', coalesce(v_msg like '%switchboard_consume_run_link: a delete page runs on one sandbox only%', false));
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt)) where id = v_del2;
    v_out := public.switchboard_consume_run_link(v_tokd, v_p->>'fingerprint', c_ready, 10);
    v_act2 := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('consume_del_approved', v_act2 is not null and (v_out->>'as_rerun')::boolean is false
      and (select l.action_id = v_act2 and l.used_at is not null from public.switchboard_run_links l where l.request_id = v_del2));
    -- A second delete page for the same pre-check, while this one runs.
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 10}}'::jsonb); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_second_page_refused', coalesce(v_msg like ('%another delete page (request ' || v_del2::text || ') is deleting%'), false));
    -- The new function on a delete page's run.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 4, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_on_delete_run_refused', coalesce(v_msg like '%that run is not a pre-check''s run or rerun%', false));
    delete from public.switchboard_runs where id = v_run;

    -- ---- 8. retry, O24 ----
    -- Never started: the actions guard keeps created_at, so the run says so, as the 15-minute expiry writes it.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, finished_at)
    values (c_alex, v_act2, 'real', 'test: never picked up', '{"ok": false, "expired": true, "reason": "expired_not_picked_up"}', 'expired_not_picked_up', now());
    v_out := public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready);
    v_act3 := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('retry_del_resent', v_act3 is not null and (v_out->>'replaces')::uuid = v_act2
      and (select status = 'failed' from public.switchboard_actions where id = v_act2));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 6, "sandbox": "test-sb"}}', now()) returning id into v_run;
    perform public.switchboard_record_kept_test_records(v_run);
    v_msg := null;
    begin perform public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('retry_del_stale_refused', coalesce(v_msg like '%switchboard_retry_run: the kept TEST records changed since this delete page was queued (16 now, 10 on the page)%', false));
    update public.switchboard_run_requests set kept_test_records = kept_test_records - 4 where id = v_pre;
    update public.switchboard_run_requests set kept_test_records = jsonb_set(kept_test_records, '{1,sandbox}', '"test-x"') where id = v_pre;
    v_msg := null;
    begin perform public.switchboard_retry_run(v_tokd, v_p->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('retry_del_other_sandbox_refused', coalesce(v_msg like '%switchboard_retry_run: the TEST records were kept in another sandbox%', false));
    update public.switchboard_run_requests set kept_test_records = jsonb_set(kept_test_records, '{1,sandbox}', '"test-sb"') where id = v_pre;
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt || '{"org_type": "production"}'::jsonb)) where id = v_del2;
    v_msg := null;
    begin perform public.switchboard_retry_run(v_tokd, public.switchboard_run_preview(v_tokd)->>'fingerprint', c_ready); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('retry_del_other_org_refused', coalesce(v_msg like '%switchboard_retry_run: a delete page runs on one sandbox only%', false));
    update public.switchboard_run_requests set request = jsonb_set(request, '{orgs}', jsonb_build_array(c_sbt)) where id = v_del2;

    -- ---- 9. outcome, O24 ----
    update public.switchboard_actions set picked_up_at = now() where id = v_act3;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act3, 'real', 'test', '{"ok": false}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"stopped": {"already_changed": 2}}'::jsonb);
    v_checks := v_checks || jsonb_build_object('outcome_del_failed_marks_nothing', (v_out->>'recorded')::boolean
      and not exists (select 1 from jsonb_array_elements((select kept_test_records from public.switchboard_run_requests where id = v_pre)) e where (e->>'deleted_by') is not null));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at, finished_at)
    values (c_alex, v_act3, 'real', 'test', '{"ok": true, "pass": false}', now() + interval '1 minute', now() + interval '1 minute') returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 9}'::jsonb);
    v_checks := v_checks || jsonb_build_object('outcome_del_fail_marks_nothing', (v_out->>'recorded')::boolean
      and not exists (select 1 from jsonb_array_elements((select kept_test_records from public.switchboard_run_requests where id = v_pre)) e where (e->>'deleted_by') is not null));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, started_at, finished_at)
    values (c_alex, v_act3, 'real', 'test', '{"ok": true, "pass": true}', now() + interval '2 minutes', now() + interval '2 minutes') returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 10}'::jsonb);
    select kept_test_records into v_kept from public.switchboard_run_requests where id = v_pre;
    v_checks := v_checks || jsonb_build_object('outcome_del_pass_marks_its_sets', (v_out->>'recorded')::boolean
      and jsonb_array_length(v_kept) = 4
      and not exists (select 1 from jsonb_array_elements(v_kept) e where (e->>'deleted_by') is distinct from v_del2::text));
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 10}'::jsonb);
    v_checks := v_checks || jsonb_build_object('outcome_del_repeat_already', (v_out->>'already')::boolean);
    update public.switchboard_actions set status = 'succeeded' where id = v_act3;
    -- A correction once the write ran: refused, even wording.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_del2, 'wording', v_dbase || '{"counts": {"expected": 10}, "headline": "Z"}'::jsonb, c_why); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_correct_after_write_refused', coalesce(v_msg like '%a production write already ran on this request%', false));
    -- Everything deleted: a new delete page finds nothing; a set kept since is the next page's whole count.
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 10}}'::jsonb); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_after_delete_nothing_left', coalesce(v_msg like '%no kept TEST records left to delete%', false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 3, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    v_del4 := (public.switchboard_queue_run_request(v_dbase || '{"counts": {"expected": 3}}'::jsonb)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('del_counts_only_whats_left', (v_out->>'kept')::integer = 3
      and (select total_count = 3 and test_run_ids = array[v_run] from public.switchboard_run_requests where id = v_del4));

    -- ---- 10. pretend ----
    v_ppre := (public.switchboard_queue_run_request(v_keep || '{"project_code": "h6v-s2b-p", "run_tag": "h6v-s2b-p-s1-ab12", "simulation": true, "pretend": {"scenario": "keep_ok"}}'::jsonb)->>'request_id')::uuid;
    v_tok := substring(public.switchboard_issue_run_link(v_ppre)->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_pact := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_pact;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_pact, 'real', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 2, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_kept_test_records(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_real_on_pretend_refused', coalesce(v_msg like '%a pretend run records only on a pretend request%', false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_pact, 'pretend', 'test', '{"ok": true, "pass": true, "kept_test_records": {"count": 2, "sandbox": "test-sb"}}', now()) returning id into v_run;
    v_out := public.switchboard_record_kept_test_records(v_run);
    v_checks := v_checks || jsonb_build_object('kept_pretend_recorded', (v_out->>'recorded')::boolean and (v_out->>'kept')::integer = 2);
    v_out := public.switchboard_queue_run_request(v_dbase || jsonb_build_object('project_code', 'h6v-s2b-p', 'simulation', true, 'pretend', '{"scenario": "delete_ok"}'::jsonb,
               'counts', '{"expected": 2}'::jsonb, 'test_data_of', jsonb_build_object('request_id', v_ppre, 'run_tag', 'h6v-s2b-p-s1-ab12')));
    v_checks := v_checks || jsonb_build_object('del_pretend_accepted', (select pretend and simulation and total_count = 2 from public.switchboard_run_requests where id = (v_out->>'request_id')::uuid));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_dbase || jsonb_build_object('project_code', 'h6v-s2b-p', 'simulation', true,
               'counts', '{"expected": 2}'::jsonb, 'test_data_of', jsonb_build_object('request_id', v_ppre, 'run_tag', 'h6v-s2b-p-s1-ab12')));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('del_plain_sim_on_pretend_refused', coalesce(v_msg like '%must both have pretend, or neither%', false));

    -- ---- 11. the constraints ----
    v_msg := null;
    begin update public.switchboard_run_requests set page = 'nope' where id = v_del4; exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('page_constraint_refuses_unknown', coalesce(v_msg like '%switchboard_run_requests_page_check%', false));
    v_msg := null;
    begin update public.switchboard_run_requests set base_page = 'nope' where id = v_del4; exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('base_page_constraint_refuses_unknown', coalesce(v_msg like '%switchboard_run_requests_base_page_check%', false));
    v_msg := null;
    begin update public.switchboard_run_requests set kept_test_records = '{}'::jsonb where id = v_pre; exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('kept_column_must_be_a_list', v_msg is not null);

    -- ---- 12. 256, 257 and 258 still hold ----
    v_msg := null;
    begin perform public.switchboard_queue_run_request((v_keep - 'keep_test_records') || '{"project_code": "h6v-s2b-k", "simulation": true, "pretend": {"scenario": "a/b"}, "steps": [{"code": "write"}]}'::jsonb);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_shape_still_refused', coalesce(v_msg like '%pretend must be {"scenario": "<name>"}%', false));
    v_out := public.switchboard_queue_run_request((v_keep - array['keep_test_records', 'counts']) || jsonb_build_object('page', 'undo', 'steps', '[{"code": "write"}]'::jsonb,
               'counts', '{"expected": 45, "undo_up_to": 40}'::jsonb, 'undo_of', jsonb_build_object('run_tag', 'h6v-s2b-a-s1-ab12', 'request_id', v_dop)));
    v_checks := v_checks || jsonb_build_object('undo_of_still_accepted', (v_out->>'request_id') is not null);
    v_cid := (public.switchboard_queue_run_request((v_keep - 'keep_test_records') || jsonb_build_object('page', 'check', 'steps', '[{"code": "job_state"}]'::jsonb,
               'interrupted', jsonb_build_object('run_tag', 'h6v-s2b-a-s3-ef56', 'request_id', v_dop)))->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'field', jsonb_set((v_keep - 'keep_test_records') || jsonb_build_object('page', 'check', 'steps', '[{"code": "job_state"}]'::jsonb,
               'interrupted', jsonb_build_object('run_tag', 'h6v-s2b-a-s3-ef56', 'request_id', v_dop)), '{operation,field}', '"Other__c"'), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('check_field_edit_still_refused', coalesce(v_msg like '%so a field edit is refused%', false));
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, '{}'::jsonb); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_precheck_still_refused', coalesce(v_msg like '%only a data operation, undo or check has an outcome%', false));

    -- ---- 13. conformance ----
    v_checks := v_checks || jsonb_build_object('conformant', coalesce(public.platform_check_conformance() like 'CONFORMANT%', false));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
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
