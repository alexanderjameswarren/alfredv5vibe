-- overwatch_settings-t3k: test the claim-block rule, the limits defaults and counts.limits in public.overwatch_nightly_counts.
-- Runs after the migration, with --test. It undoes itself: the inner block ends in its own error, the checks survive in a
-- variable, and the result row says { ok, failed, checks }. The clock is pinned 40 days ahead at 04:20 Pacific, so only the
-- fixtures (codes ost-*) are on "yesterday".

do $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  c_done    constant text := 'OST_UNDO';
  v_d       date := (now() at time zone c_tz)::date + 40;
  v_as_of   timestamptz := ((v_d + time '04:20') at time zone c_tz);
  v_y       timestamptz := ((v_d - 1 + time '09:00') at time zone c_tz);
  v_set     jsonb := '{"stall_days": 5, "waiting_on_alex_days": 3, "fading_days": 30, "overdue_days": 2,
                       "overrun_factor": 1.5, "active_project_limit": 1000, "inbox_backlog_threshold": 5,
                       "routing_low_confidence": 0.6, "urgent_within_days": 7, "inventory_stale_days": 7,
                       "fading_max_items": "x", "impact_max_tables": 8}';
  v_type    text;
  v_gi      text;
  v_gj      text;
  v_r       jsonb;
  v_cb      jsonb;
  v_keys    text[] := array['stall_days', 'waiting_on_alex_days', 'fading_days', 'overdue_days', 'overrun_factor',
                            'active_project_limit', 'inbox_backlog_threshold', 'routing_low_confidence', 'urgent_within_days',
                            'inventory_stale_days', 'claim_block_max_per_day', 'unrouted_stale_hours',
                            'inbox_backlog_old_days', 'scan_gap_nights', 'pull_max_calls_per_app', 'fading_max_items',
                            'finish_summaries_per_night', 'impact_max_tables', 'impact_max_follow_ups',
                            'impact_max_profile_rewrites', 'nightly_checks.silence_hours'];
  c         jsonb := '{}';
  v_result  jsonb;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    perform public.create_overwatch_plan('TEST plan', v_set, 'Test only; rolled back.');

    -- a/b: 6 one way and 5 the other on yesterday = 11, flagged.
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select case when n <= 6 then 'ost-a' else 'ost-b' end, case when n <= 6 then 'ost-b' else 'ost-a' end,
           'docs/x.md', v_y + make_interval(mins => n), v_y + make_interval(mins => n)
      from generate_series(1, 11) n;
    -- c/d: exactly 10, not flagged.
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select 'ost-c', 'ost-d', 'docs/x.md', v_y + make_interval(mins => n), v_y + make_interval(mins => n)
      from generate_series(1, 10) n;
    -- g/h: 10 waits, each over two files (20 rows) = 10 episodes, not flagged.
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select 'ost-g', 'ost-h', f, v_y + make_interval(mins => n), v_y + make_interval(mins => n)
      from generate_series(1, 10) n,
           unnest(array['supabase/functions/mcp/index.ts', 'supabase/functions/mcp/index.test.mjs']) f;
    -- e/f: 6 yesterday and 6 the day before: not added together.
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select 'ost-e', 'ost-f', 'docs/x.md',
           v_y - case when n > 6 then interval '1 day' else interval '0' end + make_interval(mins => n),
           v_y - case when n > 6 then interval '1 day' else interval '0' end + make_interval(mins => n)
      from generate_series(1, 12) n;
    -- k/l: 12 today, after midnight: not yesterday.
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select 'ost-k', 'ost-l', 'docs/x.md', ((v_d + time '00:30') at time zone c_tz) + make_interval(mins => n),
           ((v_d + time '00:30') at time zone c_tz) + make_interval(mins => n)
      from generate_series(1, 12) n;
    -- i/j: 12 yesterday, but a no_parallel link between their Projects.
    select id into v_type from public.group_types where kind = 'project' order by created_at limit 1;
    insert into public.item_groups (group_type_id, name, status) values (v_type, 'ost i', 'active') returning id into v_gi;
    insert into public.item_groups (group_type_id, name, status) values (v_type, 'ost j', 'active') returning id into v_gj;
    insert into public.project_plans (group_id, project_code) values (v_gi, 'ost-i'), (v_gj, 'ost-j');
    insert into public.project_links (from_group_id, to_group_id, kind) values (v_gj, v_gi, 'no_parallel');
    insert into public.claim_blocks (waiter_code, holder_code, item, blocked_at, last_seen_at)
    select 'ost-i', 'ost-j', 'docs/x.md', v_y + make_interval(mins => n), v_y + make_interval(mins => n)
      from generate_series(1, 12) n;

    v_r  := public.overwatch_nightly_counts(v_as_of);
    v_cb := v_r -> 'claim_blocks';
    c := c || jsonb_build_object(
      'eleven_both_ways_flagged', v_cb @> jsonb_build_array(jsonb_build_object(
        'code_a', 'ost-a', 'code_b', 'ost-b', 'day', v_d - 1, 'episodes', 11, 'group_a', null, 'group_b', null)),
      'ten_not_flagged', not v_cb @> '[{"code_a": "ost-c"}]'::jsonb,
      'two_files_one_wait', not v_cb @> '[{"code_a": "ost-g"}]'::jsonb,
      'two_days_not_added', not v_cb @> '[{"code_a": "ost-e"}]'::jsonb,
      'today_not_counted', not v_cb @> '[{"code_a": "ost-k"}]'::jsonb,
      'no_parallel_left_out', not v_cb @> '[{"code_a": "ost-i"}]'::jsonb,
      'default_used', (v_r -> 'limits' ->> 'claim_block_max_per_day') = '10',
      'default_named', v_r -> 'settings_missing' @> '["claim_block_max_per_day (used 10)", "nightly_checks.silence_hours (used 36)"]'::jsonb,
      'invalid_uses_default', (v_r -> 'limits' ->> 'fading_max_items') = '10'
                              and v_r -> 'settings_missing' @> '["fading_max_items (used 10)"]'::jsonb,
      'set_value_used', (v_r -> 'limits' ->> 'impact_max_tables') = '8'
                        and not exists (select 1 from jsonb_array_elements_text(v_r -> 'settings_missing') m
                                         where m like 'impact_max_tables%'),
      'present_key_not_missing', not v_r -> 'settings_missing' @> '["inventory_stale_days (used 7)"]'::jsonb,
      'limits_every_key', (select bool_and(v_r -> 'limits' ? k) from unnest(v_keys) k),
      'limits_no_extra', (select count(*) from jsonb_object_keys(v_r -> 'limits')) = array_length(v_keys, 1),
      'previous_scan_gap_runs', jsonb_array_length(v_r -> 'prior_runs' -> 'previous') <= 2,
      'unrouted_stale_hours', (v_r -> 'unrouted' -> 0 ->> 'stale_hours') = '24');

    -- A plan value is honoured: at 5, e/f's 6 yesterday are flagged.
    perform public.create_overwatch_plan('TEST plan 2', v_set || '{"claim_block_max_per_day": 5}', 'Test only; rolled back.');
    v_cb := public.overwatch_nightly_counts(v_as_of) -> 'claim_blocks';
    c := c || jsonb_build_object(
      'plan_max_used', v_cb @> '[{"code_a": "ost-e", "code_b": "ost-f", "episodes": 6}]'::jsonb);

    v_result := jsonb_build_object(
      'ok', not exists (select 1 from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'check_count', (select count(*) from jsonb_object_keys(c)),
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('ok', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('overwatch_settings.result', v_result::text, false);
end;
$$;

select current_setting('overwatch_settings.result')::jsonb as result;
