-- Switchboard 2.0 s86b: verify the helper kinds (sf_check, sb_setup), their payload checks, the click rules,
-- switchboard_queue_helper, switchboard_queue_git through it, and switchboard_pickup_helper.
-- Run after the helper-kinds migration, through the queue with --test. Throwaway rows, undone.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/8_verify_helper_kinds.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_code constant text := 'verify-helper-kinds';
  c_org  constant jsonb := '{"alias":"ti-dev1","type":"developer","level":"metadata","login":"integration","cli_deploy":true,"shared":false}';
  v_checks jsonb := '{}'::jsonb;
  v_out jsonb;
  v_row public.switchboard_actions;
  v_ok boolean;
  v_result jsonb;
  v_bad record;
  v_ready int;
  v_pick jsonb;
  v_old uuid;
  v_old_git uuid;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- sf_check: queued with no click.
    v_out := public.switchboard_queue_helper('sf_check', c_code, '{"check":"limits","alias":"ti-dev1"}', 'SF CHECK TEST');
    select * into v_row from public.switchboard_actions where id = (v_out->>'action_id')::uuid;
    v_checks := v_checks
      || jsonb_build_object('sf_check_queued', v_row.kind = 'sf_check' and v_row.status = 'queued')
      || jsonb_build_object('sf_check_no_click', not v_row.needs_click)
      || jsonb_build_object('sf_check_created_by_claude', v_row.created_by = 'claude' and v_row.user_id = c_alex);
    v_out := public.switchboard_queue_helper('sf_check', c_code, '{"check":"metadata","alias":"ti-dev1","metadata_type":"ApexClass"}', 'SF CHECK TEST');
    v_checks := v_checks || jsonb_build_object('sf_check_metadata_with_type_queued', v_out ? 'action_id');

    begin
      perform public.switchboard_issue_link((v_out->>'action_id')::uuid); v_ok := false;
    exception when object_not_in_prerequisite_state then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('sf_check_gets_no_link', v_ok);

    for v_bad in select * from (values
      ('sf_unknown_check_refused', '{"check":"data","alias":"ti-dev1"}'),
      ('sf_missing_alias_refused', '{"check":"limits"}'),
      ('sf_bad_alias_refused', '{"check":"limits","alias":"-o prod"}'),
      ('sf_metadata_without_type_refused', '{"check":"metadata","alias":"ti-dev1"}'),
      ('sf_bad_metadata_type_refused', '{"check":"metadata","alias":"ti-dev1","metadata_type":"Apex Class"}'),
      ('sf_type_on_other_check_refused', '{"check":"limits","alias":"ti-dev1","metadata_type":"ApexClass"}'),
      ('sf_extra_key_refused', '{"check":"limits","alias":"ti-dev1","target_org":"prod"}'),
      -- The NULL paths (a CHECK passes on NULL): missing keys, JSON nulls, and non-strings.
      ('sf_missing_check_refused', '{"alias":"ti-dev1"}'),
      ('sf_alias_json_null_refused', '{"check":"limits","alias":null}'),
      ('sf_alias_number_refused', '{"check":"limits","alias":5}'),
      ('sf_metadata_type_json_null_refused', '{"check":"metadata","alias":"ti-dev1","metadata_type":null}'),
      ('sf_metadata_type_number_refused', '{"check":"metadata","alias":"ti-dev1","metadata_type":5}'),
      ('sf_empty_payload_refused', '{}')
    ) as t(name, payload) loop
      begin
        perform public.switchboard_queue_helper('sf_check', c_code, v_bad.payload::jsonb, 'TEST'); v_ok := false;
      exception when check_violation then v_ok := true; end;
      v_checks := v_checks || jsonb_build_object(v_bad.name, v_ok);
    end loop;

    -- sb_setup: queued, always a click.
    v_out := public.switchboard_queue_helper('sb_setup', c_code,
      jsonb_build_object('command', 'org add', 'client', 'team-impact', 'orgs', jsonb_build_array(c_org)), 'SB SETUP TEST');
    select * into v_row from public.switchboard_actions where id = (v_out->>'action_id')::uuid;
    v_checks := v_checks
      || jsonb_build_object('sb_setup_queued', v_row.kind = 'sb_setup' and v_row.status = 'queued')
      || jsonb_build_object('sb_setup_needs_click', v_row.needs_click);
    v_out := public.switchboard_queue_helper('sb_setup', c_code, jsonb_build_object('command', 'client start', 'client', 'fuse',
      'from_sandbox', 'fuse-dev', 'name', 'Fuse', 'sandboxes', 'all', 'integration_ok', true,
      'orgs', jsonb_build_array(c_org, c_org || '{"alias":"fuse-dev","type":"partial","level":"objects"}')), 'SB SETUP TEST');
    v_checks := v_checks || jsonb_build_object('sb_client_start_two_orgs_queued', v_out ? 'action_id');

    for v_bad in select * from (values
      ('sb_production_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"type":"production"}'))),
      ('sb_level_ids_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"level":"ids"}'))),
      ('sb_level_data_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"level":"data"}'))),
      ('sb_missing_level_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org - 'level'))),
      ('sb_level_not_string_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"level":5}'))),
      ('sb_contract_in_org_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"contract_ok":true}'))),
      ('sb_contract_top_level_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'contract_ok', true, 'orgs', jsonb_build_array(c_org))),
      ('sb_one_bad_org_of_two_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org, c_org || '{"level":"data"}'))),
      ('sb_client_end_refused', jsonb_build_object('command', 'client end', 'client', 'ti', 'orgs', jsonb_build_array(c_org))),
      ('sb_org_set_refused', jsonb_build_object('command', 'org set', 'client', 'ti', 'orgs', jsonb_build_array(c_org))),
      ('sb_no_orgs_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', '[]'::jsonb)),
      ('sb_orgs_not_list_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', c_org)),
      ('sb_bad_client_refused', jsonb_build_object('command', 'org add', 'client', 'Team IMPACT', 'orgs', jsonb_build_array(c_org))),
      ('sb_bad_alias_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"alias":"--target-org"}'))),
      -- The NULL paths.
      ('sb_missing_command_refused', jsonb_build_object('client', 'ti', 'orgs', jsonb_build_array(c_org))),
      ('sb_missing_client_refused', jsonb_build_object('command', 'org add', 'orgs', jsonb_build_array(c_org))),
      ('sb_missing_orgs_refused', jsonb_build_object('command', 'org add', 'client', 'ti')),
      ('sb_orgs_json_null_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', 'null'::jsonb)),
      ('sb_org_missing_alias_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org - 'alias'))),
      ('sb_org_missing_type_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org - 'type'))),
      ('sb_org_level_json_null_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', jsonb_build_array(c_org || '{"level":null}'))),
      ('sb_org_not_object_refused', jsonb_build_object('command', 'org add', 'client', 'ti', 'orgs', '["ti-dev1"]'::jsonb)),
      ('sb_client_json_null_refused', jsonb_build_object('command', 'org add', 'client', 'null'::jsonb, 'orgs', jsonb_build_array(c_org)))
    ) as t(name, payload) loop
      begin
        perform public.switchboard_queue_helper('sb_setup', c_code, v_bad.payload, 'TEST'); v_ok := false;
      exception when check_violation then v_ok := true; end;
      v_checks := v_checks || jsonb_build_object(v_bad.name, v_ok);
    end loop;

    -- The queue itself.
    begin
      perform public.switchboard_queue_helper('sql', c_code, '{"sql":"select 1"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('queue_helper_refuses_sql', v_ok);

    -- git still works as before, through switchboard_queue_git.
    v_out := public.switchboard_queue_git(c_code, '{"command":"gitsync"}', 'GITSYNC TEST');
    select * into v_row from public.switchboard_actions where id = (v_out->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('queue_git_still_queues_git_with_click', v_row.kind = 'git' and v_row.needs_click);
    begin
      perform public.switchboard_queue_git(c_code, '{"command":"gitpush"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('git_payload_check_still_applies', v_ok);

    perform set_config('request.jwt.claims', '', true);
    begin
      perform public.switchboard_queue_helper('sf_check', c_code, '{"check":"limits","alias":"ti-dev1"}', 'TEST'); v_ok := false;
    exception when invalid_authorization_specification then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('queue_helper_no_user_refused', v_ok);

    -- Pickup. Only checked when no real action is ready, so the test never takes one of Alex's real actions.
    select count(*) into v_ready from public.switchboard_actions a
     where a.user_id = c_alex and a.kind in ('git', 'sf_check', 'sb_setup') and a.picked_up_at is null
       and a.project_code <> c_code and (a.status = 'consumed' or (a.status = 'queued' and not a.needs_click));
    if v_ready = 0 then
      -- Back-dated throwaway rows: a no-click check queued 11 minutes ago, and a clicked git action as old.
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
      values (c_alex, 'sf_check', c_code, '{"check":"org-verify","alias":"ti-dev1"}', 'OLD CHECK TEST', 'claude', now() - interval '11 minutes')
      returning id into v_old;
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
      values (c_alex, 'git', c_code, '{"command":"gitsync"}', 'OLD GIT TEST', 'claude', now() - interval '11 minutes')
      returning id into v_old_git;

      v_pick := public.switchboard_pickup_helper(c_alex);
      v_checks := v_checks
        || jsonb_build_object('expired_check_marked_failed', (select status = 'failed' and picked_up_at is null
             from public.switchboard_actions where id = v_old))
        || jsonb_build_object('expired_check_has_a_run_saying_so', exists (select 1 from public.switchboard_runs
             where action_id = v_old and summary like 'expired before the helper picked it up%' and finished_at is not null
               and result->>'ok' = 'false'))
        || jsonb_build_object('expired_check_not_picked', v_pick->>'action_id' is distinct from v_old::text)
        || jsonb_build_object('old_clicked_action_not_expired', (select status = 'queued'
             from public.switchboard_actions where id = v_old_git))
        -- Both fresh checks share one created_at (one transaction), so either may come first; the clicked kinds never do.
        || jsonb_build_object('pickup_takes_a_no_click_check', v_pick->>'kind' = 'sf_check' and v_pick ? 'payload')
        || jsonb_build_object('pickup_opens_a_real_run', exists (select 1 from public.switchboard_runs
             where id = (v_pick->>'run_id')::uuid and mode = 'real'))
        || jsonb_build_object('pickup_one_running_per_project', public.switchboard_pickup_helper(c_alex) is null);
    else
      v_checks := v_checks || jsonb_build_object('pickup_skipped_real_actions_ready', true);
    end if;

    v_checks := v_checks
      || jsonb_build_object('queue_helper_anon_cannot', not has_function_privilege('anon', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('queue_helper_authenticated_can', has_function_privilege('authenticated', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('queue_helper_security_definer', (select prosecdef from pg_proc where oid = 'public.switchboard_queue_helper(text, text, jsonb, text, text)'::regprocedure))
      || jsonb_build_object('queue_git_anon_cannot', not has_function_privilege('anon', 'public.switchboard_queue_git(text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('pickup_helper_authenticated_cannot', not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid)', 'execute'))
      || jsonb_build_object('pickup_helper_anon_cannot', not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid)', 'execute'))
      || jsonb_build_object('pickup_helper_service_role_can', has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid)', 'execute'))
      || jsonb_build_object('pickup_git_still_there', to_regprocedure('public.switchboard_pickup_git(uuid)') is not null)
      || jsonb_build_object('authenticated_still_cannot_insert', not has_table_privilege('authenticated', 'public.switchboard_actions', 'insert'));

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
