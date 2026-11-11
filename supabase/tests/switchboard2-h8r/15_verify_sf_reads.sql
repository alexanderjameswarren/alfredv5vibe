-- Switchboard 2.0 s89a: verify Salesforce reads by link (kind sf_read): the payload check, the click, queue and pickup,
-- switchboard_sf_results with its take and prune, switchboard_sf_read_log, and the kill switch. Run after the sf_reads
-- migration, through the queue with --test. Throwaway rows, undone. Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/15_verify_sf_reads.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  t_res  constant text := 'public.switchboard_sf_results';
  t_log  constant text := 'public.switchboard_sf_read_log';
  c_good constant jsonb := jsonb_build_array(
    '{"alias":"ti-dev1","production":false,"level":"objects"}',
    '{"alias":"ti-dev1","production":false,"level":"metadata","object":"Account"}',
    '{"alias":"ti-prod","production":true,"level":"ids","object":"Opportunity","count":true,
      "filters":[{"field":"CreatedDate","op":">=","value":"2026-11-01T00:00:00Z"}]}',
    '{"alias":"ti-prod","production":true,"level":"ids","object":"Contact","fields":["Id","CreatedDate","LastModifiedDate"],
      "limit":200,"filters":[{"field":"Id","op":"in","value":["003000000000001","003000000000002"]}]}',
    '{"alias":"ti-prod","production":true,"level":"data","object":"Donation__c","fields":["Id","Amount__c","Status__c"],
      "limit":50,"filters":[{"field":"Status__c","op":"=","value":"Failed"},{"field":"Amount__c","op":">","value":100},
      {"field":"Refunded__c","op":"!=","value":true},{"field":"Notes__c","op":"=","value":null}]}');
  c_bad constant jsonb := jsonb_build_object(
    'soql_text',             '{"alias":"ti-prod","production":true,"level":"data","object":"Account","fields":["Id"],"limit":5,"soql":"SELECT Id FROM Account"}',
    'query_key',             '{"alias":"ti-prod","production":true,"level":"objects","query":"SELECT Id FROM Account"}',
    'missing_production',    '{"alias":"ti-dev1","level":"objects"}',
    'production_not_bool',   '{"alias":"ti-dev1","production":"no","level":"objects"}',
    'missing_alias',         '{"production":false,"level":"objects"}',
    'bad_alias',             '{"alias":"-x","production":false,"level":"objects"}',
    'missing_level',         '{"alias":"ti-dev1","production":false}',
    'bad_level',             '{"alias":"ti-dev1","production":false,"level":"all"}',
    'objects_with_object',   '{"alias":"ti-dev1","production":false,"level":"objects","object":"Account"}',
    'metadata_no_object',    '{"alias":"ti-dev1","production":false,"level":"metadata"}',
    'metadata_with_fields',  '{"alias":"ti-dev1","production":false,"level":"metadata","object":"Account","fields":["Id"],"limit":5}',
    'ids_no_object',         '{"alias":"ti-dev1","production":false,"level":"ids","count":true}',
    'ids_other_field',       '{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","fields":["Id","Email"],"limit":5}',
    'ids_filter_other_field','{"alias":"ti-dev1","production":false,"level":"ids","object":"Contact","count":true,"filters":[{"field":"Email","op":"=","value":"x"}]}',
    'relationship_field',    '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Account.Name"],"limit":5}',
    'relationship_object',   '{"alias":"ti-dev1","production":false,"level":"metadata","object":"Account.Owner"}',
    'data_no_limit',         '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Id"]}',
    'data_no_fields',        '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","limit":5}',
    'limit_over_cap',        '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Id"],"limit":5000}',
    'limit_zero',            '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Id"],"limit":0}',
    'limit_fraction',        '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Id"],"limit":1.5}',
    'limit_text',            '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":["Id"],"limit":"5"}',
    'fields_empty',          '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":[],"limit":5}',
    'fields_not_array',      '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","fields":"Id","limit":5}',
    'count_with_fields',     '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"fields":["Id"],"limit":5}',
    'count_false',           '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":false}',
    'filter_bad_op',         '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"like","value":"A%"}]}',
    'filter_extra_key',      '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"=","value":"A","or":true}]}',
    'filter_no_value',       '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"="}]}',
    'filter_object_value',   '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"=","value":{"a":1}}]}',
    'filter_in_empty',       '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"in","value":[]}]}',
    'filter_in_nested',      '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"in","value":[{"a":1}]}]}',
    'filter_in_scalar',      '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Name","op":"in","value":"A"}]}',
    'filter_relationship',   '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[{"field":"Account.Name","op":"=","value":"A"}]}',
    'filters_empty',         '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":[]}',
    'filters_not_array',     '{"alias":"ti-dev1","production":false,"level":"data","object":"Contact","count":true,"filters":{"field":"Name"}}');
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_ids     uuid[] := '{}';
  v_id      uuid;
  v_out     jsonb;
  v_pick    jsonb;
  v_ready   integer;
  v_ok      boolean;
  v_wrong   text[] := '{}';
  v_count   integer;
  v_kv      record;
  i         integer;
