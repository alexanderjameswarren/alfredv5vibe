-- nightly_counts-f8k: test public.overwatch_nightly_counts with fixtures either side of each threshold.
-- Runs after the migration, with --test. It undoes itself: the inner block ends in its own error, the checks survive in a
-- variable, and the result row says { ok, failed, checks, ms }. Settings are pinned by a throwaway plan. The clock is pinned
-- 40 days ahead, so real rows can be present and only the fixtures (ids nct_*) are checked.

do $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  c_done    constant text := 'NCT_UNDO';
  v_today   date := (now() at time zone c_tz)::date;
  v_d       date := v_today + 40;
  v_as_of   timestamptz := ((v_d + time '12:00') at time zone c_tz);
  -- Older than any real row, so these rank first under the fading cap of 50.
  v_old     timestamptz := timestamptz '2020-01-01 20:00:00+00';
  v_set     jsonb := '{"stall_days": 5, "waiting_on_alex_days": 3, "fading_days": 30, "overdue_days": 2,
                       "overrun_factor": 1.5, "active_project_limit": 1000, "inbox_backlog_threshold": 5,
                       "routing_low_confidence": 0.6, "urgent_within_days": 7, "inventory_stale_days": 7}';
  v_type    text;
  v_g       jsonb := '{}';
  v_id      text;
  v_name    text;
  v_n       int;
  v_base    jsonb;
  v_r       jsonb;
  v_r2      jsonb;
  v_rows    jsonb;
  v_t0      timestamptz;
  v_ms      numeric;
  c         jsonb := '{}';
  v_result  jsonb;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    perform public.create_overwatch_plan('TEST plan', v_set, 'Test only; rolled back.');
    select id into v_type from public.group_types where kind = 'project' order by created_at limit 1;

    -- Baselines for the inbox, before any fixture.
    v_base := public.overwatch_nightly_counts(v_as_of);

    -- Project groups, by name.
    foreach v_name in array array['stall_none', 'stall_at', 'stall_over', 'stall_wait_project', 'alex', 'over_at', 'over_past',
                                  'target_today', 'target_past', 'empty', 'member_live', 'member_removed', 'member_archived',
                                  'empty_someday', 'watch_own', 'watch_member'] loop
      insert into public.item_groups (group_type_id, name, status)
      values (v_type, 'nct ' || v_name, case when v_name = 'empty_someday' then 'someday' else 'active' end)
      returning id into v_id;
      v_g := v_g || jsonb_build_object(v_name, v_id);
    end loop;

    insert into public.project_plans (group_id, project_code, effort_estimate, target_date, waiting_on, waiting_on_kind, waiting_on_group_id)
    values
      (v_g ->> 'stall_none', 'nct-stall-none', null, null, null, null, null),
      (v_g ->> 'stall_at', 'nct-stall-at', null, null, null, null, null),
      (v_g ->> 'stall_over', 'nct-stall-over', null, null, null, null, null),
      (v_g ->> 'stall_wait_project', 'nct-wait-proj', null, null, 'another', 'project', v_g ->> 'stall_none'),
      (v_g ->> 'alex', 'nct-alex', null, null, 'Alex to answer', 'alex', null),
      (v_g ->> 'over_at', 'nct-over-at', 4, null, null, null, null),
      (v_g ->> 'over_past', 'nct-over-past', 4, null, null, null, null),
      (v_g ->> 'target_today', 'nct-target-today', null, v_d, null, null, null),
      (v_g ->> 'target_past', 'nct-target-past', null, v_d - 1, null, null, null);

    -- Last reports: exactly stall_days, one more, and steps either side of 4 x 1.5 = 6.
    insert into public.clips (source, page_text, run_tag, created_at)
    values ('cli', 'x', 'nct-stall-at-s1-aaaa', ((v_d - 5 + time '12:00') at time zone c_tz)),
           ('cli', 'x', 'nct-stall-over-s1-aaaa', ((v_d - 6 + time '12:00') at time zone c_tz));
    insert into public.clips (source, page_text, run_tag, created_at)
    select 'cli', 'x', 'nct-over-at-s' || s || '-aaaa', v_as_of - interval '1 hour' from generate_series(1, 6) s;
    insert into public.clips (source, page_text, run_tag, created_at)
    select 'cli', 'x', 'nct-over-past-s' || s || '-aaaa', v_as_of - interval '1 hour' from generate_series(1, 7) s;

    -- Intentions.
    insert into public.intents (id, text, is_intention, status, updated_at, recurrence_config, archived, group_id, description)
    values
      ('nct_f_oneoff', 'f oneoff', true, 'active', v_old, null, false, null, null),
      ('nct_f_once', 'f once', true, 'active', v_old, '{"type": "once"}', false, null, null),
      ('nct_f_recurring', 'f recurring', true, 'active', v_old, '{"type": "weekly"}', false, null, null),
      ('nct_f_future', 'f future event', true, 'active', v_old, null, false, null, null),
      ('nct_f_today', 'f event today', true, 'active', v_old, null, false, null, null),
      ('nct_f_undone', 'f undone in window', true, 'active', v_old, null, false, null, null),
      ('nct_f_done', 'f done in window', true, 'active', v_old, null, false, null, null),
      ('nct_f_old_undone', 'f undone before window', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_focus', 'f watched focus', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_eye', 'f watched eye', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_ease', 'f ease_off does not count', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_ended', 'f watch ended', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_group', 'f watched by own group', true, 'active', v_old, null, false, v_g ->> 'watch_own', null),
      ('nct_f_w_member', 'f watched by membership', true, 'active', v_old, null, false, null, null),
      ('nct_f_w_removed', 'f removed member', true, 'active', v_old, null, false, null, null),
      ('nct_f_archived', 'f archived', true, 'active', v_old, null, true, null, null),
      ('nct_f_someday', 'f someday', true, 'someday', v_old, null, false, null, null),
      ('nct_o_at', 'o at the line', true, 'active', now(), null, false, null, null),
      ('nct_o_past', 'o past the line', true, 'active', now(), null, false, null, null),
      ('nct_o_recurring', 'o recurring missed', true, 'active', now(), '{"type": "weekly"}', false, null, null),
      ('nct_d_none', 'd no event', true, 'active', now(), null, false, null, 'renew by March'),
      ('nct_d_future', 'd future event', true, 'active', now(), null, false, null, null),
      ('nct_d_window', 'd past event in window', true, 'active', now(), null, false, null, null),
      ('nct_d_old', 'd only an event before the window', true, 'active', now(), null, false, null, null);

    insert into public.events (id, intent_id, time) values
      ('nct_e_future', 'nct_f_future', v_d + 1),
      ('nct_e_today', 'nct_f_today', v_d),
      ('nct_e_undone', 'nct_f_undone', v_d - 3),
      ('nct_e_done', 'nct_f_done', v_d - 3),
      ('nct_e_old_undone', 'nct_f_old_undone', v_d - 31),
      ('nct_e_o_at', 'nct_o_at', v_d - 2),
      ('nct_e_o_past', 'nct_o_past', v_d - 3),
      ('nct_e_o_recurring', 'nct_o_recurring', v_d - 3),
      ('nct_e_d_future', 'nct_d_future', v_d + 5),
      ('nct_e_d_window', 'nct_d_window', v_d - 1),
      ('nct_e_d_old', 'nct_d_old', v_d - 31);
    insert into public.executions (id, event_id, intent_id, status, started_at)
    values ('nct_x_done', 'nct_e_done', 'nct_f_done', 'active', now());

    -- Members and an item that must never fade.
    insert into public.items (id, name, status, updated_at, archived) values
      ('nct_i_old', 'nct old item', 'active', v_old, false),
      ('nct_i_archived', 'nct archived item', 'active', v_old, true);
    insert into public.item_group_members (group_id, member_type, member_id, position, removed_at) values
      (v_g ->> 'member_live', 'item', 'nct_i_old', 1, null),
      (v_g ->> 'member_removed', 'item', 'nct_i_old', 1, now()),
      (v_g ->> 'member_archived', 'item', 'nct_i_archived', 1, null),
      (v_g ->> 'watch_member', 'intention', 'nct_f_w_member', 1, null),
      (v_g ->> 'watch_member', 'intention', 'nct_f_w_removed', 2, now());

    -- Watch items.
    insert into public.overwatch_watch (kind, text, intent_id, group_id, starts_on, ends_on) values
      ('focus', 'nct', 'nct_f_w_focus', null, v_d - 1, v_d + 1),
      ('keep_an_eye_on', 'nct', 'nct_f_w_eye', null, v_d - 1, v_d + 1),
      ('ease_off', 'nct', 'nct_f_w_ease', null, v_d - 1, v_d + 1),
      ('focus', 'nct', 'nct_f_w_ended', null, v_d - 5, v_d - 1),
      ('focus', 'nct', null, v_g ->> 'watch_own', v_d - 1, v_d + 1),
      ('focus', 'nct', null, v_g ->> 'watch_member', v_d - 1, v_d + 1);

    -- Inbox: exactly the threshold in games, one over in timer. Real rows in those apps count toward the fill.
    select 5 - count(*) into v_n from public.inbox where source_app = 'games' and triaged_at is null and archived is not true;
    if v_n < 0 then raise exception 'games already has more inbox rows than the threshold'; end if;
    insert into public.inbox (id, captured_text, source_app, created_at)
    select 'nct_b_games_' || s, 'x', 'games', v_as_of - interval '1 hour' from generate_series(1, v_n) s;
    select 6 - count(*) into v_n from public.inbox where source_app = 'timer' and triaged_at is null and archived is not true;
    if v_n < 1 then raise exception 'timer already has more inbox rows than the threshold'; end if;
    insert into public.inbox (id, captured_text, source_app, created_at)
    select 'nct_b_timer_' || s, 'x', 'timer',
           case when s = 1 then v_as_of - interval '6 days' else v_as_of - interval '1 hour' end
      from generate_series(1, v_n) s;
    insert into public.inbox (id, captured_text, source_app, ai_confidence, created_at, triaged_at) values
      ('nct_u_old', E'unrouted old\nsecond line', null, null, v_as_of - interval '2 days', null),
      ('nct_u_new', 'unrouted new', null, null, v_as_of - interval '1 hour', null),
      ('nct_u_triaged', 'triaged', null, null, v_as_of - interval '2 days', now()),
      ('nct_l_below', 'low below', 'arnold', 0.59, v_as_of - interval '1 minute', null),
      ('nct_l_at', 'low at', 'arnold', 0.60, v_as_of - interval '1 minute', null);

    -- Schedules, due 08:00 on v_d with an hour's grace. Noise pushes every fixture run out of the newest 50.
    insert into public.platform_schedules (app, job, executor, cadence, day_of_week, expected_by, grace_hours, created_at) values
      ('overwatch', 'nct_stopped', 'claude', 'daily', null, '08:00', 1, now()),
      ('overwatch', 'nct_fine', 'claude', 'daily', null, '08:00', 1, now()),
      ('overwatch', 'nct_in_grace', 'claude', 'daily', null, '11:30', 1, now()),
      ('overwatch', 'nct_never', 'claude', 'daily', null, '08:00', 1, now()),
      ('overwatch', 'nct_new', 'claude', 'daily', null, '08:00', 1, v_as_of - interval '1 hour'),
      ('overwatch', 'nct_failed', 'claude', 'daily', null, '08:00', 1, now()),
      ('overwatch', 'nct_weekly', 'claude', 'weekly', extract(dow from v_d)::smallint, '08:00', 1, now()),
      ('overwatch', 'nct_weekly_old', 'claude', 'weekly', extract(dow from v_d)::smallint, '08:00', 1, now());
    insert into public.platform_runs (app, job, executor, status, started_at, finished_at)
    select 'overwatch', r.job, 'claude', r.status, r.ran_at, r.ran_at
      from (values
        ('nct_stopped', 'ok', v_as_of - interval '3 days'),
        ('nct_fine', 'ok', v_as_of - interval '2 hours'),
        ('nct_failed', 'ok', v_as_of - interval '3 days'),
        ('nct_failed', 'failed', v_as_of - interval '1 hour'),
        ('nct_weekly', 'ok', v_as_of - interval '2 hours'),
        ('nct_weekly_old', 'ok', v_as_of - interval '8 days')) r(job, status, ran_at);
    insert into public.platform_runs (app, job, executor, status, started_at, finished_at)
    select 'overwatch', 'nct_noise', 'claude', 'ok', v_as_of - interval '1 minute', v_as_of - interval '1 minute'
      from generate_series(1, 60);

    v_t0 := clock_timestamp();
    v_r := public.overwatch_nightly_counts(v_as_of);
    v_ms := round(extract(epoch from clock_timestamp() - v_t0) * 1000);

    c := c || jsonb_build_object('local_date', v_r ->> 'local_date' = v_d::text);

    -- Fading.
    v_rows := v_r -> 'fading_candidates' -> 'rows';
    foreach v_id in array array['nct_f_oneoff', 'nct_f_once', 'nct_f_done', 'nct_f_old_undone', 'nct_f_w_ease',
                                'nct_f_w_ended', 'nct_f_w_removed'] loop
      c := c || jsonb_build_object('fading_in_' || v_id, v_rows @> jsonb_build_array(jsonb_build_object('id', v_id)));
    end loop;
    foreach v_id in array array['nct_f_recurring', 'nct_f_future', 'nct_f_today', 'nct_f_undone', 'nct_f_w_focus',
                                'nct_f_w_eye', 'nct_f_w_group', 'nct_f_w_member', 'nct_f_archived', 'nct_f_someday', 'nct_i_old'] loop
      c := c || jsonb_build_object('fading_out_' || v_id, not v_rows @> jsonb_build_array(jsonb_build_object('id', v_id)));
    end loop;
    c := c || jsonb_build_object(
      'fading_intentions_only', not exists (select 1 from jsonb_array_elements(v_rows) x where x ->> 'kind' <> 'intention'),
      'fading_capped_at_50', jsonb_array_length(v_rows) <= 50);

    -- The fading line: nct_f_oneoff was touched on Jan 1 2020, Pacific. Real rows are newer, so the cap cannot hide it.
    v_r2 := public.overwatch_nightly_counts((date '2020-01-31' + time '12:00') at time zone c_tz);
    c := c || jsonb_build_object('fading_not_at_line',
      not (v_r2 -> 'fading_candidates' -> 'rows') @> '[{"id": "nct_f_oneoff"}]'::jsonb);
    v_r2 := public.overwatch_nightly_counts((date '2020-02-01' + time '12:00') at time zone c_tz);
    c := c || jsonb_build_object('fading_past_line',
      (v_r2 -> 'fading_candidates' -> 'rows') @> '[{"id": "nct_f_oneoff", "days": 31}]'::jsonb);

    -- Stalled.
    v_rows := v_r -> 'stalled';
    c := c || jsonb_build_object(
      'stalled_no_report', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'stall_none')),
      'stalled_past_line', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'stall_over', 'days', 6)),
      'stalled_not_at_line', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'stall_at')),
      'stalled_not_waiting_on_project', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'stall_wait_project')));

    -- Waiting on Alex: status_written_at is stamped now by trigger, so the clock moves instead.
    v_r2 := public.overwatch_nightly_counts(((v_today + 3 + time '12:00') at time zone c_tz));
    c := c || jsonb_build_object('waiting_not_at_line',
      not (v_r2 -> 'waiting_on_alex') @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'alex')));
    v_r2 := public.overwatch_nightly_counts(((v_today + 4 + time '12:00') at time zone c_tz));
    c := c || jsonb_build_object('waiting_past_line',
      (v_r2 -> 'waiting_on_alex') @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'alex', 'days', 4)));

    -- Overruns.
    v_rows := v_r -> 'overruns';
    c := c || jsonb_build_object(
      'overrun_steps_past', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'over_past', 'kind', 'steps', 'steps_used', 7)),
      'overrun_steps_not_at', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'over_at')),
      'overrun_target_past', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'target_past', 'kind', 'target')),
      'overrun_target_not_today', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'target_today')));

    -- Empty projects.
    v_rows := v_r -> 'empty_projects';
    c := c || jsonb_build_object(
      'empty_no_members', v_rows @> jsonb_build_array(jsonb_build_object('id', v_g ->> 'empty')),
      'empty_someday', v_rows @> jsonb_build_array(jsonb_build_object('id', v_g ->> 'empty_someday', 'status', 'someday')),
      'empty_removed_member', v_rows @> jsonb_build_array(jsonb_build_object('id', v_g ->> 'member_removed')),
      'empty_archived_member', v_rows @> jsonb_build_array(jsonb_build_object('id', v_g ->> 'member_archived')),
      'empty_not_live_member', not v_rows @> jsonb_build_array(jsonb_build_object('id', v_g ->> 'member_live')));

    -- Inbox.
    v_rows := v_r -> 'backlogs';
    c := c || jsonb_build_object(
      'backlog_past_line', v_rows @> jsonb_build_array(jsonb_build_object('app', 'timer', 'total', 6)),
      'backlog_oldest_days', (select (x ->> 'oldest_days')::int >= 6 from jsonb_array_elements(v_rows) x where x ->> 'app' = 'timer'),
      'backlog_not_at_line', not v_rows @> jsonb_build_array(jsonb_build_object('app', 'games')),
      'urgent_backlog_old', (v_r -> 'inbox_urgent' -> 'backlog_old') @> '["timer"]'::jsonb,
      'unrouted_total', (v_r #>> '{unrouted,0,total}')::int = (v_base #>> '{unrouted,0,total}')::int + 2,
      'unrouted_old', (v_r #>> '{unrouted,0,older_than_one_day}')::int = (v_base #>> '{unrouted,0,older_than_one_day}')::int + 1,
      'urgent_first_line', (v_r -> 'inbox_urgent' -> 'unrouted_old') @> jsonb_build_array(jsonb_build_object('id', 'nct_u_old', 'first_line', 'unrouted old')),
      'low_below', (v_r -> 'low_confidence_routing') @> jsonb_build_array(jsonb_build_object('id', 'nct_l_below')),
      'low_not_at', not (v_r -> 'low_confidence_routing') @> jsonb_build_array(jsonb_build_object('id', 'nct_l_at')));

    -- Stopped schedules.
    v_rows := v_r -> 'stopped_schedules';
    c := c || jsonb_build_object(
      'stopped_true_last_ok', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_stopped',
        'last_ok', ((v_as_of - interval '3 days') at time zone c_tz)::date)),
      'stopped_never_ran', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_never', 'last_ok', null)),
      'stopped_failed_is_not_ok', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_failed')),
      'stopped_weekly_old', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_weekly_old')),
      'stopped_not_fine', not v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_fine')),
      'stopped_not_in_grace', not v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_in_grace')),
      'stopped_not_new_schedule', not v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_new')),
      'stopped_not_weekly_fine', not v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_weekly')));

    -- Overdue.
    v_rows := v_r -> 'overdue_intentions';
    c := c || jsonb_build_object(
      'overdue_past_line', v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_o_past', 'days_overdue', 3)),
      'overdue_recurring_counts', v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_o_recurring')),
      'overdue_also_undone_fixture', v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_f_undone')),
      'overdue_not_at_line', not v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_o_at')),
      'overdue_not_done', not v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_f_done')),
      'overdue_not_before_window', not v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_f_old_undone')));

    -- Deadline candidates.
    v_rows := v_r -> 'deadline_candidates';
    c := c || jsonb_build_object(
      'deadline_no_event', v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_d_none', 'description', 'renew by March')),
      'deadline_old_event_only', v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_d_old')),
      'deadline_not_future_event', not v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_d_future')),
      'deadline_not_window_event', not v_rows @> jsonb_build_array(jsonb_build_object('id', 'nct_d_window')));

    -- Over limit: either side of the real count, through throwaway plans.
    v_n := jsonb_array_length(v_r -> 'projects');
    perform public.create_overwatch_plan('TEST plan', v_set || jsonb_build_object('active_project_limit', v_n), 'Test only; rolled back.');
    v_r2 := public.overwatch_nightly_counts(v_as_of);
    c := c || jsonb_build_object('over_limit_not_at_line', v_r2 -> 'over_limit' = '[]'::jsonb);
    perform public.create_overwatch_plan('TEST plan', v_set || jsonb_build_object('active_project_limit', v_n - 1), 'Test only; rolled back.');
    v_r2 := public.overwatch_nightly_counts(v_as_of);
    c := c || jsonb_build_object('over_limit_past_line',
      v_r2 -> 'over_limit' = jsonb_build_array(jsonb_build_object('count', v_n, 'limit', v_n - 1)));

    -- A missing setting leaves its count out and names it.
    perform public.create_overwatch_plan('TEST plan', (v_set - 'stall_days') - 'inventory_stale_days', 'Test only; rolled back.');
    v_r2 := public.overwatch_nightly_counts(v_as_of);
    c := c || jsonb_build_object(
      'missing_leaves_key_out', not v_r2 ? 'stalled',
      'missing_named', (v_r2 -> 'settings_missing') @> '["stall_days", "inventory_stale_days (used 7)"]'::jsonb);

    -- Security.
    c := c || jsonb_build_object(
      'invoker', (select not p.prosecdef from pg_proc p where p.oid = 'public.overwatch_nightly_counts(timestamptz)'::regprocedure),
      'stable', (select p.provolatile = 's' from pg_proc p where p.oid = 'public.overwatch_nightly_counts(timestamptz)'::regprocedure),
      'anon_cannot_execute', not has_function_privilege('anon', 'public.overwatch_nightly_counts(timestamptz)', 'execute'),
      'authenticated_can_execute', has_function_privilege('authenticated', 'public.overwatch_nightly_counts(timestamptz)', 'execute'));

    v_result := jsonb_build_object(
      'ok', not exists (select 1 from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'check_count', (select count(*) from jsonb_object_keys(c)),
      'ms', v_ms,
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('ok', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('nightly_counts.result', v_result::text, false);
end;
$$;

select current_setting('nightly_counts.result')::jsonb as result;
