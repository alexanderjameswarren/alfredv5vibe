-- Purpose: nightly_counts-f8k. Two fixes to public.overwatch_nightly_counts (from 197):
--   1. stopped_schedules: a job is stopped only when the current due time plus grace has passed and it has no ok run after
--      the previous due time plus grace. A job that runs before its expected_by (sam/daily_plan_review, 00:16 against
--      08:00) was a false alarm once today's grace ended. A run inside the previous cycle's grace counts for that cycle only.
--   2. apps.active_yesterday: true only for activity on the local day before local_date, not today's too.
-- Kind: schema change (one function)
-- Applied: NO
--
-- Spec: docs/technical-spec-nightly_counts-f8k.md section 6. Safe to re-run: create or replace.

begin;

create or replace function public.overwatch_nightly_counts(p_as_of timestamptz default now())
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_tz       constant text := 'America/Los_Angeles';
  v_local    date := (p_as_of at time zone c_tz)::date;
  v_offset   interval := (p_as_of at time zone c_tz) - (p_as_of at time zone 'UTC');
  v_plan     public.overwatch_plans%rowtype;
  v_s        jsonb;
  v_missing  jsonb;
  v_since    timestamptz;
  v_stall    int;
  v_wait     int;
  v_fading   int;
  v_overdue  int;
  v_factor   numeric;
  v_limit    int;
  v_backlog  int;
  v_low      numeric;
  v_stale    int;
  v_seen     timestamptz;
  v_projects jsonb;
  v_count    int;
  v_stalled  jsonb;
  v_waiting  jsonb;
  v_overruns jsonb;
  v_finish   jsonb;
  v_groups   jsonb;
  v_r        jsonb;