begin
  begin
    -- 1. The two tables: registered, RLS, grants, comments, conformance.
    v_checks := v_checks
      || jsonb_build_object('results_exists', to_regclass(t_res) is not null)
      || jsonb_build_object('log_exists', to_regclass(t_log) is not null)
      || jsonb_build_object('results_registered', exists (select 1 from platform.registry where table_name = t_res))
      || jsonb_build_object('log_registered', exists (select 1 from platform.registry where table_name = t_log))
      || jsonb_build_object('results_not_audited', (select not audited from platform.registry where table_name = t_res))
      || jsonb_build_object('results_mcp_hidden', (select mcp_read = 'hidden' from platform.registry where table_name = t_res))
      || jsonb_build_object('results_rls_on', (select relrowsecurity from pg_class where oid = to_regclass(t_res)))
      || jsonb_build_object('log_rls_on', (select relrowsecurity from pg_class where oid = to_regclass(t_log)))
      || jsonb_build_object('results_anon_nothing', not has_table_privilege('anon', t_res, 'select')
           and not has_table_privilege('anon', t_res, 'insert') and not has_table_privilege('anon', t_res, 'delete'))
      || jsonb_build_object('log_anon_nothing', not has_table_privilege('anon', t_log, 'select')
           and not has_table_privilege('anon', t_log, 'insert'))
      || jsonb_build_object('results_authenticated_select_only', has_table_privilege('authenticated', t_res, 'select')
           and not has_table_privilege('authenticated', t_res, 'insert')
           and not has_table_privilege('authenticated', t_res, 'update')
           and not has_table_privilege('authenticated', t_res, 'delete'))
      || jsonb_build_object('results_service_role_insert', has_table_privilege('service_role', t_res, 'insert'))
      || jsonb_build_object('log_append_only', has_table_privilege('authenticated', t_log, 'select')
           and has_table_privilege('authenticated', t_log, 'insert')
           and not has_table_privilege('authenticated', t_log, 'update')
           and not has_table_privilege('authenticated', t_log, 'delete'))
      || jsonb_build_object('every_column_commented', not exists (
           select 1 from pg_attribute a
            where a.attrelid in (to_regclass(t_res), to_regclass(t_log)) and a.attnum > 0 and not a.attisdropped
              and col_description(a.attrelid, a.attnum) is null))
      || jsonb_build_object('log_has_no_rows_column', not exists (
           select 1 from pg_attribute where attrelid = to_regclass(t_log) and attname = 'rows' and not attisdropped))
      || jsonb_build_object('no_conformance_failures', not exists (
           select 1 from platform.conformance_failures where table_name::text in (t_res, t_log)));

    -- 2. The kill switch: present, not null, on by default.
    v_checks := v_checks
      || jsonb_build_object('kill_switch_default_true', exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'switchboard_settings' and column_name = 'sf_reads_enabled'
              and is_nullable = 'NO' and column_default = 'true'))
      || jsonb_build_object('kill_switch_on_for_alex', (select sf_reads_enabled from public.switchboard_settings where user_id = c_alex));

    -- 3. Good payloads are accepted and wait for a click. One project code each: one live action per project.
    for i in 0 .. jsonb_array_length(c_good) - 1 loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_read', 'sf-verify-good-' || i, (c_good->>i)::jsonb, 'SF READ TEST', 'claude')
        returning id into v_id;
        v_ids := v_ids || v_id;
      exception when check_violation then
        v_wrong := v_wrong || ('good_' || i);
      end;
    end loop;
    v_checks := v_checks
      || jsonb_build_object('good_payloads_accepted', cardinality(v_wrong) = 0)
      || jsonb_build_object('good_payloads_refused', to_jsonb(v_wrong))
      || jsonb_build_object('sf_read_needs_click', not exists (
           select 1 from public.switchboard_actions where id = any (v_ids) and not needs_click))
      || jsonb_build_object('needs_click_function_true', public.switchboard_needs_click('sf_read', '{}'::jsonb, 'claude'));

    -- 4. Bad payloads are refused: SOQL text, a missing field, anything outside its level.
    v_wrong := '{}';
    i := 0;
    for v_kv in select key, value from jsonb_each(c_bad) loop
      i := i + 1;
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_read', 'sf-verify-bad-' || i, (v_kv.value #>> '{}')::jsonb, 'SF READ TEST', 'claude');
        v_wrong := v_wrong || v_kv.key;
      exception when check_violation then
        null;
      end;
    end loop;
    v_checks := v_checks
      || jsonb_build_object('bad_payloads_refused', cardinality(v_wrong) = 0)
      || jsonb_build_object('bad_payloads_accepted', to_jsonb(v_wrong))
      || jsonb_build_object('bad_payload_count', i = 36);

    -- 5. switchboard_queue_helper takes sf_read and derives sf-<alias>.
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_out := public.switchboard_queue_helper('sf_read', null,
               '{"alias":"verify-sf-read-1","production":false,"level":"ids","object":"Account","count":true}', 'SF READ TEST');
    v_checks := v_checks
      || jsonb_build_object('queue_helper_derives_code', v_out->>'project_code' = 'sf-verify-sf-read-1')
      || jsonb_build_object('queue_helper_row_waits', exists (select 1 from public.switchboard_actions
           where id = (v_out->>'action_id')::uuid and kind = 'sf_read' and status = 'queued' and needs_click));
    begin
      perform public.switchboard_queue_helper('sf_read', null,
        '{"alias":"verify-sf-read-2","production":false,"level":"objects","soql":"SELECT Id FROM Account"}', 'TEST');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('queue_helper_refuses_soql', v_ok);

    -- 6. Pickup hands out a clicked sf_read. Only checked when no real action is ready, so the test never takes one.
    select count(*) into v_ready from public.switchboard_actions a
     where a.user_id = c_alex and a.kind in ('git', 'sf_check', 'sf_read', 'sb_setup') and a.picked_up_at is null
       and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click));
    if v_ready = 0 then
      update public.switchboard_actions set status = 'consumed' where id = (v_out->>'action_id')::uuid;
      v_pick := public.switchboard_pickup_helper(c_alex);
      v_checks := v_checks
        || jsonb_build_object('pickup_takes_a_clicked_sf_read', v_pick->>'action_id' = v_out->>'action_id'
             and v_pick->>'kind' = 'sf_read' and v_pick->'payload'->>'level' = 'ids');
    else
      v_checks := v_checks || jsonb_build_object('pickup_skipped_real_actions_ready', true);
    end if;

    -- 7. Take: once, then nothing. v_ids: 1 objects, 2 metadata, 3 ids count, 4 ids rows, 5 data.
    insert into public.switchboard_sf_results (user_id, action_id, rows, row_count, production_full_data)
    values (c_alex, v_ids[5], '[{"Id":"a0100000000TEST","Amount__c":120,"Status__c":"Failed"}]', 1, true);
    v_out := public.switchboard_take_sf_result(v_ids[5]);
    v_checks := v_checks
      || jsonb_build_object('take_returns_rows', v_out->'rows'->0->>'Status__c' = 'Failed' and (v_out->>'row_count')::int = 1)
      || jsonb_build_object('take_carries_stamp', (v_out->>'production_full_data')::boolean)
      || jsonb_build_object('take_deletes', not exists (select 1 from public.switchboard_sf_results where action_id = v_ids[5]))
      || jsonb_build_object('take_twice_nothing', public.switchboard_take_sf_result(v_ids[5]) is null);

    -- An expired row is never returned, and the take sweeps it.
    insert into public.switchboard_sf_results (user_id, action_id, rows, row_count, created_at, expires_at)
    values (c_alex, v_ids[4], '[{"Id":"0030000000TEST1"}]', 1, now() - interval '20 minutes', now() - interval '15 minutes');
    -- The take runs in its own statement: a check in the same statement reads that statement's snapshot, taken before
    -- the function's delete, and would still see the row (s89ab).
    v_out := public.switchboard_take_sf_result(v_ids[4]);
    v_checks := v_checks
      || jsonb_build_object('take_expired_nothing', v_out is null)
      || jsonb_build_object('take_swept_expired', not exists (select 1 from public.switchboard_sf_results where action_id = v_ids[4]));

    -- Another user's result is not taken.
    insert into public.switchboard_sf_results (user_id, action_id, rows, row_count)
    values (c_alex, v_ids[1], '[]', 0);
    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    v_out := public.switchboard_take_sf_result(v_ids[1]);
    v_checks := v_checks
      || jsonb_build_object('take_only_own', v_out is null
           and exists (select 1 from public.switchboard_sf_results where action_id = v_ids[1]));

    -- No signed-in user: refused.
    perform set_config('request.jwt.claims', '', true);
    begin
      perform public.switchboard_take_sf_result(v_ids[1]);
      v_ok := false;
    exception when others then
      v_ok := sqlstate = '28000';
    end;
    v_checks := v_checks || jsonb_build_object('take_no_user_refused', v_ok);

    -- 8. Prune: expired rows go, fresh ones stay.
    insert into public.switchboard_sf_results (user_id, action_id, rows, row_count, created_at, expires_at)
    values (c_alex, v_ids[3], '[]', 42, now() - interval '11 minutes', now() - interval '1 minute');
    v_count := public.switchboard_prune_sf_results();
    v_checks := v_checks
      || jsonb_build_object('prune_counts', v_count >= 1)
      || jsonb_build_object('prune_removed_expired', not exists (select 1 from public.switchboard_sf_results where action_id = v_ids[3]))
      || jsonb_build_object('prune_kept_fresh', exists (select 1 from public.switchboard_sf_results where action_id = v_ids[1]));

    -- 9. A result can't be kept past 10 minutes, and rows must be an array.
    begin
      insert into public.switchboard_sf_results (user_id, action_id, rows, row_count, expires_at)
      values (c_alex, v_ids[2], '[]', 0, now() + interval '1 hour');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('results_max_ten_minutes', v_ok);
    begin
      insert into public.switchboard_sf_results (user_id, action_id, rows, row_count) values (c_alex, v_ids[2], '{}', 0);
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('results_rows_array', v_ok);

    -- 10. The log takes what was asked, and refuses an unknown stage.
    insert into public.switchboard_sf_read_log (user_id, action_id, stage, org_alias, level, object, fields, filters, query_text, row_count)
    values (c_alex, v_ids[5], 'ran', 'ti-prod', 'data', 'Donation__c', '["Id","Amount__c"]',
            '[{"field":"Status__c","op":"=","value":"Failed"}]', 'SELECT Id, Amount__c FROM Donation__c WHERE Status__c = ''Failed'' LIMIT 50', 1);
    v_checks := v_checks || jsonb_build_object('log_insert_ok', exists (
      select 1 from public.switchboard_sf_read_log where action_id = v_ids[5] and stage = 'ran'));
    begin
      insert into public.switchboard_sf_read_log (user_id, stage, org_alias) values (c_alex, 'bogus', 'ti-prod');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('log_stage_checked', v_ok);

    -- 11. Function grants and the cron job.
    v_checks := v_checks
      || jsonb_build_object('take_authenticated_only', has_function_privilege('authenticated', 'public.switchboard_take_sf_result(uuid)', 'execute')
           and not has_function_privilege('anon', 'public.switchboard_take_sf_result(uuid)', 'execute'))
      || jsonb_build_object('prune_no_api_role', not has_function_privilege('anon', 'public.switchboard_prune_sf_results()', 'execute')
           and not has_function_privilege('authenticated', 'public.switchboard_prune_sf_results()', 'execute')
           and not has_function_privilege('service_role', 'public.switchboard_prune_sf_results()', 'execute'))
      || jsonb_build_object('pickup_service_role_only', has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid)', 'execute')
           and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid)', 'execute'))
      || jsonb_build_object('cron_every_minute', exists (
           select 1 from cron.job where jobname = 'switchboard-prune-sf-results' and schedule = '* * * * *'
             and command = 'select public.switchboard_prune_sf_results()'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb and jsonb_typeof(value) = 'boolean'),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks) where jsonb_typeof(value) = 'boolean'),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks)
                  where value <> 'true'::jsonb and jsonb_typeof(value) = 'boolean'),
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
