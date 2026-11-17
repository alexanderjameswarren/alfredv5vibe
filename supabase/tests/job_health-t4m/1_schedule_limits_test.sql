-- Job health job_health-t4m s5: the platform_schedules limits columns. Run after the schedule limits migration,
-- through the queue with --test. It changes rows only to prove the checks refuse bad values, and undoes itself.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/job_health-t4m/1_schedule_limits_test.sql

do $$
declare
  v_checks jsonb := '{}'::jsonb;
  v_ok boolean;
  v_result jsonb;
  n int;
begin
  begin
    -- a. The six columns exist with their types.
    v_checks := v_checks || jsonb_build_object('a_columns', (
      select count(*) = 6 from information_schema.columns
      where table_schema = 'public' and table_name = 'platform_schedules'
        and (column_name, data_type) in (
          ('hourly_until', 'time without time zone'), ('max_run_minutes', 'integer'), ('catch_up', 'text'),
          ('failure_subject', 'text'), ('failure_severity', 'text'), ('started_by', 'text'))));
    v_checks := v_checks || jsonb_build_object('a_comments', (
      select count(*) = 6 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'platform_schedules'
        and c.column_name in ('hourly_until', 'max_run_minutes', 'catch_up', 'failure_subject', 'failure_severity', 'started_by')
        and col_description('public.platform_schedules'::regclass, c.ordinal_position) is not null));

    -- b. The checks refuse bad values.
    begin update public.platform_schedules set catch_up = 'later' where job = 'wb-sync'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_catch_up_refused', v_ok);

    begin update public.platform_schedules set max_run_minutes = 0 where job = 'wb-sync'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_max_run_minutes_zero_refused', v_ok);

    begin update public.platform_schedules set failure_severity = 'loud' where job = 'wb-sync'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_severity_refused', v_ok);

    begin update public.platform_schedules set failure_subject = 'Bad Subject {kind}' where job = 'wb-sync'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_subject_refused', v_ok);

    begin update public.platform_schedules set started_by = 'robot' where job = 'wb-sync'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_started_by_refused', v_ok);

    begin update public.platform_schedules set hourly_until = time '23:00' where app = 'overwatch' and job = 'weekly'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_hourly_until_on_weekly_refused', v_ok);

    begin update public.platform_schedules set hourly_until = time '04:00' where job = 'claude_hourly_notifications'; v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('b_hourly_until_before_expected_by_refused', v_ok);

    -- A good value is accepted (undone with the rest).
    begin update public.platform_schedules set catch_up = 'run_now' where job = 'wb-sync'; v_ok := true;
    exception when others then v_ok := false; end;
    v_checks := v_checks || jsonb_build_object('b_good_catch_up_accepted', v_ok);
    update public.platform_schedules set catch_up = 'self' where job = 'wb-sync';

    -- c. Every row has the agreed values (spec §4), and no row is missing or extra.
    with expected(app, job, hourly_until, max_run_minutes, catch_up, failure_subject, failure_severity, started_by) as (values
      ('alfred',        'claude_hourly_notifications', time '19:00', 10, 'skip',    'alfred:claude_hourly_notifications:failure:{kind}', 'high', 'task:claude-hourly-notifications'),
      ('alfred',        'inbox_enrich_hourly',         time '21:00', 10, 'self',    'alfred:inbox_enrich_hourly:failure:{kind}',         'high', 'task:hourly-inbox-enrichment'),
      ('alfred',        'notify-dispatch',             null,         null, null,    null,                                                null,   null),
      ('arnold',        'arnold_morning_review',       null,         10, 'skip',    'arnold:arnold_morning_review:failure',              'high', 'task:arnold-morning-review'),
      ('dj',            'daily_history_sync',          null,         15, 'run_now', 'dj:daily_history_sync:failure:{kind}',              'high', 'task:dj-daily'),
      ('dj',            'weekly_review',               null,         20, 'run_now', 'dj:weekly_review:failure',                          'high', 'task:dj-weekly-review'),
      ('drive_mix',     'daily_refresh',               null,         20, 'self',    'drive_mix:daily_refresh:failure:{kind}',            'high', 'task:drive-mix-daily-refresh'),
      ('ken',           'ken_seed_check',              null,         10, 'self',    'ken:ken_seed_check:failure:{kind}',                 'high', 'task:ken-seed-check'),
      ('overwatch',     'nightly',                     null,         30, 'self',    'overwatch:nightly:failure:{kind}',                  'high', 'task:overwatch-nightly'),
      ('overwatch',     'weekly',                      null,         30, 'run_now', 'overwatch:weekly:failure:{kind}',                   'high', 'task:overwatch-weekly'),
      ('sam',           'daily_plan_review',           null,         15, 'self',    'sam:daily_plan_review:failure:{kind}',              'high', 'task:sam-daily-review'),
      ('warren_buffet', 'wb_weekly_cleanup',           null,         20, 'self',    'warren_buffet:wb_weekly_cleanup:failure:{kind}',    'high', 'task:money-cleanup'),
      ('warren_buffet', 'wb-sync',                     null,         10, 'self',    'wb-sync:failure:kind:{kind}',                       'low',  'task:wb-sync')
    )
    select count(*) into n
    from expected e
    full join public.platform_schedules s on s.app = e.app and s.job = e.job
    where e.app is null or s.app is null
       or s.hourly_until     is distinct from e.hourly_until
       or s.max_run_minutes  is distinct from e.max_run_minutes
       or s.catch_up         is distinct from e.catch_up
       or s.failure_subject  is distinct from e.failure_subject
       or s.failure_severity is distinct from e.failure_severity
       or s.started_by       is distinct from e.started_by;
    v_checks := v_checks || jsonb_build_object('c_rows_mismatched_or_missing', n, 'c_values_agreed', n = 0);
    v_checks := v_checks || jsonb_build_object('c_row_count_13', (select count(*) = 13 from public.platform_schedules));

    -- d. Grants unchanged: anon gets nothing; the platform has no complaint about the table.
    v_checks := v_checks
      || jsonb_build_object('d_anon_no_select', not has_table_privilege('anon', 'public.platform_schedules', 'select'))
      || jsonb_build_object('d_authenticated_select', has_table_privilege('authenticated', 'public.platform_schedules', 'select'))
      || jsonb_build_object('d_conformant', not exists (
           select 1 from platform.conformance_failures f where f.table_name like '%platform_schedules%'));

    v_result := jsonb_build_object(
      'all_passed', not exists (
        select 1 from jsonb_each(v_checks) where key <> 'c_rows_mismatched_or_missing' and value <> 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks)
                 where key <> 'c_rows_mismatched_or_missing' and value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'job_health_schedule_limits_undo';
  exception when others then
    if sqlerrm <> 'job_health_schedule_limits_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('job_health.schedule_limits_result', v_result::text, true);
end;
$$;

select current_setting('job_health.schedule_limits_result')::jsonb as result;
