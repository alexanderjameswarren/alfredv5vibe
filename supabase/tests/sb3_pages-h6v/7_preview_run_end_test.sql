-- sb3_pages-h6v s21b: the migration that has switchboard_run_preview return the run's ok, pass and summary. Acting as
-- Alex (auth.uid() from the JWT claims). Each way a run can end, on its own approved link: refused before anything
-- ran (failed, result {ok:false}, no failure_reason), failed partway (failed, some evidence recorded), expired never
-- picked up (failure_reason expired_not_picked_up, not_started), cancelled (Don't run: no run, the link voided), PASS
-- and FAIL (both succeeded, told apart by pass), and pruned (result null: ok and pass null, summary kept). Also: the
-- summary is cut to 500 characters, a non-boolean pass reads null without breaking the preview, and the fields 254
-- returned are still there. Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/7_preview_run_end_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_refuse constant text := 'refused by the helper: sf_run isn''t built yet; nothing ran';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_base   jsonb;
  v_fresh  jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_p      jsonb;
  v_act    uuid;
  v_case   jsonb;
  v_r      jsonb;
  v_name   text;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', '[{"code": "write"}]'::jsonb);

    -- ---- 1-7. each end, on its own request and approved link ----
    -- status: the action's; picked: whether picked_up_at is set; result, summary, reason: the run row (no run when
    -- run is false).
    for v_case in select * from jsonb_array_elements(jsonb_build_array(
      jsonb_build_object('name', 'refused', 'status', 'failed', 'picked', true, 'run', true, 'result', '{"ok": false}'::jsonb, 'summary', c_refuse),
      jsonb_build_object('name', 'partway', 'status', 'failed', 'picked', true, 'run', true,
                         'result', '{"ok": false, "checks": [{"check": "count", "ok": true}]}'::jsonb, 'summary', 'stopped at the login check: no edit access'),
      jsonb_build_object('name', 'expired', 'status', 'failed', 'picked', false, 'run', true,
                         'result', '{"ok": false, "expired": true, "reason": "expired_not_picked_up"}'::jsonb, 'summary', 'not picked up within 15 minutes',
                         'reason', 'expired_not_picked_up'),
      jsonb_build_object('name', 'pass', 'status', 'succeeded', 'picked', true, 'run', true, 'result', '{"ok": true, "pass": true}'::jsonb, 'summary', 'pre-check passed'),
      jsonb_build_object('name', 'fail', 'status', 'succeeded', 'picked', true, 'run', true, 'result', '{"ok": true, "pass": false}'::jsonb, 'summary', 'pre-check: 2 checks failed'),
      jsonb_build_object('name', 'pruned', 'status', 'failed', 'picked', true, 'run', true, 'result', null, 'summary', c_refuse),
      jsonb_build_object('name', 'long', 'status', 'succeeded', 'picked', true, 'run', true, 'result', '{"ok": true, "pass": "yes"}'::jsonb,
                         'summary', repeat('x', 600))))
    loop
      v_name := v_case->>'name';
      v_req := (public.switchboard_queue_run_request(v_base || jsonb_build_object('project_code', 'h6v-e-' || v_name))->>'request_id')::uuid;
      update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
      v_out := public.switchboard_issue_run_link(v_req);
      v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
      v_p := public.switchboard_run_preview(v_tok);
      v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, (v_p->>'total_count')::integer)->>'action_id')::uuid;
      -- Failed partway: only the checks recorded before the stop are left on the request (two of six), and the
      -- preview returns them with the failed run.
      if v_name = 'partway' then
        update public.switchboard_run_requests set evidence = (
          select jsonb_agg(e) from jsonb_array_elements(v_fresh) e where e->>'check' in ('count', 'login')) where id = v_req;
      end if;
      update public.switchboard_actions
         set status = v_case->>'status', picked_up_at = case when (v_case->>'picked')::boolean then now() end
       where id = v_act;
      insert into public.switchboard_runs (user_id, action_id, mode, summary, result, failure_reason, started_at, finished_at)
      values (c_alex, v_act, 'real', v_case->>'summary', case when jsonb_typeof(v_case->'result') = 'object' then v_case->'result' end,
              v_case->>'reason', now() - interval '1 minute', now());
      v_p := public.switchboard_run_preview(v_tok);
      v_r := v_p->'run';
      v_checks := v_checks || jsonb_build_object(
        v_name || '_status', v_r->>'status' = v_case->>'status',
        v_name || '_finished_at', v_r->>'finished_at' is not null,
        v_name || '_254_fields_kept', v_r ?& array['action_id', 'consumed_at', 'picked_up_at', 'failure_reason', 'not_started', 'rerun']
                                       and v_p ? 'total_count' and v_p ? 'outcome');
      case v_name
        when 'refused' then v_checks := v_checks || jsonb_build_object(
          'refused_ok_false', v_r->'ok' = 'false'::jsonb,
          'refused_pass_null', jsonb_typeof(v_r->'pass') = 'null',
          'refused_summary', v_r->>'summary' = c_refuse,
          'refused_no_failure_reason', jsonb_typeof(v_r->'failure_reason') = 'null',
          'refused_started', v_r->'not_started' = 'false'::jsonb);
        when 'partway' then v_checks := v_checks || jsonb_build_object(
          'partway_ok_false', v_r->'ok' = 'false'::jsonb,
          'partway_summary', v_r->>'summary' = 'stopped at the login check: no edit access',
          'partway_two_checks_shown', jsonb_array_length(v_p->'request'->'evidence') = 2);
        when 'expired' then v_checks := v_checks || jsonb_build_object(
          'expired_reason', v_r->>'failure_reason' = 'expired_not_picked_up',
          'expired_not_started', v_r->'not_started' = 'true'::jsonb,
          'expired_never_picked_up', jsonb_typeof(v_r->'picked_up_at') = 'null',
          'expired_ok_false', v_r->'ok' = 'false'::jsonb);
        when 'pass' then v_checks := v_checks || jsonb_build_object(
          'pass_ok_true', v_r->'ok' = 'true'::jsonb, 'pass_pass_true', v_r->'pass' = 'true'::jsonb);
        when 'fail' then v_checks := v_checks || jsonb_build_object(
          'fail_ok_true', v_r->'ok' = 'true'::jsonb, 'fail_pass_false', v_r->'pass' = 'false'::jsonb,
          'fail_summary', v_r->>'summary' = 'pre-check: 2 checks failed');
        when 'pruned' then v_checks := v_checks || jsonb_build_object(
          'pruned_ok_null', v_r ? 'ok' and jsonb_typeof(v_r->'ok') = 'null',
          'pruned_pass_null', v_r ? 'pass' and jsonb_typeof(v_r->'pass') = 'null',
          'pruned_summary_kept', v_r->>'summary' = c_refuse,
          'pruned_status_failed', v_r->>'status' = 'failed');
        when 'long' then v_checks := v_checks || jsonb_build_object(
          'summary_cut_to_500', length(v_r->>'summary') = 500,
          'non_boolean_pass_null', jsonb_typeof(v_r->'pass') = 'null',
          'long_ok_true', v_r->'ok' = 'true'::jsonb);
        else null;
      end case;
    end loop;

    -- ---- 8. cancelled (Don't run): no run, the link voided with its note ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-e-cancel"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    perform public.switchboard_cancel_run_link(v_tok, 'wait');
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'cancelled_no_run', jsonb_typeof(v_p->'run') = 'null',
      'cancelled_link_voided', v_p->'link'->>'voided_at' is not null,
      'cancelled_reason', v_p->'link'->>'void_reason' = 'cancelled: wait');

    -- ---- 9. no run yet: run is still null ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-e-none"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_p := public.switchboard_run_preview(substring(v_out->>'url' from '/run/([0-9a-f]{64})$'));
    v_checks := v_checks || jsonb_build_object('no_run_still_null', jsonb_typeof(v_p->'run') = 'null');

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
