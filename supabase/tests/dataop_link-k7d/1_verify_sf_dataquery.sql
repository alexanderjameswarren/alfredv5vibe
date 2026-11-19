-- dataop_link-k7d s7: verify the sf_dataquery migration (docs/technical-spec-dataop_link-k7d.md parts 2 to 6): the kind,
-- its payload check and every limit, needs_click always true, the run-result check, the queue and pickup functions,
-- the grants, and that sf_dataop and an sql run's result are unchanged. Run after the migration, through the queue
-- with --test. Throwaway rows; everything is undone, including any real action a pickup call touches.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/dataop_link-k7d/1_verify_sf_dataquery.sql

do $$
declare
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_code  constant text := 'dataop-verify-k7d';
  c_req   constant text := '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  c_sel   constant text := E'SELECT Id, GiftCommitmentId FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND CreatedDate < 2026-11-18T00:00:00Z\n';
  c_broad constant text := 'SELECT Id, GiftCommitmentId, Amount FROM GiftTransaction WHERE Source__c = ''ActBlue''';
  c_r1    constant text := 'SELECT COUNT() FROM GiftTransaction WHERE Source__c = ''ActBlue'' AND GiftCommitmentId = null';
  c_r2    constant text := 'SELECT COUNT() FROM GiftCommitment WHERE Rollup_Pending__c = true';
  -- An sf_dataop payload as 240 takes it (dataops_alfred-d4x's test).
  c_dataop constant jsonb := '{"alias":"cd-prod","repo":"C:\\Users\\Alex\\projects\\common-defense","plan":"dataops/fixc-plan.json",
    "stamp":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","preflight_at":"2026-11-18T15:00:00.000Z",
    "object":"Demo_Gift__c","problem":"Forty-five gifts were saved without a link to their plan.","expected":45,
    "write":{"kind":"bulk"},"rows":[{"label":"Gifts in the list with no plan link","before":45,"goal":0}]}';
  v_base    jsonb;
  v_export  jsonb;
  v_count   jsonb;
  v_long    text;
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_ok      boolean;
  v_kv      record;
  v_id      uuid;
  v_new     uuid;
  v_unclick uuid;
  v_old     uuid;
  v_dop     uuid;
  v_q       jsonb;
  v_pick    jsonb;
  v_seen    uuid[] := '{}';
  i         integer;
