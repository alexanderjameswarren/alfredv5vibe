-- sb3_pages-h6v s31: the slice 2 migration (spec 15.3, 16.3, 16.4, 16.6). Acting as Alex (auth.uid() from the JWT
-- claims) for the page functions; evidence and outcome are called as this test's role, as the runner's service role
-- would. Runs, links and approvals are made by hand or through the functions; nothing is picked up. Covers:
--   item b: a rehearsal failure {ok: true, pass: false, failed_check: 'rehearsal', checks} keeps the passed production
--     checks (their run's time), never a rehearsal, voids the rehearsal in use, keeps the other checks in use, and is
--     recorded once; each refused form (failed_check on a pass, on ok false, naming another check; a rehearsal listed;
--     no checks; a newer rehearsal in use); a fail with no failed_check still refused; a full pass unchanged; a records
--     correction that kept its rehearsal stays a correction when its rerun fails at the rehearsal; the queue refusing a
--     data operation on a pre-check with no rehearsal in use, and accepting one with it;
--   O23: interrupted.request_id accepted for the caller's own data operation with the check's operation matching,
--     field compared only when the data operation has one; refused for a bad or upper-case id, off a check page, an
--     unknown id, a pre-check or undo, another project, a simulation or pretend mismatch either way, no operation, and
--     an object, kind or field mismatch, naming both sides; interrupted without it still queues; a correction never
--     changes or removes it; (s31b) a field or value edit on a check page refused, a wording edit on it still made,
--     and field and value edits on a pre-check still made;
--   item e: a check's outcome {check: {job, at_goal, at_backup, neither}} recorded for each job state and none, a later
--     run of the same link replacing it; each refused form, also on a run that already has one; already on a repeat;
--     the pretend rules and a plain simulation still refused; a pre-check still refused, in the new words; a data
--     operation's and an undo's outcome unchanged (shape-free);
--   256/257 still holding: pretend's shape, undo_of.request_id, the pretend evidence rule; grants; conformance.
-- Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/9_slice2_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_why    constant jsonb := '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_pret   constant jsonb := '{"scenario": "count_ok"}';
  c_check  constant jsonb := '{"check": {"job": "Completed", "at_goal": 45, "at_backup": 0, "neither": 0}}';
  c_jobs   constant text[] := array['Queued', 'Preparing', 'Processing', 'Holding', 'InProgress', 'Completed', 'Failed', 'Aborted', 'none'];
  c_fail   constant jsonb := '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}, {"check": "login", "org": "production"}]}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_st     text;
  v_ok     boolean;
  v_base   jsonb;
  v_fresh  jsonb;
  v_chk    jsonb;
  v_bad    jsonb;
  v_out    jsonb;
  v_tok    text;
  v_p      jsonb;
  v_link   uuid;
  v_req    uuid;
  v_req2   uuid;
  v_dop    uuid;
  v_del    uuid;
  v_cid    uuid;
  v_act    uuid;
  v_run    uuid;
  v_run2   uuid;
  v_job    text;
  v_case   record;
  v_evid   jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'precheck', 'headline', 'H6V TEST: SLICE 2', 'project_code', 'h6v-s2-a', 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', '[{"code": "write"}]'::jsonb, 'phases', '[{"name": "Write", "state": "not_started"}]'::jsonb);

    -- ---- 0. grants and comments ----
    v_checks := v_checks || jsonb_build_object(
      'queue_grants_kept', has_function_privilege('authenticated', 'public.switchboard_queue_run_request(jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_queue_run_request(jsonb)', 'execute'),
      'evidence_service_role_only', has_function_privilege('service_role', 'public.switchboard_record_run_evidence(uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_record_run_evidence(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_record_run_evidence(uuid)', 'execute'),
      'outcome_service_role_only', has_function_privilege('service_role', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute'),
      'comments_name_s31', obj_description('public.switchboard_queue_run_request(jsonb)'::regprocedure, 'pg_proc') like '%interrupted.request_id, s31%'
        and obj_description('public.switchboard_record_run_evidence(uuid)'::regprocedure, 'pg_proc') like '%failed_check%'
        and obj_description('public.switchboard_record_run_outcome(uuid, jsonb)'::regprocedure, 'pg_proc') like '%(s31) check%'
        and obj_description('public.switchboard_correct_run_request(uuid, text, jsonb, jsonb)'::regprocedure, 'pg_proc') like '%(s31b) a field or value edit on a check page%',
      'correction_grants_kept', has_function_privilege('authenticated', 'public.switchboard_correct_run_request(uuid, text, jsonb, jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_correct_run_request(uuid, text, jsonb, jsonb)', 'execute'));

    -- ---- 1. item b: a pre-check whose rehearsal failed ----
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    -- Each refused form, on its own run of this action.
    v_ok := true;
    for v_case in select * from (values
        ('failed_check_on_a_pass', '{"ok": true, "pass": true, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}]}'::jsonb, '23514', '%failed_check is only "rehearsal"%'),
        ('failed_check_on_ok_false', '{"ok": false, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}]}', '23514', '%failed_check is only "rehearsal"%'),
        ('failed_check_naming_count', '{"ok": true, "pass": false, "failed_check": "count", "checks": [{"check": "login", "org": "production"}]}', '23514', '%failed_check is only "rehearsal"%'),
        ('failed_check_not_text', '{"ok": true, "pass": false, "failed_check": ["rehearsal"], "checks": [{"check": "login", "org": "production"}]}', '23514', '%failed_check is only "rehearsal"%'),
        ('fail_without_failed_check', '{"ok": true, "pass": false, "checks": [{"check": "count", "org": "production"}]}', '55000', '%the run did not pass%'),
        ('rehearsal_listed', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}, {"check": "rehearsal", "org": "sandbox"}]}', '23514', '%never records a rehearsal%'),
        ('no_checks', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": []}', '23514', '%names no checks%')
      ) t(k, res, st, pat) loop
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
      values (c_alex, v_act, 'real', 'test: ' || v_case.k, v_case.res, now()) returning id into v_run2;
      v_msg := null; v_st := null;
      begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
      if not coalesce(v_st = v_case.st and v_msg like v_case.pat, false) then
        v_ok := false;
        v_checks := v_checks || jsonb_build_object('evidence_refused_' || v_case.k, coalesce(v_st || ': ' || v_msg, 'recorded'));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object('evidence_each_bad_failure_refused', v_ok
      and (select evidence = v_fresh from public.switchboard_run_requests where id = v_req));
    -- A newer rehearsal in use: a failure that finished before it never voids it.
    update public.switchboard_run_requests
       set evidence = (select jsonb_agg(case when e->>'check' = 'rehearsal' then e || jsonb_build_object('passed_at', now() - interval '10 minutes') else e end)
                         from jsonb_array_elements(v_fresh) e)
     where id = v_req;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: failure older than the rehearsal', '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}]}', now() - interval '1 hour')
    returning id into v_run2;
    v_msg := null; v_st := null;
    begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('evidence_older_failure_never_voids_a_newer_rehearsal',
      coalesce(v_st = '55000' and v_msg like '%newer evidence for these checks is already in use%', false));
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    -- The failure itself.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: rehearsal failed', c_fail, now()) returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    select evidence into v_evid from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'failure_recorded_two', (v_out->>'recorded')::integer = 2 and (v_out->>'rehearsal_failed')::boolean and v_out->>'page' = 'precheck',
      'failure_keeps_count_and_login_new', (select count(*) = 2 from jsonb_array_elements(v_evid) e
         where e->>'check' in ('count', 'login') and e->>'run_id' = v_run::text and not coalesce((e->>'voided')::boolean, false)
           and (e->>'passed_at')::timestamptz = now()),
      'failure_voids_the_old_count_and_login', (select count(*) = 2 from jsonb_array_elements(v_evid) e
         where e->>'check' in ('count', 'login') and not (e ? 'run_id') and (e->>'voided')::boolean),
      'failure_voids_the_rehearsal', not exists (select 1 from jsonb_array_elements(v_evid) e
         where e->>'check' = 'rehearsal' and not coalesce((e->>'voided')::boolean, false))
         and exists (select 1 from jsonb_array_elements(v_evid) e where e->>'check' = 'rehearsal' and (e->>'voided')::boolean),
      'failure_keeps_the_other_checks_in_use', (select count(*) = 3 from jsonb_array_elements(v_evid) e
         where e->>'check' in ('automation', 'backup', 'sample') and not coalesce((e->>'voided')::boolean, false)
           and (e->>'passed_at')::timestamptz = now() - interval '2 hours'),
      'failure_page_stays_precheck', (select page = 'precheck' from public.switchboard_run_requests where id = v_req));
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object('failure_recorded_once', (v_out->>'already')::boolean and (v_out->>'recorded')::integer = 0);
    -- The queue: a data operation on that pre-check is refused, having no rehearsal in use.
    v_msg := null; v_st := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'pre_check_request_id', v_req));
    exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_a_precheck_with_no_rehearsal',
      coalesce(v_st = '23514' and v_msg like '%the pre-check has no rehearsal in use%', false));

    -- A full pass is unchanged: a rehearsal recorded and in use, and then a data operation on it is queued.
    v_req2 := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-s2-b"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req2;
    v_out := public.switchboard_issue_run_link(v_req2);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: passed',
            '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}, {"check": "rehearsal", "org": "sandbox"}]}', now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object('pass_recorded_unchanged', (v_out->>'recorded')::integer = 2 and not (v_out->>'rehearsal_failed')::boolean
      and (select count(*) = 1 from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
            where r.id = v_req2 and e->>'check' = 'rehearsal' and not coalesce((e->>'voided')::boolean, false) and e->>'run_id' = v_run::text));
    v_out := public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-s2-b', 'pre_check_request_id', v_req2));
    v_checks := v_checks || jsonb_build_object('queue_accepts_a_precheck_with_a_rehearsal', (v_out->>'copied_checks')::integer = 6);

    -- A records correction kept the rehearsal; its rerun then fails at the rehearsal: the page stays a correction.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-s2-c"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'records',
              jsonb_set(jsonb_set(jsonb_set(v_base || '{"project_code": "h6v-s2-c"}'::jsonb, '{counts,total}', '48'), '{counts,expected}', '48'), '{selected_by,text}', '"48 ids"')
                || jsonb_build_object('steps', '[{"code": "count_listed"}, {"code": "save_backup"}]'::jsonb,
                                      'phases', '[{"name": "Pre-check", "state": "not_started"}]'::jsonb), c_why);
    v_checks := v_checks || jsonb_build_object('records_correction_keeps_the_rehearsal',
      (select page = 'correction' and exists (select 1 from jsonb_array_elements(evidence) e
                                                where e->>'check' = 'rehearsal' and not coalesce((e->>'voided')::boolean, false))
         from public.switchboard_run_requests where id = v_req));
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: records rerun, rehearsal failed',
            '{"ok": true, "pass": false, "failed_check": "rehearsal", "checks": [{"check": "count", "org": "production"}, {"check": "backup", "org": "production"}, {"check": "sample", "org": "production"}]}', now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object('rerun_failure_stays_a_correction', (v_out->>'recorded')::integer = 3 and v_out->>'page' = 'correction'
      and (select page = 'correction' and not exists (select 1 from jsonb_array_elements(evidence) e
                                                       where e->>'check' = 'rehearsal' and not coalesce((e->>'voided')::boolean, false))
            from public.switchboard_run_requests where id = v_req));

    -- ---- 2. O23: interrupted.request_id on a check page ----
    v_dop := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-s2-d"}'::jsonb)->>'request_id')::uuid;
    v_del := (public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-s2-d',
               'operation', '{"kind": "delete", "object": "Gift__c"}'::jsonb))->>'request_id')::uuid;
    v_req2 := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-s2-d"}'::jsonb)->>'request_id')::uuid;
    v_chk := v_base || jsonb_build_object('page', 'check', 'project_code', 'h6v-s2-d',
               'interrupted', jsonb_build_object('run_tag', 'h6v-s2-d-s5-ab12', 'request_id', v_dop));
    v_cid := (public.switchboard_queue_run_request(v_chk)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('check_names_its_own_dataop',
      (select request->'interrupted'->>'request_id' = v_dop::text and base_page = 'check' from public.switchboard_run_requests where id = v_cid));
    v_out := public.switchboard_queue_run_request(v_chk || jsonb_build_object(
               'interrupted', jsonb_build_object('run_tag', 'h6v-s2-d-s6-ab12', 'request_id', v_del),
               'operation', '{"kind": "delete", "object": "Gift__c", "field": "Anything__c"}'::jsonb));
    v_checks := v_checks || jsonb_build_object('field_not_compared_when_the_dataop_has_none', (v_out->>'request_id') is not null);
    v_out := public.switchboard_queue_run_request((v_chk - 'operation') || jsonb_build_object('interrupted', '{"run_tag": "h6v-s2-d-s7-ab12"}'::jsonb));
    v_checks := v_checks || jsonb_build_object('interrupted_without_request_id_queues', (v_out->>'request_id') is not null);
    -- A simulation and a pretend data operation, for the mismatches.
    v_req := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-s2-d", "simulation": true}'::jsonb)->>'request_id')::uuid;
    v_run2 := (public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-s2-d', 'simulation', true, 'pretend', c_pret))->>'request_id')::uuid;
    v_ok := true;
    for v_case in select * from (values
        ('bad_uuid', jsonb_set(v_chk, '{interrupted,request_id}', '"not-a-uuid"'), '23514', '%interrupted.request_id must be%'),
        ('upper_case_uuid', jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(upper(v_dop::text))), '23514', '%interrupted.request_id must be%'),
        ('number', jsonb_set(v_chk, '{interrupted,request_id}', '5'), '23514', '%interrupted.request_id must be%'),
        ('on_a_dataop', v_chk || '{"page": "dataop"}'::jsonb, '23514', '%only a check names the data operation that was interrupted%'),
        ('on_a_precheck', v_chk || '{"page": "precheck"}'::jsonb, '23514', '%only a check names the data operation that was interrupted%'),
        ('on_an_undo', (v_chk - 'counts') || '{"page": "undo", "counts": {"expected": 45, "undo_up_to": 40}}'::jsonb, '23514', '%only a check names the data operation that was interrupted%'),
        ('unknown_id', jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(gen_random_uuid()::text)), 'P0002', '%no such data operation request (%) for interrupted.request_id%'),
        ('naming_a_precheck', jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(v_req2::text)), '23514', '%is not a data operation (it is a precheck)%'),
        ('naming_a_check', jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(v_cid::text)), '23514', '%is not a data operation (it is a check)%'),
        ('another_project', v_chk || '{"project_code": "h6v-s2-e"}'::jsonb, '23514', '%is for project h6v-s2-d, not h6v-s2-e%'),
        ('real_check_of_a_simulation', jsonb_set(v_chk, '{interrupted,request_id}', to_jsonb(v_req::text)), '23514', '%never check each other; the check and its data operation must both be simulations%'),
        ('simulation_check_of_a_real', v_chk || '{"simulation": true}'::jsonb, '23514', '%never check each other; the check and its data operation must both be simulations%'),
        ('plain_check_of_a_pretend', jsonb_set(v_chk || '{"simulation": true}'::jsonb, '{interrupted,request_id}', to_jsonb(v_run2::text)), '23514', '%must both have pretend, or neither%'),
        ('pretend_check_of_a_plain', jsonb_set(v_chk || jsonb_build_object('simulation', true, 'pretend', c_pret), '{interrupted,request_id}', to_jsonb(v_req::text)), '23514', '%must both have pretend, or neither%'),
        ('no_operation', v_chk - 'operation', '23514', '%add operation: the interrupted data operation''s object and kind%'),
        ('another_object', jsonb_set(v_chk, '{operation,object}', '"Contact"'), '23514', '%(object: the check has Contact, the data operation Gift__c)%'),
        ('another_kind', jsonb_set(v_chk, '{operation,kind}', '"delete"'), '23514', '%(kind: the check has delete, the data operation update)%'),
        ('another_field', jsonb_set(v_chk, '{operation,field}', '"Appeal__c"'), '23514', '%(field: the check has Appeal__c, the data operation Campaign__c)%'),
        ('no_field', v_chk #- '{operation,field}', '23514', '%(field: the check has (none), the data operation Campaign__c)%'),
        ('all_three', v_chk || '{"operation": {"kind": "insert", "object": "Contact"}}'::jsonb, '23514',
           '%(object: the check has Contact, the data operation Gift__c; kind: the check has insert, the data operation update; field: the check has (none), the data operation Campaign__c)%')
      ) t(k, req, st, pat) loop
      v_msg := null; v_st := null;
      begin perform public.switchboard_queue_run_request(v_case.req); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
      if not coalesce(v_st = v_case.st and v_msg like v_case.pat, false) then
        v_ok := false;
        v_checks := v_checks || jsonb_build_object('o23_refused_' || v_case.k, coalesce(v_st || ': ' || v_msg, 'queued'));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object('o23_each_bad_form_refused', v_ok);
    -- A correction never changes or removes it (interrupted is in neither c_words nor c_run).
    v_msg := null; v_st := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'wording',
                    jsonb_set(v_chk || '{"headline": "H6V TEST: NEW WORDS"}'::jsonb, '{interrupted,request_id}', to_jsonb(v_del::text)), c_why);
    exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('correction_never_changes_interrupted',
      coalesce(v_st = '23514' and v_msg like '%a wording edit changes only%(it changed %interrupted%', false));
    v_msg := null; v_st := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'wording', (v_chk #- '{interrupted,request_id}') || '{"headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('correction_never_removes_interrupted_request_id',
      coalesce(v_st = '23514' and v_msg like '%a wording edit changes only%(it changed %interrupted%', false)
      and (select request->'interrupted'->>'request_id' = v_dop::text from public.switchboard_run_requests where id = v_cid));
    -- s31b: a field or value edit on a check page is refused; the same edits on a pre-check, and a wording edit on the
    -- check, are still made.
    v_msg := null; v_st := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'field', jsonb_set(v_chk, '{operation,field}', '"Appeal__c"'), c_why);
    exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('check_field_edit_refused', coalesce(v_st = '23514'
      and v_msg like '%a check page''s operation must stay the interrupted data operation''s, so a field edit is refused; queue a new check instead.%', false));
    v_msg := null; v_st := null;
    begin perform public.switchboard_correct_run_request(v_cid, 'value', jsonb_set(v_chk, '{operation,value}', '"Y"'), c_why);
    exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('check_value_edit_refused', coalesce(v_st = '23514'
      and v_msg like '%a check page''s operation must stay the interrupted data operation''s, so a value edit is refused; queue a new check instead.%', false)
      and (select version = 1 and page = 'check' and request->'operation'->>'field' = 'Campaign__c' and request->'operation'->>'value' = 'X'
             from public.switchboard_run_requests where id = v_cid));
    v_out := public.switchboard_correct_run_request(v_cid, 'wording', v_chk || '{"headline": "H6V TEST: CHECK, NEW WORDS"}'::jsonb, c_why);
    v_checks := v_checks || jsonb_build_object('check_wording_edit_still_made', (v_out->>'version')::integer = 1
      and (select request->>'headline' = 'H6V TEST: CHECK, NEW WORDS' and page = 'check' from public.switchboard_run_requests where id = v_cid));
    v_out := public.switchboard_correct_run_request(v_req2, 'field',
               jsonb_set(v_base || '{"project_code": "h6v-s2-d"}'::jsonb, '{operation,field}', '"Appeal__c"'), c_why);
    v_checks := v_checks || jsonb_build_object('precheck_field_edit_still_made', (v_out->>'version')::integer = 2
      and (select page = 'correction' and request->'operation'->>'field' = 'Appeal__c' from public.switchboard_run_requests where id = v_req2));
    v_link := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-s2-d"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_correct_run_request(v_link, 'value',
               jsonb_set(v_base || '{"project_code": "h6v-s2-d"}'::jsonb, '{operation,value}', '"Y"'), c_why);
    v_checks := v_checks || jsonb_build_object('precheck_value_edit_still_made', (v_out->>'version')::integer = 2
      and (select page = 'correction' and request->'operation'->>'value' = 'Y' from public.switchboard_run_requests where id = v_link));

    -- ---- 3. item e: a check's outcome ----
    v_req := (public.switchboard_queue_run_request((v_chk - 'interrupted') || jsonb_build_object('project_code', 'h6v-s2-f',
               'interrupted', '{"run_tag": "h6v-s2-f-s5-ab12"}'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    v_checks := v_checks || jsonb_build_object('check_approve_sets_action_id',
      (select action_id = v_act from public.switchboard_run_links where id = v_link));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: check', '{"ok": true}', now()) returning id into v_run;
    v_ok := true;
    foreach v_bad in array array[
        jsonb_set(c_check, '{check,job}', '"completed"'), jsonb_set(c_check, '{check,job}', '"Running"'),
        jsonb_set(c_check, '{check,job}', '""'), jsonb_set(c_check, '{check,job}', '5'), jsonb_set(c_check, '{check,job}', 'null'),
        c_check #- '{check,neither}', c_check #- '{check,job}', jsonb_set(c_check, '{check,extra}', '1'), c_check || '{"changed": 45}',
        jsonb_set(c_check, '{check,neither}', '-1'), jsonb_set(c_check, '{check,at_goal}', '1.5'), jsonb_set(c_check, '{check,at_backup}', '"5"'),
        jsonb_set(c_check, '{check,at_goal}', '1000000000'), jsonb_set(c_check, '{check,at_goal}', 'null'),
        '{"check": 5}', '{"check": [1, 2]}', '{"check": null}', '{}', '{"changed": 45}']::jsonb[] loop
      v_msg := null; v_st := null;
      begin perform public.switchboard_record_run_outcome(v_run, v_bad); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
      if not coalesce(v_st = '22023' and v_msg like '%a check''s outcome is exactly%', false) then
        v_ok := false;
        v_checks := v_checks || jsonb_build_object('outcome_refused_' || v_bad::text, coalesce(v_st || ': ' || v_msg, 'recorded'));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object('outcome_each_bad_check_refused', v_ok
      and (select outcome is null from public.switchboard_run_requests where id = v_req));
    -- Each job state and none, each by a later run of the same link, which replaces the one before.
    v_ok := true;
    foreach v_job in array c_jobs loop
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
      values (c_alex, v_act, 'real', 'test: job ' || v_job, '{"ok": true}', now()) returning id into v_run2;
      v_out := public.switchboard_record_run_outcome(v_run2, jsonb_set(c_check, '{check,job}', to_jsonb(v_job)));
      v_ok := v_ok and coalesce((v_out->>'recorded')::boolean, false)
        and (select outcome->'check'->>'job' = v_job and outcome_run_id = v_run2 from public.switchboard_run_requests where id = v_req);
    end loop;
    v_checks := v_checks || jsonb_build_object('outcome_each_job_recorded', v_ok);
    -- The largest count accepted, 999999999 (nine digits).
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: largest count', '{"ok": true}', now()) returning id into v_run2;
    v_out := public.switchboard_record_run_outcome(v_run2, jsonb_set(c_check, '{check,at_goal}', '999999999'));
    v_checks := v_checks || jsonb_build_object('outcome_largest_count_accepted', coalesce((v_out->>'recorded')::boolean, false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: job none', '{"ok": true}', now()) returning id into v_run2;
    v_out := public.switchboard_record_run_outcome(v_run2, jsonb_set(c_check, '{check,job}', '"none"'));
    v_out := public.switchboard_record_run_outcome(v_run2, jsonb_set(c_check, '{check,job}', '"none"'));
    v_checks := v_checks || jsonb_build_object('outcome_repeat_already', (v_out->>'already')::boolean and not (v_out->>'recorded')::boolean);
    v_msg := null; v_st := null;
    begin perform public.switchboard_record_run_outcome(v_run2, jsonb_set(c_check, '{check,neither}', '-1')); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('outcome_bad_check_refused_after_one_kept',
      coalesce(v_st = '22023' and v_msg like '%a check''s outcome is exactly%', false)
      and (select outcome = jsonb_set(c_check, '{check,job}', '"none"') from public.switchboard_run_requests where id = v_req));
    -- The pretend rules still hold on a check: a pretend run on this real check is refused.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'test: pretend run on a real check', '{"ok": true}', now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_check); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_pretend_run_on_real_check_refused', coalesce(v_msg like '%a pretend run''s outcome is kept only on a pretend request%', false));
    -- A pretend check: a pretend run's outcome recorded, a real run's refused.
    v_req := (public.switchboard_queue_run_request((v_chk - 'interrupted') || jsonb_build_object('project_code', 'h6v-s2-g', 'simulation', true, 'pretend', c_pret,
               'interrupted', '{"run_tag": "h6v-s2-g-s5-ab12"}'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: real run on a pretend check', '{"ok": true}', now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_check); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_real_run_on_pretend_check_refused', coalesce(v_msg like '%a pretend run''s outcome is kept only on a pretend request%', false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'test: pretend check', '{"ok": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, c_check);
    v_checks := v_checks || jsonb_build_object('outcome_pretend_check_recorded', (v_out->>'recorded')::boolean
      and (select outcome = c_check from public.switchboard_run_requests where id = v_req));
    -- A plain-simulation check: consume makes no action, so one is made by hand for its link; its outcome is refused.
    v_req := (public.switchboard_queue_run_request((v_chk - 'interrupted') || jsonb_build_object('project_code', 'h6v-s2-h', 'simulation', true,
               'interrupted', '{"run_tag": "h6v-s2-h-s5-ab12"}'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_run', 'h6v-s2-h', jsonb_build_object('link_id', v_link::text), 'H6V TEST: BY HAND', 'claude') returning id into v_act;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    update public.switchboard_run_links set action_id = v_act where id = v_link;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: plain simulation check', '{"ok": true}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_check); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_plain_simulation_check_refused', coalesce(v_msg like '%is a simulation; it has no outcome%', false));
    -- A pre-check's run is still refused, in the new words (section 1's passing pre-check, h6v-s2-b).
    select r.id into v_run from public.switchboard_runs r join public.switchboard_actions a on a.id = r.action_id
     where a.project_code = 'h6v-s2-b' and r.summary = 'test: passed';
    v_msg := null; v_st := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_check); exception when others then v_msg := sqlerrm; v_st := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('outcome_precheck_refused_in_new_words',
      coalesce(v_st = '55000' and v_msg like '%is a precheck run; only a data operation, undo or check has an outcome%', false));
    -- A data operation's outcome is unchanged and shape-free: {changed} kept, and even a {check} kept as given.
    v_req := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-s2-i"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: write', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 45}');
    v_ok := (v_out->>'recorded')::boolean;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: write resent', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"check": "anything", "changed": 45}');
    v_checks := v_checks || jsonb_build_object('outcome_dataop_unchanged_shape_free', v_ok and (v_out->>'recorded')::boolean
      and (select outcome = '{"check": "anything", "changed": 45}'::jsonb from public.switchboard_run_requests where id = v_req));
    -- An undo's too.
    v_req := (public.switchboard_queue_run_request((v_base - 'counts') || jsonb_build_object('page', 'undo', 'project_code', 'h6v-s2-j',
               'counts', '{"expected": 45, "undo_up_to": 40}'::jsonb, 'undo_of', '{"run_tag": "h6v-s2-j-s1-ab12"}'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 40)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: undo', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 40}');
    v_checks := v_checks || jsonb_build_object('outcome_undo_unchanged', (v_out->>'recorded')::boolean);

    -- ---- 4. 256 and 257 still hold ----
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('simulation', true, 'project_code', 'h6v-s2-k', 'pretend', '{"scenario": "a/b"}'::jsonb));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_shape_still_refused', coalesce(v_msg like '%pretend must be {"scenario": "<name>"}%', false));
    v_out := public.switchboard_queue_run_request((v_base - 'counts') || jsonb_build_object('page', 'undo', 'project_code', 'h6v-s2-d',
               'counts', '{"expected": 45, "undo_up_to": 40}'::jsonb, 'undo_of', jsonb_build_object('run_tag', 'h6v-s2-d-s1-ab12', 'request_id', v_dop)));
    v_checks := v_checks || jsonb_build_object('undo_of_request_id_still_accepted', (v_out->>'request_id') is not null);
    -- A pretend run's rehearsal failure on a real pre-check is refused by 256's rule, after the new lines.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-s2-l"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'pretend', 'test: pretend failure on a real pre-check', c_fail, now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_pretend_failure_on_real_refused', coalesce(v_msg like '%a pretend run records evidence only on a pretend request%', false)
      and (select evidence = v_fresh from public.switchboard_run_requests where id = v_req));

    -- ---- 5. conformance ----
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
