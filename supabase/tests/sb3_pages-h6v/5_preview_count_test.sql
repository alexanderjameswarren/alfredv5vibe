-- sb3_pages-h6v s16: the migration that has switchboard_run_preview return total_count. Acting as Alex (auth.uid()
-- from the JWT claims). Covers: the preview returns the row's total_count, which is counts.total when it differs from
-- counts.expected; approving with that count works, and any other count (the expected one, one more, none) is still
-- refused; a request with no count (a pre-check) returns null; the preview still deletes an
-- expired sample and still shows a live one; the newest run, not_started and the simulation flag are still there; an
-- unknown token is still refused. Everything is undone. Run after the migration with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/5_preview_count_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  c_prod   constant jsonb := '{"alias": "test-prod", "org_type": "production", "role": "target"}';
  c_sb     constant jsonb := '{"alias": "test-sb", "org_type": "sandbox", "role": "rehearsal"}';
  c_sample constant jsonb := '{"records": [{"role": "update", "id_label": "G-1", "fields": []}]}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_fresh  jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_p      jsonb;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    -- counts.total (48) differs from counts.expected (45): total_count is 48, the count the write checks.
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 48 GIFTS', 'project_code', 'h6v-p-c', 'simulation', false,
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(c_prod, c_sb),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '48 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 48),
      'steps', '[{"code": "write"}]'::jsonb);

    -- ---- 1. the preview returns total_count ----
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'preview_returns_total_count', v_p->'total_count' = '48'::jsonb,
      'total_count_is_the_rows', (v_p->>'total_count')::integer = (select total_count from public.switchboard_run_requests where id = v_req),
      'still_returns_simulation_false', v_p->'request'->'simulation' = 'false'::jsonb,
      'no_run_yet', jsonb_typeof(v_p->'run') = 'null');

    -- ---- 2. any other count is still refused, and nothing is approved ----
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('expected_count_refused', coalesce(v_msg like '%the count approved (45) is not the request''s count (48)%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, 49);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('one_more_refused', coalesce(v_msg like '%the count approved (49)%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, null);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('no_count_refused', coalesce(v_msg like '%is not the request''s count (48)%', false),
      'refusals_approve_nothing', (select used_at is null from public.switchboard_run_links where id = (v_p->>'link_id')::uuid));

    -- ---- 3. approving with the preview's count works; the preview shows the run ----
    v_out := public.switchboard_consume_run_link(v_tok, v_p->>'fingerprint', c_ready, (v_p->>'total_count')::integer);
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'approve_with_total_count_works', (v_out->>'action_id') is not null,
      'preview_shows_the_newest_run', v_p->'run'->>'action_id' = v_out->>'action_id' and v_p->'run'->>'status' = 'consumed',
      'run_not_started_false', v_p->'run'->'not_started' = 'false'::jsonb,
      'link_used', v_p->'link'->>'used_at' is not null,
      'total_count_still_there', v_p->'total_count' = '48'::jsonb);

    -- ---- 4. a request with no count (a pre-check) gives null ----
    v_req := (public.switchboard_queue_run_request((v_base - 'steps') || jsonb_build_object('page', 'precheck', 'project_code', 'h6v-p-n',
              'counts', '{}'::jsonb, 'steps', '[{"code": "count_listed"}]'::jsonb))->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_p := public.switchboard_run_preview(substring(v_out->>'url' from '/run/([0-9a-f]{64})$'));
    v_checks := v_checks || jsonb_build_object('no_count_gives_null', v_p ? 'total_count' and jsonb_typeof(v_p->'total_count') = 'null');

    -- ---- 5. the sample: a live one is shown; an expired one is deleted by the read ----
    v_req := (public.switchboard_queue_run_request(v_base || jsonb_build_object('project_code', 'h6v-p-s', 'simulation', true))->>'request_id')::uuid;
    insert into public.switchboard_run_samples (user_id, request_id, sample, created_at, expires_at)
    values (c_alex, v_req, c_sample, now() - interval '1 hour', now() + interval '1 hour');
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'live_sample_shown', v_p->'sample' = c_sample,
      'simulation_still_returned', v_p->'request'->'simulation' = 'true'::jsonb);
    update public.switchboard_run_samples set created_at = now() - interval '3 hours', expires_at = now() - interval '1 minute'
     where request_id = v_req;
    v_p := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object(
      'expired_sample_not_shown', jsonb_typeof(v_p->'sample') = 'null',
      'expired_sample_deleted', not exists (select 1 from public.switchboard_run_samples where request_id = v_req));

    -- ---- 6. an unknown token is still refused ----
    v_msg := null;
    begin perform public.switchboard_run_preview(repeat('0', 64));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('unknown_token_refused', coalesce(v_msg = 'switchboard_run_preview: no such link.', false));

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