begin
  begin
    v_base := jsonb_build_object('alias', 'cd-prod', 'repo', 'C:\Users\Alex\projects\common-defense',
      'run', 'data-ops/' || c_code || '/fixc-2026-11-19', 'run_tag', c_code || '-s4-ab12', 'request_sha256', c_req);
    v_export := v_base || jsonb_build_object('queries', jsonb_build_array(
      jsonb_build_object('step', 'manifest', 'soql', c_sel, 'sha256', encode(sha256(convert_to(c_sel, 'UTF8')), 'hex'), 'file', 'selection.soql'),
      jsonb_build_object('step', 'before', 'soql', c_broad, 'sha256', encode(sha256(convert_to(c_broad, 'UTF8')), 'hex'), 'label', 'broad snapshot')));
    v_count := v_base || jsonb_build_object('queries', jsonb_build_array(
      jsonb_build_object('step', 'rules', 'soql', c_r1, 'sha256', encode(sha256(convert_to(c_r1, 'UTF8')), 'hex'), 'label', 'Installments with no gift commitment'),
      jsonb_build_object('step', 'rules', 'soql', c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'), 'label', 'Commitments whose totals are still updating')));

    -- ---- schema and grants ----
    v_checks := v_checks || jsonb_build_object(
      'kind_check_has_sf_dataquery', coalesce((select pg_get_constraintdef(oid) like '%sf_dataquery%' from pg_constraint
        where conname = 'switchboard_actions_kind_valid' and conrelid = 'public.switchboard_actions'::regclass), false),
      'kind_check_keeps_sf_dataop', coalesce((select pg_get_constraintdef(oid) like '%''sf_dataop''%' from pg_constraint
        where conname = 'switchboard_actions_kind_valid' and conrelid = 'public.switchboard_actions'::regclass), false),
      'payload_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_dataquery_payload'
        and conrelid = 'public.switchboard_actions'::regclass),
      'click_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_actions_sf_dataquery_click'
        and conrelid = 'public.switchboard_actions'::regclass),
      'sf_dataop_checks_kept', (select count(*) = 2 from pg_constraint where conrelid = 'public.switchboard_actions'::regclass
        and conname in ('switchboard_actions_sf_dataop_payload', 'switchboard_actions_sf_dataop_click')),
      'runs_result_check_exists', exists (select 1 from pg_constraint where conname = 'switchboard_runs_dataquery_result'
        and conrelid = 'public.switchboard_runs'::regclass),
      'payload_ok_grants',
        has_function_privilege('authenticated', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute')
        and has_function_privilege('service_role', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_dataquery_payload_ok(jsonb, text)', 'execute'),
      'pickup_service_role_only',
        has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid, text[])', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[])', 'execute'),
      'queue_helper_no_anon',
        has_function_privilege('authenticated', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'),
      'needs_click_no_anon',
        not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'));

    -- ---- accepted payloads; needs_click true whoever queues it ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, needs_click)
    values (c_alex, 'sf_dataquery', c_code, v_export, 'PRODUCTION EXPORT TEST', 'cli', false)
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('export_payload_accepted', true,
      'needs_click_as_cli', (select needs_click from public.switchboard_actions where id = v_id));
    begin
      update public.switchboard_actions set needs_click = false where id = v_id;
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('needs_click_update_refused', v_ok);

    v_long := 'SELECT COUNT() FROM Contact WHERE Name != ''' || repeat('x', 8000 - 44) || '''';
    for v_kv in select * from (values
      ('count_payload',      v_count),
      ('count_at_8000',      v_base || jsonb_build_object('queries', jsonb_build_array(jsonb_build_object('step', 'rules',
                               'soql', v_long, 'sha256', encode(sha256(convert_to(v_long, 'UTF8')), 'hex'), 'label', 'Long rule')))),
      ('queries_40',         v_base || jsonb_build_object('queries', (select jsonb_agg(jsonb_build_object('step', 'preflight-counts', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Rule ' || g))
                               from (select g, 'SELECT COUNT() FROM Contact WHERE Name != ''n' || g || '''' as s from generate_series(1, 40) g) x))),
      ('file_only_no_request_hash', (v_base - 'request_sha256') || jsonb_build_object('queries', jsonb_build_array(v_export->'queries'->0))),
      ('run_backslash',      jsonb_set(v_export, '{run}', to_jsonb('data-ops\' || c_code || '\fixc-2026-11-19'))),
      -- The undo's fresh export of the written records, by the selection query (Alex, s4).
      ('undo_export',        v_base || jsonb_build_object('queries', jsonb_build_array(jsonb_build_object('step', 'undo', 'soql', c_sel,
                               'sha256', encode(sha256(convert_to(c_sel, 'UTF8')), 'hex'), 'file', 'selection.soql')))),
      ('leading_newline_export', v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'manifest', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'file', 'selection.soql'))
                               from (select E'\n\t  ' || c_sel as s) x))),
      ('leading_newline_count', v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Newline first'))
                               from (select E'\r\n' || c_r2 as s) x)))
    ) as t(key, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_dataquery', c_code, v_kv.value, 'PRODUCTION COUNTS TEST', 'claude');
        v_ok := true;
      exception when check_violation then
        v_ok := false;
      end;
      v_checks := v_checks || jsonb_build_object('accepted_' || v_kv.key, v_ok);
    end loop;
    v_checks := v_checks || jsonb_build_object('count_at_8000_is_8000', char_length(v_long) = 8000);

    -- ---- refusals ----
    v_long := v_long || 'x';
    for v_kv in select * from (values
      ('queries_41',         v_base || jsonb_build_object('queries', (select jsonb_agg(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Rule ' || g))
                               from (select g, 'SELECT COUNT() FROM Contact WHERE Name != ''n' || g || '''' as s from generate_series(1, 41) g) x))),
      ('no_queries',         jsonb_set(v_export, '{queries}', '[]')),
      ('mixed_export_count', jsonb_set(v_export, '{queries}', (v_export->'queries') || (v_count->'queries'->0))),
      ('mixed_count_steps',  jsonb_set(v_count, '{queries,1,step}', '"preflight-counts"')),
      ('wrong_sha256',       jsonb_set(v_count, '{queries,0,sha256}', to_jsonb(repeat('0', 64)))),
      ('upper_sha256',       jsonb_set(v_count, '{queries,0,sha256}', to_jsonb(upper(v_count->'queries'->0->>'sha256')))),
      ('semicolon',          v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Semi'))
                               from (select 'SELECT COUNT() FROM Contact WHERE Name != null; DELETE' as s) x))),
      ('group_by',           v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Grouped'))
                               from (select 'SELECT COUNT() FROM Contact WHERE Name != null GROUP BY Name' as s) x))),
      ('count_8001',         v_base || jsonb_build_object('queries', jsonb_build_array(jsonb_build_object('step', 'rules',
                               'soql', v_long, 'sha256', encode(sha256(convert_to(v_long, 'UTF8')), 'hex'), 'label', 'Long rule')))),
      ('count_not_count',    v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Not a count'))
                               from (select 'SELECT Id FROM Contact WHERE Name != null' as s) x))),
      ('count_id_field',     v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Count of Id'))
                               from (select 'SELECT COUNT(Id) FROM Contact WHERE Name != null' as s) x))),
      ('export_with_count',  v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'manifest', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'file', 'selection.soql'))
                               from (select 'SELECT Id, (SELECT COUNT() FROM Contacts) FROM Account WHERE Name != null' as s) x))),
      ('export_not_id_first', v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'manifest', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'file', 'selection.soql'))
                               from (select 'SELECT Name, Id FROM Contact WHERE Name != null' as s) x))),
      ('export_over_100000', v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'manifest', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'file', 'selection.soql'))
                               from (select 'SELECT Id FROM Contact WHERE Name != ''' || repeat('x', 100000) || '''' as s) x))),
      ('no_repo',            v_export - 'repo'),
      ('no_run',             v_export - 'run'),
      ('no_run_tag',         v_export - 'run_tag'),
      ('no_alias',           v_export - 'alias'),
      ('extra_key',          v_export || '{"ids":["a0D000000000001AAA"]}'),
      ('query_extra_key',    jsonb_set(v_count, '{queries,0,rows}', '[]')),
      ('run_other_code',     jsonb_set(v_export, '{run}', '"data-ops/other-code/fixc-2026-11-19"')),
      ('run_not_data_ops',   jsonb_set(v_export, '{run}', to_jsonb('dataops/' || c_code || '/fixc'))),
      ('run_dot_dot',        jsonb_set(v_export, '{run}', to_jsonb('data-ops/' || c_code || '/..'))),
      ('run_two_folders',    jsonb_set(v_export, '{run}', to_jsonb('data-ops/' || c_code || '/a/b'))),
      ('run_no_folder',      jsonb_set(v_export, '{run}', to_jsonb('data-ops/' || c_code))),
      ('run_tag_other_code', jsonb_set(v_export, '{run_tag}', '"other-code-s4-ab12"')),
      ('repo_relative',      jsonb_set(v_export, '{repo}', '"projects\\common-defense"')),
      ('label_without_request_hash', v_count - 'request_sha256'),
      ('file_and_label',     jsonb_set(v_export, '{queries,0,label}', '"selection"')),
      ('no_file_or_label',   v_export #- '{queries,0,file}'),
      ('file_with_folder',   jsonb_set(v_export, '{queries,0,file}', '"../selection.soql"')),
      ('duplicate_label',    jsonb_set(v_count, '{queries,1,label}', to_jsonb(v_count->'queries'->0->>'label'))),
      ('unknown_step',       jsonb_set(v_export, '{queries,1,step}', '"gate"')),
      ('undo_on_count_link', jsonb_set(v_count, '{queries,1,step}', '"undo"')),
      ('undo_with_count_soql', jsonb_set(jsonb_set(v_count, '{queries,0,step}', '"undo"'), '{queries,1,step}', '"undo"')),
      ('leading_newline_wrong_sha256', v_base || jsonb_build_object('queries', jsonb_build_array(jsonb_build_object('step', 'rules',
                               'soql', E'\n' || c_r2, 'sha256', encode(sha256(convert_to(c_r2, 'UTF8')), 'hex'), 'label', 'Hash without the newline')))),
      ('leading_text_before_select', v_base || jsonb_build_object('queries', (select jsonb_build_array(jsonb_build_object('step', 'rules', 'soql', s,
                               'sha256', encode(sha256(convert_to(s, 'UTF8')), 'hex'), 'label', 'Comment first'))
                               from (select E'-- note\n' || c_r2 as s) x))),
      ('soql_not_text',      jsonb_set(v_count, '{queries,0,soql}', '42'))
    ) as t(key, value) loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_dataquery', c_code, v_kv.value, 'PRODUCTION COUNTS TEST', 'claude');
        v_ok := false;
      exception when check_violation then
        v_ok := true;
      end;
      v_checks := v_checks || jsonb_build_object('refused_' || v_kv.key, v_ok);
    end loop;

    -- ---- sf_dataop is unchanged ----
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
      values (c_alex, 'sf_dataop', 'dataop-verify-dop', c_dataop || jsonb_build_object('queries', v_count->'queries'),
              'PRODUCTION DATA RUN TEST', 'claude');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('sf_dataop_still_refuses_soql', v_ok);

    -- ---- queue_helper ----
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_q := public.switchboard_queue_helper('sf_dataquery', c_code, v_count, 'PRODUCTION COUNTS TEST', null);
    v_checks := v_checks || jsonb_build_object('queue_helper_accepts', coalesce((select needs_click and created_by = 'claude'
      and kind = 'sf_dataquery' from public.switchboard_actions where id = (v_q->>'action_id')::uuid), false));
    begin
      perform public.switchboard_queue_helper('sf_dataquery', null, v_count, 'PRODUCTION COUNTS TEST', null);
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('queue_without_code_refused', v_ok);

    -- ---- the run's result ----
    for v_kv in select * from (values
      ('good',            true,  '{"ok":true,"exit_code":0,"query_counts":[26440,31200],"pass":true}'::jsonb),
      ('failed_no_pass',  true,  '{"ok":false,"query_counts":[3]}'::jsonb),
      ('sql_run_counts',  true,  '{"ok":true,"statements":[],"counts":[{"rows":3,"expected":3}],"mismatch":false}'::jsonb),
      ('helper_output',   true,  '{"ok":true,"exit_code":0,"output":"done"}'::jsonb),
      ('with_output',     false, '{"ok":true,"query_counts":[1],"pass":true,"output":"Id,Name\n003..."}'::jsonb),
      ('with_rows',       false, '{"ok":true,"query_counts":[1],"pass":true,"rows":[{"Id":"003000000000001AAA"}]}'::jsonb),
      ('count_text',      false, '{"ok":true,"query_counts":["1"],"pass":true}'::jsonb),
      ('count_negative',  false, '{"ok":true,"query_counts":[-1],"pass":true}'::jsonb),
      ('count_fraction',  false, '{"ok":true,"query_counts":[1.5],"pass":true}'::jsonb),
      ('count_object',    false, '{"ok":true,"query_counts":[{"Name":"x","n":1}],"pass":true}'::jsonb),
      ('ok_without_pass', false, '{"ok":true,"query_counts":[1]}'::jsonb),
      ('pass_text',       false, '{"ok":true,"query_counts":[1],"pass":"PASS"}'::jsonb),
      ('counts_empty',    false, '{"ok":true,"query_counts":[],"pass":true}'::jsonb),
      ('counts_41',       false, jsonb_build_object('ok', true, 'pass', true, 'query_counts', (select jsonb_agg(g) from generate_series(1, 41) g)))
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
    -- Each in its own project: v_new clicked now, v_unclick never clicked, v_old clicked 16 minutes ago, v_dop an
    -- sf_dataop clicked now.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataquery', 'dataop-verify-new', replace(v_export::text, c_code, 'dataop-verify-new')::jsonb,
            'PRODUCTION EXPORT TEST', 'claude') returning id into v_new;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataquery', 'dataop-verify-unc', replace(v_export::text, c_code, 'dataop-verify-unc')::jsonb,
            'PRODUCTION EXPORT TEST', 'claude') returning id into v_unclick;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataquery', 'dataop-verify-old', replace(v_export::text, c_code, 'dataop-verify-old')::jsonb,
            'PRODUCTION EXPORT TEST', 'claude') returning id into v_old;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_dataop', 'dataop-verify-dop2', c_dataop, 'PRODUCTION DATA RUN TEST', 'claude') returning id into v_dop;
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now(), status = 'consumed'
     where id in (v_new, v_dop);
    update public.switchboard_actions
       set link_hash = md5(random()::text) || md5(random()::text), link_expires_at = now() + interval '30 minutes',
           link_used_at = now() - interval '16 minutes', status = 'consumed'
     where id = v_old;

    -- No kinds, the old four, and the five of dataops_alfred-d4x: never an sf_dataquery. The five still get sf_dataop.
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
    v_checks := v_checks || jsonb_build_object('no_kinds_and_old_four_never_get_either', not (v_seen && array[v_new, v_unclick, v_old, v_dop]));
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'five_kinds_still_get_sf_dataop', v_dop = any(v_seen),
      'five_kinds_never_get_sf_dataquery', not (v_seen && array[v_new, v_unclick, v_old]),
      'expired_after_15_minutes', coalesce((select status = 'failed' from public.switchboard_actions where id = v_old), false),
      'expired_run_says_why', exists (select 1 from public.switchboard_runs where action_id = v_old
        and summary like 'expired: approved over 15 minutes ago and never picked up%' and finished_at is not null));

    v_seen := '{}';
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop', 'sf_dataquery']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'clicked_sf_dataquery_picked_when_named', v_new = any(v_seen),
      'unclicked_sf_dataquery_never_picked', not (v_unclick = any(v_seen)),
      'expired_sf_dataquery_never_picked', not (v_old = any(v_seen)));

    begin
      perform public.switchboard_pickup_helper(c_alex, array['git', 'sf_export']);
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
