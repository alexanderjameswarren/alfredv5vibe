-- sb3_pages-h6v s17: the migration that keeps a write's outcome on its request (switchboard_record_run_outcome, and the
-- preview returning it). Acting as Alex (auth.uid() from the JWT claims) for the page functions; the outcome function
-- is called as this test's role, as the runner's service role would. Covers: accepted for a data operation's own run,
-- succeeded and failed; once per run (already); the preview returns it; refused for a pre-check's run, a rerun (a
-- correction's Approve), an unfinished run, a dry run, a run that never started, a simulation, a non-object, an
-- outcome over 64 KB and an unknown run; an undo's own run is accepted; authenticated and anon can't execute it;
-- recording changes no evidence, page, version or count, and 253's count rule still holds. s17b (Alex's option A): a
-- data operation's correction, wording included, is refused while its approved write waits within its 15 minutes,
-- once it has a run and after it was picked up; allowed after a write that never started (its run marked
-- expired_not_picked_up, or consumed, unpicked and past 15 minutes); a pre-check's correction is unaffected. Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/6_run_outcome_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_why    constant jsonb := '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_write  constant jsonb := '[{"code": "still_match_backup"}, {"code": "login_can_write"}, {"code": "automation_unchanged"}, {"code": "type_count"}, {"code": "write"}, {"code": "read_back"}, {"code": "save_results"}]';
  c_rehearse constant jsonb := '[{"code": "create_test"}, {"code": "rehearse_operation"}, {"code": "rehearse_undo"}, {"code": "delete_test"}]';
  c_ok     constant jsonb := '{"changed": 45, "rows": [{"label": "Gifts with no campaign", "before": 45, "goal": 0, "after": 0}, {"label": "Donor rollups recalculated", "before": 0, "goal": 12, "after": 12, "knock_on": true}]}';
  c_stop   constant jsonb := '{"changed": 20, "stopped": {"already_changed": 20, "saved_on_pc": ["data-ops/h6v/backup.csv"]}}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_fresh  jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_p      jsonb;
  v_act    uuid;
  v_run    uuid;
  v_run2   uuid;
  v_before public.switchboard_run_requests;
  v_after  public.switchboard_run_requests;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'project_code', 'h6v-o-a', 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', c_write, 'phases', '[{"name": "Write", "state": "not_started"}]'::jsonb);

    -- ---- 0. the grants ----
    v_checks := v_checks || jsonb_build_object(
      'authenticated_cannot_execute', not has_function_privilege('authenticated', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute'),
      'anon_cannot_execute', not has_function_privilege('anon', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute'),
      'service_role_can_execute', has_function_privilege('service_role', 'public.switchboard_record_run_outcome(uuid, jsonb)', 'execute'));

    -- ---- 1. a data operation's own run, succeeded: recorded once; the preview returns it ----
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object('preview_no_outcome_yet', v_p ? 'outcome' and jsonb_typeof(v_p->'outcome') = 'null'
      and jsonb_typeof(v_p->'outcome_run_id') = 'null' and jsonb_typeof(v_p->'outcome_recorded_at') = 'null');
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    -- An unfinished run of the same action is refused.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, started_at)
    values (c_alex, v_act, 'real', 'test: still running', now() - interval '1 minute') returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('unfinished_refused', coalesce(v_msg like '%has not finished%', false));
    -- A dry run is refused.
    update public.switchboard_runs set mode = 'dry_run', finished_at = now() where id = v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('dry_run_refused', coalesce(v_msg like '%not a real run%', false));

    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: write passed', '{"ok": true, "pass": true}', now())
    returning id into v_run;
    -- Not an object, or over 64 KB: refused before anything is read.
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, '[1, 2]'::jsonb); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('array_refused', coalesce(v_msg like '%must be a JSON object%', false));
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, '"done"'::jsonb); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('string_refused', coalesce(v_msg like '%must be a JSON object%', false));
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, null); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('null_refused', coalesce(v_msg like '%must be a JSON object%', false));
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, jsonb_build_object('note', repeat('a', 70000)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('over_64_kb_refused', coalesce(v_msg like '%over 64 KB%', false));
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(gen_random_uuid(), c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('unknown_run_refused', coalesce(v_msg like '%no such run%', false));

    select * into v_before from public.switchboard_run_requests where id = v_req;
    v_out := public.switchboard_record_run_outcome(v_run, c_ok);
    select * into v_after from public.switchboard_run_requests where id = v_req;
    v_checks := v_checks || jsonb_build_object(
      'succeeded_recorded', v_out = jsonb_build_object('recorded', true, 'already', false, 'request_id', v_req),
      'stored_as_given', v_after.outcome = c_ok and v_after.outcome_run_id = v_run and v_after.outcome_recorded_at is not null,
      'evidence_unchanged', v_after.evidence = v_before.evidence,
      'page_version_count_unchanged', v_after.page = v_before.page and v_after.version = v_before.version
        and v_after.total_count = v_before.total_count and v_after.request = v_before.request);
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 1}'::jsonb);
    v_checks := v_checks || jsonb_build_object(
      'second_call_already', v_out = jsonb_build_object('recorded', false, 'already', true, 'request_id', v_req),
      'second_call_changes_nothing', (select outcome = c_ok from public.switchboard_run_requests where id = v_req));
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'preview_returns_outcome', v_p->'outcome' = c_ok and v_p->>'outcome_run_id' = v_run::text and v_p->>'outcome_recorded_at' is not null,
      'preview_keeps_total_count', v_p->'total_count' = '45'::jsonb);
    -- A simulation is refused (the flag set on this row only to test it; a simulation never makes a run).
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: another run', '{"ok": true, "pass": true}', now()) returning id into v_run2;
    update public.switchboard_run_requests set simulation = true where id = v_req;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('simulation_refused', coalesce(v_msg like '%is a simulation%', false));

    -- ---- 2. a data operation's own run, failed: recorded ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-o-f"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    -- 253's rule still holds: any count but the request's is refused.
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 44); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('wrong_count_still_refused', coalesce(v_msg like '%the count approved (44) is not the request''s count (45)%', false));
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, (v_p->>'total_count')::integer)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'failed' where id = v_act;
    -- A run that never started has no outcome.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, finished_at, failure_reason)
    values (c_alex, v_act, 'real', 'test: never picked up', now(), 'expired_not_picked_up') returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('never_started_refused', coalesce(v_msg like '%never started%', false));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at, failure_reason)
    values (c_alex, v_act, 'real', 'test: write stopped', '{"ok": false, "pass": false}', now(), 'stopped')
    returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, c_stop);
    v_checks := v_checks || jsonb_build_object('failed_recorded', (v_out->>'recorded')::boolean
      and (select outcome = c_stop from public.switchboard_run_requests where id = v_req));

    -- ---- 2b. s17b (Alex's option A): once a write has run, or may still start, no correction ----
    -- The failed write above has a run: even a wording edit is refused, and the outcome stays.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"project_code": "h6v-o-f", "headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_refused_after_a_run',
      coalesce(v_msg = format('switchboard_correct_run_request: a production write already ran on this request (action %s); queue a new request through diagnosis. No link was issued.', v_act), false)
        and (select outcome = c_stop and outcome_run_id = v_run and version = 1 from public.switchboard_run_requests where id = v_req));
    -- A new write: approved and waiting within its 15 minutes; then failed with only a run; then that run marked never
    -- started (correctable); then picked up (picked_up_at is set once, so last). Each refusal has one reason only.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-o-w"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45)->>'action_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    jsonb_set(v_base || '{"project_code": "h6v-o-w"}'::jsonb, '{operation,value}', '"Y"')
                      || jsonb_build_object('steps', c_rehearse, 'phases', '[{"name": "Sandbox rehearsal", "state": "not_started"}]'::jsonb), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_refused_while_waiting', coalesce(v_msg like '%a production write already ran on this request%', false));
    update public.switchboard_actions set status = 'failed' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, finished_at, failure_reason)
    values (c_alex, v_act, 'real', 'test: stopped before pickup was recorded', now(), 'stopped') returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"project_code": "h6v-o-w", "headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_refused_with_a_run', coalesce(v_msg like '%a production write already ran on this request%', false));
    -- Never started (failed as expired_not_picked_up): the request is correctable again.
    update public.switchboard_runs set failure_reason = 'expired_not_picked_up' where id = v_run2;
    v_msg := null;
    begin v_out := public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"project_code": "h6v-o-w", "headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_allowed_after_never_started', v_msg is null
      and (select request->>'headline' = 'H6V TEST: NEW WORDS' from public.switchboard_run_requests where id = v_req));
    -- Picked up (the action failed, its only run marked never started): pickup alone refuses it.
    update public.switchboard_actions set picked_up_at = now() where id = v_act;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"project_code": "h6v-o-w", "headline": "H6V TEST: OTHER WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_refused_after_pickup', coalesce(v_msg like '%a production write already ran on this request%', false));
    -- Consumed, never picked up and past its 15 minutes: never started, so correctable. The action is made as consume
    -- makes it, approved 20 minutes ago (the guard keeps an earlier created_at), and the link points at it.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-o-n"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'h6v-o-n', jsonb_build_object('link_id', v_out->>'link_id'), 'H6V TEST: UPDATES 45 GIFTS', 'claude',
            now() - interval '20 minutes')
    returning id into v_act;
    update public.switchboard_run_links set action_id = v_act where id = (v_out->>'link_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"project_code": "h6v-o-n", "headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correct_allowed_after_15_minutes_unpicked', v_msg is null
      and (select status = 'consumed' and picked_up_at is null from public.switchboard_actions where id = v_act)
      and (select request->>'headline' = 'H6V TEST: NEW WORDS' from public.switchboard_run_requests where id = v_req));

    -- ---- 2c. an undo's own run: its outcome is accepted ----
    v_req := (public.switchboard_queue_run_request((v_base - 'counts') || jsonb_build_object('page', 'undo', 'project_code', 'h6v-o-u',
              'counts', '{"expected": 45, "undo_up_to": 40}'::jsonb, 'undo_of', '{"run_tag": "h6v-o-a-s1-ab12"}'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, (v_p->>'total_count')::integer)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: undo passed', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_out := public.switchboard_record_run_outcome(v_run, '{"changed": 40}'::jsonb);
    v_checks := v_checks || jsonb_build_object(
      'undo_count_is_undo_up_to', v_p->'total_count' = '40'::jsonb,
      'undo_outcome_recorded', (v_out->>'recorded')::boolean
        and (select outcome = '{"changed": 40}'::jsonb and outcome_run_id = v_run from public.switchboard_run_requests where id = v_req),
      'undo_preview_returns_it', public.switchboard_run_preview(v_tok)->'outcome' = '{"changed": 40}'::jsonb);

    -- ---- 3. a pre-check's run is refused ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"page": "precheck", "project_code": "h6v-o-p"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: pre-check passed', '{"ok": true, "pass": true, "checks": []}', now())
    returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('precheck_run_refused', coalesce(v_msg like '%only a data operation or undo has an outcome%', false)
      and (select outcome is null from public.switchboard_run_requests where id = v_req));
    -- A pre-check's correction is unaffected by its run.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording',
                    v_base || '{"page": "precheck", "project_code": "h6v-o-p", "headline": "H6V TEST: NEW WORDS"}'::jsonb, c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('precheck_correct_unaffected', v_msg is null
      and (select request->>'headline' = 'H6V TEST: NEW WORDS' from public.switchboard_run_requests where id = v_req));

    -- ---- 4. a rerun (a write's correction Approve) is refused ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-o-r"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'value',
              jsonb_set(v_base || '{"project_code": "h6v-o-r"}'::jsonb, '{operation,value}', '"Y"')
                || jsonb_build_object('steps', c_rehearse, 'phases', '[{"name": "Sandbox rehearsal", "state": "not_started"}]'::jsonb), c_why);
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_out := public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null);
    v_act := (v_out->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: rehearsal passed', '{"ok": true, "pass": true, "checks": [{"check": "rehearsal", "org": "sandbox"}]}', now())
    returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object(
      'correction_approve_was_a_rerun', (v_out->>'as_rerun')::boolean,
      'rerun_refused', coalesce(v_msg like '%is not the run its link approved%', false)
        and (select outcome is null from public.switchboard_run_requests where id = v_req));

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
