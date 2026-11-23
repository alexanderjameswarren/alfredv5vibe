-- sb3_runner-r4q r7 (L1): verify the sf_run migration (switchboard repo docs/technical-spec-sb3_plumbing-n7c.md L1;
-- docs/technical-spec-sb3_pages-h6v.md parts 2, 4.5, 5): the kind and its payload and click checks, consumed at
-- insert with no link, needs_click, no other way in (switchboard_queue_helper refuses it, signed-in users can't
-- insert), handed out only to a helper that names it, within 15 minutes of created_at, and failed past that by either
-- pickup with failure_reason 'expired_not_picked_up'; the grants. Run after the migration, through the queue with
-- --test. Throwaway rows; everything is undone, including any real action a pickup call touches.
-- Result: one row, with all_passed, failed, errors and checks.
-- supabase/tests/sb3_runner-r4q/2_verify_sf_run.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_all    constant text[] := array['git', 'sf_check', 'sf_read', 'sb_setup', 'sf_dataop', 'sf_dataquery', 'sf_datawrite', 'sf_run'];
  c_why    constant jsonb := '{"ok": false, "expired": true, "reason": "expired_not_picked_up"}';
  v_checks jsonb := '{}'::jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_result jsonb;
  v_ok     boolean;
  v_kv     record;
  v_row    public.switchboard_actions;
  v_cons   text;
  v_new    uuid;   -- approved just now
  v_old    uuid;   -- approved 16 minutes ago, failed by the helper pickup
  v_oldg   uuid;   -- approved 16 minutes ago, failed by pickup_git
  v_pick   jsonb;
  v_seen   uuid[] := '{}';
  i        integer;
