-- Job health job_health-t4m s9: the Job health check's schedule row and claude_reader's access. Run after the health
-- check schedule migration, through the queue with --test. Read-only checks, in a block that undoes itself anyway.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/job_health-t4m/3_health_check_schedule_test.sql

do $$
declare
  v_owner  uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_row    public.platform_schedules;
  n        int;
begin
  begin
    -- a. The row.
    select * into v_row from public.platform_schedules
    where user_id = v_owner and app = 'alfred' and job = 'job_health_check';
    v_checks := v_checks
      || jsonb_build_object('a_row_exists', v_row.id is not null)
      || jsonb_build_object('a_values', v_row.executor = 'claude' and v_row.cadence = 'daily'
           and v_row.expected_by = time '06:00' and v_row.grace_hours = 2 and v_row.enabled
           and v_row.max_run_minutes = 10 and v_row.catch_up is null and v_row.failure_subject is null
           and v_row.failure_severity is null and v_row.hourly_until is null
           and v_row.started_by = 'task:job-health-check')
      || jsonb_build_object('a_notes_name_the_prompt', v_row.notes like '%docs/claude-health-check-task-prompt.md (PROMPT VERSION 2026-11-17a)%')
      || jsonb_build_object('a_fourteen_schedules', (select count(*) = 14 from public.platform_schedules where user_id = v_owner));

    -- b. claude_reader can select every column of both tables (237's six included); anon nothing.
    select count(*) into n from information_schema.columns c
    where c.table_schema = 'public' and c.table_name in ('platform_schedules', 'job_health_state')
      and not has_column_privilege('claude_reader', format('public.%I', c.table_name), c.column_name, 'select');
    v_checks := v_checks
      || jsonb_build_object('b_reader_columns_missing', n)
      || jsonb_build_object('b_reader_reads_all_columns', n = 0)
      || jsonb_build_object('b_reader_new_columns', has_column_privilege('claude_reader', 'public.platform_schedules', 'max_run_minutes', 'select')
           and has_column_privilege('claude_reader', 'public.platform_schedules', 'catch_up', 'select')
           and has_column_privilege('claude_reader', 'public.platform_schedules', 'hourly_until', 'select')
           and has_column_privilege('claude_reader', 'public.platform_schedules', 'failure_subject', 'select')
           and has_column_privilege('claude_reader', 'public.platform_schedules', 'failure_severity', 'select')
           and has_column_privilege('claude_reader', 'public.platform_schedules', 'started_by', 'select'))
      || jsonb_build_object('b_reader_policies', (select count(*) = 2 from pg_policy
           where polname = 'claude_reader_read'
             and polrelid in ('public.platform_schedules'::regclass, 'public.job_health_state'::regclass)))
      || jsonb_build_object('b_reader_cannot_write', not has_table_privilege('claude_reader', 'public.platform_schedules', 'insert')
           and not has_table_privilege('claude_reader', 'public.job_health_state', 'update'))
      || jsonb_build_object('b_anon_nothing', not has_table_privilege('anon', 'public.platform_schedules', 'select')
           and not has_table_privilege('anon', 'public.job_health_state', 'select')
           and not has_column_privilege('anon', 'public.platform_schedules', 'max_run_minutes', 'select'));

    -- c. The platform has no complaint.
    v_checks := v_checks || jsonb_build_object('c_conformant', not exists (
      select 1 from platform.conformance_failures f
      where f.table_name like '%platform_schedules%' or f.table_name like '%job_health%'));

    v_result := jsonb_build_object(
      'all_passed', not exists (
        select 1 from jsonb_each(v_checks) where key <> 'b_reader_columns_missing' and value <> 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks)
                 where key <> 'b_reader_columns_missing' and value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'job_health_schedule_row_undo';
  exception when others then
    if sqlerrm <> 'job_health_schedule_row_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('job_health.health_check_schedule_result', v_result::text, true);
end;
$$;

select current_setting('job_health.health_check_schedule_result')::jsonb as result;
