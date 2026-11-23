-- sb3_pages-h6v B1: every link rule refuses what it should, and the good paths do what part 5, 4.5 and 10a say.
-- Acting as Alex (auth.uid() from the JWT claims), on throwaway requests with their own project codes. Evidence is set
-- by a direct update, as the service role writes it (the chat can't supply it). Covers: queue refusals (evidence
-- included); expired checks; a missing, all-voided or future-dated check; a wrong count; a missing or not-ready desktop
-- answer; a stale fingerprint; a used link; a second link on an approved request; one path per project (Q10), also
-- against a today's-kind action approved by link; a good approval (one sf_run, consumed, payload {link_id} only);
-- Don't run; a correction voiding the link, and its refusals; a lookup by link id taking the newest action; a resend
-- keeping the link id and failing the stale action; a rerun on expired checks, refused while it runs, allowed after it
-- finished; the rerun on a link whose approval never started (s6b); a simulation spending its link and creating
-- nothing (Q7); the sample's rules. Everything is undone. Run after the migration through the queue with --test.
-- Result: one row, with all_passed, failed, errors and checks.
-- supabase/tests/sb3_pages-h6v/2_failure_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true, "extension_version": "1.3.0"}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_fresh  jsonb;
  v_old    jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_fp     text;
  v_link   uuid;
  v_prev   jsonb;
  v_act    public.switchboard_actions;
  v_stale  uuid;
  v_git    uuid;
  v_n      integer;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- Every check a write needs, passed an hour ago; and one count check 25 hours ago (expired).
    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '1 hour'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'rehearsal']) c;
    v_old := jsonb_build_array(jsonb_build_object('check', 'count', 'org', 'production', 'passed_at', now() - interval '25 hours'));
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'run_tag', 'h6v-t-s10-ab12', 'client', 'Test',
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(jsonb_build_object('alias', 'test-prod', 'org_type', 'production', 'role', 'target')),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', jsonb_build_array(jsonb_build_object('code', 'write')));

    -- ---- queue refusals, before any link ----
    v_msg := null;
    begin perform public.switchboard_queue_run_request((v_base || '{"project_code": "h6v-t-q"}') - 'side_effects');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_no_side_effects', coalesce(v_msg like '%add side_effects%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request((v_base || '{"project_code": "h6v-t-q"}') - 'counts');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_dataop_without_count', coalesce(v_msg like '%add counts.total%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-q", "sample": {"records": []}}');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_a_sample', coalesce(v_msg like '%leave the sample out%', false));
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('project_code', 'h6v-t-q', 'evidence', v_fresh));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('queue_refuses_evidence_from_the_chat', coalesce(v_msg like '%leave evidence out%', false));

    -- ---- A: expired, missing, all-voided and future checks; count; desktop; fingerprint; then a good approval ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-a"}')->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_checks := v_checks || jsonb_build_object('link_url_has_token', v_tok is not null);
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_no_evidence', coalesce(v_msg like '%not every check has passed%', false));

    update public.switchboard_run_requests set evidence = v_old where id = v_req;
    v_checks := v_checks || jsonb_build_object('preview_says_expired', (public.switchboard_run_preview(v_tok)->>'expired')::boolean);
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_expired_checks', coalesce(v_msg like '%checks expired%', false));

    update public.switchboard_run_requests set evidence = v_fresh - 4 where id = v_req;  -- no rehearsal
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_missing_rehearsal', coalesce(v_msg like '%missing rehearsal%', false));

    update public.switchboard_run_requests
       set evidence = (select jsonb_agg(e || '{"voided": true}') from jsonb_array_elements(v_fresh) e) where id = v_req;
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_all_voided', coalesce(v_msg like '%not every check has passed%', false));

    update public.switchboard_run_requests
       set evidence = v_fresh || jsonb_build_array(jsonb_build_object('check', 'sample', 'org', 'production', 'passed_at', now() + interval '1 hour'))
     where id = v_req;
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_future_check', coalesce(v_msg like '%dated in the future%', false));

    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;  -- the checks pass
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 44);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_wrong_count', coalesce(v_msg like '%count approved (44)%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, null, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_missing_desktop', coalesce(v_msg like '%desktop is not ready%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, '{"answer": "running", "panel": true, "helper": false}', 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_helper_down', coalesce(v_msg like '%desktop is not ready%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, 'not-the-fingerprint', c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_stale_fingerprint', coalesce(v_msg like '%not the current request%', false));
    v_checks := v_checks || jsonb_build_object('refusals_created_nothing',
      not exists (select 1 from public.switchboard_actions where payload->>'link_id' = v_link::text),
      'refusals_left_link_unused', (select used_at is null from public.switchboard_run_links where id = v_link));

    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    select * into v_act from public.switchboard_actions where id = (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'approve_consumed', (v_out->>'consumed')::boolean and not (v_out->>'simulated')::boolean,
      'approve_one_sf_run', (select count(*) from public.switchboard_actions where payload->>'link_id' = v_link::text) = 1,
      'approve_action_consumed_no_link', v_act.kind = 'sf_run' and v_act.status = 'consumed' and v_act.link_hash is null
                                         and v_act.link_used_at is null and v_act.needs_click,
      'approve_payload_link_id_only', v_act.payload = jsonb_build_object('link_id', v_link::text),
      'approve_link_records_it', (select used_at is not null and action_id = v_act.id and desktop = c_ready
                                    from public.switchboard_run_links where id = v_link));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_used_link', coalesce(v_msg like '%already been used%', false));
    v_msg := null;
    begin perform public.switchboard_issue_run_link(v_req);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('no_second_link_on_approved_request', coalesce(v_msg like '%already approved%', false));

    -- ---- Q10: A's run is live, so another request for h6v-t-a is refused; one live link per request ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-a"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_second_path_for_project', coalesce(v_msg like '%one at a time per project%', false));
    v_msg := null;
    begin perform public.switchboard_issue_run_link(v_req);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('one_live_link_per_request', coalesce(v_msg like '%still live%', false));

    -- ---- Q10 against today's kind: a git action queued 30 minutes ago, approved by its link a minute ago ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'git', 'h6v-t-h', '{"command": "gitsync"}', 'H6V TEST GIT', 'cli', now() - interval '30 minutes')
    returning id into v_git;
    update public.switchboard_actions
       set link_hash = repeat('a', 64), link_expires_at = now() + interval '20 minutes', link_used_at = now() - interval '1 minute',
           status = 'consumed'
     where id = v_git;
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-h"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('q10_sees_link_approved_action', coalesce(v_msg like '%' || v_git::text || '%one at a time%', false));

    -- ---- B: Don't run, then nothing approves; the note is one line of at most 200 characters ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-b"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_cancel_run_link(v_tok, repeat('x', 250) || E'\n');
    v_checks := v_checks || jsonb_build_object('cancel_note_capped', char_length(v_out->>'reason') = 200,
      'cancel_reason_stored', (select void_reason like 'cancelled: x%' from public.switchboard_run_links where id = (v_out->>'link_id')::uuid));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_cancelled_link', coalesce(v_msg like '%voided (cancelled%', false));

    -- ---- C: a correction raises the version and voids the live link; object and disguised edits are refused ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-c"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'wording', v_base || '{"project_code": "h6v-t-c", "counts": {"expected": 50, "total": 50}}',
                                                         '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('wording_edit_cannot_change_counts', coalesce(v_msg like '%changes only the headline%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    v_base || '{"project_code": "h6v-t-c", "operation": {"kind": "delete", "object": "Gift__c"}}',
                    '{"reason": "r", "items": [{"what": "w", "old": "a", "new": "b"}]}');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_edit_cannot_change_operation', coalesce(v_msg like '%object or operation changed%', false));
    v_out := public.switchboard_correct_run_request(v_req, 'records', v_base || '{"project_code": "h6v-t-c"}',
                                                    '{"reason": "Three more ids.", "items": [{"what": "Records", "old": "45", "new": "48"}]}');
    v_checks := v_checks || jsonb_build_object('correction_version_2', (v_out->>'version')::integer = 2,
      'correction_voided_link', (v_out->>'voided_links')::integer = 1,
      'correction_voided_count_and_backup', (v_out->>'voided_checks')::integer = 2,
      'correction_keeps_base_page', (select page = 'correction' and base_page = 'dataop' from public.switchboard_run_requests where id = v_req));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_link_after_correction', coalesce(v_msg like '%voided (corrected)%', false));
    v_msg := null;
    begin perform public.switchboard_correct_run_request(v_req, 'object', v_base, '{"reason": "r", "items": [{}]}');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correction_refuses_object', coalesce(v_msg like '%new request through diagnosis%', false));

    -- ---- D: a resend keeps the link id, fails the stale action in the same step; the lookup takes the newest ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-d"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_retry_run(v_tok, v_fp, c_ready);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('retry_refuses_never_approved', coalesce(v_msg like '%never approved%', false));
    -- An approval 16 minutes ago that was never picked up (the guard lets an insert set an earlier created_at).
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'h6v-t-d', jsonb_build_object('link_id', v_link::text), 'H6V TEST STALE', 'claude', now() - interval '16 minutes')
    returning id into v_stale;
    update public.switchboard_run_links set used_at = now() - interval '16 minutes', action_id = v_stale, desktop = c_ready where id = v_link;
    v_prev := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object('preview_not_started', (v_prev->'run'->>'not_started')::boolean
                                                                     and (v_prev->'run'->>'action_id')::uuid = v_stale);
    v_out := public.switchboard_retry_run(v_tok, v_fp, c_ready);
    v_checks := v_checks || jsonb_build_object(
      'resend_same_link_id', (v_out->>'link_id')::uuid = v_link
                             and (select payload->>'link_id' from public.switchboard_actions where id = (v_out->>'action_id')::uuid) = v_link::text,
      'resend_failed_the_stale', (select status = 'failed' from public.switchboard_actions where id = v_stale)
                                 and (select count(*) from public.switchboard_runs where action_id = v_stale
                                         and failure_reason = 'expired_not_picked_up' and finished_at is not null) = 1,
      'resend_new_is_consumed', (select status = 'consumed' and picked_up_at is null from public.switchboard_actions
                                  where id = (v_out->>'action_id')::uuid),
      'lookup_takes_newest', (public.switchboard_run_preview(v_tok)->'run'->>'action_id')::uuid = (v_out->>'action_id')::uuid,
      'link_action_is_newest', (select action_id from public.switchboard_run_links where id = v_link) = (v_out->>'action_id')::uuid);
    v_msg := null;
    begin perform public.switchboard_retry_run(v_tok, v_fp, c_ready);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('retry_refuses_a_live_run', coalesce(v_msg like '%not "not started"%', false));

    -- ---- E: a rerun on expired checks is its own approval; refused while it runs, allowed after it finished ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-e"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_old where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null, 'rerun');
    v_checks := v_checks || jsonb_build_object('rerun_accepted', (v_out->>'mode') = 'rerun' and (v_out->>'action_id') is not null,
      'rerun_keeps_link_unused', (select used_at is null and rerun_at is not null and rerun_action_id = (v_out->>'action_id')::uuid
                                    from public.switchboard_run_links where id = v_link));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null, 'rerun');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_second_rerun_while_it_runs', coalesce(v_msg like '%already asked for again%', false));
    -- The rerun ran and failed: the checks are still expired, and another rerun is allowed.
    update public.switchboard_actions set status = 'failed' where id = (v_out->>'action_id')::uuid;
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null, 'rerun');
    v_checks := v_checks || jsonb_build_object('rerun_again_after_a_failed_rerun', (v_out->>'mode') = 'rerun');

    -- ---- E2 (s6b): approved, never started, checks since expired: the rerun frees the link ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-s"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_old where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'h6v-t-s', jsonb_build_object('link_id', v_link::text), 'H6V TEST STUCK', 'claude', now() - interval '3 hours')
    returning id into v_stale;
    update public.switchboard_run_links set used_at = now() - interval '3 hours', action_id = v_stale, desktop = c_ready where id = v_link;
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null, 'rerun');
    v_checks := v_checks || jsonb_build_object(
      'stuck_rerun_accepted', (v_out->>'mode') = 'rerun',
      'stuck_rerun_frees_link', (select used_at is null from public.switchboard_run_links where id = v_link),
      'stuck_rerun_failed_the_stale', (select status = 'failed' from public.switchboard_actions where id = v_stale)
                                      and exists (select 1 from public.switchboard_runs where action_id = v_stale
                                                    and failure_reason = 'expired_not_picked_up'));

    -- ---- F: a simulation spends its link and creates no action or run (Q7) ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-f", "simulation": true}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    v_checks := v_checks || jsonb_build_object('simulation_simulated', (v_out->>'simulated')::boolean,
      'simulation_no_action', not exists (select 1 from public.switchboard_actions where payload->>'link_id' = v_link::text),
      'simulation_link_spent', (select used_at is not null from public.switchboard_run_links where id = v_link));
    v_msg := null;
    begin perform public.switchboard_store_run_sample(v_req, '{"records": [{"id_label": "x"}]}');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('simulation_holds_no_sample', coalesce(v_msg like '%no client data%', false));

    -- ---- G: the sample: held at most until the checks' valid-until, deleted by a read past it and by the prune ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-t-g"}')->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    v_out := public.switchboard_store_run_sample(v_req, '{"records": [{"role": "record", "id_label": "Gift G-1", "fields": []}]}');
    v_checks := v_checks || jsonb_build_object('sample_expires_with_checks',
      (v_out->>'expires_at')::timestamptz = (now() - interval '1 hour') + interval '24 hours');
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_checks := v_checks || jsonb_build_object('preview_shows_sample', public.switchboard_run_preview(v_tok)->'sample' <> 'null'::jsonb);
    update public.switchboard_run_samples set expires_at = now() - interval '1 second' where request_id = v_req;
    -- The read in its own statement: a check in the same statement would see the snapshot from before its delete.
    v_prev := public.switchboard_run_preview(v_tok);
    v_checks := v_checks || jsonb_build_object('preview_past_expiry_shows_none', v_prev->'sample' = 'null'::jsonb,
      'read_deleted_the_sample', not exists (select 1 from public.switchboard_run_samples where request_id = v_req));
    perform public.switchboard_store_run_sample(v_req, '{"records": [{"role": "record", "id_label": "Gift G-1", "fields": []}]}');
    update public.switchboard_run_samples set expires_at = now() - interval '1 second' where request_id = v_req;
    v_n := public.switchboard_prune_sf_results();
    v_checks := v_checks || jsonb_build_object('prune_deletes_expired_sample', not exists (select 1 from public.switchboard_run_samples where request_id = v_req));

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
