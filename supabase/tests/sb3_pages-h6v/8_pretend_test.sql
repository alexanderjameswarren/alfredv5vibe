-- sb3_pages-h6v s27: the pretend migration (spec 15.2), and O5's undo_of.request_id. Acting as Alex (auth.uid() from
-- the JWT claims) for the page functions; the pickups, evidence, sample and outcome are called as this test's role, as
-- the runner's service role would. Covers: the schema (column, its two checks, the run mode); request.pretend
-- {scenario} accepted and each refused form, and never without simulation; the column check; a pre-check and data
-- operation that disagree on pretend (refused both ways; differing scenario names accepted); consume making an sf_run
-- with {link_id, pretend: true} and the preview returning request.pretend as stored; the pickup opening a pretend run
-- and replaying it; the evidence, sample and outcome accepted for pretend on pretend, refused across real and pretend,
-- and refused for a plain simulation; a plain simulation still making no action; the correction keeping the stored
-- pretend object; the 15-minute expiry (retry and pickup_git) making a pretend run, the resend keeping pretend;
-- undo_of.request_id accepted for the caller's own data operation, refused for another user's, another project's, a
-- non-data operation, a bad uuid, a non-undo page and a simulation or pretend mismatch, never added by a correction,
-- and undo_of without it still queuing; conformance unchanged.
-- Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/8_pretend_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_why    constant jsonb := '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_write  constant jsonb := '[{"code": "write"}]';
  c_rehearse constant jsonb := '[{"code": "create_test"}, {"code": "rehearse_operation"}]';
  c_pass   constant jsonb := '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}';
  c_sample constant jsonb := '{"records": [{"role": "record", "id_label": "Gift G-1", "fields": []}]}';
  c_ok     constant jsonb := '{"changed": 45}';
  c_pret   constant jsonb := '{"scenario": "count_ok"}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_sim    jsonb;
  v_pbase  jsonb;
  v_fresh  jsonb;
  v_bad    jsonb;
  v_req    uuid;
  v_req2   uuid;
  v_dop    uuid;
  v_out    jsonb;
  v_tok    text;
  v_link   uuid;
  v_p      jsonb;
  v_act    uuid;
  v_act2   uuid;
  v_run    uuid;
  v_run2   uuid;
  v_pid    uuid;
  v_ok     boolean;
  v_undo   jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'precheck', 'headline', 'H6V TEST: PRETEND', 'project_code', 'h6v-p-a', 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', c_write, 'phases', '[{"name": "Write", "state": "not_started"}]'::jsonb);
    v_sim := v_base || '{"simulation": true}'::jsonb;
    v_pbase := v_sim || jsonb_build_object('pretend', c_pret);

    -- ---- 0. the schema ----
    v_checks := v_checks || jsonb_build_object(
      'column_not_null_default_false', exists (select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'switchboard_run_requests' and column_name = 'pretend'
          and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'),
      'check_pretend_simulation', exists (select 1 from pg_constraint where conrelid = 'public.switchboard_run_requests'::regclass
        and conname = 'switchboard_run_requests_pretend_simulation'),
      'check_pretend_request', exists (select 1 from pg_constraint where conrelid = 'public.switchboard_run_requests'::regclass
        and conname = 'switchboard_run_requests_pretend_request'),
      'run_mode_takes_pretend', (select pg_get_constraintdef(oid) like '%pretend%' from pg_constraint
        where conrelid = 'public.switchboard_runs'::regclass and conname = 'switchboard_runs_mode_valid'),
      'queue_grants_kept', has_function_privilege('authenticated', 'public.switchboard_queue_run_request(jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_queue_run_request(jsonb)', 'execute'),
      'pickup_grants_kept', has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute'));

    -- ---- 1. the shape: accepted, and each refused form ----
    v_req := (public.switchboard_queue_run_request(v_pbase)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('pretend_accepted',
      (select pretend and simulation and request->'pretend' = c_pret from public.switchboard_run_requests where id = v_req));
    v_req2 := (public.switchboard_queue_run_request(v_sim || '{"project_code": "h6v-p-b"}'::jsonb)->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('plain_simulation_not_pretend',
      (select simulation and not pretend and not (request ? 'pretend') from public.switchboard_run_requests where id = v_req2));
    v_ok := true;
    foreach v_bad in array array['true', 'false', 'null', '"count_ok"', '[]', '{}', '{"scenario": 5}', '{"scenario": null}',
                                 '{"scenario": ""}', '{"scenario": "Count_OK"}', '{"scenario": "a/b"}', '{"scenario": "has space"}',
                                 format('{"scenario": "%s"}', repeat('a', 41)), '{"scenario": "ok", "extra": 1}']::jsonb[] loop
      v_msg := null;
      begin perform public.switchboard_queue_run_request(v_sim || jsonb_build_object('pretend', v_bad));
      exception when others then v_msg := sqlerrm; end;
      if not coalesce(v_msg like '%pretend must be {"scenario": "<name>"}%', false) then
        v_ok := false;
        v_checks := v_checks || jsonb_build_object('refused_form_' || v_bad::text, coalesce(v_msg, 'accepted'));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object('each_bad_form_refused', v_ok);
    -- 40 characters is the longest accepted.
    v_checks := v_checks || jsonb_build_object('forty_characters_accepted',
      (public.switchboard_queue_run_request(v_sim || jsonb_build_object('project_code', 'h6v-p-c', 'pretend',
         jsonb_build_object('scenario', repeat('a', 40))))->>'request_id') is not null);
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('pretend', c_pret));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_without_simulation_refused', coalesce(v_msg like '%pretend needs simulation true%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request((v_base - 'simulation') || jsonb_build_object('pretend', c_pret));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_simulation_left_out_refused', coalesce(v_msg like '%pretend needs simulation true%', false));

    -- ---- 2. the column check ----
    v_msg := null;
    begin update public.switchboard_run_requests set pretend = false where id = v_req;
    exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('column_false_with_object_refused', coalesce(v_msg like '%switchboard_run_requests_pretend_request%', false));
    v_msg := null;
    begin update public.switchboard_run_requests set request = request - 'pretend' where id = v_req;
    exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('object_removed_while_true_refused', coalesce(v_msg like '%switchboard_run_requests_pretend_request%', false));
    v_msg := null;
    begin update public.switchboard_run_requests set pretend = true where id = v_req2;
    exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('column_true_without_object_refused', coalesce(v_msg like '%switchboard_run_requests_pretend_request%', false));
    v_msg := null;
    begin update public.switchboard_run_requests set simulation = false where id = v_req;
    exception when check_violation then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_without_simulation_column_refused', coalesce(v_msg like '%switchboard_run_requests_pretend_simulation%', false));

    -- ---- 3. a pre-check and a data operation that disagree on pretend ----
    -- A pretend pre-check, its checks passed; a plain-simulation data operation naming it is refused.
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"project_code": "h6v-p-d"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_sim || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-p-d', 'pre_check_request_id', v_req));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('plain_dataop_on_pretend_precheck_refused', coalesce(v_msg like '%must both have pretend, or neither%', false));
    -- Another scenario name on the data operation: accepted, the checks copied.
    v_out := public.switchboard_queue_run_request(v_sim || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-p-d',
               'pre_check_request_id', v_req, 'pretend', '{"scenario": "write_ok"}'::jsonb));
    v_checks := v_checks || jsonb_build_object('scenario_names_may_differ', (v_out->>'copied_checks')::integer = 6
      and (select pretend and request->'pretend' = '{"scenario": "write_ok"}'::jsonb from public.switchboard_run_requests where id = (v_out->>'request_id')::uuid));
    -- A plain-simulation pre-check; a pretend data operation naming it is refused.
    v_req := (public.switchboard_queue_run_request(v_sim || '{"project_code": "h6v-p-e"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_pbase || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-p-e', 'pre_check_request_id', v_req));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('pretend_dataop_on_plain_precheck_refused', coalesce(v_msg like '%must both have pretend, or neither%', false));

    -- ---- 4. consume: a pretend pre-check makes its sf_run, payload {link_id, pretend: true} ----
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"project_code": "h6v-p-f"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object('preview_returns_pretend_as_stored', v_p->'request'->'pretend' = c_pret
      and (v_p->'request'->>'simulation')::boolean);
    v_out := public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null);
    v_act := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'consume_returns_simulated_and_pretend', (v_out->>'simulated')::boolean and (v_out->>'pretend')::boolean and v_act is not null,
      'consume_payload_link_id_and_pretend', (select kind = 'sf_run' and status = 'consumed'
                                                and payload = jsonb_build_object('link_id', v_link::text, 'pretend', true)
                                                from public.switchboard_actions where id = v_act),
      'consume_spends_the_link', (select used_at is not null and action_id = v_act from public.switchboard_run_links where id = v_link));

    -- ---- 5. the pickup opens it as a pretend run, and a lost reply replays it ----
    v_pid := gen_random_uuid();
    v_out := public.switchboard_pickup_helper(c_alex, array['sf_run'], v_pid);
    v_run := (v_out->>'run_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'pickup_hands_out_this_action', (v_out->>'action_id')::uuid = v_act and v_out->'payload'->'pretend' = 'true'::jsonb,
      'pickup_run_is_pretend', (select mode = 'pretend' and finished_at is null from public.switchboard_runs where id = v_run));
    v_out := public.switchboard_pickup_helper(c_alex, array['sf_run'], v_pid);
    v_checks := v_checks || jsonb_build_object('pickup_replays_a_pretend_run', (v_out->>'run_id')::uuid = v_run and (v_out->>'action_id')::uuid = v_act);

    -- ---- 6. evidence and sample: pretend on pretend accepted ----
    update public.switchboard_runs set finished_at = now(), result = c_pass where id = v_run;
    update public.switchboard_actions set status = 'succeeded' where id = v_act;
    -- A real run on the pretend request is refused (inserted on the same action).
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: real run on a pretend request', c_pass, now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_real_run_on_pretend_refused', coalesce(v_msg like '%a pretend run records evidence only on a pretend request%', false));
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object('evidence_pretend_on_pretend_recorded', (v_out->>'recorded')::integer = 1
      and (select evidence @> jsonb_build_array(jsonb_build_object('check', 'count', 'run_id', v_run)) from public.switchboard_run_requests where id = v_req));
    v_out := public.switchboard_store_run_sample(v_req, c_sample);
    v_checks := v_checks || jsonb_build_object('sample_pretend_stored', (v_out->>'stored')::boolean
      and exists (select 1 from public.switchboard_run_samples where request_id = v_req and sample = c_sample));

    -- A real pre-check (picked up at once, so no later pickup takes it); a pretend run on it is refused.
    v_req2 := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-p-g"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req2);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_out := public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null);
    v_act2 := (v_out->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act2;
    v_checks := v_checks || jsonb_build_object('real_consume_payload_unchanged', not (v_out->>'pretend')::boolean
      and (select payload = jsonb_build_object('link_id', v_out->>'link_id') from public.switchboard_actions where id = v_act2));
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'pretend', 'test: pretend run on a real request', c_pass, now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_run2); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_pretend_run_on_real_refused', coalesce(v_msg like '%a pretend run records evidence only on a pretend request%', false)
      and (select evidence = '[]'::jsonb from public.switchboard_run_requests where id = v_req2));

    -- ---- 7. outcome: pretend on pretend accepted, refused across ----
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"page": "dataop", "project_code": "h6v-p-h"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45)->>'action_id')::uuid;
    v_out := public.switchboard_pickup_helper(c_alex, array['sf_run']);
    v_run := (v_out->>'run_id')::uuid;
    v_checks := v_checks || jsonb_build_object('dataop_pickup_run_is_pretend', (v_out->>'action_id')::uuid = v_act
      and (select mode = 'pretend' from public.switchboard_runs where id = v_run));
    update public.switchboard_runs set finished_at = now(), result = '{"ok": true, "pass": true}' where id = v_run;
    update public.switchboard_actions set status = 'succeeded' where id = v_act;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: real run on a pretend write', '{"ok": true, "pass": true}', now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_real_run_on_pretend_refused', coalesce(v_msg like '%a pretend run''s outcome is kept only on a pretend request%', false));
    v_out := public.switchboard_record_run_outcome(v_run, c_ok);
    v_checks := v_checks || jsonb_build_object('outcome_pretend_on_pretend_recorded', (v_out->>'recorded')::boolean
      and (select outcome = c_ok and outcome_run_id = v_run from public.switchboard_run_requests where id = v_req));
    -- A real data operation; a pretend run on its approved action is refused.
    v_req2 := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-p-i"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req2;
    v_out := public.switchboard_issue_run_link(v_req2);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_act2 := (public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45)->>'action_id')::uuid;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act2;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act2, 'pretend', 'test: pretend run on a real write', '{"ok": true, "pass": true}', now()) returning id into v_run2;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run2, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_pretend_run_on_real_refused', coalesce(v_msg like '%a pretend run''s outcome is kept only on a pretend request%', false)
      and (select outcome is null from public.switchboard_run_requests where id = v_req2));

    -- ---- 8. a plain simulation still makes no action; its evidence, sample and outcome are refused ----
    v_req := (public.switchboard_queue_run_request(v_sim || '{"project_code": "h6v-p-j"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_out := public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null);
    v_checks := v_checks || jsonb_build_object('plain_simulation_no_action', (v_out->>'simulated')::boolean
      and v_out->'action_id' = 'null'::jsonb and not (v_out ? 'pretend')
      and not exists (select 1 from public.switchboard_actions where payload->>'link_id' = v_link::text)
      and (select used_at is not null and action_id is null from public.switchboard_run_links where id = v_link));
    -- An action made by hand for its link (consume never makes one), picked up so no pickup takes it.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_run', 'h6v-p-j', jsonb_build_object('link_id', v_link::text), 'H6V TEST: BY HAND', 'claude') returning id into v_act;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    update public.switchboard_run_links set action_id = v_act where id = v_link;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: plain simulation', c_pass, now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_run); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_plain_simulation_refused', coalesce(v_msg like '%a simulation records no evidence%', false));
    v_msg := null;
    begin perform public.switchboard_store_run_sample(v_req, c_sample); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('sample_plain_simulation_refused', coalesce(v_msg like '%a simulation holds no client data%', false));
    v_req := (public.switchboard_queue_run_request(v_sim || '{"page": "dataop", "project_code": "h6v-p-k"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_run', 'h6v-p-k', jsonb_build_object('link_id', v_link::text), 'H6V TEST: BY HAND', 'claude') returning id into v_act;
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_act;
    update public.switchboard_run_links set action_id = v_act where id = v_link;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_act, 'real', 'test: plain simulation write', '{"ok": true, "pass": true}', now()) returning id into v_run;
    v_msg := null;
    begin perform public.switchboard_record_run_outcome(v_run, c_ok); exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('outcome_plain_simulation_refused', coalesce(v_msg like '%is a simulation; it has no outcome%', false));

    -- ---- 9. the correction keeps the stored pretend object ----
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"project_code": "h6v-p-l"}'::jsonb)->>'request_id')::uuid;
    -- Wording, sending another pretend: the stored one stays.
    perform public.switchboard_correct_run_request(v_req, 'wording',
              v_sim || jsonb_build_object('project_code', 'h6v-p-l', 'headline', 'H6V TEST: NEW WORDS', 'pretend', '{"scenario": "other"}'::jsonb), c_why);
    v_checks := v_checks || jsonb_build_object('wording_keeps_pretend', (select pretend and request->'pretend' = c_pret
      and request->>'headline' = 'H6V TEST: NEW WORDS' from public.switchboard_run_requests where id = v_req));
    -- A value edit (reruns the rehearsal), pretend left out: the stored one stays.
    perform public.switchboard_correct_run_request(v_req, 'value',
              jsonb_set(v_sim || '{"project_code": "h6v-p-l"}'::jsonb, '{operation,value}', '"Y"')
                || jsonb_build_object('steps', c_rehearse, 'phases', '[{"name": "Sandbox rehearsal", "state": "not_started"}]'::jsonb), c_why);
    v_checks := v_checks || jsonb_build_object('rerun_kind_keeps_pretend', (select pretend and page = 'correction' and version = 2
      and request->'pretend' = c_pret from public.switchboard_run_requests where id = v_req));
    -- A real request's correction that sends pretend: dropped, the column stays false.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-p-m"}'::jsonb)->>'request_id')::uuid;
    perform public.switchboard_correct_run_request(v_req, 'wording',
              v_base || jsonb_build_object('project_code', 'h6v-p-m', 'headline', 'H6V TEST: NEW WORDS', 'pretend', c_pret), c_why);
    v_checks := v_checks || jsonb_build_object('real_correction_drops_pretend', (select not pretend and not (request ? 'pretend')
      and request->>'headline' = 'H6V TEST: NEW WORDS' from public.switchboard_run_requests where id = v_req));

    -- ---- 10. the 15-minute expiry: a pretend sf_run's expired run is mode pretend ----
    -- Retry: an approval 16 minutes ago, never picked up (the guard lets an insert set an earlier created_at).
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"project_code": "h6v-p-n"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'h6v-p-n', jsonb_build_object('link_id', v_link::text, 'pretend', true), 'H6V TEST STALE', 'claude', now() - interval '16 minutes')
    returning id into v_act;
    update public.switchboard_run_links set used_at = now() - interval '16 minutes', action_id = v_act, desktop = c_ready where id = v_link;
    v_out := public.switchboard_retry_run(v_tok, public.switchboard_run_preview(v_tok)->>'fingerprint', c_ready);
    v_checks := v_checks || jsonb_build_object(
      'retry_expired_run_is_pretend', (select count(*) = 1 from public.switchboard_runs where action_id = v_act
                                         and mode = 'pretend' and failure_reason = 'expired_not_picked_up'),
      'resend_keeps_pretend', (select payload = jsonb_build_object('link_id', v_link::text, 'pretend', true)
                                 from public.switchboard_actions where id = (v_out->>'action_id')::uuid));
    -- pickup_git's expiry, on another stale pretend sf_run.
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"project_code": "h6v-p-o"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'h6v-p-o', jsonb_build_object('link_id', v_out->>'link_id', 'pretend', true), 'H6V TEST STALE', 'claude', now() - interval '16 minutes')
    returning id into v_act2;
    perform public.switchboard_pickup_git(c_alex);
    v_checks := v_checks || jsonb_build_object('pickup_git_expired_run_is_pretend',
      (select status = 'failed' from public.switchboard_actions where id = v_act2)
      and (select count(*) = 1 from public.switchboard_runs where action_id = v_act2 and mode = 'pretend' and failure_reason = 'expired_not_picked_up'));

    -- ---- 11. undo_of.request_id (O5) ----
    v_undo := (v_base - 'counts') || jsonb_build_object('page', 'undo', 'project_code', 'h6v-p-u',
                'counts', '{"expected": 45, "undo_up_to": 40}'::jsonb);
    v_dop := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-p-u"}'::jsonb)->>'request_id')::uuid;
    v_out := public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'h6v-p-u-s1-ab12', 'request_id', v_dop)));
    v_checks := v_checks || jsonb_build_object('undo_own_dataop_accepted', (select request->'undo_of'->>'request_id' = v_dop::text
      from public.switchboard_run_requests where id = (v_out->>'request_id')::uuid));
    v_out := public.switchboard_queue_run_request(v_undo || '{"undo_of": {"run_tag": "h6v-p-u-s1-ab12"}}'::jsonb);
    v_req2 := (v_out->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('undo_without_request_id_queues', v_req2 is not null);
    -- A correction can't add it: undo_of is no kind's field.
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req2, 'wording',
                    v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'h6v-p-u-s1-ab12', 'request_id', v_dop)), c_why);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correction_cannot_add_request_id', coalesce(v_msg like '%it changed undo!_of.request!_id%' escape '!', false));
    -- Simulation and pretend must match, as for a pre-check.
    v_req := (public.switchboard_queue_run_request(v_sim || '{"page": "dataop", "project_code": "h6v-p-u"}'::jsonb)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_real_of_simulation_refused', coalesce(v_msg like '%never undo each other; the undo and its data operation must both be simulations, or neither%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('simulation', true, 'undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_dop)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_simulation_of_real_refused', coalesce(v_msg like '%must both be simulations, or neither%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('simulation', true, 'pretend', c_pret,
                    'undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_pretend_of_plain_refused', coalesce(v_msg like '%must both have pretend, or neither%', false));
    v_req := (public.switchboard_queue_run_request(v_pbase || '{"page": "dataop", "project_code": "h6v-p-u"}'::jsonb)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('simulation', true, 'undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_plain_of_pretend_refused', coalesce(v_msg like '%must both have pretend, or neither%', false));
    v_out := public.switchboard_queue_run_request(v_undo || jsonb_build_object('simulation', true, 'pretend', c_pret,
               'undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    v_checks := v_checks || jsonb_build_object('undo_pretend_of_pretend_accepted', (v_out->>'request_id') is not null);
    -- Another user's data operation in the same project, made by hand: not found.
    insert into public.switchboard_run_requests (user_id, project_code, page, base_page, request, evidence)
    values (gen_random_uuid(), 'h6v-p-u', 'dataop', 'dataop', v_base || '{"page": "dataop", "project_code": "h6v-p-u"}'::jsonb, '[]'::jsonb)
    returning id into v_req;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_other_users_dataop_refused', coalesce(v_msg like '%no such data operation request (' || v_req || ')%', false));
    -- Another project's.
    v_req := (public.switchboard_queue_run_request(v_base || '{"page": "dataop", "project_code": "h6v-p-x"}'::jsonb)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_other_project_refused', coalesce(v_msg like '%the data operation is for project h6v-p-x, not h6v-p-u%', false));
    -- A pre-check, not a data operation.
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-p-u"}'::jsonb)->>'request_id')::uuid;
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_req)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_non_dataop_refused', coalesce(v_msg like '%is not a data operation (it is a precheck)%', false));
    -- Bad uuids: text, upper case, a number, null.
    v_ok := true;
    foreach v_bad in array array['"not-a-uuid"', to_jsonb(upper(v_dop::text)), '42', 'null']::jsonb[] loop
      v_msg := null;
      begin perform public.switchboard_queue_run_request(v_undo || jsonb_build_object('undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_bad)));
      exception when others then v_msg := sqlerrm; end;
      if not coalesce(v_msg like '%undo_of.request_id must be the data operation request''s id%', false) then
        v_ok := false;
        v_checks := v_checks || jsonb_build_object('undo_bad_uuid_' || v_bad::text, coalesce(v_msg, 'accepted'));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object('undo_bad_uuid_refused', v_ok);
    -- Only an undo carries it.
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('page', 'dataop', 'project_code', 'h6v-p-u',
                    'undo_of', jsonb_build_object('run_tag', 'x', 'request_id', v_dop)));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('undo_of_request_id_on_dataop_refused', coalesce(v_msg like '%only an undo names the data operation it undoes%', false));

    -- ---- 12. conformance unchanged ----
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
