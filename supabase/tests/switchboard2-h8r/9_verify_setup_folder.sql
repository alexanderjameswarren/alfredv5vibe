-- Switchboard 2.0 s86h: verify setup without a project code (sf-<alias>, sb-<client>) and the sb_setup folder check.
-- Run after the setup-folder migration, through the queue with --test. Throwaway rows, undone.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/9_verify_setup_folder.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_org  constant jsonb := '{"alias":"ti-dev1","type":"developer","level":"metadata"}';
  v_start jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_out jsonb;
  v_ok boolean;
  v_result jsonb;
  v_bad record;
  v_a uuid;
  v_b uuid;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    v_start := jsonb_build_object('command', 'client start', 'client', 'verify-acme', 'from_sandbox', 'acme-dev',
                                  'orgs', jsonb_build_array(c_org));

    -- Derived codes.
    v_out := public.switchboard_queue_helper('sf_check', null, '{"check":"limits","alias":"ti-dev1"}', 'TEST');
    v_checks := v_checks || jsonb_build_object('sf_null_code_is_sf_alias',
      (select project_code from public.switchboard_actions where id = (v_out->>'action_id')::uuid) = 'sf-ti-dev1'
      and v_out->>'project_code' = 'sf-ti-dev1');
    v_out := public.switchboard_queue_helper('sf_check', '  ', '{"check":"limits","alias":"TI.Dev1"}', 'TEST');
    v_checks := v_checks || jsonb_build_object('sf_blank_code_folds_alias', v_out->>'project_code' = 'sf-ti_dev1');
    v_out := public.switchboard_queue_helper('sf_check', null, jsonb_build_object('check', 'limits', 'alias', 'A' || repeat('b', 79)), 'TEST');
    v_checks := v_checks || jsonb_build_object('sf_long_alias_cut_to_40', length(v_out->>'project_code') = 40);
    v_out := public.switchboard_queue_helper('sf_check', 'verify-given', '{"check":"limits","alias":"ti-dev1"}', 'TEST');
    v_checks := v_checks || jsonb_build_object('sf_given_code_kept', v_out->>'project_code' = 'verify-given');
    v_out := public.switchboard_queue_helper('sb_setup', null,
      jsonb_build_object('command', 'org add', 'client', 'verify-acme', 'orgs', jsonb_build_array(c_org)), 'TEST');
    v_checks := v_checks || jsonb_build_object('sb_null_code_is_sb_client', v_out->>'project_code' = 'sb-verify-acme');

    for v_bad in select * from (values
      ('git_null_code_refused', 'git', '{"command":"gitsync"}'),
      ('sf_null_code_no_alias_refused', 'sf_check', '{"check":"limits"}'),
      ('sf_null_code_number_alias_refused', 'sf_check', '{"check":"limits","alias":5}'),
      ('sb_null_code_no_client_refused', 'sb_setup', '{"command":"org add","orgs":[]}'),
      ('sb_null_code_number_client_refused', 'sb_setup', '{"command":"org add","client":5}')
    ) as t(name, kind, payload) loop
      begin
        perform public.switchboard_queue_helper(v_bad.kind, null, v_bad.payload::jsonb, 'TEST'); v_ok := false;
      exception when check_violation then v_ok := true; end;
      v_checks := v_checks || jsonb_build_object(v_bad.name, v_ok);
    end loop;

    -- One live link per client.
    v_a := (public.switchboard_queue_helper('sb_setup', null, v_start || jsonb_build_object('folder', 'C:\Users\Alex\projects\verify-acme'), 'TEST')->>'action_id')::uuid;
    v_b := (public.switchboard_queue_helper('sb_setup', null, v_start || jsonb_build_object('folder', 'C:\Users\Alex\projects\verify-acme2'), 'TEST')->>'action_id')::uuid;
    perform public.switchboard_issue_link(v_a);
    begin
      perform public.switchboard_issue_link(v_b); v_ok := false;
    exception when object_not_in_prerequisite_state then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('sb_one_live_link_per_client', v_ok);
    v_b := (public.switchboard_queue_helper('sb_setup', null, jsonb_build_object('command', 'org add', 'client', 'verify-other',
             'orgs', jsonb_build_array(c_org)), 'TEST')->>'action_id')::uuid;
    perform public.switchboard_issue_link(v_b);
    v_checks := v_checks || jsonb_build_object('sb_other_client_gets_link',
      (select status from public.switchboard_actions where id = v_b) = 'link_issued');

    -- Folders accepted.
    for v_bad in select * from (values
      ('folder_nested_ok', 'C:\Users\Alex\projects\actblue\verify-acme'),
      ('folder_lower_case_ok', 'c:\users\alex\projects\verify-acme')
    ) as t(name, folder) loop
      v_out := public.switchboard_queue_helper('sb_setup', null, v_start || jsonb_build_object('folder', v_bad.folder), 'TEST');
      v_checks := v_checks || jsonb_build_object(v_bad.name, v_out ? 'action_id');
    end loop;

    -- Folders and folder placements refused.
    for v_bad in select * from (values
      ('from_sandbox_without_folder_refused', v_start),
      ('folder_is_projects_itself_refused', v_start || '{"folder":"C:\\Users\\Alex\\projects"}'),
      ('folder_trailing_backslash_refused', v_start || '{"folder":"C:\\Users\\Alex\\projects\\"}'),
      ('folder_dotdot_refused', v_start || '{"folder":"C:\\Users\\Alex\\projects\\a\\..\\b"}'),
      ('folder_dotdot_segment_refused', v_start || '{"folder":"C:\\Users\\Alex\\projects\\.."}'),
      ('folder_outside_refused', v_start || '{"folder":"C:\\Users\\Alex\\Documents\\acme"}'),
      ('folder_other_drive_refused', v_start || '{"folder":"D:\\Users\\Alex\\projects\\acme"}'),
      ('folder_forward_slashes_refused', v_start || '{"folder":"C:/Users/Alex/projects/acme"}'),
      ('folder_bad_char_refused', v_start || '{"folder":"C:\\Users\\Alex\\projects\\a:b"}'),
      ('folder_prefix_trick_refused', v_start || '{"folder":"C:\\Users\\Alex\\projectsx\\acme"}'),
      ('folder_too_long_refused', v_start || jsonb_build_object('folder', 'C:\Users\Alex\projects\' || repeat('a', 230))),
      ('folder_json_null_refused', v_start || '{"folder":null}'),
      ('folder_number_refused', v_start || '{"folder":5}'),
      ('folder_with_repo_refused', (v_start - 'from_sandbox') || '{"repo":"https://example.com/a.git","folder":"C:\\Users\\Alex\\projects\\acme"}'),
      ('folder_with_adopt_refused', (v_start - 'from_sandbox') || '{"adopt":"C:\\Users\\Alex\\projects\\acme","folder":"C:\\Users\\Alex\\projects\\acme"}'),
      ('folder_with_org_add_refused', jsonb_build_object('command', 'org add', 'client', 'verify-acme', 'orgs', jsonb_build_array(c_org),
                                                        'folder', 'C:\Users\Alex\projects\acme'))
    ) as t(name, payload) loop
      begin
        perform public.switchboard_queue_helper('sb_setup', null, v_bad.payload, 'TEST'); v_ok := false;
      exception when check_violation then v_ok := true; end;
      v_checks := v_checks || jsonb_build_object(v_bad.name, v_ok);
    end loop;

    -- 218's rules still hold.
    begin
      perform public.switchboard_queue_helper('sb_setup', null, v_start || '{"folder":"C:\\Users\\Alex\\projects\\acme","contract":true}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('unknown_key_still_refused', v_ok);
    begin
      perform public.switchboard_queue_helper('sb_setup', null, jsonb_build_object('command', 'org add', 'client', 'verify-acme',
        'orgs', jsonb_build_array(c_org || '{"type":"production"}')), 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('production_still_refused', v_ok);

    v_checks := v_checks
      || jsonb_build_object('payload_check_validated', (select convalidated from pg_constraint where conname = 'switchboard_actions_sb_setup_payload'))
      || jsonb_build_object('folder_check_not_valid', (select not convalidated from pg_constraint where conname = 'switchboard_actions_sb_setup_folder'))
      || jsonb_build_object('project_code_still_not_null', (select attnotnull from pg_attribute
           where attrelid = 'public.switchboard_actions'::regclass and attname = 'project_code'))
      || jsonb_build_object('queue_helper_anon_cannot', not has_function_privilege('anon', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('queue_helper_authenticated_can', has_function_privilege('authenticated', 'public.switchboard_queue_helper(text, text, jsonb, text, text)', 'execute'))
      || jsonb_build_object('queue_helper_security_definer', (select prosecdef from pg_proc where oid = 'public.switchboard_queue_helper(text, text, jsonb, text, text)'::regprocedure))
      || jsonb_build_object('queue_git_still_works', public.switchboard_queue_git('verify-git', '{"command":"gitsync"}', 'TEST') ? 'action_id');

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
