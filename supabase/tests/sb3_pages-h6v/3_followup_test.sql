-- sb3_pages-h6v s12: the follow-up migration (the correction gap and switchboard_record_run_evidence). Acting as Alex
-- (auth.uid() from the JWT claims) for the page functions; the evidence function is called as this test's role, as the
-- runner's service role would. Covers: a corrected data operation can't be approved while its reruns wait or before
-- they pass, and can through the same link once they do, with fresh checks and every 250 rule; the evidence function
-- refuses authenticated and anon, takes nothing but a run id, records a passing run's checks (once), lets a newer run
-- void an older one's entry and never the reverse, refuses an unfinished or failing run, a malformed check, a run
-- finished before the correction, a data operation's own run, and a simulation; Don't run is refused while the
-- correction's reruns run. s12b: a data operation naming its pre-check (pre_check_request_id) gets its checks in use
-- with their original times, and approves; one pre-check backs one write; a mismatch in object, records (or expected
-- count), field or value, another project, another user, a non-pre-check and a bad id are refused; the chat still
-- can't supply evidence; a copy over 24 hours old can't be approved. s12c: the sample moves with the copy (the write's
-- preview shows it, the pre-check's doesn't); a correction outside its row (a value correction changing the target org,
-- records or count; a records one changing the value; a code one changing the value) is refused, naming the field; a
-- correction can't change or drop pre_check_request_id; a code correction still supersedes the older review.
-- Everything is undone. Run after the migration through the queue with --test.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/sb3_pages-h6v/3_followup_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_ready  constant jsonb := '{"answer": "running", "panel": true, "helper": true}';
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_msg    text;
  v_base   jsonb;
  v_fresh  jsonb;
  v_req    uuid;
  v_out    jsonb;
  v_tok    text;
  v_fp     text;
  v_link   uuid;
  v_rerun  uuid;
  v_run    uuid;
  v_bad    uuid;
  v_write  uuid;
  v_pre    uuid;
  v_other  uuid;
  v_why    text;
  v_bad_req jsonb;
  v_dup    uuid;
