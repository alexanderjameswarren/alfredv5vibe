-- dataop_write-j5w s10: verify the sf_datawrite Id rule (docs/technical-spec-dataop_write-j5w.md part 2, "Ids"):
-- each query that may list Ids (selection.soql, "after: selection", an after-count, an export labelled
-- "... broad snapshot") takes up to 200, with the exact sentence at 201; every other export takes none; Fix C's shape
-- (a 136-Id selection and four 136-Id rule counts) passes; an exclude upload with as many rows as expected, or more,
-- passes (s11c); and the main accepted payloads from 1_verify still pass.
-- Run after the _pending_ ids_rule migration, through the queue with --test. Throwaway rows; everything is undone.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/dataop_write-j5w/2_verify_ids_rule.sql

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
  c_where constant text := '; Ids go only in selection.soql, "after: selection", an after-count or an export labelled "... broad snapshot". Select by criteria instead.';
  c_over  constant text := ' lists 201 Ids; a Salesforce query takes at most 200. Select by criteria instead, or split the run.';
  v_selsha  text;
  q_sel     jsonb;
  q_gbroad  jsonb;
  q_ggc     jsonb;
  q_abroad  jsonb;
  q_asel    jsonb;
  q_r1      jsonb;
  q_wait    jsonb;
  v_base    jsonb;
  v_batch   jsonb;
  v_bulk    jsonb;
  v_batchx  jsonb;
  v_undo    jsonb;
  v_list    jsonb := '{}'::jsonb;   -- n -> the quoted Id list
  v_fixc    jsonb := '{}'::jsonb;   -- n -> Fix C's payload with n Ids
  v_cnt     jsonb := '{}'::jsonb;   -- n -> an after-count naming n Ids, labelled "One record"
  v_bg      jsonb := '{}'::jsonb;   -- n -> "gate: broad snapshot" naming n Ids
  v_ba      jsonb := '{}'::jsonb;   -- n -> "after: broad snapshot" naming n Ids
  v_s       text;
  v_n       integer;
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_ok      boolean;
  v_kv      record;
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
    v_bulk := v_base || jsonb_build_object('org_type', 'sandbox',
      'write', jsonb_build_object('kind', 'bulk', 'operation', 'update', 'csv', 'update.csv', 'csv_sha256', c_hex2),
      'queries', jsonb_build_array(q_sel, q_ggc, q_abroad, q_r1));
    v_batchx := v_batch || jsonb_build_object(
      'uploads', jsonb_build_array(jsonb_build_object('purpose', 'exclude', 'file', 'exclude.csv', 'sha256', c_hex3, 'rows', 3)));
    v_undo := v_base || jsonb_build_object(
      'write', jsonb_build_object('kind', 'undo', 'class', 'FixCUndoBatch', 'ids_file', 'undo-ids.csv', 'ids_sha256', c_hex2),
      'uploads', jsonb_build_array(jsonb_build_object('purpose', 'undo-ids', 'file', 'undo-ids.csv', 'sha256', c_hex2, 'rows', 45)),
      'queries', jsonb_build_array(q_gbroad, q_abroad));

    -- ---- the payloads with 136, 200 and 201 Ids ----
    foreach v_n in array array[136, 200, 201] loop
      select string_agg(quote_literal('a0D' || lpad(g::text, 12, '0') || 'AAA'), ',') into v_s from generate_series(1, v_n) g;
      v_list := v_list || jsonb_build_object(v_n::text, v_s);
    end loop;
    foreach v_n in array array[136, 200, 201] loop
      -- Fix C: selection.soql and "after: selection" name n Ids, and so do four rule counts.
      v_s := 'SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Id IN (' || (v_list->>v_n::text) || ')';
      v_fixc := v_fixc || jsonb_build_object(v_n::text, v_batch || jsonb_build_object(
        'selection_sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'),
        'queries', jsonb_build_array(
          jsonb_build_object('step', 'gate', 'soql', v_s, 'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'file', 'selection.soql'),
          q_gbroad, q_abroad,
          jsonb_build_object('step', 'after', 'soql', v_s, 'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'after: selection'))
          || (select jsonb_agg(jsonb_build_object('step', 'after-counts', 'soql', c, 'sha256', encode(sha256(convert_to(c, 'UTF8')), 'hex'),
                'label', 'Rule ' || g) order by g)
              from (select g, 'SELECT COUNT() FROM GiftTransaction WHERE GiftCommitmentId = null AND Id IN (' || (v_list->>v_n::text) || ')' as c
                    from generate_series(1, 4) g) x)));
      v_s := 'SELECT COUNT() FROM GiftTransaction WHERE GiftCommitmentId = null AND Id IN (' || (v_list->>v_n::text) || ')';
      v_cnt := v_cnt || jsonb_build_object(v_n::text, jsonb_set(v_batch, '{queries,4}', jsonb_build_object('step', 'after-counts',
        'soql', v_s, 'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'One record')));
      v_s := 'SELECT Id, Amount, LastModifiedById FROM GiftTransaction WHERE Id IN (' || (v_list->>v_n::text) || ')';
      v_bg := v_bg || jsonb_build_object(v_n::text, jsonb_set(v_batch, '{queries,1}', jsonb_build_object('step', 'gate',
        'soql', v_s, 'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'gate: broad snapshot')));
      v_ba := v_ba || jsonb_build_object(v_n::text, jsonb_set(v_batch, '{queries,2}', jsonb_build_object('step', 'after',
        'soql', v_s, 'sha256', encode(sha256(convert_to(v_s, 'UTF8')), 'hex'), 'label', 'after: broad snapshot')));
    end loop;

    v_checks := v_checks || jsonb_build_object(
      'problem_fn_grants',
        has_function_privilege('authenticated', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute')
        and has_function_privilege('service_role', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_datawrite_payload_problem(jsonb, text)', 'execute'),
      'fixc_136_lists_136_ids_in_six_queries', (select count(*) = 6 from jsonb_array_elements(v_fixc->'136'->'queries') e
        where e->>'soql' like '%a0D000000000136AAA%' and e->>'soql' not like '%a0D000000000137AAA%'));

    -- ---- accepted: by the rule, and by the table's check ----
    for v_kv in select * from (values
      ('fixc_136',              v_fixc->'136'),
      ('fixc_200',              v_fixc->'200'),
      ('after_count_136',       v_cnt->'136'),
      ('after_count_200',       v_cnt->'200'),
      ('gate_broad_200',        v_bg->'200'),
      ('after_broad_200',       v_ba->'200'),
      ('after_broad_136',       v_ba->'136'),
      -- 1_verify's main accepted payloads, unchanged by the new rule.
      ('batch',                 v_batch),
      ('bulk_sandbox',          v_bulk),
      ('batch_with_exclude',    v_batchx),
      ('undo',                  v_undo),
      ('undo_gate_200_ids',     jsonb_set(v_undo, '{queries,0}', (v_bg->'200'->'queries'->1))),
      ('gate_one_export_no_counts', jsonb_set(v_batch, '{queries}', jsonb_build_array(q_sel, q_abroad))),
      ('no_problem_no_uploads', v_batch - 'problem'),
      ('run_backslash',         jsonb_set(v_batch, '{run}', to_jsonb('data-ops\' || c_code || '\fixc-2026-11-19'))),
      -- s11c: the exclude-rows rule is dropped; exclude.csv also holds records added at the gate.
      ('exclude_rows_equal_expected', jsonb_set(v_batchx, '{uploads,0,rows}', '45')),
      ('exclude_rows_over_expected',  jsonb_set(v_batchx, '{uploads,0,rows}', '46'))
    ) as t(key, value) loop
      v_checks := v_checks || jsonb_build_object('rule_accepts_' || v_kv.key,
        public.switchboard_datawrite_payload_problem(v_kv.value, c_code) is null);
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_datawrite', c_code, v_kv.value, 'PRODUCTION DATA WRITE TEST', 'claude');
        v_ok := true;
      exception when check_violation then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('table_accepts_' || v_kv.key, v_ok);
    end loop;

    -- ---- refused, each with its exact sentence ----
    -- A 201-Id "after: selection" can't be refused on its own: it is selection.soql run again, so selection.soql (first in
    -- the gate) lists the same 201 and is refused first. fixc_201 checks that sentence.
    for v_kv in select * from (values
      ('fixc_201_at_selection', v_fixc->'201', '''selection.soql''' || c_over),
      ('after_count_201',       v_cnt->'201',  '''One record''' || c_over),
      ('gate_broad_201',        v_bg->'201',   '''gate: broad snapshot''' || c_over),
      ('after_broad_201',       v_ba->'201',   '''after: broad snapshot''' || c_over),
      ('gift_commitments_1_id', jsonb_set(v_bulk, '{queries,1}', (select jsonb_build_object('step', 'gate', 'soql', s,
                                  'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'gate: gift commitments')
                                  from (select 'SELECT Id FROM GiftCommitment WHERE Id = ''a0E000000000001AAA''' as s) x)),
                                '''gate: gift commitments'' lists 1 Id' || c_where),
      ('gift_commitments_136_ids', jsonb_set(v_bulk, '{queries,1}', (select jsonb_build_object('step', 'gate', 'soql', s,
                                  'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'gate: gift commitments')
                                  from (select 'SELECT Id FROM GiftCommitment WHERE Id IN (' || (v_list->>'136') || ')' as s) x)),
                                '''gate: gift commitments'' lists 136 Ids' || c_where)
    ) as t(key, value, want) loop
      v_checks := v_checks || jsonb_build_object('sentence_' || v_kv.key,
        coalesce(public.switchboard_datawrite_payload_problem(v_kv.value, c_code) = 'the query ' || v_kv.want, false));
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_datawrite', c_code, v_kv.value, 'PRODUCTION DATA WRITE TEST', 'claude');
        v_ok := false;
      exception when check_violation then
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('table_refuses_' || v_kv.key, v_ok);
    end loop;

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