begin
  select * into v_plan from public.overwatch_plans where active limit 1;
  if v_plan.id is null then
    raise exception 'overwatch_nightly_counts: no active Overwatch plan.' using errcode = 'P0002';
  end if;

  v_s       := v_plan.settings;
  v_stall   := (v_s ->> 'stall_days')::int;
  v_wait    := (v_s ->> 'waiting_on_alex_days')::int;
  v_fading  := (v_s ->> 'fading_days')::int;
  v_overdue := (v_s ->> 'overdue_days')::int;
  v_factor  := (v_s ->> 'overrun_factor')::numeric;
  v_limit   := (v_s ->> 'active_project_limit')::int;
  v_backlog := (v_s ->> 'inbox_backlog_threshold')::int;
  v_low     := (v_s ->> 'routing_low_confidence')::numeric;
  v_stale   := coalesce((v_s ->> 'inventory_stale_days')::int, 7);

  select coalesce(jsonb_agg(k), '[]'::jsonb) into v_missing
    from unnest(array['stall_days', 'waiting_on_alex_days', 'fading_days', 'overdue_days', 'overrun_factor',
                      'active_project_limit', 'inbox_backlog_threshold', 'routing_low_confidence',
                      'urgent_within_days']) k
   where not v_s ? k;
  if not v_s ? 'inventory_stale_days' then
    v_missing := v_missing || '["inventory_stale_days (used 7)"]'::jsonb;
  end if;

  select n.created_at into v_since from public.overwatch_notes n
   where n.period = 'nightly' and n.for_date < v_local
   order by n.created_at desc limit 1;
  v_since := coalesce(v_since, ((v_local - 1)::timestamp at time zone c_tz));

  -- Projects: one read of the progress function, every project count from it.
  with p as materialized (
    select pr.*, coalesce(pr.project_code, pr.name) as label,
           v_local - (pr.last_report_at at time zone c_tz)::date as report_days,
           v_local - (pr.first_report_at at time zone c_tz)::date as first_days,
           v_local - (pr.status_written_at at time zone c_tz)::date as written_days,
           e.original_estimate, e.original_estimate + e.steps_added as scope_adjusted_estimate
      from public.overwatch_project_progress(array['active'], null) pr
      cross join lateral (
        select max(x.estimate) filter (where x.kind = 'initial') as original_estimate,
               coalesce(sum(x.steps_added), 0)::int as steps_added
          from public.project_estimates x where x.group_id = pr.group_id
      ) e
  )
  select count(*)::int,
         coalesce(jsonb_agg(to_jsonb(p) - 'label' - 'report_days' - 'first_days' - 'written_days'
                            order by p.last_report_at desc nulls last, p.name), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('project', p.label, 'group_id', p.group_id, 'days', p.report_days,
                                               'last_report_at', p.last_report_at))
                  filter (where p.waiting_on_kind is distinct from 'project'
                            and (p.report_days > v_stall or (p.last_report_at is null and p.has_plan))), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('project', p.label, 'group_id', p.group_id, 'days', p.written_days,
                                               'waiting_on', p.waiting_on))
                  filter (where p.waiting_on_kind = 'alex' and p.written_days > v_wait), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('project', p.label, 'group_id', p.group_id, 'kind', 'steps',
                                               'steps_used', p.steps_used, 'effort_estimate', p.effort_estimate))
                  filter (where p.steps_used > p.effort_estimate * v_factor), '[]'::jsonb)
         || coalesce(jsonb_agg(jsonb_build_object('project', p.label, 'group_id', p.group_id, 'kind', 'target',
                                                  'target_date', p.target_date))
                     filter (where p.target_date < v_local), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('group_id', p.group_id, 'finish',
           case when p.effort_estimate is not null and p.steps_used >= p.effort_estimate then 'over estimate'
                when p.effort_estimate is not null and p.steps_used > 0 and p.first_report_at is not null
                  then (v_local + ceil((p.effort_estimate - p.steps_used)::numeric * p.first_days / p.steps_used)::int)::text
                else 'unknown' end)), '[]'::jsonb),
         coalesce(jsonb_agg(p.group_id), '[]'::jsonb)
    into v_count, v_projects, v_stalled, v_waiting, v_overruns, v_finish, v_groups
    from p;

  v_r := jsonb_build_object(
    'local_date', v_local,
    'utc_offset', case when v_offset < interval '0' then '-' else '+' end
                  || to_char(case when v_offset < interval '0' then -v_offset else v_offset end, 'HH24:MI'),
    'since_last', v_since,
    'plan', jsonb_build_object(
      'id', v_plan.id,
      'instructions', v_plan.instructions,
      'settings', v_s,
      'checks_later', (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(v_plan.checks_next_run) c
                        where (c ->> 'check_on')::date > v_local)),
    'settings_missing', v_missing,
    'checks_due', (select coalesce(jsonb_agg(c), '[]'::jsonb) from jsonb_array_elements(v_plan.checks_next_run) c
                    where (c ->> 'check_on')::date <= v_local),
    'projects', v_projects,
    'estimated_finish', v_finish);

  -- The run's own row is in today's list; Claude leaves out its own id.
  v_r := v_r || jsonb_build_object('prior_runs', jsonb_build_object(
    'today', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'started_at', t.started_at, 'status', t.status,
                                                           'reminders_sent', t.details -> 'reminders_sent')
                                        order by t.started_at desc), '[]'::jsonb)
                from public.platform_runs t
               where t.app = 'overwatch' and t.job = 'nightly' and (t.started_at at time zone c_tz)::date = v_local),
    'last_two', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'started_at', l.started_at,
                                                              'skipped', l.details -> 'skipped')
                                           order by l.started_at desc), '[]'::jsonb)
                   from (select * from public.platform_runs t
                          where t.app = 'overwatch' and t.job = 'nightly' and t.status <> 'running'
                            and not t.details ? 'duplicate_of'
                            and (t.started_at at time zone c_tz)::date < v_local
                          order by t.started_at desc limit 2) l)));

  -- Apps, activity and quiet.
  with last_use as (
    select ac.app_id, max((ac.occurred_at at time zone c_tz)::date) as last_on,
           bool_or((ac.occurred_at at time zone c_tz)::date = v_local - 1) as on_yesterday
      from public.activity ac group by ac.app_id
  ), a as (
    select ap.id as app_id, ap.name, pf.rhythm_days, pf.activity_recipe, pf.current_state, l.last_on, l.on_yesterday,
           exists (select 1 from public.overwatch_watch w
                    where w.app_id = ap.id and w.kind = 'ease_off'
                      and w.starts_on <= v_local and w.ends_on >= v_local) as eased
      from public.apps ap
      left join public.app_profiles pf on pf.app_id = ap.id
      left join last_use l on l.app_id = ap.id
  )
  select v_r || jsonb_build_object(
    'apps', coalesce(jsonb_agg(jsonb_build_object(
        'app_id', a.app_id, 'name', a.name, 'rhythm_days', a.rhythm_days, 'activity_recipe', a.activity_recipe,
        'current_state', a.current_state, 'last_activity_on', a.last_on,
        'active_yesterday', coalesce(a.on_yesterday, false)) order by a.app_id), '[]'::jsonb),
    'quiet_apps', coalesce(jsonb_agg(jsonb_build_object(
        'app', a.app_id, 'last_used_on', a.last_on, 'days_since', v_local - a.last_on, 'rhythm_days', a.rhythm_days)
        order by a.app_id)
        filter (where a.rhythm_days is not null and not a.eased and v_local - a.last_on > a.rhythm_days), '[]'::jsonb),
    'quiet_needs_own_data', coalesce(jsonb_agg(a.app_id order by a.app_id)
        filter (where a.rhythm_days is not null and not a.eased and a.last_on is null), '[]'::jsonb))
    into v_r
    from a;

  v_r := v_r || jsonb_build_object('activity_yesterday', (
    select coalesce(jsonb_agg(jsonb_build_object('app_id', y.app_id, 'kind', y.kind, 'title', y.title)
                              order by y.occurred_at desc), '[]'::jsonb)
      from (select * from public.activity ac
             where (ac.occurred_at at time zone c_tz)::date = v_local - 1
             order by ac.occurred_at desc limit 200) y));

  -- Project counts that have their setting.
  if v_stall is not null then v_r := v_r || jsonb_build_object('stalled', v_stalled); end if;
  if v_wait is not null then v_r := v_r || jsonb_build_object('waiting_on_alex', v_waiting); end if;
  if v_factor is not null then v_r := v_r || jsonb_build_object('overruns', v_overruns); end if;
  if v_limit is not null then
    v_r := v_r || jsonb_build_object('over_limit',
      case when v_count > v_limit then jsonb_build_array(jsonb_build_object('count', v_count, 'limit', v_limit))
           else '[]'::jsonb end);
  end if;

  v_r := v_r || jsonb_build_object(
    'scope_changes', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'project', coalesce(pl.project_code, g.name), 'group_id', x.group_id, 'steps_added', x.steps_added,
               'at_step', x.at_step, 'reason', x.reason, 'estimate', x.estimate) order by x.created_at), '[]'::jsonb)
        from public.project_estimates x
        join public.item_groups g on g.id = x.group_id
        left join public.project_plans pl on pl.group_id = x.group_id
       where x.kind in ('scope_increase', 'scope_decrease') and x.created_at > v_since
         and v_groups ? x.group_id),
    -- A member counts only while its record is live, as get_groups' shapeGroups has it.
    'empty_projects', (
      select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'id', g.id, 'status', g.status) order by g.name), '[]'::jsonb)
        from public.item_groups g
        join public.group_types t on t.id = g.group_type_id and t.kind = 'project'
       where g.archived = false and g.status in ('active', 'someday')
         and not exists (
           select 1 from public.item_group_members m
            where m.group_id = g.id and m.removed_at is null
              and ((m.member_type = 'item' and exists (select 1 from public.items i
                     where i.id = m.member_id and i.archived is not true))
                or (m.member_type = 'intention' and exists (select 1 from public.intents i
                     where i.id = m.member_id and i.archived is not true))))));

  -- Inbox: untriaged and unarchived, as get_inbox.
  with b as materialized (
    select n.id, n.source_app, n.ai_confidence, n.created_at, split_part(n.captured_text, E'\n', 1) as first_line
      from public.inbox n
     where n.triaged_at is null and n.archived is not true
  ), by_app as (
    select b.source_app as app, count(*)::int as total, max(v_local - (b.created_at at time zone c_tz)::date) as oldest_days
      from b where b.source_app is not null group by b.source_app
  ), low as (
    select * from b where b.source_app is not null and b.ai_confidence < v_low order by b.created_at desc limit 10
  )
  select v_r || jsonb_build_object(
    'inbox_total', (select count(*) from b),
    'overwatch_open_first_lines', (select coalesce(jsonb_agg(b.first_line), '[]'::jsonb) from b where b.source_app = 'overwatch'),
    'followup_open_first_lines', (select coalesce(jsonb_agg(b.first_line), '[]'::jsonb) from b where b.first_line like 'Overwatch: follow-up%'),
    'unrouted', jsonb_build_array(jsonb_build_object(
      'total', (select count(*) from b where b.source_app is null),
      'older_than_one_day', (select count(*) from b where b.source_app is null and b.created_at < p_as_of - interval '1 day'))),
    'inbox_urgent', jsonb_build_object(
      'unrouted_old', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'first_line', b.first_line)), '[]'::jsonb)
                         from b where b.source_app is null and b.created_at < p_as_of - interval '1 day'),
      'backlog_old', (select coalesce(jsonb_agg(by_app.app), '[]'::jsonb) from by_app
                       where by_app.total > v_backlog and by_app.oldest_days > v_stall),
      'low_confidence', (select coalesce(jsonb_agg(low.id), '[]'::jsonb) from low)))
  || case when v_backlog is null then '{}'::jsonb else jsonb_build_object('backlogs', (
       select coalesce(jsonb_agg(jsonb_build_object('app', by_app.app, 'total', by_app.total, 'oldest_days', by_app.oldest_days)
                                 order by by_app.total desc), '[]'::jsonb)
         from by_app where by_app.total > v_backlog)) end
  || case when v_low is null then '{}'::jsonb else jsonb_build_object('low_confidence_routing', (
       select coalesce(jsonb_agg(jsonb_build_object('id', low.id, 'first_line', low.first_line, 'source_app', low.source_app,
                                                    'ai_confidence', low.ai_confidence) order by low.created_at desc), '[]'::jsonb)
         from low)) end
    into v_r;

  -- Schedules: each job's true last ok run. Stopped once the current due time plus grace has passed with no ok run after
  -- the previous due time plus grace: a run before expected_by counts, and one inside the previous cycle's grace counts
  -- for that cycle only. A schedule created after its due time has not missed it. The previous due time is worked out in
  -- Pacific days, so daylight time cannot move it.
  with s as (
    select sc.app, sc.job, sc.grace_hours, sc.created_at, due.due_at,
           ((due.due_at at time zone c_tz)
             - case when sc.cadence = 'daily' then interval '1 day' else interval '7 days' end) at time zone c_tz as previous_due_at,
           (select max(coalesce(r.finished_at, r.started_at)) from public.platform_runs r
             where r.app = sc.app and r.job = sc.job and r.status = 'ok') as last_ok
      from public.platform_schedules sc
      cross join lateral (
        select case
          when sc.cadence = 'daily' then
            case when ((v_local + sc.expected_by) at time zone c_tz) <= p_as_of
                 then ((v_local + sc.expected_by) at time zone c_tz)
                 else (((v_local - 1) + sc.expected_by) at time zone c_tz) end
          else
            case when (((v_local - ((extract(dow from v_local)::int - sc.day_of_week + 7) % 7)) + sc.expected_by) at time zone c_tz) <= p_as_of
                 then (((v_local - ((extract(dow from v_local)::int - sc.day_of_week + 7) % 7)) + sc.expected_by) at time zone c_tz)
                 else (((v_local - ((extract(dow from v_local)::int - sc.day_of_week + 7) % 7) - 7) + sc.expected_by) at time zone c_tz) end
          end as due_at
      ) due
     where sc.enabled and (sc.app, sc.job) not in (('overwatch', 'nightly'), ('alfred', 'notify-dispatch'))
  )
  select v_r || jsonb_build_object('stopped_schedules', (
    select coalesce(jsonb_agg(x.entry), '[]'::jsonb) from (
      select jsonb_build_object('app', s.app, 'job', s.job, 'last_ok', (s.last_ok at time zone c_tz)::date) as entry
        from s
       where s.created_at <= s.due_at
         and s.due_at + make_interval(hours => s.grace_hours) < p_as_of
         and (s.last_ok is null or s.last_ok <= s.previous_due_at + make_interval(hours => s.grace_hours))
      union all
      -- notify-dispatch writes no runs: its sign of life is the reminder queue.
      select jsonb_build_object('app', sc.app, 'job', sc.job,
                                'last_ok', 'reminder due ' || (r.due_at at time zone c_tz)::date || ' unsent')
        from public.platform_schedules sc
        cross join lateral (select rm.due_at from public.reminders rm where rm.state = 'scheduled'
                             order by rm.due_at limit 1) r
       where sc.enabled and sc.app = 'alfred' and sc.job = 'notify-dispatch'
         and r.due_at + make_interval(hours => sc.grace_hours) < p_as_of
    ) x))
    into v_r;

  v_r := v_r || jsonb_build_object(
    'orphan_runs', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'app', r.app, 'job', r.job, 'started_at', r.started_at)
                                order by r.started_at), '[]'::jsonb)
        from public.platform_runs r
       where r.status = 'running' and (r.started_at at time zone c_tz)::date < v_local),
    -- Three or more episodes between one pair in 30 days, unless the pair already has a no_parallel link.
    'claim_blocks', (
      select coalesce(jsonb_agg(jsonb_build_object('code_a', c.code_a, 'code_b', c.code_b, 'episodes', c.episodes,
                                                   'group_a', pa.group_id, 'group_b', pb.group_id)
                                order by c.episodes desc), '[]'::jsonb)
        from (select least(k.waiter_code, k.holder_code) as code_a, greatest(k.waiter_code, k.holder_code) as code_b,
                     count(distinct k.blocked_at)::int as episodes
                from public.claim_blocks k
               where k.blocked_at >= ((v_local - 30)::timestamp at time zone c_tz)
               group by 1, 2 having count(distinct k.blocked_at) >= 3) c
        left join public.project_plans pa on pa.project_code = c.code_a
        left join public.project_plans pb on pb.project_code = c.code_b
       where not exists (
         select 1 from public.project_links l
          where l.kind = 'no_parallel'
            and ((l.from_group_id = pa.group_id and l.to_group_id = pb.group_id)
              or (l.from_group_id = pb.group_id and l.to_group_id = pa.group_id)))),
    'watch_in_force', (
      select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'kind', w.kind, 'text', w.text, 'app_id', w.app_id,
                                                   'group_id', w.group_id, 'intent_id', w.intent_id, 'ends_on', w.ends_on)
                                order by w.ends_on), '[]'::jsonb)
        from public.overwatch_watch w where w.starts_on <= v_local and w.ends_on >= v_local),
    'watch_ended', (
      select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'kind', w.kind, 'text', w.text, 'app_id', w.app_id,
                                                   'group_id', w.group_id, 'intent_id', w.intent_id, 'ends_on', w.ends_on)
                                order by w.ends_on), '[]'::jsonb)
        from public.overwatch_watch w where w.ends_on < v_local and w.expiry_noted_at is null));

  -- Intentions. Fading and the two event counts share the window Step 5.7 reads: back fading_days, forward without end.
  if v_fading is not null then
    with watched as (
      select w.intent_id, w.group_id from public.overwatch_watch w
       where w.kind in ('focus', 'keep_an_eye_on') and w.starts_on <= v_local and w.ends_on >= v_local
    ), cand as (
      select i.id, i.text, i.updated_at, v_local - (i.updated_at at time zone c_tz)::date as days
        from public.intents i
       where i.status = 'active' and i.archived is not true
         and (i.recurrence_config is null or i.recurrence_config ->> 'type' = 'once')
         and v_local - (i.updated_at at time zone c_tz)::date > v_fading
         and not exists (select 1 from public.events e
                          where e.intent_id = i.id and e.archived is not true and e.time >= v_local)
         -- An undone past event in the window is a missed date. One older than the window stays a candidate.
         and not exists (select 1 from public.events e
                          where e.intent_id = i.id and e.archived is not true
                            and e.time >= v_local - v_fading and e.time < v_local
                            and not exists (select 1 from public.executions x where x.event_id = e.id))
         and not exists (select 1 from watched w where w.intent_id = i.id)
         and not exists (select 1 from watched w where w.group_id = i.group_id)
         and not exists (select 1 from watched w
                           join public.item_group_members m on m.group_id = w.group_id
                          where m.member_type = 'intention' and m.member_id = i.id and m.removed_at is null)
    )
    select v_r || jsonb_build_object('fading_candidates', jsonb_build_object(
      'total', (select count(*) from cand),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('kind', 'intention', 'id', o.id, 'text', o.text, 'days', o.days)
                                         order by o.updated_at, o.id), '[]'::jsonb)
                 from (select * from cand order by cand.updated_at, cand.id limit 50) o)))
      into v_r;

    v_r := v_r || jsonb_build_object('deadline_candidates', (
      select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'text', i.text, 'description', left(i.description, 200))
                                order by i.id), '[]'::jsonb)
        from public.intents i
       where i.status = 'active' and i.archived is not true
         and not exists (select 1 from public.events e
                          where e.intent_id = i.id and e.archived is not true and e.time >= v_local - v_fading)));

    if v_overdue is not null then
      v_r := v_r || jsonb_build_object('overdue_intentions', (
        select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'intention', i.text, 'event_id', e.id, 'event_date', e.time,
                                                     'days_overdue', v_local - e.time) order by e.time), '[]'::jsonb)
          from public.events e
          join public.intents i on i.id = e.intent_id and i.status = 'active' and i.archived is not true
         where e.archived is not true
           and e.time >= v_local - v_fading and e.time <= v_local - v_overdue - 1
           and not exists (select 1 from public.executions x where x.event_id = e.id)));
    end if;
  end if;

  -- Every part of one rebuild shares its seen_at.
  select max(pi.seen_at) into v_seen from public.platform_inventory pi;
  v_r := v_r || jsonb_build_object(
    'inventory_stale', case
      when v_seen is null then jsonb_build_object('seen_at', 'never', 'days', null)
      when v_local - (v_seen at time zone c_tz)::date > v_stale
        then jsonb_build_object('seen_at', v_seen, 'days', v_local - (v_seen at time zone c_tz)::date)
      else '[]'::jsonb end,
    'finish_summaries_total', (select count(*) from public.finish_summaries f where f.reviewed_at is null),
    'finish_summaries', (
      select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'project_code', f.project_code, 'merge_commit', f.merge_commit,
                                                   'finished_at', f.finished_at, 'migrations', f.migrations, 'tools', f.tools,
                                                   'skills', f.skills, 'paths', f.paths) order by f.finished_at), '[]'::jsonb)
        from (select * from public.finish_summaries fs where fs.reviewed_at is null
               order by fs.finished_at limit 10) f),
    'portfolio_review_due', (
      select coalesce(jsonb_agg(jsonb_build_object('portfolio_id', po.id, 'name', po.name, 'review_by', pp.review_by)
                                order by po.position, po.name), '[]'::jsonb)
        from public.portfolios po
        join public.portfolio_plans pp on pp.portfolio_id = po.id and pp.active
       where po.archived = false and pp.review_by < v_local));

  return v_r;
end;
$$;

comment on function public.overwatch_nightly_counts(timestamptz) is
  'Overwatch: most of the nightly counts as one JSON object, its flags keys matching overwatch_notes.flags. Reads the active '
  'plan itself and works in America/Los_Angeles days from p_as_of, which pins the clock and does not rewind the data. A count '
  'whose setting is missing is left out and named in settings_missing. Fading is one-off active intentions only: items never '
  'fade. Invoker: RLS decides the rows. Backs get_overwatch_nightly_counts. Spec: docs/technical-spec-nightly_counts-f8k.md.';
revoke all on function public.overwatch_nightly_counts(timestamptz) from public, anon;
grant execute on function public.overwatch_nightly_counts(timestamptz) to authenticated, service_role;

commit;