begin
  begin
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- ---- the evidence function: service role only, one argument (a run id), nothing else ----
    v_checks := v_checks || jsonb_build_object(
      'evidence_fn_service_role', has_function_privilege('service_role', 'public.switchboard_record_run_evidence(uuid)', 'execute'),
      'evidence_fn_not_authenticated', not has_function_privilege('authenticated', 'public.switchboard_record_run_evidence(uuid)', 'execute'),
      'evidence_fn_not_anon', not has_function_privilege('anon', 'public.switchboard_record_run_evidence(uuid)', 'execute'),
      'evidence_fn_takes_only_a_run_id', (select pronargs = 1 from pg_proc where oid = 'public.switchboard_record_run_evidence(uuid)'::regprocedure),
      'consume_still_authenticated_only', has_function_privilege('authenticated', 'public.switchboard_consume_run_link(text, text, jsonb, integer, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_consume_run_link(text, text, jsonb, integer, text)', 'execute'));

    select jsonb_agg(jsonb_build_object('check', c, 'org', case when c = 'rehearsal' then 'sandbox' else 'production' end,
                                        'passed_at', now() - interval '2 hours'))
      into v_fresh from unnest(array['count', 'login', 'automation', 'backup', 'sample', 'rehearsal']) c;
    v_base := jsonb_build_object(
      'page', 'dataop', 'headline', 'H6V TEST: UPDATES 45 GIFTS', 'project_code', 'h6v-f-a',
      'problem', jsonb_build_object('label', 'P1', 'sentence', 'A test problem sentence.'),
      'side_effects', 'None, a test.', 'orgs', jsonb_build_array(jsonb_build_object('alias', 'test-prod', 'org_type', 'production', 'role', 'target')),
      'operation', jsonb_build_object('kind', 'update', 'object', 'Gift__c', 'field', 'Campaign__c', 'value', 'X'),
      'selected_by', jsonb_build_object('kind', 'ids', 'text', '45 ids'),
      'counts', jsonb_build_object('expected', 45, 'total', 45),
      'steps', jsonb_build_array(jsonb_build_object('code', 'write')));

    -- ---- the gap: correct a data operation (records: count, backup, sample rerun) ----
    v_req := (public.switchboard_queue_run_request(v_base)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    perform public.switchboard_correct_run_request(v_req, 'records', v_base,
              '{"reason": "Three more ids.", "items": [{"what": "Records", "old": "45", "new": "48"}]}');
    -- The correction ten minutes ago, so runs within this test (now() and a minute before) finish after it.
    update public.switchboard_run_requests set corrected_at = now() - interval '10 minutes' where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, null);
    v_rerun := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'correction_approve_is_a_rerun', (v_out->>'as_rerun')::boolean,
      'correction_link_stays_unused', (select used_at is null and rerun_at is not null and rerun_action_id = v_rerun
                                         from public.switchboard_run_links where id = v_link));
    -- While the reruns wait: no second approval, and the page is still a correction.
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('refuses_while_reruns_wait', coalesce(v_msg like '%still running%', false),
      'still_a_correction', (select page = 'correction' from public.switchboard_run_requests where id = v_req));
    v_msg := null;
    begin perform public.switchboard_cancel_run_link(v_tok, 'stop');
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('no_dont_run_while_reruns_run', coalesce(v_msg like '%running again%', false));
    -- An unfinished run records nothing.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result)
    values (c_alex, v_rerun, 'real', 'test: running', null)
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_unfinished_run', coalesce(v_msg like '%has not finished%', false));

    -- The reruns run and fail: nothing is recorded, the request stays a correction, and the write can't be approved.
    update public.switchboard_actions set picked_up_at = now(), status = 'failed' where id = v_rerun;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: reruns failed', '{"ok": true, "pass": false, "checks": []}', now())
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_failing_run', coalesce(v_msg like '%did not pass%', false));
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    -- A correction page's Approve is a rerun again, not the write: the write is never approved from a correction.
    v_checks := v_checks || jsonb_build_object('failed_reruns_leave_no_write',
      coalesce((select page = 'correction' from public.switchboard_run_requests where id = v_req), false)
      and not exists (select 1 from public.switchboard_run_links where id = v_link and used_at is not null));

    -- A second correction Approve (the first failed) is allowed: a fresh rerun, which passes this time.
    if v_msg is not null then
      v_checks := v_checks || jsonb_build_object('second_correction_approve_error', v_msg);
    end if;
    v_rerun := (select rerun_action_id from public.switchboard_run_links where id = v_link);
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_rerun;
    -- A malformed check is refused.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: malformed', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production", "extra": 1}]}', now())
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_malformed_check', coalesce(v_msg like '%isn''t {check, org, commit?}%', false));
    -- A run finished before the correction is refused.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: old', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}', now() - interval '1 day')
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_run_before_correction', coalesce(v_msg like '%before the request was corrected%', false));

    -- The passing rerun: its checks are read from the run row only.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: reruns passed',
            '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}, {"check": "backup", "org": "production"}, {"check": "sample", "org": "production"}]}',
            now())
    returning id into v_run;
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object(
      'evidence_recorded_three', (v_out->>'recorded')::integer = 3,
      'evidence_back_to_dataop', v_out->>'page' = 'dataop',
      'evidence_page_key_follows', (select page = 'dataop' and request->>'page' = 'dataop' from public.switchboard_run_requests where id = v_req),
      'evidence_from_the_run_row', (select count(*) = 3 from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
                                     where r.id = v_req and e->>'run_id' = v_run::text and coalesce((e->>'voided')::boolean, false) = false
                                       and (e->>'passed_at')::timestamptz = now()),
      'evidence_voids_the_old', (select count(*) = 3 from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
                                  where r.id = v_req and e->>'check' in ('count', 'backup', 'sample') and (e->>'voided')::boolean));
    v_out := public.switchboard_record_run_evidence(v_run);
    v_checks := v_checks || jsonb_build_object('evidence_recorded_once', (v_out->>'already')::boolean);
    -- A later passing run for count voids the earlier run's count entry; an older run never replaces newer evidence.
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: count again', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}', now())
    returning id into v_bad;
    perform public.switchboard_record_run_evidence(v_bad);
    v_checks := v_checks || jsonb_build_object('newer_run_voids_the_earlier_entry',
      (select (e->>'voided')::boolean from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
        where r.id = v_req and e->>'check' = 'count' and e->>'run_id' = v_run::text) is true);
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: older', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}', now() - interval '1 minute')
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('older_run_never_replaces_newer', coalesce(v_msg like '%newer evidence%', false));

    -- Now the same link approves the write: the page reloads (new fingerprint), the count and the fresh checks hold.
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('old_fingerprint_refused_after_return', coalesce(v_msg like '%not the current request%', false));
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 44);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('write_still_checks_the_count', coalesce(v_msg like '%count approved (44)%', false));
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    v_write := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'corrected_write_approved', not (v_out->>'as_rerun')::boolean and v_write is not null,
      'write_spends_the_link', (select used_at is not null and action_id = v_write from public.switchboard_run_links where id = v_link));
    -- The data operation's own run is never evidence.
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_write;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_write, 'real', 'test: the write', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}', now())
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_the_write_run', coalesce(v_msg like '%not this link''s pre-check or rerun%', false));

    -- ---- a simulation records no evidence ----
    v_req := (public.switchboard_queue_run_request((v_base || '{"project_code": "h6v-f-s", "page": "precheck", "simulation": true}'::jsonb) - 'counts')->>'request_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_req);
    v_link := (v_out->>'link_id')::uuid;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_run', 'h6v-f-s', jsonb_build_object('link_id', v_link::text), 'H6V TEST SIM', 'claude')
    returning id into v_rerun;
    update public.switchboard_run_links set used_at = now(), action_id = v_rerun, desktop = c_ready where id = v_link;
    insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
    values (c_alex, v_rerun, 'real', 'test: sim', '{"ok": true, "pass": true, "checks": [{"check": "count", "org": "production"}]}', now())
    returning id into v_bad;
    v_msg := null;
    begin perform public.switchboard_record_run_evidence(v_bad);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('evidence_refuses_simulation', coalesce(v_msg like '%simulation records no evidence%', false));

    -- ---- s12b: a data operation names its pre-check (pre_check_request_id); its checks are copied, times kept ----
    v_base := (v_base || '{"project_code": "h6v-f-p"}'::jsonb);
    v_pre := (public.switchboard_queue_run_request(v_base || '{"page": "precheck"}'::jsonb)->>'request_id')::uuid;
    -- Its checks passed two hours ago (written as the runner would); one older entry, voided, is never copied.
    update public.switchboard_run_requests
       set evidence = v_fresh || '[{"check": "count", "org": "production", "passed_at": "2020-01-01T00:00:00Z", "voided": true}]'::jsonb
     where id = v_pre;
    v_out := public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_pre::text));
    v_req := (v_out->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'copy_counts_six', (v_out->>'copied_checks')::integer = 6,
      'copy_keeps_original_times', (select count(*) = 6 from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e
                                     where r.id = v_req and (e->>'passed_at')::timestamptz = now() - interval '2 hours'
                                       and e->>'copied_from' = v_pre::text and not (e ? 'voided')),
      'copy_skips_voided', (select jsonb_array_length(evidence) = 6 from public.switchboard_run_requests where id = v_req));
    -- The copy approves: same project, every write check in use, within 24 hours of the oldest.
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    v_write := (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('copy_approves_the_write', v_write is not null and not (v_out->>'as_rerun')::boolean);
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = v_write;
    -- The same pre-check never backs a second write.
    v_msg := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_pre::text));
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('one_pre_check_one_write', coalesce(v_msg like '%already backed an approved data operation%', false));

    -- A fresh pre-check for the refusals.
    v_pre := (public.switchboard_queue_run_request(v_base || '{"page": "precheck"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_pre;
    -- Each mismatch refused, naming why.
    foreach v_msg in array array['object', 'records', 'field', 'value'] loop
      v_bad_req := case v_msg
        when 'object'  then jsonb_set(v_base, '{operation,object}', '"Opportunity"')
        when 'records' then jsonb_set(v_base, '{selected_by,text}', '"46 ids"')
        when 'field'   then jsonb_set(v_base, '{operation,field}', '"Appeal__c"')
        when 'value'   then jsonb_set(v_base, '{operation,value}', '"Y"')
      end || jsonb_build_object('pre_check_request_id', v_pre::text);
      v_why := null;
      begin perform public.switchboard_queue_run_request(v_bad_req);
      exception when others then v_why := sqlerrm; end;
      v_checks := v_checks || jsonb_build_object('copy_refuses_' || v_msg,
        coalesce(v_why like '%differs from what its pre-check checked: ' || case v_msg when 'records' then 'the records or filter' else 'the ' || v_msg end || '.%', false));
    end loop;
    -- A filter instead of ids is the records too; another total or expected count is the count.
    v_why := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_base, '{selected_by}', '{"kind": "filter", "text": "Campaign__c = null"}') || jsonb_build_object('pre_check_request_id', v_pre::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_a_filter_for_ids', coalesce(v_why like '%checked: the records or filter.%', false));
    v_why := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_base, '{counts,total}', '4500') || jsonb_build_object('pre_check_request_id', v_pre::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_another_total', coalesce(v_why like '%checked: the count.%', false));
    v_why := null;
    begin perform public.switchboard_queue_run_request(jsonb_set(v_base, '{counts,expected}', '46') || jsonb_build_object('pre_check_request_id', v_pre::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_another_expected_count', coalesce(v_why like '%checked: the count.%', false));
    -- A key set to null is a key left out.
    v_out := public.switchboard_queue_run_request(v_base || '{"operation": {"kind": "update", "object": "Gift__c", "field": "Campaign__c", "value": "X", "file": null}}'::jsonb
                                                  || jsonb_build_object('pre_check_request_id', v_pre::text));
    v_checks := v_checks || jsonb_build_object('copy_null_is_left_out', (v_out->>'copied_checks')::integer = 6);
    v_dup := (v_out->>'request_id')::uuid;
    -- Wording may differ: the headline and side effects aren't checked.
    v_out := public.switchboard_queue_run_request(v_base || '{"headline": "H6V TEST: OTHER WORDS", "side_effects": "Other words."}'::jsonb
                                                  || jsonb_build_object('pre_check_request_id', v_pre::text));
    v_checks := v_checks || jsonb_build_object('copy_allows_other_wording', (v_out->>'copied_checks')::integer = 6);
    -- Two copies of one pre-check queued before either is approved: once one writes, the other's Approve is refused.
    v_out := public.switchboard_issue_run_link((v_out->>'request_id')::uuid);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_out := public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    update public.switchboard_actions set picked_up_at = now(), status = 'succeeded' where id = (v_out->>'action_id')::uuid;
    v_out := public.switchboard_issue_run_link(v_dup);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_why := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('second_copy_refused_at_approve', coalesce(v_why like '%already backed an approved data operation%', false));
    -- The first copied request, written at v1, can't write again at a later version on the same copied checks.
    update public.switchboard_run_requests set version = version + 1 where id = v_req;
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_why := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('same_request_no_second_write', coalesce(v_why like '%already backed an approved data operation%', false));
    -- Another project, another user, a non-pre-check, and an id that isn't one.
    v_other := (public.switchboard_queue_run_request(v_base || '{"page": "precheck", "project_code": "h6v-f-q"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_other;
    v_why := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_other::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_another_project', coalesce(v_why like '%for project h6v-f-q, not h6v-f-p%', false));
    update public.switchboard_run_requests set user_id = gen_random_uuid() where id = v_other;
    v_why := null;
    begin perform public.switchboard_queue_run_request((v_base || '{"project_code": "h6v-f-q"}'::jsonb) || jsonb_build_object('pre_check_request_id', v_other::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_another_user', coalesce(v_why like '%no such pre-check request%', false));
    v_why := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_req::text));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_a_data_operation_as_pre_check', coalesce(v_why like '%is not a Pre-check and Rehearsal request%', false));
    v_why := null;
    begin perform public.switchboard_queue_run_request(v_base || '{"pre_check_request_id": "not-an-id"}'::jsonb);
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('copy_refuses_a_bad_id', coalesce(v_why like '%must be the pre-check request''s id%', false));
    -- The chat still can't supply evidence, with or without a pre-check.
    v_why := null;
    begin perform public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_pre::text, 'evidence', v_fresh));
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('chat_evidence_refused_with_pre_check', coalesce(v_why like '%leave evidence out%', false));

    -- A copy whose oldest check passed over 24 hours ago is accepted but can't be approved: the clock never resets.
    v_pre := (public.switchboard_queue_run_request((v_base || '{"page": "precheck", "project_code": "h6v-f-o"}'::jsonb))->>'request_id')::uuid;
    update public.switchboard_run_requests
       set evidence = (select jsonb_agg(case when e->>'check' = 'login' then e || jsonb_build_object('passed_at', now() - interval '25 hours') else e end)
                         from jsonb_array_elements(v_fresh) e)
     where id = v_pre;
    v_req := (public.switchboard_queue_run_request((v_base || '{"project_code": "h6v-f-o"}'::jsonb) || jsonb_build_object('pre_check_request_id', v_pre::text))->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object('copy_keeps_the_old_time', (select (e->>'passed_at')::timestamptz = now() - interval '25 hours'
                                                from public.switchboard_run_requests r, jsonb_array_elements(r.evidence) e where r.id = v_req and e->>'check' = 'login'));
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_fp := public.switchboard_run_preview(v_tok)->>'fingerprint';
    v_msg := null;
    begin perform public.switchboard_consume_run_link(v_tok, v_fp, c_ready, 45);
    exception when others then v_msg := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('old_copy_not_approved', coalesce(v_msg like '%checks expired at%', false));

    -- ---- s12c: the sample moves with the copy ----
    v_base := v_base || '{"project_code": "h6v-f-c"}'::jsonb;
    v_pre := (public.switchboard_queue_run_request(v_base || '{"page": "precheck"}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_pre;
    insert into public.switchboard_run_samples (user_id, request_id, sample, expires_at)
    values (c_alex, v_pre, '{"records": [{"role": "update", "fields": [{"name": "Campaign__c", "now": "A", "after": "X"}]}]}', now() + interval '20 hours');
    v_out := public.switchboard_queue_run_request(v_base || jsonb_build_object('pre_check_request_id', v_pre::text));
    v_req := (v_out->>'request_id')::uuid;
    v_checks := v_checks || jsonb_build_object(
      'sample_moved', (v_out->>'moved_sample')::boolean,
      'sample_keeps_expiry', (select request_id = v_req and expires_at = now() + interval '20 hours' from public.switchboard_run_samples
                               where sample->'records'->0->>'role' = 'update' and user_id = c_alex and request_id in (v_req, v_pre)));
    v_out := public.switchboard_issue_run_link(v_req);
    v_tok := substring(v_out->>'url' from '/run/([0-9a-f]{64})$');
    v_checks := v_checks || jsonb_build_object('write_preview_shows_sample',
      public.switchboard_run_preview(v_tok)->'sample'->'records'->0->>'role' = 'update');
    v_out := public.switchboard_issue_run_link(v_pre);
    v_checks := v_checks || jsonb_build_object('pre_check_preview_no_sample',
      jsonb_typeof(public.switchboard_run_preview(substring(v_out->>'url' from '/run/([0-9a-f]{64})$'))->'sample') = 'null');
    -- No sample on the pre-check: nothing moves.
    v_out := public.switchboard_queue_run_request((v_base || '{"headline": "H6V TEST: NO SAMPLE"}'::jsonb) || jsonb_build_object('pre_check_request_id', v_pre::text));
    v_checks := v_checks || jsonb_build_object('no_sample_nothing_moves', not (v_out->>'moved_sample')::boolean);

    -- ---- s12c: each correction kind changes only its own row; pre_check_request_id never changes ----
    v_bad_req := v_base || jsonb_build_object('pre_check_request_id', v_pre::text);
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    jsonb_set(jsonb_set(v_bad_req, '{operation,value}', '"Y"'), '{orgs}', '[{"alias": "other-prod", "org_type": "production", "role": "target"}]'),
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_refuses_target_org', coalesce(v_why like '%a value correction changes only the value; it also changed orgs.%', false));
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    jsonb_set(jsonb_set(v_bad_req, '{operation,value}', '"Y"'), '{selected_by,text}', '"46 ids"'),
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_refuses_records', coalesce(v_why like '%it also changed selected_by.text.%', false));
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    jsonb_set(jsonb_set(v_bad_req, '{operation,value}', '"Y"'), '{counts,total}', '46'),
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('value_refuses_count', coalesce(v_why like '%it also changed counts.total.%', false));
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'records', jsonb_set(v_bad_req, '{operation,value}', '"Y"'),
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('records_refuses_value', coalesce(v_why like '%a records correction changes only the records and their counts; it also changed operation.value.%', false));
    -- Ids to a filter is a records_filter correction (it reruns the rehearsal), not a records one.
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'records', jsonb_set(v_bad_req, '{selected_by}', '{"kind": "filter", "text": "Campaign__c = null"}'),
                    '{"reason": "r", "items": [{"what": "Records", "old": "45 ids", "new": "a filter"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('records_refuses_ids_to_filter', coalesce(v_why like '%it also changed selected_by.kind.%', false));
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value',
                    jsonb_set(v_bad_req, '{operation,value}', '"Y"') || jsonb_build_object('pre_check_request_id', v_other::text),
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correction_refuses_pre_check_change', coalesce(v_why like '%never changes pre_check_request_id%', false));
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'value', jsonb_set(v_bad_req, '{operation,value}', '"Y"') - 'pre_check_request_id',
                    '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('correction_refuses_dropping_pre_check', coalesce(v_why like '%never changes pre_check_request_id%', false));
    -- Within its row, with its own steps, a value correction goes through.
    v_out := public.switchboard_correct_run_request(v_req, 'value',
               jsonb_set(v_bad_req, '{operation,value}', '"Y"') || '{"steps": [{"code": "create_test"}, {"code": "rehearse_operation"}]}'::jsonb,
               '{"reason": "r", "items": [{"what": "Value", "old": "X", "new": "Y"}]}');
    v_checks := v_checks || jsonb_build_object('value_within_row_accepted', (v_out->>'version')::integer = 2);

    -- ---- s12c: a code correction still supersedes the older review (as 250) ----
    v_req := (public.switchboard_queue_run_request(v_base || '{"project_code": "h6v-f-k", "code": {"commit": "abc1234"}}'::jsonb)->>'request_id')::uuid;
    update public.switchboard_run_requests set evidence = v_fresh where id = v_req;
    insert into public.switchboard_code_reviews (user_id, request_id, commit, review)
    values (c_alex, v_req, 'abc1234', '{}') returning id into v_dup;
    v_why := null;
    begin perform public.switchboard_correct_run_request(v_req, 'code', v_base || '{"project_code": "h6v-f-k", "code": {"commit": "def5678"}, "headline": "H6V TEST: NEW"}'::jsonb
                                                         || '{"operation": {"kind": "update", "object": "Gift__c", "field": "Campaign__c", "value": "Z"}}'::jsonb,
                    '{"reason": "r", "items": [{"what": "Code", "old": "abc1234", "new": "def5678"}]}');
    exception when others then v_why := sqlerrm; end;
    v_checks := v_checks || jsonb_build_object('code_refuses_value', coalesce(v_why like '%a code correction changes only the code; it also changed operation.value.%', false));
    perform public.switchboard_correct_run_request(v_req, 'code', v_base || '{"project_code": "h6v-f-k", "code": {"commit": "def5678"}}'::jsonb,
              '{"reason": "r", "items": [{"what": "Code", "old": "abc1234", "new": "def5678"}]}');
    v_checks := v_checks || jsonb_build_object('code_correction_supersedes_review',
      (select status = 'superseded' and superseded_by = 'def5678' from public.switchboard_code_reviews where id = v_dup));

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
