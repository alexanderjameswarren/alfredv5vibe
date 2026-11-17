-- Job health job_health-t4m s6/s6b: the Alfred watchdog. Kind: schema change (one new table, registered; eight new
-- functions; one pg_cron job). Spec: docs/technical-spec-job_health-t4m.md 5.1, 6, 6.2, 7, 8.1, 9.2, 9.3 (Parts B, C,
-- E, F and O4). Applied: NO (queued at s6b; only a run id shows it ran).
-- Tables read: platform_runs, platform_schedules (migration 237's columns). Tables written by the watchdog:
-- platform_runs (stuck runs marked failed), signals (direct insert, as raise_signal would), inbox and reminders
-- (outage, recovery and the stuck dispatcher only), job_health_state (new).
-- Test: supabase/tests/job_health-t4m/2_watchdog_test.sql.
--
-- Every 15 minutes pg_cron runs public.job_health_watchdog(), which for each user with schedules:
--   a. sweeps runs still running past their schedule's max_run_minutes: marked failed (failure_kind stuck); a run
--      started in the last 24 hours also gets the job's own failure signal, older ones are only marked;
--   b. watches the Claude heartbeat (the newest run with executor claude, or 5:15 AM today if later): between
--      5 AM and 8 PM Pacific, more than 2 hours without one opens an outage, with ONE inbox item and ONE reminder;
--   c. closes the outage when a Claude run arrives, with ONE recovery item listing the missed runs, and a reminder;
--   d. for a stuck hourly dispatcher (claude_hourly_notifications), also writes its inbox item and reminder directly,
--      since the dispatcher cannot deliver its own failure (O4);
--   e. stamps job_health_state.
-- notify-dispatch pushes each reminder within a minute. No HTTP, no secret.
--
-- Every function takes p_now (default now()) so the test can run them at chosen times; nothing else passes it.
-- supabase/migrations/238_watchdog.sql

-- ============================================================================
-- 1. job_health_state: one row per user, written by the watchdog every 15 minutes.
-- ============================================================================
create table if not exists public.job_health_state (
  user_id                 uuid        primary key default auth.uid() references auth.users (id) on delete cascade,
  last_watchdog_run_at    timestamptz,
  last_watchdog_error     text,
  last_heartbeat_at       timestamptz,
  outage_started_at       timestamptz,
  outage_alerted_at       timestamptz,
  outage_inbox_id         text,
  last_recovery_at        timestamptz,
  last_outage_started_at  timestamptz,
  last_sweep              jsonb       not null default '{}'::jsonb,
  updated_at              timestamptz not null default now(),
  constraint job_health_state_last_sweep_object check (jsonb_typeof(last_sweep) = 'object')
);

comment on table public.job_health_state is
  'Job health: the Alfred watchdog''s state, one row per user. Written only by job_health_watchdog (pg_cron '
  'job-health-every-15-min); read by get_job_health. An open outage has outage_started_at set.';
comment on column public.job_health_state.user_id is 'The owner; one row each.';
comment on column public.job_health_state.last_watchdog_run_at is 'When the watchdog last ran (its p_now). get_job_health calls it healthy within 35 minutes.';
comment on column public.job_health_state.last_watchdog_error is 'The parts that failed on the last run, verbatim (sweep: ...; heartbeat: ...), or null when all ran.';
comment on column public.job_health_state.last_heartbeat_at is 'The newest started_at of any platform_runs row with executor claude, as of the last run.';
comment on column public.job_health_state.outage_started_at is 'Open outage: the heartbeat anchor it is counted from (the last Claude run, or 5:15 AM). Null when no outage is open.';
comment on column public.job_health_state.outage_alerted_at is 'When the open outage''s inbox item and reminder were written. One alert per outage.';
comment on column public.job_health_state.outage_inbox_id is 'The open outage''s inbox item.';
comment on column public.job_health_state.last_recovery_at is 'When the last outage closed: the start of the Claude run that ended it.';
comment on column public.job_health_state.last_outage_started_at is 'The last closed outage''s start, for "review missed jobs since <time>".';
comment on column public.job_health_state.last_sweep is 'The last run''s sweep: {at, swept, signalled, alerted}.';
comment on column public.job_health_state.updated_at is 'When the row last changed.';

-- Not audited: written every 15 minutes. Only the watchdog writes it, so authenticated reads only (owner RLS).
select platform.register_table('public.job_health_state', p_audited => false);
revoke insert, update, delete on public.job_health_state from authenticated;

-- ============================================================================
-- 2. Wording helpers (Part F): friendly Pacific times, durations, catch-up lines.
-- ============================================================================

-- "9:40 AM", or "9:40 AM on Nov 16" when it is not p_now's Pacific day.
create or replace function public.job_health_when(p_at timestamptz, p_now timestamptz default now())
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_at is null then 'an unknown time'
    when (p_at at time zone 'America/Los_Angeles')::date = (p_now at time zone 'America/Los_Angeles')::date
      then to_char(p_at at time zone 'America/Los_Angeles', 'FMHH12:MI AM')
    else to_char(p_at at time zone 'America/Los_Angeles', 'FMHH12:MI AM "on" Mon FMDD')
  end
$$;
comment on function public.job_health_when(timestamptz, timestamptz) is
  'Job health: a time for alert wording, 12-hour Pacific ("9:40 AM"), with the date ("on Nov 16") when it is not p_now''s day.';

-- "45 min", or "3 h 5 min".
create or replace function public.job_health_duration(p interval)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p < interval '1 hour' then greatest(floor(extract(epoch from p) / 60), 0)::int || ' min'
    else floor(extract(epoch from p) / 3600)::int || ' h ' || (floor(extract(epoch from p) / 60)::int % 60) || ' min'
  end
$$;
comment on function public.job_health_duration(interval) is 'Job health: a duration for alert wording ("45 min", "3 h 5 min").';

-- A job's task name for alert wording: its started_by without "task:", else app/job.
create or replace function public.job_health_task_name(p_started_by text, p_app text, p_job text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(nullif(regexp_replace(coalesce(p_started_by, ''), '^task:', ''), ''), p_app || '/' || p_job)
$$;
comment on function public.job_health_task_name(text, text, text) is
  'Job health: the name alerts use for a job: its schedule''s started_by without "task:" (the scheduled task''s name), else app/job.';

-- What happens about a missed or stuck run, by its catch_up rule (spec 7), as one sentence.
create or replace function public.job_health_catch_up_line(p_catch_up text, p_task_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_catch_up
    when 'self'    then 'The next run covers the gap: nothing to do.'
    when 'skip'    then 'Not worth running late: nothing to do.'
    when 'run_now' then format('Run it once by hand: open the ''%s'' task in claude.ai and press Run now.', p_task_name)
    else 'No catch-up rule is set for this job.'
  end
$$;
comment on function public.job_health_catch_up_line(text, text) is
  'Job health: the recovery sentence for a catch_up rule (self, skip, run_now), for alert wording.';

revoke all on function public.job_health_when(timestamptz, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.job_health_duration(interval) from public, anon, authenticated, service_role;
revoke all on function public.job_health_task_name(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.job_health_catch_up_line(text, text) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. job_health_missed_runs: expected runs with no run in their slot (spec 7).
-- ============================================================================
-- Security invoker: called as authenticated (through get_job_health), owner RLS keeps it to the caller's own rows.
create or replace function public.job_health_missed_runs(
  p_user uuid,
  p_from timestamptz,
  p_to   timestamptz default now()
)
returns table (app text, job text, executor text, expected_at timestamptz, catch_up text, task_name text)
language sql
stable
set search_path = ''
as $$
  with s as (
    select ps.app, ps.job, ps.executor, ps.cadence, ps.day_of_week, ps.expected_by, ps.grace_hours,
           ps.hourly_until, ps.catch_up,
           -- As job_health_task_name, inlined: this runs as the caller, who cannot execute the helper.
           coalesce(nullif(regexp_replace(coalesce(ps.started_by, ''), '^task:', ''), ''), ps.app || '/' || ps.job) as task_name
    from public.platform_schedules ps
    where ps.user_id = p_user and ps.enabled and ps.catch_up is not null
  ),
  days as (
    select d::date as d
    from generate_series((p_from at time zone 'America/Los_Angeles')::date,
                         (p_to   at time zone 'America/Los_Angeles')::date,
                         interval '1 day') as g(d)
  ),
  slots as (
    -- Once a day (or week): expected at expected_by; the slot is that Pacific day up to expected_by + grace.
    select s.app, s.job, s.executor, s.catch_up, s.task_name,
           (days.d + s.expected_by) at time zone 'America/Los_Angeles' as expected_at,
           days.d::timestamp at time zone 'America/Los_Angeles' as slot_from,
           ((days.d + s.expected_by) at time zone 'America/Los_Angeles') + make_interval(hours => s.grace_hours) as slot_to
    from s cross join days
    where s.hourly_until is null
      and (s.cadence = 'daily' or extract(dow from days.d)::int = s.day_of_week)
    union all
    -- Hourly: one each hour from expected_by to hourly_until; the slot is that hour.
    select s.app, s.job, s.executor, s.catch_up, s.task_name,
           ((days.d + s.expected_by) at time zone 'America/Los_Angeles') + make_interval(hours => h),
           ((days.d + s.expected_by) at time zone 'America/Los_Angeles') + make_interval(hours => h),
           ((days.d + s.expected_by) at time zone 'America/Los_Angeles') + make_interval(hours => h + 1)
    from s cross join days
    cross join generate_series(0, floor(extract(epoch from (s.hourly_until - s.expected_by)) / 3600)::int) as hrs(h)
    where s.hourly_until is not null
  )
  select sl.app, sl.job, sl.executor, sl.expected_at, sl.catch_up, sl.task_name
  from slots sl
  where sl.expected_at >= p_from
    and sl.slot_to <= p_to
    and not exists (
      select 1 from public.platform_runs r
      where r.user_id = p_user and r.app = sl.app and r.job = sl.job
        and r.started_at >= sl.slot_from and r.started_at < sl.slot_to)
  order by sl.expected_at, sl.app, sl.job
$$;
comment on function public.job_health_missed_runs(uuid, timestamptz, timestamptz) is
  'Job health: expected runs between p_from and p_to with no run started in their slot, for enabled schedules with a '
  'catch_up rule. Daily and weekly: due at expected_by (Pacific), slot = that day to expected_by + grace_hours. Hourly '
  '(hourly_until set): each hour from expected_by to hourly_until, slot = that hour. Counted only once the slot has ended.';
revoke all on function public.job_health_missed_runs(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.job_health_missed_runs(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- ============================================================================
-- 4. job_health_alert: one inbox item and one reminder due now, so notify-dispatch pushes it.
-- ============================================================================
create or replace function public.job_health_alert(
  p_user      uuid,
  p_text      text,
  p_push      text,
  p_task_name text,
  p_now       timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := gen_random_uuid()::text;
begin
  insert into public.inbox (id, user_id, captured_text, source_type, source_app, ai_status, source_metadata)
  values (v_id, p_user, p_text, 'task', 'overwatch', 'complete',
          jsonb_build_object('task_name', p_task_name,
                             'run_date', to_char(p_now at time zone 'America/Los_Angeles', 'YYYY-MM-DD'),
                             'kind', 'job_health'));
  insert into public.reminders (user_id, text, due_at, state, inbox_id, created_by, started_by)
  values (p_user, p_push, p_now, 'scheduled', v_id, 'app', 'task:job-health-watchdog');
  return v_id;
end;
$$;
comment on function public.job_health_alert(uuid, text, text, text, timestamptz) is
  'Job health: writes one inbox item (source_app overwatch, source_type task, ai_status complete) and one reminder due '
  'now linked to it, which notify-dispatch pushes. Used only by job_health_watchdog: outage, recovery, stuck dispatcher.';
revoke all on function public.job_health_alert(uuid, text, text, text, timestamptz) from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. job_health_watchdog: sweep, heartbeat, recovery, state. Run by pg_cron every 15 minutes.
-- ============================================================================
create or replace function public.job_health_watchdog(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_tz       constant text := 'America/Los_Angeles';
  v_user     uuid;
  v_errors   text[];
  v_swept    int;
  v_signal   int;
  v_alerted  int;
  r          record;
  v_ran      int;
  v_msg      text;
  v_text     text;
  v_title    text;
  v_task     text;
  v_state    public.job_health_state;
  v_last     timestamptz;
  v_anchor   timestamptz;
  v_local    timestamp;
  v_id       text;
  v_missed   int;
  v_by_hand  int;
  v_lines    text;
  v_summary  jsonb := '[]'::jsonb;
  v_event    text;
begin
  perform set_config('app.actor', 'job_health_watchdog', true);

  for v_user in select distinct ps.user_id from public.platform_schedules ps loop
    v_errors := '{}';
    v_swept := 0; v_signal := 0; v_alerted := 0; v_event := null;
    insert into public.job_health_state (user_id) values (v_user) on conflict (user_id) do nothing;

    -- a. Sweep stuck runs (spec 5.1).
    begin
      for r in
        select pr.id, pr.app, pr.job, pr.started_at, s.max_run_minutes, s.failure_subject, s.failure_severity,
               s.started_by, s.catch_up
        from public.platform_runs pr
        join public.platform_schedules s on s.user_id = pr.user_id and s.app = pr.app and s.job = pr.job
        where pr.user_id = v_user
          and pr.status = 'running'
          and s.max_run_minutes is not null
          and pr.started_at < p_now - make_interval(mins => s.max_run_minutes)
        order by pr.started_at
        for update of pr skip locked
      loop
        v_ran := floor(extract(epoch from (p_now - r.started_at)) / 60)::int;
        v_msg := format('Still running after %s minutes; marked stuck by the job-health watchdog.', v_ran);
        update public.platform_runs
        set status = 'failed', finished_at = p_now, error_message = v_msg,
            details = details || jsonb_build_object('failure_kind', 'stuck', 'swept_by', 'job_health_watchdog',
                                                    'ran_minutes', v_ran, 'max_run_minutes', r.max_run_minutes)
        where id = r.id and status = 'running';
        if not found then continue; end if;
        v_swept := v_swept + 1;

        -- Older stuck runs are marked only: no signal, no alert.
        continue when r.started_at < p_now - interval '24 hours';

        v_task  := public.job_health_task_name(r.started_by, r.app, r.job);
        v_title := left(format('%s stuck: marked failed after %s min', r.job, v_ran), 200);
        v_text  := format(
          E'%s was stuck and has been marked failed\n\n'
          || 'What happened: %s/%s run %s started at %s and was still running after %s min (its limit is %s min). '
          || E'The watchdog marked it failed.\n\n'
          || E'Kind: fix needed. Claude and Supabase are up; something in this job is broken.\n\n'
          || E'Error (verbatim): "%s"\n\n'
          || 'What to check: the job''s own record of that run: the Edge Function logs at that time for an Alfred job '
          || E'(wb-sync), or the task''s run history in claude.ai for a Claude task.\n\n'
          || E'Recovery: %s To find the cause, start a new Claude thread and paste:\n\n'
          || '    Fast track: diagnose %s/%s run %s. It was still running after %s min and was marked failed as stuck. '
          || 'Error: "%s". Read the run with get_platform_runs, find why it hung, and propose the fix.',
          r.job, r.app, r.job, r.id, public.job_health_when(r.started_at, p_now), v_ran, r.max_run_minutes,
          v_msg, public.job_health_catch_up_line(r.catch_up, v_task),
          r.app, r.job, r.id, v_ran, v_msg);

        -- The job's own failure signal, inserted as raise_signal would (it refuses under pg_cron).
        if r.failure_subject is not null and r.started_by is not null then
          insert into public.signals (user_id, app, job, severity, subject_key, title, body, started_by, source_ref, details)
          values (v_user, r.app, r.job, coalesce(r.failure_severity, 'high'),
                  replace(r.failure_subject, '{kind}', 'stuck'), v_title, v_text, r.started_by,
                  'job_health:stuck:' || r.id,
                  jsonb_build_object(
                    'kind', 'failure', 'run_id', r.id, 'failure_kind', 'stuck',
                    'item', jsonb_build_object(
                      'captured_text', v_text,
                      'source_app', r.app,
                      'source_metadata', jsonb_build_object(
                        'task_name', v_title,
                        'run_date', to_char(p_now at time zone c_tz, 'YYYY-MM-DD'),
                        'kind', 'failure'))))
          on conflict (user_id, source_ref) where source_ref is not null do nothing;
          if found then v_signal := v_signal + 1; end if;
        end if;

        -- d. O4: the dispatcher cannot deliver its own failure, so it gets a direct item and push too.
        if r.app = 'alfred' and r.job = 'claude_hourly_notifications' then
          perform public.job_health_alert(
            v_user, v_text,
            format('The hourly dispatcher hung at %s. Fix needed: task notifications may be stuck. Details in your inbox.',
                   public.job_health_when(r.started_at, p_now)),
            v_title, p_now);
          v_alerted := v_alerted + 1;
        end if;
      end loop;
    exception when others then
      v_errors := v_errors || ('sweep: ' || sqlerrm);
    end;

    -- b and c. Heartbeat, outage and recovery (spec 6).
    begin
      select * into v_state from public.job_health_state where user_id = v_user for update;
      select max(pr.started_at) into v_last
      from public.platform_runs pr where pr.user_id = v_user and pr.executor = 'claude' and pr.started_at <= p_now;
      v_local  := p_now at time zone c_tz;
      v_anchor := greatest(v_last, (v_local::date + time '05:15') at time zone c_tz);

      if v_state.outage_started_at is null then
        if v_local::time >= time '05:00' and v_local::time < time '20:00'
           and p_now - v_anchor > interval '2 hours' then
          v_text := format(
            E'Claude tasks stopped at %1$s\n\n'
            || 'What happened: no Claude scheduled task has started since %1$s (%2$s). The hourly dispatcher, inbox '
            || 'enrichment and every other Claude task are not running, so Alfred notifications from tasks are not going out.'
            || E'\n\nKind: outage. Claude, or Claude''s connection to Alfred, is down.\n\n'
            || 'What to check: status.claude.com and status.supabase.com. If either shows an incident, wait: there is '
            || E'nothing to fix on our side.\n\n'
            || E'Recovery: once it is fixed, start a new Claude thread and paste:\n\n'
            || E'    Overwatch: connections are back. Review missed jobs since %1$s and give me the recovery plan.\n\n'
            || 'If both status pages have been green for over an hour, treat it as fix needed: check in claude.ai that the '
            || 'scheduled tasks are still enabled and that the Alfred connector is connected.',
            public.job_health_when(v_anchor, p_now), public.job_health_duration(p_now - v_anchor));
          v_id := public.job_health_alert(
            v_user, v_text,
            format('Claude tasks stopped at %s. Outage: check status.claude.com and status.supabase.com. Details in your inbox.',
                   public.job_health_when(v_anchor, p_now)),
            'Job health: outage', p_now);
          update public.job_health_state
          set outage_started_at = v_anchor, outage_alerted_at = p_now, outage_inbox_id = v_id
          where user_id = v_user;
          v_event := 'outage_opened';
        end if;

      elsif v_last > v_state.outage_started_at then
        -- One line per job, its missed times together.
        select string_agg(m.line, E'\n' order by m.first_at)
        into v_lines
        from (
          select min(mr.expected_at) as first_at, mr.catch_up,
                 format('- %s (%s/%s), %s: %s. %s', mr.task_name, mr.app, mr.job,
                        string_agg(public.job_health_when(mr.expected_at, p_now), ', ' order by mr.expected_at),
                        mr.catch_up, public.job_health_catch_up_line(mr.catch_up, mr.task_name)) as line
          from public.job_health_missed_runs(v_user, v_state.outage_started_at, p_now) mr
          group by mr.app, mr.job, mr.task_name, mr.catch_up
        ) m;
        -- Counts are of runs, not jobs.
        select count(*), count(*) filter (where mr.catch_up = 'run_now')
        into v_missed, v_by_hand
        from public.job_health_missed_runs(v_user, v_state.outage_started_at, p_now) mr;

        v_text := format(
          E'Claude tasks are running again: %1$s to %2$s\n\n'
          || E'What happened: no Claude task ran for %3$s. %4$s scheduled runs were missed.\n\n'
          || E'Kind: outage, now over.\n\n'
          || E'Missed runs:%5$s\n\n'
          || E'Recovery: run the "run it now" jobs above by hand. For a full review, start a new Claude thread and paste:\n\n'
          || '    Overwatch: connections are back. Review missed jobs since %1$s and give me the recovery plan.',
          public.job_health_when(v_state.outage_started_at, p_now), public.job_health_when(v_last, p_now),
          public.job_health_duration(v_last - v_state.outage_started_at), v_missed,
          case when v_missed = 0 then ' none.' else E'\n' || v_lines end);
        perform public.job_health_alert(
          v_user, v_text,
          format('Claude tasks are running again. %s runs missed, %s to run by hand. List in your inbox.', v_missed, v_by_hand),
          'Job health: recovery', p_now);
        update public.job_health_state
        set last_outage_started_at = outage_started_at, last_recovery_at = v_last,
            outage_started_at = null, outage_alerted_at = null, outage_inbox_id = null
        where user_id = v_user;
        v_event := 'recovered';
      end if;

      update public.job_health_state set last_heartbeat_at = v_last where user_id = v_user;
    exception when others then
      v_errors := v_errors || ('heartbeat: ' || sqlerrm);
    end;

    -- e. State.
    update public.job_health_state
    set last_watchdog_run_at = p_now,
        last_watchdog_error  = nullif(array_to_string(v_errors, '; '), ''),
        last_sweep           = jsonb_build_object('at', p_now, 'swept', v_swept, 'signalled', v_signal, 'alerted', v_alerted),
        updated_at           = now()
    where user_id = v_user;

    v_summary := v_summary || jsonb_build_object('user_id', v_user, 'swept', v_swept, 'signalled', v_signal,
                                                 'alerted', v_alerted, 'event', v_event, 'errors', to_jsonb(v_errors));
  end loop;
  return jsonb_build_object('at', p_now, 'users', v_summary);
end;
$$;
comment on function public.job_health_watchdog(timestamptz) is
  'Job health: the Alfred watchdog, run by pg_cron job-health-every-15-min. Per user: sweeps stuck runs (failed, '
  'failure_kind stuck; signal only if started in the last 24 h; the dispatcher also gets a direct alert), opens an '
  'outage after 2 h with no Claude run between 5 AM and 8 PM Pacific (one inbox item and push), closes it with one '
  'recovery item listing missed runs, and stamps job_health_state. p_now exists for the test only.';
revoke all on function public.job_health_watchdog(timestamptz) from public, anon, authenticated, service_role;

-- ============================================================================
-- 6. get_job_health: what the health check task (s8 tool) reads. Read-only, the caller's own rows.
-- ============================================================================
create or replace function public.get_job_health(p_since timestamptz default null, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_since timestamptz;
  v_state public.job_health_state;
  v_mins  int;
begin
  if v_user is null then
    raise exception 'get_job_health needs a signed-in user';
  end if;

  -- Default window: since the previous finished health check, else 24 hours.
  v_since := coalesce(
    p_since,
    (select max(pr.started_at) from public.platform_runs pr
     where pr.user_id = v_user and pr.app = 'alfred' and pr.job = 'job_health_check'
       and pr.status <> 'running' and pr.started_at <= p_now),
    p_now - interval '24 hours');

  select * into v_state from public.job_health_state where user_id = v_user;
  v_mins := floor(extract(epoch from (p_now - v_state.last_watchdog_run_at)) / 60)::int;

  return jsonb_build_object(
    'since', v_since,
    'watchdog', jsonb_build_object(
      'last_run_at', v_state.last_watchdog_run_at,
      'minutes_since', v_mins,
      'healthy', coalesce(v_mins <= 35, false),
      'last_error', v_state.last_watchdog_error),
    'outage', jsonb_build_object(
      'open', v_state.outage_started_at is not null,
      'started_at', v_state.outage_started_at,
      'alerted_at', v_state.outage_alerted_at,
      'last_heartbeat_at', v_state.last_heartbeat_at,
      'last_recovery_at', v_state.last_recovery_at,
      'last_outage_started_at', v_state.last_outage_started_at),
    'stuck_runs', coalesce((
      select jsonb_agg(x order by x.started_at) from (
        -- Swept in the window.
        select pr.id, pr.app, pr.job, pr.started_at, pr.finished_at, pr.error_message,
               (pr.details ->> 'ran_minutes')::int as ran_minutes,
               (pr.details ->> 'max_run_minutes')::int as max_run_minutes, true as swept
        from public.platform_runs pr
        where pr.user_id = v_user and pr.details ->> 'failure_kind' = 'stuck' and pr.finished_at >= v_since
        union all
        -- Still running past the limit: only possible while the watchdog is not running.
        select pr.id, pr.app, pr.job, pr.started_at, null, pr.error_message,
               floor(extract(epoch from (p_now - pr.started_at)) / 60)::int, s.max_run_minutes, false
        from public.platform_runs pr
        join public.platform_schedules s on s.user_id = pr.user_id and s.app = pr.app and s.job = pr.job
        where pr.user_id = v_user and pr.status = 'running' and s.max_run_minutes is not null
          and pr.started_at < p_now - make_interval(mins => s.max_run_minutes)
      ) x), '[]'::jsonb),
    'missed_runs', coalesce((
      select jsonb_agg(m order by m.expected_at)
      from public.job_health_missed_runs(v_user, v_since, p_now) m), '[]'::jsonb));
end;
$$;
comment on function public.get_job_health(timestamptz, timestamptz) is
  'Job health: for the get_job_health tool (s8). The watchdog''s last run (healthy within 35 min), the outage state, '
  'runs swept stuck since p_since (and any still running past their limit), and missed runs since p_since. p_since '
  'defaults to the previous finished alfred/job_health_check run, else 24 hours ago. Read-only; the caller''s rows only.';
revoke all on function public.get_job_health(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_job_health(timestamptz, timestamptz) to authenticated, service_role;

-- ============================================================================
-- 7. The cron job: every 15 minutes. No secret.
-- ============================================================================
select cron.unschedule(jobid) from cron.job where jobname = 'job-health-every-15-min';
select cron.schedule('job-health-every-15-min', '*/15 * * * *', 'select public.job_health_watchdog()');

-- ============================================================================
-- 8. Result: must say CONFORMANT. Then run supabase/tests/job_health-t4m/2_watchdog_test.sql.
-- ============================================================================
select public.platform_check_conformance() as conformance;
