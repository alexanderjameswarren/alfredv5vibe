-- dataop_write-j5w s7: verify the sf_datawrite migration (docs/technical-spec-dataop_write-j5w.md parts 2, 3 and 5):
-- the kind, its payload check and every rule with its sentence, needs_click always true, the run-result check, the
-- queue and pickup functions, the grants, and that sf_dataop and sf_dataquery are unchanged. Run after the migration,
-- through the queue with --test. Throwaway rows; everything is undone, including any real action a pickup call touches.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/dataop_write-j5w/1_verify_sf_datawrite.sql

do $$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_code  constant text := 'dataop-verify-j5w';
  c_req   constant text := '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  c_hex2  constant text := 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  c_hex3  constant text := 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbccccccccccccccccdddddddddddddddd';
  c_sel   constant text := E'SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND CreatedDate < 2026-11-18T00:00:00Z\n';
  c_broad constant text := 'SELECT Id, GiftCommitmentId, Amount, LastModifiedById FROM GiftTransaction WHERE Source__c = ''ActBlue''';
  c_gc    constant text := 'SELECT Id, ExpectedTotalAmount FROM GiftCommitment WHERE Source__c = ''ActBlue''';
  c_r1    constant text := 'SELECT COUNT() FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND GiftCommitmentId = null';
  c_r2    constant text := 'SELECT COUNT() FROM GiftCommitment WHERE Rollup_Pending__c = true';
  -- An sf_dataop payload as 240 takes it (dataops_alfred-d4x's test).
  c_dataop constant jsonb := '{"alias":"cd-prod","repo":"C:\\Users\\Alex\\projects\\common-defense","plan":"dataops/fixc-plan.json",
    "stamp":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","preflight_at":"2026-11-18T15:00:00.000Z",
    "object":"Demo_Gift__c","problem":"Forty-five gifts were saved without a link to their plan.","expected":45,
    "write":{"kind":"bulk"},"rows":[{"label":"Gifts in the list with no plan link","before":45,"goal":0}]}';
  v_selsha  text;
  q_sel     jsonb;   -- gate: selection.soql
  q_gbroad  jsonb;   -- gate: broad snapshot
  q_ggc     jsonb;   -- gate: gift commitments
  q_abroad  jsonb;   -- after: broad snapshot
  q_asel    jsonb;   -- after: selection
  q_r1      jsonb;   -- an after-count
  q_wait    jsonb;   -- an after-count wait
  v_base    jsonb;
  v_batch   jsonb;
  v_bulk    jsonb;
  v_batchx  jsonb;   -- a batch with an exclude upload
  v_undo    jsonb;
  v_ids200  text;
  v_ids201  text;
  v_s       text;
  v_t       text;
  v_p       jsonb;
  v_big     jsonb;
  v_under   jsonb;
  v_201     jsonb;
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_ok      boolean;
  v_msg     text;
  v_kv      record;
  v_id      uuid;
  v_new     uuid;
  v_unclick uuid;
  v_old     uuid;
  v_q       jsonb;
  v_pick    jsonb;
  v_seen    uuid[] := '{}';
  i         integer;
