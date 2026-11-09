-- Switchboard 2.0 s86pa: verify that an sf_check waits for a click and gets a link, and git and sb_setup are unchanged.
-- Run after the sf-check-click migration, through the queue with --test. Throwaway rows, undone. Result: one row, with
-- all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/12_verify_sf_check_click.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_sf uuid;
  v_sf_meta uuid;
  v_git uuid;
  v_push uuid;
  v_sb uuid;
  v_link jsonb;
  v_picked jsonb;
  v_result jsonb;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);

    -- The function itself.
    v_checks := v_checks
      || jsonb_build_object('fn_sf_check_true', public.switchboard_needs_click('sf_check', '{"check":"limits","alias":"a"}', 'claude'))
      || jsonb_build_object('fn_git_sync_true', public.switchboard_needs_click('git', '{"command":"gitsync"}', 'claude'))
      || jsonb_build_object('fn_git_push_true', public.switchboard_needs_click('git', '{"command":"gitpush","mode":"push"}', 'claude'))
      || jsonb_build_object('fn_sb_setup_true', public.switchboard_needs_click('sb_setup', '{}', 'claude'))
      || jsonb_build_object('fn_sql_true', public.switchboard_needs_click('sql', '{}', 'claude'))
      || jsonb_build_object('fn_anon_cannot_execute', not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'))
      || jsonb_build_object('fn_authenticated_can_execute', has_function_privilege('authenticated', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'));

    -- A new sf_check: queued needing a click, with no project code (sf-<alias>) and with one.
    v_sf := (public.switchboard_queue_helper('sf_check', null, '{"check":"org-verify","alias":"verify-sf-dev1"}', 'TEST')->>'action_id')::uuid;
    v_sf_meta := (public.switchboard_queue_helper('sf_check', 'verify-sfc', '{"check":"metadata","alias":"verify-sf-dev2","metadata_type":"ApexClass"}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks
      || jsonb_build_object('sf_needs_click', (select needs_click from public.switchboard_actions where id = v_sf))
      || jsonb_build_object('sf_with_code_needs_click', (select needs_click from public.switchboard_actions where id = v_sf_meta))
      || jsonb_build_object('sf_code_from_alias', (select project_code from public.switchboard_actions where id = v_sf) = 'sf-verify-sf-dev1')
      || jsonb_build_object('sf_starts_queued', (select status from public.switchboard_actions where id = v_sf) = 'queued');

    -- Not handed to the helper before the click.
    v_picked := public.switchboard_pickup_helper(c_alex);
    v_checks := v_checks || jsonb_build_object('sf_not_picked_before_click',
      v_picked is null or (v_picked->>'action_id')::uuid not in (v_sf, v_sf_meta));

    -- switchboard_issue_link accepts it.
    v_link := public.switchboard_issue_link(v_sf);
    v_checks := v_checks
      || jsonb_build_object('sf_link_issued', v_link->>'url' like '%/approve/%?kind=sf_check&exp=%')
      || jsonb_build_object('sf_status_link_issued', (select status from public.switchboard_actions where id = v_sf) = 'link_issued')
      || jsonb_build_object('sf_link_hash_kept', (select link_hash is not null and link_expires_at > now() from public.switchboard_actions where id = v_sf))
      || jsonb_build_object('sf_with_code_link_issued', public.switchboard_issue_link(v_sf_meta) ? 'url');

    -- git and sb_setup unchanged.
    v_git := (public.switchboard_queue_git('verify-sfg', '{"command":"gitsync"}', 'TEST')->>'action_id')::uuid;
    v_push := (public.switchboard_queue_git('verify-sfp', '{"command":"gitpush","mode":"push"}', 'TEST')->>'action_id')::uuid;
    v_sb := (public.switchboard_queue_helper('sb_setup', null,
      '{"command":"org add","client":"verify-sfb","orgs":[{"alias":"verify-sfb-dev1","type":"developer","level":"objects"}]}', 'TEST')->>'action_id')::uuid;
    v_checks := v_checks
      || jsonb_build_object('git_sync_needs_click', (select needs_click from public.switchboard_actions where id = v_git))
      || jsonb_build_object('git_push_needs_click', (select needs_click from public.switchboard_actions where id = v_push))
      || jsonb_build_object('git_link_issued', public.switchboard_issue_link(v_git)->>'url' like '%?kind=git&exp=%')
      || jsonb_build_object('sb_needs_click', (select needs_click from public.switchboard_actions where id = v_sb))
      || jsonb_build_object('sb_link_issued', public.switchboard_issue_link(v_sb)->>'url' like '%?kind=sb_setup&exp=%');

    -- The payload check still holds for sf_check.
    begin
      perform public.switchboard_queue_helper('sf_check', null, '{"check":"soql","alias":"verify-sf-dev3"}', 'TEST');
      v_checks := v_checks || jsonb_build_object('sf_bad_check_still_refused', false);
    exception when check_violation then
      v_checks := v_checks || jsonb_build_object('sf_bad_check_still_refused', true);
    end;

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
