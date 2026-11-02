-- nightly_counts-f8k: test the stopped-schedule rule and active_yesterday in public.overwatch_nightly_counts.
-- Runs after the stopped-rule migration, with --test. It undoes itself: the inner block ends in its own error, the checks
-- survive in a variable, and the result row says { ok, failed, checks }. The clock is pinned 40 days ahead and only the
-- fixtures (jobs nct_*) are checked. active_yesterday reads real activity, so it writes nothing: an app's first ever
-- active day has activity that day and none the day before, whatever else it has since.

do $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  c_done    constant text := 'NCT_UNDO';
  v_d       date := (now() at time zone c_tz)::date + 40;
  v_set     jsonb := '{"stall_days": 5, "waiting_on_alex_days": 3, "fading_days": 30, "overdue_days": 2,
                       "overrun_factor": 1.5, "active_project_limit": 1000, "inbox_backlog_threshold": 5,
                       "routing_low_confidence": 0.6, "urgent_within_days": 7, "inventory_stale_days": 7}';
  v_dow     smallint := extract(dow from v_d)::smallint;
  v_rows    jsonb;
  v_app     text;
  v_first   date;
  c         jsonb := '{}';
  v_result  jsonb;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    perform public.create_overwatch_plan('TEST plan', v_set, 'Test only; rolled back.');

    -- All due 08:00 with 6 hours' grace, so grace ends at 14:00, except nct_grace (15:00) and the weekly pair, due on v_d.
    insert into public.platform_schedules (app, job, executor, cadence, day_of_week, expected_by, grace_hours, created_at) values
      ('overwatch', 'nct_midnight', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_morning_before', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_ran_late_yesterday', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_at_previous_grace', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_after_previous_grace', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_long_gone', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_never', 'claude', 'daily', null, '08:00', 6, now()),
      ('overwatch', 'nct_grace', 'claude', 'daily', null, '08:00', 7, now()),
      ('overwatch', 'nct_created_late', 'claude', 'daily', null, '08:00', 6, ((v_d + time '09:00') at time zone c_tz)),
      ('overwatch', 'nct_week_inside', 'claude', 'weekly', v_dow, '08:00', 6, now()),
      ('overwatch', 'nct_week_outside', 'claude', 'weekly', v_dow, '08:00', 6, now());

    insert into public.platform_runs (app, job, executor, status, started_at, finished_at)
    select 'overwatch', r.job, 'claude', 'ok', r.ran_at, r.ran_at
      from (values
        ('nct_midnight', ((v_d + time '00:16') at time zone c_tz)),
        ('nct_morning_before', ((v_d - 1 + time '07:00') at time zone c_tz)),
        ('nct_ran_late_yesterday', ((v_d - 1 + time '09:00') at time zone c_tz)),
        ('nct_at_previous_grace', ((v_d - 1 + time '14:00') at time zone c_tz)),
        ('nct_after_previous_grace', ((v_d - 1 + time '14:01') at time zone c_tz)),
        ('nct_long_gone', ((v_d - 3 + time '07:00') at time zone c_tz)),
        ('nct_grace', ((v_d - 3 + time '07:00') at time zone c_tz)),
        ('nct_week_inside', ((v_d - 7 + time '14:01') at time zone c_tz)),
        ('nct_week_outside', ((v_d - 7 + time '09:00') at time zone c_tz))) r(job, ran_at);

    -- 14:35, past most jobs' grace: the time of the false alarm.
    v_rows := public.overwatch_nightly_counts((v_d + time '14:35') at time zone c_tz) -> 'stopped_schedules';
    c := c || jsonb_build_object(
      'ran_before_due_not_stopped', not v_rows @> '[{"job": "nct_midnight"}]'::jsonb,
      'no_run_since_previous_due_stopped', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_morning_before', 'last_ok', v_d - 1)),
      'ran_09_00_yesterday_stopped', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_ran_late_yesterday', 'last_ok', v_d - 1)),
      'run_exactly_at_previous_grace_stopped', v_rows @> '[{"job": "nct_at_previous_grace"}]'::jsonb,
      'run_after_previous_grace_not_stopped', not v_rows @> '[{"job": "nct_after_previous_grace"}]'::jsonb,
      'long_gone_stopped', v_rows @> jsonb_build_array(jsonb_build_object('job', 'nct_long_gone', 'last_ok', v_d - 3)),
      'never_ran_stopped', v_rows @> '[{"job": "nct_never", "last_ok": null}]'::jsonb,
      'in_grace_not_stopped', not v_rows @> '[{"job": "nct_grace"}]'::jsonb,
      'created_after_due_not_stopped', not v_rows @> '[{"job": "nct_created_late"}]'::jsonb,
      'weekly_inside_window_not_stopped', not v_rows @> '[{"job": "nct_week_inside"}]'::jsonb,
      'weekly_outside_window_stopped', v_rows @> '[{"job": "nct_week_outside"}]'::jsonb);

    -- 15:01: nct_grace's grace is over.
    v_rows := public.overwatch_nightly_counts((v_d + time '15:01') at time zone c_tz) -> 'stopped_schedules';
    c := c || jsonb_build_object('grace_over_stopped', v_rows @> '[{"job": "nct_grace"}]'::jsonb);

    -- 04:20, the nightly's time: the current due time is yesterday's.
    v_rows := public.overwatch_nightly_counts((v_d + time '04:20') at time zone c_tz) -> 'stopped_schedules';
    c := c || jsonb_build_object(
      'nightly_ran_yesterday_morning_not_stopped', not v_rows @> '[{"job": "nct_morning_before"}]'::jsonb,
      'nightly_long_gone_stopped', v_rows @> '[{"job": "nct_long_gone"}]'::jsonb);

    -- active_yesterday: on an app's first active day there is activity today and none yesterday.
    select a.app_id, min((a.occurred_at at time zone c_tz)::date) into v_app, v_first
      from public.activity a group by a.app_id order by 2 desc limit 1;
    if v_app is null then raise exception 'no activity rows to test active_yesterday with'; end if;
    v_rows := public.overwatch_nightly_counts((v_first + time '12:00') at time zone c_tz) -> 'apps';
    c := c || jsonb_build_object('only_today_not_active_yesterday',
      v_rows @> jsonb_build_array(jsonb_build_object('app_id', v_app, 'active_yesterday', false)));
    v_rows := public.overwatch_nightly_counts((v_first + 1 + time '12:00') at time zone c_tz) -> 'apps';
    c := c || jsonb_build_object('next_day_active_yesterday',
      v_rows @> jsonb_build_array(jsonb_build_object('app_id', v_app, 'active_yesterday', true)));

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
  perform set_config('nightly_counts.result', v_result::text, false);
end;
$$;

select current_setting('nightly_counts.result')::jsonb as result;
