-- Switchboard 2.0 s80: verify git actions, needs_click from the action type, and the helper's pickup.
-- Run after migration 206, through the queue with --test. Throwaway rows, undone. Result: one row, with
-- all_passed, failed and checks.
-- supabase/tests/switchboard2-h8r/6_verify_git.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_checks jsonb := '{}'::jsonb;
  v_a uuid; v_b uuid; v_c uuid;
  v_nc boolean;
  v_pick jsonb;
  v_ok boolean;
  v_result jsonb;
begin
  begin
    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
        values (c_alex, 'git', 'verify-git-a', '{"command":"rm"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('unknown_git_command_refused', v_ok);

    begin
      insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
        values (c_alex, 'git', 'verify-git-a', '{"command":"gitpush"}', 'TEST'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('gitpush_without_mode_refused', v_ok);

    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, needs_click)
      values (c_alex, 'git', 'verify-git-a', '{"command":"gitsync"}', 'TEST A', false) returning id, needs_click into v_a, v_nc;
    v_checks := v_checks || jsonb_build_object('caller_cannot_clear_needs_click', v_nc);
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'git', 'verify-git-a', '{"command":"gitpush","mode":"checkpoint"}', 'TEST B') returning id, needs_click into v_b, v_nc;
    v_checks := v_checks || jsonb_build_object('gitpush_needs_click', v_nc);
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline)
      values (c_alex, 'git', 'verify-git-c', '{"command":"gitcom"}', 'TEST C') returning id into v_c;

    begin
      update public.switchboard_actions set needs_click = false where id = v_a; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('needs_click_never_changes', v_ok);

    v_checks := v_checks || jsonb_build_object('nothing_picked_before_a_click', public.switchboard_pickup_git(c_alex) is null);

    update public.switchboard_actions set status = 'consumed' where id = v_a;
    v_pick := public.switchboard_pickup_git(c_alex);
    v_checks := v_checks
      || jsonb_build_object('clicked_action_picked', (v_pick->>'action_id')::uuid = v_a)
      || jsonb_build_object('pickup_returns_payload', v_pick->'payload'->>'command' = 'gitsync')
      || jsonb_build_object('picked_up_at_set', (select picked_up_at is not null from public.switchboard_actions where id = v_a))
      || jsonb_build_object('real_run_opened', exists (select 1 from public.switchboard_runs
                              where id = (v_pick->>'run_id')::uuid and action_id = v_a and mode = 'real'));

    update public.switchboard_actions set status = 'consumed' where id = v_b;
    v_checks := v_checks || jsonb_build_object('one_at_a_time_per_project', public.switchboard_pickup_git(c_alex) is null);

    update public.switchboard_actions set status = 'consumed' where id = v_c;
    v_checks := v_checks || jsonb_build_object('other_project_still_picked',
      (public.switchboard_pickup_git(c_alex)->>'action_id')::uuid = v_c);

    begin
      update public.switchboard_actions set picked_up_at = now() + interval '1 hour' where id = v_a; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('picked_up_at_set_once', v_ok);

    v_checks := v_checks
      || jsonb_build_object('authenticated_cannot_pick_up', not has_function_privilege('authenticated', 'public.switchboard_pickup_git(uuid)', 'execute'))
      || jsonb_build_object('anon_cannot_pick_up', not has_function_privilege('anon', 'public.switchboard_pickup_git(uuid)', 'execute'))
      || jsonb_build_object('service_role_can_pick_up', has_function_privilege('service_role', 'public.switchboard_pickup_git(uuid)', 'execute'))
      || jsonb_build_object('anon_cannot_call_needs_click', not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'))
      || jsonb_build_object('clips_source_names_clip_cmd',
           col_description('public.clips'::regclass,
             (select attnum from pg_attribute where attrelid = 'public.clips'::regclass and attname = 'source')) like '%clip.cmd%');

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