begin
  begin
    -- ---- schema, grants, needs_click ----
    v_checks := v_checks || jsonb_build_object(
      'needs_click_sf_run', public.switchboard_needs_click('sf_run', '{}'::jsonb, 'claude'),
      'authenticated_cannot_insert_actions', not has_table_privilege('authenticated', 'public.switchboard_actions', 'insert'),
      'pickup_helper_grants',
        has_function_privilege('service_role', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_helper(uuid, text[], uuid)', 'execute'),
      'pickup_git_grants',
        has_function_privilege('service_role', 'public.switchboard_pickup_git(uuid, uuid)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_pickup_git(uuid, uuid)', 'execute')
        and not has_function_privilege('authenticated', 'public.switchboard_pickup_git(uuid, uuid)', 'execute'),
      'needs_click_grants',
        has_function_privilege('service_role', 'public.switchboard_needs_click(text, jsonb, text)', 'execute')
        and not has_function_privilege('anon', 'public.switchboard_needs_click(text, jsonb, text)', 'execute'));

    -- ---- an sf_run is inserted consumed, with no link, needing a click ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by,
                                            link_hash, link_expires_at, link_used_at, needs_click)
    values (c_alex, 'sf_run', 'r4q-v-run-new', '{"link_id": "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3", "plan": "x"}',
            'R4Q SF_RUN TEST', 'claude', 'abc', now() + interval '1 hour', now(), false)
    returning * into v_row;
    v_new := v_row.id;
    v_checks := v_checks || jsonb_build_object(
      'inserted_consumed', v_row.status = 'consumed',
      'inserted_with_no_link', v_row.link_hash is null and v_row.link_expires_at is null and v_row.link_used_at is null,
      'inserted_needs_click', v_row.needs_click,
      'inserted_not_picked', v_row.picked_up_at is null,
      'inserted_fingerprint', v_row.fingerprint is not null);
    update public.switchboard_actions set created_at = now() - interval '5 minutes' where id = v_new;
    v_checks := v_checks || jsonb_build_object('guard_keeps_created_at',
      (select created_at > now() - interval '1 minute' from public.switchboard_actions where id = v_new));

    -- A future approval time is capped at now, so the 15 minutes can't be stretched.
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'r4q-v-run-future', '{"link_id": "3b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"}', 'R4Q SF_RUN TEST',
            'claude', now() + interval '1 day')
    returning * into v_row;
    v_checks := v_checks || jsonb_build_object('future_created_at_capped', v_row.created_at <= now());

    -- The pages' switchboard_retry_run fails a stale sf_run before its resend: consumed to failed is allowed.
    update public.switchboard_actions set status = 'failed' where id = v_row.id;
    v_checks := v_checks || jsonb_build_object('consumed_to_failed_allowed',
      (select status = 'failed' from public.switchboard_actions where id = v_row.id));

    -- ---- bad payloads are refused ----
    for v_kv in select * from jsonb_each(jsonb_build_object(
      'no_link_id', '{"plan": "x"}'::jsonb,
      'link_id_not_uuid', '{"link_id": "run-1"}'::jsonb,
      'link_id_upper_case', '{"link_id": "0B6C1D2E-3F40-4A5B-8C6D-7E8F90A1B2C3"}'::jsonb,
      'link_id_number', '{"link_id": 7}'::jsonb,
      'not_an_object', '["0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"]'::jsonb,
      'too_long', jsonb_build_object('link_id', '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3', 'pad', repeat('x', 200001))))
    loop
      begin
        insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
        values (c_alex, 'sf_run', 'r4q-v-run-bad', v_kv.value, 'R4Q SF_RUN TEST', 'claude');
        v_ok := false;
      exception when others then
        -- Only the sf_run payload check counts; any other refusal is recorded, not counted as a pass.
        get stacked diagnostics v_cons = constraint_name;
        v_ok := sqlstate = '23514' and v_cons = 'switchboard_actions_sf_run_payload';
        if not v_ok then
          v_errors := v_errors || jsonb_build_object(v_kv.key, sqlstate || ' ' || coalesce(v_cons, '') || ': ' || sqlerrm);
        end if;
      end;
      v_checks := v_checks || jsonb_build_object('refused_' || v_kv.key, v_ok);
    end loop;

    -- ---- switchboard_queue_helper still refuses the kind ----
    perform set_config('request.jwt.claim.sub', c_alex::text, true);
    perform set_config('request.jwt.claims', jsonb_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    begin
      perform public.switchboard_queue_helper('sf_run', 'r4q-v-run-q', '{"link_id": "0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"}', 'R4Q');
      v_ok := false;
    exception when check_violation then
      v_ok := true;
    end;
    v_checks := v_checks || jsonb_build_object('queue_helper_refuses_sf_run', v_ok);

    -- ---- the other kinds are still inserted queued ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by)
    values (c_alex, 'git', 'r4q-v-git', '{"command": "gitsync"}', 'R4Q SF_RUN TEST', 'claude')
    returning * into v_row;
    v_checks := v_checks || jsonb_build_object('git_still_inserted_queued', v_row.status = 'queued');

    -- ---- pickup_git fails an sf_run approved 16 minutes ago ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'r4q-v-run-oldg', '{"link_id": "1b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"}', 'R4Q SF_RUN TEST',
            'claude', now() - interval '16 minutes')
    returning id into v_oldg;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_git(c_alex);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'git_pickup_failed_old_sf_run',
        coalesce((select status = 'failed' and picked_up_at is null from public.switchboard_actions where id = v_oldg), false),
      'git_pickup_old_sf_run_reason',
        exists (select 1 from public.switchboard_runs where action_id = v_oldg and result = c_why
                  and failure_reason = 'expired_not_picked_up' and finished_at is not null),
      'git_pickup_left_new_sf_run',
        coalesce((select status = 'consumed' and picked_up_at is null from public.switchboard_actions where id = v_new), false));

    -- ---- the default kinds never get an sf_run; the helper pickup fails an old one ----
    insert into public.switchboard_actions (user_id, kind, project_code, payload, headline, created_by, created_at)
    values (c_alex, 'sf_run', 'r4q-v-run-old', '{"link_id": "2b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3"}', 'R4Q SF_RUN TEST',
            'claude', now() - interval '16 minutes')
    returning id into v_old;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, array['git', 'sf_check', 'sb_setup', 'sf_read', 'sf_dataop', 'sf_dataquery', 'sf_datawrite']);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'unnamed_never_get_sf_run', not (v_seen && array[v_new, v_old, v_oldg]),
      'helper_pickup_failed_old_sf_run',
        coalesce((select status = 'failed' and picked_up_at is null from public.switchboard_actions where id = v_old), false),
      'helper_pickup_old_sf_run_reason',
        exists (select 1 from public.switchboard_runs where action_id = v_old and result = c_why
                  and failure_reason = 'expired_not_picked_up' and finished_at is not null
                  and summary like 'expired: approved over 15 minutes ago and never picked up%'));

    -- ---- named, the fresh one is handed out, with its kind and payload ----
    v_seen := '{}';
    for i in 1..60 loop
      v_pick := public.switchboard_pickup_helper(c_alex, c_all);
      exit when v_pick is null;
      v_seen := v_seen || (v_pick->>'action_id')::uuid;
      if (v_pick->>'action_id')::uuid = v_new then
        v_checks := v_checks || jsonb_build_object(
          'named_pick_kind', v_pick->>'kind' = 'sf_run',
          'named_pick_link_id', v_pick->'payload'->>'link_id' = '0b6c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3',
          'named_pick_opened_run',
            exists (select 1 from public.switchboard_runs where id = (v_pick->>'run_id')::uuid and finished_at is null
                      and failure_reason is null));
      end if;
    end loop;
    v_checks := v_checks || jsonb_build_object(
      'named_gets_fresh_sf_run', v_new = any(v_seen),
      'named_never_gets_failed', not (v_seen && array[v_old, v_oldg]),
      'picked_sf_run_marked', coalesce((select picked_up_at is not null and status = 'consumed'
                                          from public.switchboard_actions where id = v_new), false));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'errors', v_errors,
      'checks', v_checks);
    raise exception 'switchboard_verify_undo';
  exception when others then
    if sqlerrm <> 'switchboard_verify_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'errors', v_errors, 'checks', v_checks);
    end if;
  end;
  perform set_config('switchboard.verify_result', v_result::text, true);
end;
$$;

select current_setting('switchboard.verify_result')::jsonb as result;
