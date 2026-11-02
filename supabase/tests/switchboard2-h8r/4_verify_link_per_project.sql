-- Switchboard 2.0 s52: verify one live link per project code, and the kind and expiry in the link. Run after the
-- migration, through the queue with --test. It works on throwaway rows and undoes itself. Result: one row, with
-- all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/4_verify_link_per_project.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_a1 uuid; v_a2 uuid; v_b uuid; v_c uuid; v_d uuid;
  v_link jsonb;
  v_ok boolean;
  v_result jsonb;
begin
  begin
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'sql', 'verify-link-a', '{"sql":"select 1"}', 'TEST A1') returning id into v_a1;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'sql', 'verify-link-a', '{"sql":"select 2"}', 'TEST A2') returning id into v_a2;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'git', 'verify-link-b', '{"command":"gitsync"}', 'TEST B') returning id into v_b;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'sf_deploy', 'verify-link-c', '{"alias":"x"}', 'TEST C') returning id into v_c;
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'sf_test', 'verify-link-d', '{"alias":"x"}', 'TEST D') returning id into v_d;

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    v_link := public.switchboard_issue_link(v_a1);
    v_checks := v_checks
      || jsonb_build_object('sql_link_has_its_token_and_kind', v_link->>'url' ~ '/approve/[0-9a-f]{64}\?kind=sql&exp=[0-9]+$')
      || jsonb_build_object('exp_matches_expires_at',
           abs(substring(v_link->>'url' from 'exp=([0-9]+)$')::bigint - extract(epoch from (v_link->>'expires_at')::timestamptz)) <= 1);

    begin perform public.switchboard_issue_link(v_a2); v_ok := false;
    exception when others then v_ok := sqlerrm like '%another link is live for verify-link-a%'; end;
    v_checks := v_checks || jsonb_build_object('second_link_same_project_refused', v_ok);

    begin perform public.switchboard_issue_link(v_a1); v_ok := false;
    exception when others then v_ok := sqlerrm like '%another link is live%'; end;
    v_checks := v_checks || jsonb_build_object('second_link_same_action_refused', v_ok);

    v_link := public.switchboard_issue_link(v_b);
    v_checks := v_checks
      || jsonb_build_object('other_project_allowed_while_first_is_live', v_link->>'url' is not null)
      || jsonb_build_object('git_link_says_git', v_link->>'url' ~ '\?kind=git&exp=');

    v_checks := v_checks
      || jsonb_build_object('sf_deploy_link_says_deploy', public.switchboard_issue_link(v_c)->>'url' ~ '\?kind=deploy&exp=')
      || jsonb_build_object('sf_test_link_says_deploy', public.switchboard_issue_link(v_d)->>'url' ~ '\?kind=deploy&exp=');

    -- Authenticated can't write this table, so step back out to expire the first link.
    perform set_config('role', 'none', true);
    update public.switchboard_actions set link_expires_at = now() - interval '1 minute' where id = v_a1;
    perform set_config('role', 'authenticated', true);

    begin
      v_link := public.switchboard_issue_link(v_a2);
      v_ok := v_link->>'url' is not null;
    exception when others then v_ok := false; end;
    v_checks := v_checks || jsonb_build_object('expired_link_does_not_count', v_ok);

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
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
