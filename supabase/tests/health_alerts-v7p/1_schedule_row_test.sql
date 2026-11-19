-- health_alerts-v7p s4: the Job health check's schedule row after the 2026-11-19a migration. Run after it, through the
-- queue with --test. Read-only checks, in a block that undoes itself anyway.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/health_alerts-v7p/1_schedule_row_test.sql

do $$
declare
  v_owner  uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_row    public.platform_schedules;
  n        int;
begin
  begin
    -- a. Exactly one row.
    select count(*) into n from public.platform_schedules
    where user_id = v_owner and app = 'alfred' and job = 'job_health_check';
    v_checks := v_checks || jsonb_build_object('a_one_row', n = 1);

    select * into v_row from public.platform_schedules
    where user_id = v_owner and app = 'alfred' and job = 'job_health_check';

    -- b. The new values.
    v_checks := v_checks
      || jsonb_build_object('b_failure_subject', v_row.failure_subject = 'alfred:job_health_check:failure:{kind}')
      || jsonb_build_object('b_failure_severity', v_row.failure_severity = 'high')
      || jsonb_build_object('b_stuck_subject_valid',
           replace(v_row.failure_subject, '{kind}', 'stuck') ~ '^[a-z0-9][a-z0-9:_.-]{0,199}$')
      || jsonb_build_object('b_notes_name_19a', v_row.notes like '%PROMPT VERSION 2026-11-19a%')
      || jsonb_build_object('b_notes_push_off', v_row.notes like '%Push is off%');

    -- c. Unchanged from 239.
    v_checks := v_checks
      || jsonb_build_object('c_unchanged', v_row.executor = 'claude' and v_row.cadence = 'daily'
           and v_row.expected_by = time '06:00' and v_row.grace_hours = 2 and v_row.enabled
           and v_row.max_run_minutes = 10 and v_row.catch_up is null and v_row.hourly_until is null
           and v_row.started_by = 'task:job-health-check');

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'health_alerts_schedule_row_undo';
  exception when others then
    if sqlerrm <> 'health_alerts_schedule_row_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('health_alerts.schedule_row_result', v_result::text, true);
end;
$$;

select current_setting('health_alerts.schedule_row_result')::jsonb as result;
