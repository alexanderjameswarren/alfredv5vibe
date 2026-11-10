-- Switchboard 2.0 s86ac, s86ag: verify switchboard_stakes, every row of the rule (none only for a sql --test, whose
-- page runs by itself; change for every link that waits for Approve), and that a link's url carries its stakes after
-- kind. Run after the stakes-click migration, through the queue with --test. Throwaway rows, undone. Result: one
-- row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/13_verify_link_stakes.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_id uuid;
  v_result jsonb;
  f constant text := 'public.switchboard_stakes(text, jsonb)';
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- The rule, row by row.
    v_checks := v_checks
      || jsonb_build_object('sql_is_change', public.switchboard_stakes('sql', '{"sql":"delete from switchboard_actions where id = 1;"}') = 'change')
      || jsonb_build_object('sql_test_false_is_change', public.switchboard_stakes('sql', '{"sql":"select 1;","test":false}') = 'change')
      || jsonb_build_object('sql_test_string_is_change', public.switchboard_stakes('sql', '{"sql":"select 1;","test":"true"}') = 'change')
      || jsonb_build_object('sql_test_is_none', public.switchboard_stakes('sql', '{"sql":"select 1;","test":true}') = 'none')
      || jsonb_build_object('gitpush_push_is_change', public.switchboard_stakes('git', '{"command":"gitpush","mode":"push"}') = 'change')
      || jsonb_build_object('gitpush_checkpoint_is_change', public.switchboard_stakes('git', '{"command":"gitpush","mode":"checkpoint"}') = 'change')
      || jsonb_build_object('gitpush_finish_is_change', public.switchboard_stakes('git', '{"command":"gitpush","mode":"finish"}') = 'change')
      || jsonb_build_object('gitnewtree_is_change', public.switchboard_stakes('git', '{"command":"gitnewtree"}') = 'change')
      || jsonb_build_object('gitsync_is_change', public.switchboard_stakes('git', '{"command":"gitsync"}') = 'change')
      || jsonb_build_object('gitcom_is_change', public.switchboard_stakes('git', '{"command":"gitcom"}') = 'change')
      || jsonb_build_object('git_test_true_is_change', public.switchboard_stakes('git', '{"command":"gitsync","test":true}') = 'change')
      || jsonb_build_object('git_unknown_command_is_change', public.switchboard_stakes('git', '{"command":"gitwhat"}') = 'change')
      || jsonb_build_object('sb_setup_is_change', public.switchboard_stakes('sb_setup', '{}') = 'change')
      || jsonb_build_object('sf_deploy_is_change', public.switchboard_stakes('sf_deploy', '{}') = 'change')
      || jsonb_build_object('sf_test_is_change', public.switchboard_stakes('sf_test', '{}') = 'change')
      || jsonb_build_object('sf_check_is_change', public.switchboard_stakes('sf_check', '{"check":"limits","alias":"a"}') = 'change')
      || jsonb_build_object('unknown_kind_is_change', public.switchboard_stakes('docs', '{}') = 'change')
      || jsonb_build_object('null_kind_is_change', public.switchboard_stakes(null, null) = 'change')
      || jsonb_build_object('fn_anon_cannot_execute', not has_function_privilege('anon', f, 'execute'))
      || jsonb_build_object('fn_authenticated_can_execute', has_function_privilege('authenticated', f, 'execute'))
      || jsonb_build_object('fn_service_role_can_execute', has_function_privilege('service_role', f, 'execute'))
      || jsonb_build_object('issue_link_anon_cannot_execute', not has_function_privilege('anon', 'public.switchboard_issue_link(uuid)', 'execute'));

    -- Links: stakes after kind, before exp.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sql', 'verify-stk-sql', '{"sql":"delete from switchboard_actions where id = 1;","description":"TEST","expected":[1]}', 'TEST', 'cli')
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('link_sql_change', public.switchboard_issue_link(v_id)->>'url' like '%/approve/%?kind=sql&stakes=change&exp=%');

    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sql', 'verify-stk-tst', '{"sql":"select 1;","description":"TEST","test":true}', 'TEST', 'cli')
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('link_sql_test_none', public.switchboard_issue_link(v_id)->>'url' like '%?kind=sql&stakes=none&exp=%');

    v_id := (public.switchboard_queue_git('verify-stk-gs', '{"command":"gitsync"}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('link_gitsync_change', public.switchboard_issue_link(v_id)->>'url' like '%?kind=git&stakes=change&exp=%');

    v_id := (public.switchboard_queue_git('verify-stk-gp', '{"command":"gitpush","mode":"push"}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('link_gitpush_change', public.switchboard_issue_link(v_id)->>'url' like '%?kind=git&stakes=change&exp=%');

    v_id := (public.switchboard_queue_helper('sf_check', null, '{"check":"limits","alias":"verify-stk-dev1"}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('link_sf_check_change', public.switchboard_issue_link(v_id)->>'url' like '%?kind=sf_check&stakes=change&exp=%');

    v_id := (public.switchboard_queue_helper('sb_setup', null,
      '{"command":"org add","client":"verify-stk","orgs":[{"alias":"verify-stk-dev2","type":"developer","level":"objects"}]}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks || jsonb_build_object('link_sb_setup_change', public.switchboard_issue_link(v_id)->>'url' like '%?kind=sb_setup&stakes=change&exp=%');

    -- A deploy shows as kind=deploy; its stakes come from the real kind.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'sf_deploy', 'verify-stk-dep', '{}', 'TEST', 'cli')
    returning id into v_id;
    v_checks := v_checks || jsonb_build_object('link_deploy_change', public.switchboard_issue_link(v_id)->>'url' like '%?kind=deploy&stakes=change&exp=%');

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
