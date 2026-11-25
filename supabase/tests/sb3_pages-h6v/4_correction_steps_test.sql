-- sb3_pages-h6v s14: migration 252 (a write's correction gets its own steps back; a sandbox can be added). Acting as
-- Alex (auth.uid() from the JWT claims) for the page functions; the evidence function is called as this test's role,
-- as the runner's service role would. Covers: a correction page shows only its rerun steps while it is one, and the
-- database keeps the write's own steps and phases (never the chat's); once the reruns pass the write returns with its
-- own steps and phases, a multi-object run's write_step following operation.steps; a second correction and a wording
-- edit on the correction page keep the first one's steps; a correction that reruns the rehearsal may add one rehearsal
-- sandbox, and no other kind may; a target org change, a second sandbox or a non-sandbox rehearsal org is refused;
-- 3_followup_test's correction-row refusals still hold; the queue refuses base_steps and base_phases from the chat, and
-- a pre-check copy still works (s14b). Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/4_correction_steps_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_why    constant jsonb := '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_write  constant jsonb := '[{"code": "still_match_backup"}, {"code": "login_can_write"}, {"code": "automation_unchanged"}, {"code": "type_count"}, {"code": "write"}, {"code": "read_back"}, {"code": "save_results"}]';
  c_rehearse constant jsonb := '[{"code": "create_test"}, {"code": "rehearse_operation"}, {"code": "rehearse_undo"}, {"code": "delete_test"}]';
  c_phases constant jsonb := '[{"name": "Before the write", "state": "not_started"}, {"name": "Write", "state": "not_started"}]';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_fresh  jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_fp     text;
  v_run    uuid;
  v_r      jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'project_code', 'h6v-g-a',
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', c_write, 'phases', c_phases);

    -- ---- 1. a write's value correction: the correction page shows its reruns; the write comes back ----
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'value',
              jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('steps', c_rehearse,
                'phases', '[{"name": "Sandbox rehearsal", "state": "not_started"}]'::jsonb,
                'base_steps', '[{"code": "write"}]'::jsonb), c_why);
    select request into v_r from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'correction_shows_rerun_steps', v_r->'steps' = c_rehearse and v_r->>'page' = 'correction',
      'base_steps_kept_from_the_row', v_r->'base_steps' = c_write and v_r->'base_phases' = c_phases);
    -- A wording edit on the correction page keeps it a correction, with its kept steps.
    perform public.switchboard_correct_run_request(v_req, 'wording',
              (jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('steps', c_rehearse,
                'phases', '[{"name": "Sandbox rehearsal", "state": "not_started"}]'::jsonb, 'headline', 'H6V TEST: NEW WORDS')), c_why);
    select request into v_r from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'wording_on_correction_keeps_page', v_r->>'page' = 'correction'
        and (select page = 'correction' from public.switchboard_run_requests where id = v_req),
      'wording_on_correction_keeps_base', v_r->'base_steps' = c_write,
      'wording_on_correction_keeps_the_correction', v_r->'changed'->>'edit_kind' = 'value' and v_r->'changed'->'wording'->>'edit_kind' = 'wording');
    -- The correction's Approve runs the reruns; the rehearsal passes; the write is back with its own steps and phases.
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null);
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = (v_out->>'action_id')::uuid;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, (v_out->>'action_id')::uuid, 'real', 'test: rehearsal passed',
            '{"ok": true, "pass": true, "checks": [{"check": "rehearsal", "org": "sandbox"}]}', now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    select request into v_r from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'returns_to_dataop', v_out->>'page' = 'dataop' and v_r->>'page' = 'dataop',
      'returns_with_its_own_steps', v_r->'steps' = c_write,
      'returns_with_its_own_phases', v_r->'phases' = c_phases,
      'base_keys_gone', not (v_r ? 'base_steps') and not (v_r ? 'base_phases'),
      'keeps_the_corrected_value', v_r->'operation'->>'value' = 'Y');

    -- ---- 2. a multi-object run's records correction: write_step follows operation.steps ----
    v_base := (v_base || jsonb_build_object('project_code', 'h6v-g-m',
      'operation', '{"kind": "multi", "steps": [{"object": "Gift__c", "kind": "update", "count": 45}]}'::jsonb,
      'steps', '[{"code": "still_match_backup"}, {"code": "write_step", "object": "Gift__c", "kind": "update", "count": 45}, {"code": "read_back"}]'::jsonb))
      - 'phases';
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'records',
              jsonb_set(jsonb_set(jsonb_set(v_base, '{operation,steps,0,count}', '48'), '{counts,total}', '48'), '{counts,expected}', '48')
                || jsonb_build_object('steps', '[{"code": "count_listed"}, {"code": "save_backup"}]'::jsonb,
                                      'phases', '[{"name": "Pre-check", "state": "not_started"}]'::jsonb), c_why);
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null);
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = (v_out->>'action_id')::uuid;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, (v_out->>'action_id')::uuid, 'real', 'test: records passed',
            '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}, {"check": "backup", "org": "production"}, {"check": "sample", "org": "production"}]}', now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    select request into v_r from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'multi_returns_to_dataop', v_out->>'page' = 'dataop',
      'write_step_follows_operation_steps', v_r->'steps' = '[{"code": "still_match_backup"}, {"code": "write_step", "object": "Gift__c", "kind": "update", "count": 48}, {"code": "read_back"}]'::jsonb,
      'no_phases_of_its_own_none_back', not (v_r ? 'phases'));
    -- A records correction may change a step's count, never its object or the number of steps.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-g-n"}'::jsonb)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'records',
            jsonb_set(v_base || '{"project_code": "h6v-g-n"}'::jsonb, '{operation,steps,0,object}', '"Opportunity"'), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('records_cannot_change_step_object', coalesce(v_msg like '%it also changed operation.steps.%', false));

    -- ---- 3. a second correction keeps the first one's base steps ----
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'project_code', 'h6v-g-c',
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45), 'steps', c_write);
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('steps', c_rehearse), c_why);
    perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(v_base, '{operation,value}', '"Z"') || jsonb_build_object('steps', c_rehearse), c_why);
    v_checks := v_checks || jsonb_build_object('second_correction_keeps_first_base',
      (select request->'base_steps' = c_write and version = 3 from public.switchboard_run_requests where id = v_req));

    -- ---- 4. the rehearsal sandbox: added by a kind that reruns the rehearsal, refused on any other ----
    v_base := v_base || jsonb_build_object('project_code', 'h6v-g-s', 'orgs', jsonb_build_array(c_prod));
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    -- Records reruns no rehearsal: refused, naming orgs.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'records',
            v_base || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb), 'steps', '[{"code": "count_listed"}, {"code": "save_backup"}]'::jsonb), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('records_cannot_add_sandbox', coalesce(v_msg like '%a records correction changes only the records and their counts; it also changed orgs.%', false));
    -- Two rehearsal orgs, or a rehearsal org that isn't a sandbox: refused.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
            jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb, c_sb || '{"alias": "test-sb2"}'), 'steps', c_rehearse), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('two_sandboxes_refused', coalesce(v_msg like '%it also changed orgs.%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
            jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb || '{"org_type": "production"}'), 'steps', c_rehearse), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('non_sandbox_rehearsal_refused', coalesce(v_msg like '%it also changed orgs.%', false));
    -- A "sandbox" under the target's own alias: refused.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
            jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb || '{"alias": "test-prod"}'), 'steps', c_rehearse), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('sandbox_with_target_alias_refused', coalesce(v_msg like '%it also changed orgs.%', false));
    -- The target changing, with the sandbox added: refused.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
            jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('orgs', jsonb_build_array(c_prod || '{"alias": "other-prod"}', c_sb), 'steps', c_rehearse), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('target_change_still_refused', coalesce(v_msg like '%a value correction changes only the value; it also changed orgs.%', false));
    -- A value correction adds it: accepted.
    v_out := public.switchboard_correct_run_request(v_req, 'value',
               jsonb_set(v_base, '{operation,value}', '"Y"') || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb), 'steps', c_rehearse), c_why);
    v_checks := v_checks || jsonb_build_object('value_adds_sandbox', (v_out->>'version')::integer = 2
      and (select request->'orgs' = jsonb_build_array(c_prod, c_sb) from public.switchboard_run_requests where id = v_req));
    -- Once it has one, another correction can't swap it.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
            jsonb_set(v_base, '{operation,value}', '"Z"') || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb || '{"alias": "test-sb2"}'), 'steps', c_rehearse), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('sandbox_not_swapped', coalesce(v_msg like '%it also changed orgs.%', false));
    -- sandbox_filter and code rerun the rehearsal too: each may add it.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-g-t"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_correct_run_request(v_req, 'sandbox_filter',
               (v_base || '{"project_code": "h6v-g-t"}'::jsonb) || jsonb_build_object('orgs', jsonb_build_array(c_prod, c_sb), 'steps', c_rehearse,
                 'selected_by', '{"kind": "ids", "text": "45 ids", "sandbox_text": "3 TEST gifts"}'::jsonb), c_why);
    v_checks := v_checks || jsonb_build_object('sandbox_filter_adds_sandbox', (v_out->>'version')::integer = 2);

    -- ---- 5. 3_followup_test's correction-row refusals still hold ----
    v_base := v_base || jsonb_build_object('project_code', 'h6v-g-r', 'orgs', jsonb_build_array(c_prod, c_sb));
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(jsonb_set(v_base, '{operation,value}', '"Y"'), '{selected_by,text}', '"46 ids"'), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_refuses_records', coalesce(v_msg like '%it also changed selected_by.text.%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(jsonb_set(v_base, '{operation,value}', '"Y"'), '{counts,total}', '46'), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_refuses_count', coalesce(v_msg like '%it also changed counts.total.%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'records', jsonb_set(v_base, '{operation,value}', '"Y"'), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('records_refuses_value', coalesce(v_msg like '%it also changed operation.value.%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(v_base, '{operation,value}', '"Y"') || '{"pre_check_request_id": "11111111-2222-4333-8444-555555555555"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pre_check_change_refused', coalesce(v_msg like '%never changes pre_check_request_id%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording', v_base || '{"counts": {"expected": 50, "total": 50}}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('wording_refuses_counts', coalesce(v_msg like '%changes only the headline%', false));

    -- ---- 6. s14b: the queue refuses base_steps and base_phases from the chat; a pre-check copy still works ----
    v_base := v_base || jsonb_build_object('project_code', 'h6v-g-p');
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('base_steps', c_write));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_base_steps', coalesce(v_msg like '%leave base_steps out%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('base_phases', c_phases));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_base_phases', coalesce(v_msg like '%leave base_phases out%', false));
    v_req := (public.switchboard_queue_run_request(v_base || '{"page": "precheck"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_req::text));
    v_checks := v_checks || jsonb_build_object('pre_check_copy_still_works', (v_out->>'copied_checks')::integer = 6
      and (select count(*) = 6 from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
            where r.id = (v_out->>'request_id')::uuid and e->>'copied_from' = v_req::text
              and (e->>'passed_at')::timestamptz = now() - interval '2 hours'));

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