begin
  begin
    v_selsha := encode(sha256(convert_to(c_sel, 'UTF8')), 'hex');
    q_sel    := jsonb_build_object('step', 'gate', 'soql', c_sel, 'sha256', v_selsha, 'file', 'selection.soql');
    q_gbroad := jsonb_build_object('step', 'gate', 'soql', c_broad, 'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot');
    q_ggc    := jsonb_build_object('step', 'gate', 'soql', c_gc, 'sha256', encode(sha256(convert_to(c_gc, 'UTF8')), 'hex'), 'label', 'gate: gift commitments');
    q_abroad := jsonb_build_object('step', 'after', 'soql', c_broad, 'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'after: broad snapshot');
    q_asel   := jsonb_build_object('step', 'after', 'soql', c_sel, 'sha256', v_selsha, 'label', 'after: selection');
    q_r1     := jsonb_build_object('step', 'after-counts', 'soql', c_r1, 'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'),
                  'label', 'Installments with no gift commitment');
    q_wait   := jsonb_build_object('step', 'after-counts', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'),
                  'label', 'Commitments whose totals are updating: wait', 'wait', jsonb_build_object('stable_minutes', 2, 'limit_minutes', 30));

    v_base := jsonb_build_object('alias', 'cd-prod', 'org_type', 'production', 'repo', 'C:\Users\Alex\projects\common-defense',
      'run', 'data-ops/' || c_code || '/fixc-2026-11-19', 'run_tag', c_code || '-s9-ab12', 'request_sha256', c_req,
      'selection_sha256', v_selsha, 'object', 'GiftTransaction',
      'problem', 'Forty-five installments were saved without a link to their gift commitment.', 'expected', 45);
    v_batch := v_base || jsonb_build_object('write', jsonb_build_object('kind', 'batch', 'class', 'FixCLinkBatch'),
      'queries', jsonb_build_array(q_sel, q_gbroad, q_abroad, q_asel, q_r1, q_wait));
    -- s6b: a bulk write uploads nothing; the exclude upload lives on a batch.
    v_bulk := v_base || jsonb_build_object('org_type', 'sandbox',
      'write', jsonb_build_object('kind', 'bulk', 'operation', 'update', 'csv', 'update.csv', 'csv_sha256', c_hex2),
      'queries', jsonb_build_array(q_sel, q_ggc, q_abroad, q_r1));
    v_batchx := v_batch || jsonb_build_object(
      'uploads', jsonb_build_array(jsonb_build_object('purpose', 'exclude', 'file', 'exclude.csv', 'sha256', c_hex3, 'rows', 3)));
    v_undo := v_base || jsonb_build_object(
      'write', jsonb_build_object('kind', 'undo', 'class', 'FixCUndoBatch', 'ids_file', 'undo-ids.csv', 'ids_sha256', c_hex2),
      'uploads', jsonb_build_array(jsonb_build_object('purpose', 'undo-ids', 'file', 'undo-ids.csv', 'sha256', c_hex2, 'rows', 45)),
      'queries', jsonb_build_array(q_gbroad, q_abroad));

    select string_agg(quote_literal('a0D' || lpad(g::text, 12, '0') || 'AAA'), ',') into v_ids200 from generate_series(1, 200) g;
    v_ids201 := v_ids200 || ',' || quote_literal('a0D000000000201AAA');

    -- ---- schema and grants ----
    v_checks := v_checks || jsonb_build_object(
      'kind_check_has_sf_datawrite', coalesce((select pg_get_constraintdef(oid) like '%sf_datawrite%' from pg_constraint
        where conname = 'switchboard_actions_kind_valid' and conrelid = 'public.switchboard_actions'::regclass), false),
      'kind_check_keeps_older_kinds', coalesce((select pg_get_constraintdef(oid) like '%''sf_dataop''%' and pg_get_constraintdef(oid) like '%sf_dataquery%'
        from pg_constraint where conname = 'switchboard_actions_kind_valid' and conrelid = 'public.switchboard_actions'::regclass), false),
      'payload_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_datawrite_payload'
        and conrelid = 'public.switchboard_actions'::regclass),
      'click_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_datawrite_click'
        and conrelid = 'public.switchboard_actions'::regclass),
      'older_kind_checks_kept', (select count(*) = 4 from pg_constraint where conrelid = 'public.switchboard_actions'::regclass
        and conname in ('switchboard_actions_sf_dataop_payload', 'switchboard_actions_sf_dataop_click',
                        'switchboard_actions_sf_dataquery_payload', 'switchboard_actions_sf_dataquery_click')),
      'runs_result_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_runs_datawrite_result'
        and conrelid = 'public.switchboard_runs'::regclass),
      'dataquery_result_check_kept', exists (select 1 from pg_constraint where conname = 'switchboard_runs_dataquery_result'
        and conrelid = 'public.switchboard_runs'::regclass),
      'problem_fn_grants',
        has_function_privilege('authenticated', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute')
        and has_function_privilege('service_role', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute'),
      'ok_fn_grants',
        has_function_privilege('authenticated', 'public.switchboard_datawrite_payload_ok(jsonb, text)', 'execute')
        and has_function_privilege('service_role', 'public.switchboard_datawrite_payload_ok(jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_datawrite_payload_ok(jsonb, text)', 'execute'),
      'pickup_service_role_only',
        has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[])', 'execute'),
      'queue_helper_no_anon',
        has_function_privilege('authenticated', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'),
      'needs_click_no_anon',
        not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'));

    -- ---- a valid batch, needs_click true whoever queues it ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, needs_click)
    values (c_alex, 'sf_datawrite', c_code, v_batch, 'PRODUCTION DATA WRITE TEST', 'cli', false)
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('accepted_batch', true,
      'needs_click_as_cli', (select needs_click from public.switchboard_actions where id = v_id),
      'problem_null_for_batch', public.switchboard_datawrite_payload_problem(v_batch, c_code) is null);
    begin
      update public.switchboard_actions set needs_click = false where id = v_id;
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('needs_click_update_refused', v_ok);

    -- ---- more accepted payloads ----
    v_s := 'SELECT Id, Amount, LastModifiedById FROM GiftTransaction WHERE Id IN (' || v_ids200 || ')';
    v_t := 'SELECT Id, Name FROM GiftTransaction WHERE Name != ''' || repeat('x', 95000) || '''';
    v_under := jsonb_set(jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate', 'soql', v_t,
                 'sha256', encode(sha256(convert_to(v_t, 'UTF8')), 'hex'), 'label', 'gate: gift commitments')),
               '{queries,2}', jsonb_build_object('step', 'after', 'soql', v_t,
                 'sha256', encode(sha256(convert_to(v_t, 'UTF8')), 'hex'), 'label', 'after: broad snapshot'));
    v_checks := v_checks || jsonb_build_object('under_cap_payload_is_long', length(v_under::text) between 190000 and 200000);
    for v_kv in select * from (values
      ('bulk_sandbox',       v_bulk),
      ('batch_with_exclude', v_batchx),
      ('undo',               v_undo),
      ('broad_200_ids',      jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate', 'soql', v_s,
                               'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot'))),
      ('undo_gate_200_ids',  jsonb_set(v_undo, '{queries,0}', jsonb_build_object('step', 'gate', 'soql', v_s,
                               'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot'))),
      ('two_long_exports_under_cap', v_under),
      ('gate_one_export_no_counts', jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad))),
      ('counts_40',          jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad) || (select jsonb_agg(jsonb_build_object(
                               'step', 'after-counts', 'soql', s, 'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Rule ' || g))
                               from (select g, 'SELECT COUNT() FROM Contact WHERE Name != ''n' || g || '''' as s from generate_series(1, 40) g) x))),
      ('waits_total_180',    jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad) || (select jsonb_agg(jsonb_build_object(
                               'step', 'after-counts', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'),
                               'label', 'Rule ' || g || ': wait', 'wait', jsonb_build_object('stable_minutes', 60, 'limit_minutes', 60)))
                               from generate_series(1, 3) g))),
      ('no_problem_no_uploads', v_batch - 'problem'),
      ('run_backslash',      jsonb_set(v_batch, '{run}', to_jsonb('data-ops\' || c_code || '\fixc-2026-11-19')))
    ) as t(key, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_datawrite', c_code, v_kv.value, 'PRODUCTION DATA WRITE TEST', 'claude');
        v_ok := true;
      exception when check_violation then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('accepted_' || v_kv.key, v_ok);
    end loop;

    -- ---- refusals ----
    v_t := 'SELECT Id, Name FROM GiftTransaction WHERE Name != ''' || repeat('x', 99800) || '''';
    v_big := jsonb_set(jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate', 'soql', v_t,
               'sha256', encode(sha256(convert_to(v_t, 'UTF8')), 'hex'), 'label', 'gate: gift commitments')),
             '{queries,2}', jsonb_build_object('step', 'after', 'soql', v_t,
               'sha256', encode(sha256(convert_to(v_t, 'UTF8')), 'hex'), 'label', 'after: broad snapshot'));
    v_checks := v_checks || jsonb_build_object('over_cap_payload_is_over', length(v_big::text) > 200000);
    v_s := 'SELECT Id, Amount, LastModifiedById FROM GiftTransaction WHERE Id IN (' || v_ids201 || ')';
    v_201 := jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate', 'soql', v_s,
               'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot'));
    for v_kv in select * from (values
      ('extra_key',          v_batch || '{"ids":["a0D000000000001AAA"]}'),
      ('write_extra_key',    jsonb_set(v_batch, '{write,ids}', '[]')),
      ('batch_with_start',   jsonb_set(v_batch, '{write,query}', to_jsonb(c_sel))),
      ('query_extra_key',    jsonb_set(v_batch, '{queries,0,rows}', '[]')),
      ('upload_extra_key',   jsonb_set(v_batchx, '{uploads,0,ids}', '[]')),
      ('org_type_prod',      jsonb_set(v_batch, '{org_type}', '"prod"')),
      ('org_type_missing',   v_batch - 'org_type'),
      ('selection_sha256_missing', v_batch - 'selection_sha256'),
      ('wrong_query_sha256', jsonb_set(v_batch, '{queries,1,sha256}', to_jsonb(repeat('0', 64)))),
      ('upper_request_sha256', jsonb_set(v_batch, '{request_sha256}', to_jsonb(upper(c_req)))),
      ('selection_sha256_other', jsonb_set(v_batch, '{selection_sha256}', to_jsonb(c_hex3))),
      ('order_counts_before_after', jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_gbroad, q_r1, q_abroad))),
      ('order_after_first',  jsonb_set(v_batch, '{queries}', jsonb_build_array(q_abroad, q_sel, q_r1))),
      ('duplicate_label',    jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_gbroad, q_abroad, q_r1, q_r1))),
      ('broad_201_ids',      v_201),
      ('after_count_one_id', jsonb_set(v_batch, '{queries,4}', (select jsonb_build_object('step', 'after-counts', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'One record')
                               from (select 'SELECT COUNT() FROM GiftTransaction WHERE Id = ''a0D000000000001AAA''' as s) x))),
      ('after_count_15_char_id', jsonb_set(v_batch, '{queries,4}', (select jsonb_build_object('step', 'after-counts', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'One record')
                               from (select 'SELECT COUNT() FROM GiftTransaction WHERE Id = ''a0D000000000001''' as s) x))),
      ('selection_with_id',  (select jsonb_set(jsonb_set(v_batch, '{queries,0}', jsonb_build_object('step', 'gate', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'file', 'selection.soql')),
                               '{selection_sha256}', to_jsonb(encode(sha256(convert_to(s, 'UTF8')), 'hex'))) #- '{queries,3}'
                               from (select 'SELECT Id FROM GiftTransaction WHERE Id = ''a0D000000000001AAA''' as s) x)),
      ('other_export_with_id', jsonb_set(v_bulk, '{queries,1}', (select jsonb_build_object('step', 'gate', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'gate: gift commitments')
                               from (select 'SELECT Id FROM GiftCommitment WHERE Id = ''a0E000000000001AAA''' as s) x))),
      ('over_200000',        v_big),
      ('undo_rows_mismatch', jsonb_set(v_undo, '{uploads,0,rows}', '44')),
      ('undo_sha_mismatch',  jsonb_set(v_undo, '{uploads,0,sha256}', to_jsonb(c_hex3))),
      ('undo_file_mismatch', jsonb_set(v_undo, '{uploads,0,file}', '"other.csv"')),
      ('undo_no_upload',     v_undo - 'uploads'),
      ('undo_ids_on_batch',  v_batch || jsonb_build_object('uploads', jsonb_build_array(jsonb_build_object('purpose', 'undo-ids',
                               'file', 'undo-ids.csv', 'sha256', c_hex2, 'rows', 45)))),
      ('exclude_not_fewer',  jsonb_set(v_batchx, '{uploads,0,rows}', '45')),
      ('two_exclude_uploads', jsonb_set(v_batchx, '{uploads}', (v_batchx->'uploads') || (v_batchx->'uploads'))),
      ('three_uploads',      jsonb_set(v_undo, '{uploads}', (v_undo->'uploads') || (v_batchx->'uploads') || (v_batchx->'uploads'))),
      ('bulk_with_uploads',  v_bulk || jsonb_build_object('uploads', v_batchx->'uploads')),
      ('bulk_with_empty_uploads', v_bulk || '{"uploads":[]}'),
      ('bulk_insert',        jsonb_set(v_bulk, '{write,operation}', '"insert"')),
      ('bulk_no_csv_sha',    v_bulk #- '{write,csv_sha256}'),
      ('write_kind_other',   jsonb_set(v_batch, '{write,kind}', '"delete"')),
      ('no_after_broad',     jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_gbroad, q_asel, q_r1))),
      ('after_unknown_label', jsonb_set(v_batch, '{queries,2,label}', '"after: other"')),
      ('after_selection_not_selection', jsonb_set(v_batch, '{queries,3}', jsonb_build_object('step', 'after', 'soql', c_broad,
                               'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'after: selection'))),
      ('gate_first_not_selection', jsonb_set(v_batch, '{queries}', jsonb_build_array(q_gbroad, q_abroad))),
      ('three_gate_exports', jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_gbroad, q_ggc, q_abroad))),
      ('undo_gate_selection', jsonb_set(v_undo, '{queries}', jsonb_build_array(q_sel, q_abroad))),
      ('undo_two_gates',     jsonb_set(v_undo, '{queries}', jsonb_build_array(q_gbroad, q_ggc, q_abroad))),
      ('undo_after_selection', jsonb_set(v_undo, '{queries}', jsonb_build_array(q_gbroad, q_abroad, q_asel))),
      ('wait_without_wait_label', jsonb_set(v_batch, '{queries,4,wait}', '{"stable_minutes":2,"limit_minutes":30}')),
      ('wait_out_of_range',  jsonb_set(v_batch, '{queries,5,wait,stable_minutes}', '0')),
      ('wait_extra_key',     jsonb_set(v_batch, '{queries,5,wait,every}', '1')),
      ('waits_over_180',     jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad) || (select jsonb_agg(jsonb_build_object(
                               'step', 'after-counts', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'),
                               'label', 'Rule ' || g || ': wait', 'wait', jsonb_build_object('stable_minutes', 2, 'limit_minutes', 50)))
                               from generate_series(1, 4) g))),
      ('counts_41',          jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad) || (select jsonb_agg(jsonb_build_object(
                               'step', 'after-counts', 'soql', s, 'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Rule ' || g))
                               from (select g, 'SELECT COUNT() FROM Contact WHERE Name != ''n' || g || '''' as s from generate_series(1, 41) g) x))),
      ('one_query',          jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel))),
      ('expected_zero',      jsonb_set(v_batch, '{expected}', '0')),
      ('expected_text',      jsonb_set(v_batch, '{expected}', '"45"')),
      ('expected_fraction',  jsonb_set(v_batch, '{expected}', '45.5')),
      ('problem_too_short',  jsonb_set(v_batch, '{problem}', '"Too short"')),
      ('gate_count_query',   jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate', 'soql', c_r1,
                               'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'), 'label', 'gate: a count'))),
      ('after_count_export', jsonb_set(v_batch, '{queries,4}', jsonb_build_object('step', 'after-counts', 'soql', c_gc,
                               'sha256', encode(sha256(convert_to(c_gc, 'UTF8')), 'hex'), 'label', 'An export'))),
      ('semicolon',          jsonb_set(v_batch, '{queries,4}', (select jsonb_build_object('step', 'after-counts', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Semi')
                               from (select 'SELECT COUNT() FROM Contact WHERE Name != null; DELETE' as s) x))),
      ('unknown_step',       jsonb_set(v_batch, '{queries,1,step}', '"before"')),
      ('file_and_label',     jsonb_set(v_batch, '{queries,0,label}', '"selection"')),
      ('run_other_code',     jsonb_set(v_batch, '{run}', '"data-ops/other-code/fixc-2026-11-19"')),
      ('run_tag_other_code', jsonb_set(v_batch, '{run_tag}', '"other-code-s9-ab12"'))
    ) as t(key, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_datawrite', c_code, v_kv.value, 'PRODUCTION DATA WRITE TEST', 'claude');
        v_ok := false;
      exception when check_violation then
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('refused_' || v_kv.key, v_ok);
    end loop;

    -- ---- the sentences say what to do ----
    v_checks := v_checks || jsonb_build_object(
      'message_201_ids', public.switchboard_datawrite_payload_problem(v_201, c_code)
        = 'the query ''gate: broad snapshot'' lists 201 Ids; the limit is 200. Select by criteria instead, or split the run.',
      'message_after_count_id', coalesce(public.switchboard_datawrite_payload_problem(jsonb_set(v_batch, '{queries,4}',
        (select jsonb_build_object('step', 'after-counts', 'soql', s, 'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'One record')
         from (select 'SELECT COUNT() FROM GiftTransaction WHERE Id = ''a0D000000000001AAA''' as s) x)), c_code)
        like 'the query ''One record'' lists 1 Id; only an export labelled "... broad snapshot" may list Ids%', false),
      'message_over_cap', coalesce(public.switchboard_datawrite_payload_problem(v_big, c_code) like '%the limit is 200,000.%', false),
      'message_extra_key', coalesce(public.switchboard_datawrite_payload_problem(v_batch || '{"ids":[]}', c_code)
        like 'the payload does not take ids.%', false),
      'message_bulk_uploads', public.switchboard_datawrite_payload_problem(v_bulk || jsonb_build_object('uploads', v_batchx->'uploads'), c_code)
        = 'a bulk write uploads nothing; remove uploads.',
      'message_undo_rows', coalesce(public.switchboard_datawrite_payload_problem(jsonb_set(v_undo, '{uploads,0,rows}', '44'), c_code)
        like 'the undo Id file has 44 rows but expected is 45%', false),
      'message_order', coalesce(public.switchboard_datawrite_payload_problem(
        jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_gbroad, q_r1, q_abroad)), c_code)
        like '%comes after a later step: list the gate first, then after, then after-counts.', false));

    -- ---- sf_dataop and sf_dataquery are unchanged ----
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'sf_dataop', 'dataop-verify-dop', c_dataop, 'PRODUCTION DATA RUN TEST', 'claude');
      v_ok := true;
    exception when check_violation then
      v_ok := false;
    end;
    v_checks := v_checks || jsonb_build_object('sf_dataop_payload_still_accepted', v_ok);
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'sf_dataop', 'dataop-verify-dop', c_dataop || jsonb_build_object('queries', v_batch->'queries'),
              'PRODUCTION DATA RUN TEST', 'claude');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('sf_dataop_still_refuses_queries', v_ok);
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'sf_dataquery', c_code, jsonb_build_object('alias', 'cd-prod', 'org_type', 'production',
              'repo', 'C:\Users\Alex\projects\common-defense', 'run', 'data-ops/' || c_code || '/fixc-2026-11-19',
              'run_tag', c_code || '-s4-ab12', 'queries', jsonb_build_array(jsonb_build_object('step', 'manifest', 'soql', c_sel,
              'sha256', v_selsha, 'file', 'selection.soql'))), 'PRODUCTION EXPORT TEST', 'claude');
      v_ok := true;
    exception when check_violation then
      v_ok := false;
    end;
    v_checks := v_checks || jsonb_build_object('sf_dataquery_payload_still_accepted', v_ok);
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
      values (c_alex, 'sf_dataquery', c_code, v_batch, 'PRODUCTION EXPORT TEST', 'claude');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('sf_dataquery_refuses_a_write_payload', v_ok);

    -- ---- queue_helper ----
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_q := public.switchboard_queue_helper('sf_datawrite', c_code, v_undo, 'PRODUCTION DATA WRITE TEST', null);
    v_checks := v_checks || jsonb_build_object('queue_helper_accepts', coalesce((select needs_click and created_by = 'claude'
      and kind = 'sf_datawrite' from public.switchboard_actions where id = (v_q->>'action_id')::uuid), false));
    begin
      perform public.switchboard_queue_helper('sf_datawrite', c_code, v_201, 'PRODUCTION DATA WRITE TEST', null);
      v_msg := null;
    exception when check_violation then
      v_msg := sqlerrm;
    end;
    v_checks := v_checks || jsonb_build_object('queue_helper_says_why',
      coalesce(v_msg like '%refused: the query ''gate: broad snapshot'' lists 201 Ids; the limit is 200. Select by criteria instead, or split the run.', false));
    begin
      perform public.switchboard_queue_helper('sf_datawrite', null, v_batch, 'PRODUCTION DATA WRITE TEST', null);
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('queue_without_code_refused', v_ok);

    -- ---- the run's result ----
    v_p := '{"ok":true,"exit_code":0,"pass":true,"datawrite":{"stage":"done","query_counts":[45,31200,31200,45,0,0],
             "gate":{"added":0,"dropped":0,"edited":0},"write":{"expected":45,"changed":42,"failed":2,"excluded":1},
             "check":{"problems":0,"extras":0,"new_records":3}}}';
    for v_kv in select * from (values
      ('good',               true,  v_p),
      ('ok_step5_failed',    true,  jsonb_set(jsonb_set(v_p, '{pass}', 'false'), '{datawrite,check,problems}', '2')),
      ('gate_stop',          true,  '{"ok":false,"datawrite":{"stage":"gate","query_counts":[45,31200],"gate":{"added":1,"dropped":0,"edited":2}}}'::jsonb),
      ('declined_enter',     true,  '{"ok":false,"datawrite":{"stage":"write","query_counts":[45,31200]}}'::jsonb),
      ('failed_bare',        true,  '{"ok":false,"datawrite":{"stage":"write"}}'::jsonb),
      ('dataquery_result',   true,  '{"ok":true,"query_counts":[1],"pass":true}'::jsonb),
      ('sf_dataop_result',   true,  '{"ok":true,"exit_code":0}'::jsonb),
      ('extra_top_key',      false, v_p || '{"output":"Id,Name\n003..."}'),
      ('top_query_counts',   false, v_p || '{"query_counts":[1]}'),
      ('extra_datawrite_key', false, jsonb_set(v_p, '{datawrite,rows}', '[{"Id":"003000000000001AAA"}]')),
      ('extra_write_key',    false, jsonb_set(v_p, '{datawrite,write,ids}', '["003000000000001AAA"]')),
      ('extra_check_key',    false, jsonb_set(v_p, '{datawrite,check,why}', '"Amount was 20.50"')),
      ('count_text',         false, jsonb_set(v_p, '{datawrite,write,changed}', '"42"')),
      ('count_negative',     false, jsonb_set(v_p, '{datawrite,gate,added}', '-1')),
      ('count_fraction',     false, jsonb_set(v_p, '{datawrite,check,extras}', '0.5')),
      ('count_over_max',     false, jsonb_set(v_p, '{datawrite,check,new_records}', '1000000000')),
      ('query_count_text',   false, jsonb_set(v_p, '{datawrite,query_counts,0}', '"45"')),
      ('query_counts_45',    false, jsonb_set(v_p, '{datawrite,query_counts}', (select jsonb_agg(g) from generate_series(1, 45) g))),
      ('stage_other',        false, jsonb_set(v_p, '{datawrite,stage}', '"finished"')),
      ('stage_missing',      false, v_p #- '{datawrite,stage}'),
      ('ok_not_done',        false, jsonb_set(v_p, '{datawrite,stage}', '"after"')),
      ('ok_without_pass',    false, v_p - 'pass'),
      ('ok_missing_check',   false, v_p #- '{datawrite,check}'),
      ('ok_missing_counts',  false, v_p #- '{datawrite,query_counts}'),
      ('pass_text',          false, jsonb_set(v_p, '{pass}', '"PASS"')),
      ('pass_sum_mismatch',  false, jsonb_set(v_p, '{datawrite,write,changed}', '41')),
      ('pass_with_problems', false, jsonb_set(v_p, '{datawrite,check,problems}', '1')),
      ('pass_not_ok',        false, '{"ok":false,"pass":true,"datawrite":{"stage":"write"}}'::jsonb),
      ('datawrite_text',     false, '{"ok":false,"datawrite":"stopped at the gate"}'::jsonb)
    ) as t(key, want, value) loop
      begin
        insert into public.switchboard_runs (user_id, action_id, mode, summary, result, finished_at)
        values (c_alex, v_id, 'real', 'verify', v_kv.value, now());
        v_ok := v_kv.want;
      exception when check_violation then
        v_ok := not v_kv.want;
      end;
      v_checks := v_checks || jsonb_build_object((case when v_kv.want then 'result_accepted_' else 'result_refused_' end) || v_kv.key, v_ok);
    end loop;

    -- ---- the pickup ----
    -- Each in its own project: v_new clicked now, v_unclick never clicked, v_old clicked 16 minutes ago.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_datawrite', 'dataop-verify-j5n', replace(v_batch::text, c_code, 'dataop-verify-j5n')::jsonb,
            'PRODUCTION DATA WRITE TEST', 'claude') returning id into v_new;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_datawrite', 'dataop-verify-j5u', replace(v_batch::text, c_code, 'dataop-verify-j5u')::jsonb,
            'PRODUCTION DATA WRITE TEST', 'claude') returning id into v_unclick;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_datawrite', 'dataop-verify-j5o', replace(v_batch::text, c_code, 'dataop-verify-j5o')::jsonb,
            'PRODUCTION DATA WRITE TEST', 'claude') returning id into v_old;
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now(), status = 'consumed'
     where id = v_new;
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now() - interval '16 minutes', status = 'consumed'
     where id = v_old;

    -- No kinds, the old four, the five of d4x and the six of k7d: never an sf_datawrite.
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop', 'sf_dataquery']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'six_kinds_and_older_never_get_sf_datawrite', not (v_seen && array[v_new, v_unclick, v_old]),
      'expired_after_15_minutes', coalesce((select status = 'failed' from public.switchboard_actions where id = v_old), false),
      'expired_run_says_why', exists (select 1 from public.switchboard_runs where action_id = v_old
        and summary like 'expired: approved over 15 minutes ago and never picked up%' and finished_at is not null));

    v_seen := '{}';
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex,
        array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop', 'sf_dataquery', 'sf_datawrite']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'clicked_sf_datawrite_picked_when_named', v_new = any(v_seen),
      'unclicked_sf_datawrite_never_picked', not (v_unclick = any(v_seen)),
      'expired_sf_datawrite_never_picked', not (v_old = any(v_seen)));

    begin
      perform public.switchboard_pickup_helper(c_alex, array['git', 'sf_write']);
      v_ok := false;
    exception when invalid_parameter_value then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('unknown_kind_refused', v_ok);

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
