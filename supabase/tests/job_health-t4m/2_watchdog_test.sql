-- Job health job_health-t4m s6: the watchdog. Run after the watchdog migration, through the queue with --test.
-- It runs the watchdog at chosen times on 2030-01-15 (Pacific), far past any real run, with runs it inserts, and
-- undoes everything. Result: one row, with all_passed, failed and checks.
--   06:30  the morning anchor: the first Claude run is due about 5:09, so no outage yet;
--   10:00  an outage (nothing since 5:15): one inbox item and one reminder; 10:15 adds nothing;
--   10:30  three stuck runs (wb-sync 25 min, wb-sync from three days ago, the dispatcher 25 min) and recovery, since
--          the stuck dispatcher run is a Claude run: one recovery item listing the missed runs; 10:45 adds nothing;
--   get_job_health's shape.
-- supabase/tests/job_health-t4m/2_watchdog_test.sql

do $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  v_owner   uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_checks  jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_state   public.job_health_state;
  v_recent  uuid;
  v_old     uuid;
  v_disp    uuid;
  v_run     public.platform_runs;
  v_health  jsonb;
  v_text    text;
  n         int;
begin
  begin
    delete from public.job_health_state where user_id = v_owner;

    -- 1. 06:30: the morning anchor is 5:15, only 1 h 15 min ago.
    perform public.job_health_watchdog(timestamp '2030-01-15 06:30' at time zone c_tz);
    select * into v_state from public.job_health_state where user_id = v_owner;
    v_checks := v_checks
      || jsonb_build_object('a_morning_no_outage', v_state.outage_started_at is null)
      || jsonb_build_object('a_morning_no_item', not exists (
           select 1 from public.inbox where user_id = v_owner and created_at >= now() and captured_text like 'Claude tasks stopped%'))
      || jsonb_build_object('a_state_stamped', v_state.last_watchdog_run_at = timestamp '2030-01-15 06:30' at time zone c_tz)
      || jsonb_build_object('a_no_error', v_state.last_watchdog_error is null);

    -- 2. 10:00: an outage since 5:15.
    perform public.job_health_watchdog(timestamp '2030-01-15 10:00' at time zone c_tz);
    select * into v_state from public.job_health_state where user_id = v_owner;
    select count(*) into n from public.inbox
    where user_id = v_owner and created_at >= now() and captured_text like 'Claude tasks stopped%';
    v_checks := v_checks
      || jsonb_build_object('b_outage_open', v_state.outage_started_at = timestamp '2030-01-15 05:15' at time zone c_tz)
      || jsonb_build_object('b_one_outage_item', n = 1)
      || jsonb_build_object('b_item_wording', (
           select captured_text like 'Claude tasks stopped at 5:15 AM%(4 h 45 min)%Kind: outage.%'
                  || 'Review missed jobs since 5:15 AM and give me the recovery plan.%'
           from public.inbox where id = v_state.outage_inbox_id))
      || jsonb_build_object('b_item_fields', (
           select source_app = 'overwatch' and source_type = 'task' and ai_status = 'complete'
                  and source_metadata ->> 'kind' = 'job_health'
           from public.inbox where id = v_state.outage_inbox_id))
      || jsonb_build_object('b_one_reminder', (
           select count(*) = 1 from public.reminders
           where inbox_id = v_state.outage_inbox_id and state = 'scheduled' and started_by = 'task:job-health-watchdog'
             and created_by = 'app' and text like 'Claude tasks stopped at 5:15 AM. Outage:%'));

    -- 3. 10:15: the same outage, no second alert.
    perform public.job_health_watchdog(timestamp '2030-01-15 10:15' at time zone c_tz);
    select count(*) into n from public.inbox
    where user_id = v_owner and created_at >= now() and captured_text like 'Claude tasks stopped%';
    v_checks := v_checks || jsonb_build_object('c_no_second_outage_item', n = 1);

    -- 4. 10:30: stuck runs, then recovery (the dispatcher's 10:05 run is a Claude run).
    insert into public.platform_runs (user_id, app, job, executor, status, started_at)
    values (v_owner, 'warren_buffet', 'wb-sync', 'alfred', 'running', timestamp '2030-01-15 10:05' at time zone c_tz)
    returning id into v_recent;
    insert into public.platform_runs (user_id, app, job, executor, status, started_at)
    values (v_owner, 'warren_buffet', 'wb-sync', 'alfred', 'running', timestamp '2030-01-12 10:00' at time zone c_tz)
    returning id into v_old;
    insert into public.platform_runs (user_id, app, job, executor, status, started_at)
    values (v_owner, 'alfred', 'claude_hourly_notifications', 'claude', 'running', timestamp '2030-01-15 10:05' at time zone c_tz)
    returning id into v_disp;

    perform public.job_health_watchdog(timestamp '2030-01-15 10:30' at time zone c_tz);

    select * into v_run from public.platform_runs where id = v_recent;
    v_checks := v_checks
      || jsonb_build_object('d_recent_marked', v_run.status = 'failed' and v_run.details ->> 'failure_kind' = 'stuck'
           and (v_run.details ->> 'ran_minutes')::int = 25 and (v_run.details ->> 'max_run_minutes')::int = 10
           and v_run.error_message = 'Still running after 25 minutes; marked stuck by the job-health watchdog.')
      || jsonb_build_object('d_recent_signal', exists (
           select 1 from public.signals
           where user_id = v_owner and source_ref = 'job_health:stuck:' || v_recent
             and subject_key = 'wb-sync:failure:kind:stuck' and severity = 'low' and started_by = 'task:wb-sync'
             and state = 'queued' and details ->> 'failure_kind' = 'stuck'
             and details -> 'item' ->> 'captured_text' like 'wb-sync was stuck and has been marked failed%Kind: fix needed.%'
             and details -> 'item' ->> 'source_app' = 'warren_buffet'))
      || jsonb_build_object('d_old_marked', (select status = 'failed' and details ->> 'failure_kind' = 'stuck'
                                             from public.platform_runs where id = v_old))
      || jsonb_build_object('d_old_no_signal', not exists (
           select 1 from public.signals where source_ref = 'job_health:stuck:' || v_old))
      || jsonb_build_object('d_dispatcher_signal', exists (
           select 1 from public.signals
           where source_ref = 'job_health:stuck:' || v_disp
             and subject_key = 'alfred:claude_hourly_notifications:failure:stuck' and severity = 'high'))
      || jsonb_build_object('d_dispatcher_direct_item', (
           select count(*) = 1 from public.inbox i
           join public.reminders rm on rm.inbox_id = i.id
           where i.user_id = v_owner and i.created_at >= now()
             and i.captured_text like 'claude_hourly_notifications was stuck%'
             and rm.text like 'The hourly dispatcher hung at 10:05 AM. Fix needed:%'));

    select * into v_state from public.job_health_state where user_id = v_owner;
    select captured_text into v_text from public.inbox
    where user_id = v_owner and created_at >= now() and captured_text like 'Claude tasks are running again%';
    v_checks := v_checks
      || jsonb_build_object('e_outage_closed', v_state.outage_started_at is null
           and v_state.last_outage_started_at = timestamp '2030-01-15 05:15' at time zone c_tz
           and v_state.last_recovery_at = timestamp '2030-01-15 10:05' at time zone c_tz)
      || jsonb_build_object('e_recovery_item', v_text like 'Claude tasks are running again: 5:15 AM to 10:05 AM%'
           || 'Missed runs:%claude-hourly-notifications (alfred/claude_hourly_notifications), 6:00 AM, 7:00 AM%'
           || 'skip. Not worth running late%Review missed jobs since 5:15 AM%')
      || jsonb_build_object('e_recovery_reminder', exists (
           select 1 from public.reminders rm join public.inbox i on i.id = rm.inbox_id
           where i.user_id = v_owner and i.created_at >= now() and i.captured_text like 'Claude tasks are running again%'
             and rm.text ~ '^Claude tasks are running again\. \d+ runs missed, \d+ to run by hand\. List in your inbox\.$'))
      || jsonb_build_object('e_sweep_counts', (v_state.last_sweep ->> 'signalled')::int >= 2
           and (v_state.last_sweep ->> 'alerted')::int = 1);

    -- 5. 10:45: no second recovery item.
    perform public.job_health_watchdog(timestamp '2030-01-15 10:45' at time zone c_tz);
    select count(*) into n from public.inbox
    where user_id = v_owner and created_at >= now() and captured_text like 'Claude tasks are running again%';
    v_checks := v_checks || jsonb_build_object('f_no_second_recovery_item', n = 1);

    -- 6. get_job_health, as the owner.
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    v_health := public.get_job_health(timestamp '2030-01-15 05:00' at time zone c_tz,
                                      timestamp '2030-01-15 10:50' at time zone c_tz);
    v_checks := v_checks
      || jsonb_build_object('g_shape', v_health ?& array['since', 'watchdog', 'outage', 'stuck_runs', 'missed_runs'])
      || jsonb_build_object('g_watchdog_healthy', (v_health -> 'watchdog' ->> 'healthy')::boolean
           and (v_health -> 'watchdog' ->> 'minutes_since')::int = 5)
      || jsonb_build_object('g_outage_closed', not (v_health -> 'outage' ->> 'open')::boolean
           and v_health -> 'outage' ->> 'last_outage_started_at' is not null)
      || jsonb_build_object('g_stuck_listed', exists (
           select 1 from jsonb_array_elements(v_health -> 'stuck_runs') e where e ->> 'id' = v_recent::text
             and (e ->> 'swept')::boolean))
      || jsonb_build_object('g_missed_listed', jsonb_array_length(v_health -> 'missed_runs') > 0)
      || jsonb_build_object('g_missed_has_catch_up', not exists (
           select 1 from jsonb_array_elements(v_health -> 'missed_runs') e where e ->> 'catch_up' is null));

    -- 7. Grants and the platform.
    v_checks := v_checks
      || jsonb_build_object('h_watchdog_private', not has_function_privilege('authenticated', 'public.job_health_watchdog(timestamptz)', 'execute')
           and not has_function_privilege('anon', 'public.job_health_watchdog(timestamptz)', 'execute'))
      || jsonb_build_object('h_tool_rpc_granted', has_function_privilege('authenticated', 'public.get_job_health(timestamptz, timestamptz)', 'execute')
           and not has_function_privilege('anon', 'public.get_job_health(timestamptz, timestamptz)', 'execute'))
      || jsonb_build_object('h_state_read_only', has_table_privilege('authenticated', 'public.job_health_state', 'select')
           and not has_table_privilege('authenticated', 'public.job_health_state', 'insert')
           and not has_table_privilege('anon', 'public.job_health_state', 'select'))
      || jsonb_build_object('h_cron_job', exists (
           select 1 from cron.job where jobname = 'job-health-every-15-min' and schedule = '*/15 * * * *' and active))
      || jsonb_build_object('h_conformant', not exists (
           select 1 from platform.conformance_failures f where f.table_name like '%job_health%'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'job_health_watchdog_undo';
  exception when others then
    if sqlerrm <> 'job_health_watchdog_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('job_health.watchdog_result', v_result::text, true);
end;
$$;

select current_setting('job_health.watchdog_result')::jsonb as result;
