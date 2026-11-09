-- Switchboard 2.0 s86k: verify the gitnewtree repo check. Run after the gitnewtree-repo migration, through the queue
-- with --test. Throwaway rows, undone. Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/11_verify_gitnewtree_repo.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_out jsonb;
  v_ok boolean;
  v_result jsonb;
  v_case record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- Accepted.
    for v_case in select * from (values
      ('newtree_without_repo_ok', '{"command":"gitnewtree"}'),
      ('newtree_repo_ok', '{"command":"gitnewtree","repo":"C:\\Users\\Alex\\projects\\alfred-v5"}'),
      ('newtree_repo_lower_drive_ok', '{"command":"gitnewtree","repo":"c:\\users\\alex\\projects\\switchboard"}'),
      ('newtree_repo_with_install_ok', '{"command":"gitnewtree","install":true,"repo":"C:\\Users\\Alex\\projects\\actblue\\acme"}'),
      ('sync_without_repo_ok', '{"command":"gitsync"}')
    ) as t(name, payload) loop
      v_out := public.switchboard_queue_git('verify-repo', v_case.payload::jsonb, 'TEST');
      v_checks := v_checks || jsonb_build_object(v_case.name, v_out ? 'action_id'
        and (select payload->'repo' from public.switchboard_actions where id = (v_out->>'action_id')::uuid)
            is not distinct from (v_case.payload::jsonb)->'repo');
    end loop;

    -- Refused.
    for v_case in select * from (values
      ('repo_on_gitsync_refused', '{"command":"gitsync","repo":"C:\\Users\\Alex\\projects\\alfred-v5"}'),
      ('repo_on_gitcom_refused', '{"command":"gitcom","repo":"C:\\Users\\Alex\\projects\\alfred-v5"}'),
      ('repo_on_gitpush_refused', '{"command":"gitpush","mode":"push","repo":"C:\\Users\\Alex\\projects\\alfred-v5"}'),
      ('repo_relative_refused', '{"command":"gitnewtree","repo":"projects\\alfred-v5"}'),
      ('repo_drive_only_refused', '{"command":"gitnewtree","repo":"C:\\"}'),
      ('repo_trailing_backslash_refused', '{"command":"gitnewtree","repo":"C:\\Users\\Alex\\projects\\alfred-v5\\"}'),
      ('repo_forward_slashes_refused', '{"command":"gitnewtree","repo":"C:/Users/Alex/projects/alfred-v5"}'),
      ('repo_dotdot_refused', '{"command":"gitnewtree","repo":"C:\\Users\\Alex\\projects\\..\\x"}'),
      ('repo_bad_char_refused', '{"command":"gitnewtree","repo":"C:\\Users\\Alex\\a\"b"}'),
      ('repo_unc_refused', '{"command":"gitnewtree","repo":"\\\\server\\share\\repo"}'),
      ('repo_json_null_refused', '{"command":"gitnewtree","repo":null}'),
      ('repo_number_refused', '{"command":"gitnewtree","repo":5}'),
      ('repo_empty_refused', '{"command":"gitnewtree","repo":""}')
    ) as t(name, payload) loop
      begin
        perform public.switchboard_queue_git('verify-repo', v_case.payload::jsonb, 'TEST'); v_ok := false;
      exception when check_violation then v_ok := true; end;
      v_checks := v_checks || jsonb_build_object(v_case.name, v_ok);
    end loop;
    begin
      perform public.switchboard_queue_git('verify-repo',
        jsonb_build_object('command', 'gitnewtree', 'repo', 'C:\' || repeat('a', 240)), 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('repo_too_long_refused', v_ok);

    -- 207 still holds; the new check is validated.
    begin
      perform public.switchboard_queue_git('verify-repo', '{"command":"gitpush"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('gitpush_without_mode_still_refused', v_ok)
      || jsonb_build_object('repo_check_validated', (select convalidated from pg_constraint where conname = 'switchboard_actions_git_repo'))
      || jsonb_build_object('git_payload_check_kept', exists (select 1 from pg_constraint where conname = 'switchboard_actions_git_payload'))
      || jsonb_build_object('sb_repo_unaffected', public.switchboard_queue_helper('sb_setup', null,
           '{"command":"client start","client":"verify-acme","repo":"https://example.com/a.git","orgs":[{"alias":"ti-dev1","type":"developer","level":"metadata"}]}',
           'TEST') ? 'action_id');

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
