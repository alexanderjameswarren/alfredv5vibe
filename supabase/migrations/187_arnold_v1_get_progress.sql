-- Purpose: Arnold V1 step 4. arnold_get_progress(): one row per goal per Pacific day, plus one row per Monday-to-Sunday
-- week for weekly goals, with the count, target, on-track status, pace checkpoints, the newest counted activity and the
-- counted execution ids. The one place progress is counted, so the hourly task, the morning review and chat agree.
-- Kind: schema change (one function)
-- Applied: NO
--
-- Spec: docs/arnold_v1-technical-spec.md sections 2 and 4. Needs 186_arnold_v1_plans_goals_notifications.sql.
-- Run as one block in the SQL editor, then run supabase/tests/arnold_v1-k7m/2_get_progress_test.sql.
-- Safe to re-run: create or replace.
-- supabase/migrations/187_arnold_v1_get_progress.sql

begin;

create or replace function public.arnold_get_progress(p_date_from date, p_date_to date, p_plan_id uuid default null)
returns table (
  plan_id          uuid,
  goal_key         text,
  label            text,
  measure          text,
  period           text,
  row_kind         text,
  local_date       date,
  week_start       date,
  count            integer,
  target           integer,
  met              boolean,
  on_track         boolean,
  days_left        integer,
  usual_day        boolean,
  before_plan      boolean,
  checkpoints      jsonb,
  last_activity_at timestamptz,
  execution_ids    text[]
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_tz        constant text := 'America/Los_Angeles';
  v_today     date := (now() at time zone 'America/Los_Angeles')::date;
  v_now_time  time := (now() at time zone 'America/Los_Angeles')::time;
  v_plan      record;
  v_from_week date;
  v_to_week   date;
begin
  if v_uid is null then
    raise exception 'arnold_get_progress: not authenticated.';
  end if;
  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception 'arnold_get_progress: give date_from and date_to, with date_from on or before date_to.'
      using errcode = '22023';
  end if;
  if p_date_to - p_date_from > 92 then
    raise exception 'arnold_get_progress: at most 93 days per call (got %).', p_date_to - p_date_from + 1
      using errcode = '22023';
  end if;

  if p_plan_id is null then
    select p.id, p.starts_on into v_plan from arnold_plans p where p.user_id = v_uid and p.status = 'active';
    if not found then
      raise exception 'arnold_get_progress: there is no active Arnold plan.' using errcode = 'P0002';
    end if;
  else
    select p.id, p.starts_on into v_plan from arnold_plans p where p.id = p_plan_id;
    if not found then
      raise exception 'arnold_get_progress: plan % not found.', p_plan_id using errcode = 'P0002';
    end if;
  end if;

  -- Weekly totals cover whole Monday-to-Sunday weeks, so gather activity over the weeks the range touches.
  v_from_week := date_trunc('week', p_date_from)::date;
  v_to_week   := date_trunc('week', p_date_to)::date + 6;

  return query
  with goals as (
    select g.* from arnold_goals g where g.plan_id = v_plan.id
  ),
  -- One row per counted unit. Elements are dated by their own completed_at, never the execution's closed_at or
  -- event_date (closed_at is set by hand and can be earlier than the ticks). The camelCase keys are a fallback for
  -- any row written before storage mapped element keys to snake_case.
  units as (
    select g.id as goal_id, e.id as execution_id,
           coalesce(el->>'completed_at', el->>'completedAt')::timestamptz as at_ts
      from goals g
      join executions e on e.intent_id = g.intent_id and e.user_id = v_uid
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(e.elements) = 'array' then e.elements else '[]'::jsonb end) el
     where g.measure = 'elements'
       and coalesce(el->>'display_type', el->>'displayType') = 'step'
       and coalesce(el->>'is_completed', el->>'isCompleted') = 'true'
       and coalesce(el->>'completed_at', el->>'completedAt') is not null
    union all
    select g.id, e.id, e.closed_at
      from goals g
      join executions e on e.intent_id = g.intent_id and e.user_id = v_uid
     where g.measure = 'executions'
       and e.status = 'closed' and e.outcome = 'done' and e.closed_at is not null
  ),
  local_units as (
    select u.goal_id, u.execution_id, u.at_ts,
           (u.at_ts at time zone v_tz)::date as day,
           (u.at_ts at time zone v_tz)::time as at_time
      from units u
     where (u.at_ts at time zone v_tz)::date between v_from_week and v_to_week
  ),
  day_rows as (
    select g.id as goal_id, d::date as day,
           count(lu.execution_id)::integer as n,
           max(lu.at_ts) as last_at,
           coalesce(array_agg(distinct lu.execution_id) filter (where lu.execution_id is not null), '{}') as ids
      from goals g
      cross join generate_series(p_date_from, p_date_to, interval '1 day') d
      left join local_units lu on lu.goal_id = g.id and lu.day = d::date
     group by g.id, d
  ),
  week_rows as (
    select g.id as goal_id, w::date as wk,
           count(lu.execution_id)::integer as n,
           max(lu.at_ts) as last_at,
           coalesce(array_agg(distinct lu.execution_id) filter (where lu.execution_id is not null), '{}') as ids
      from goals g
      cross join generate_series(v_from_week, v_to_week - 6, interval '7 days') w
      left join local_units lu on lu.goal_id = g.id and lu.day between w::date and w::date + 6
     where g.period = 'week'
     group by g.id, w
  ),
  -- Checkpoints apply to daily goals. passed: the time has gone by (any earlier day, or today after the time).
  -- count_by_time: units done by that time that day; met: count_by_time reached the checkpoint's count.
  day_checkpoints as (
    select dr.goal_id, dr.day,
           coalesce(jsonb_agg(jsonb_build_object(
             'time',          cp.value->>'time',
             'count',         (cp.value->>'count')::int,
             'passed',        dr.day < v_today or (dr.day = v_today and v_now_time >= (cp.value->>'time')::time),
             'count_by_time', (select count(*) from local_units lu
                                where lu.goal_id = dr.goal_id and lu.day = dr.day
                                  and lu.at_time <= (cp.value->>'time')::time),
             'met',           (select count(*) from local_units lu
                                where lu.goal_id = dr.goal_id and lu.day = dr.day
                                  and lu.at_time <= (cp.value->>'time')::time) >= (cp.value->>'count')::int
           ) order by cp.ordinality), '[]'::jsonb) as cps,
           -- Today is behind when a passed checkpoint asks for more than has been done so far.
           bool_or(dr.day = v_today and v_now_time >= (cp.value->>'time')::time
                   and dr.n < (cp.value->>'count')::int) as behind_now
      from day_rows dr
      join goals g on g.id = dr.goal_id and g.period = 'day'
      cross join lateral jsonb_array_elements(g.pace_checkpoints) with ordinality cp
     group by dr.goal_id, dr.day
  )
  select v_plan.id, g.goal_key, g.label, g.measure, g.period, 'day'::text,
         dr.day, date_trunc('week', dr.day)::date,
         dr.n,
         case when g.period = 'day' then g.target end,
         case when g.period = 'day' then dr.n >= g.target end,
         case when g.period <> 'day' then null
              when dr.day < v_today then dr.n >= g.target
              when dr.day = v_today then dr.n >= g.target or not coalesce(dc.behind_now, false)
         end,
         null::integer,
         lower(to_char(dr.day, 'dy')) = any (g.usual_days),
         dr.day < v_plan.starts_on,
         coalesce(dc.cps, '[]'::jsonb),
         dr.last_at,
         dr.ids
    from day_rows dr
    join goals g on g.id = dr.goal_id
    left join day_checkpoints dc on dc.goal_id = dr.goal_id and dc.day = dr.day
  union all
  select v_plan.id, g.goal_key, g.label, g.measure, g.period, 'week'::text,
         null::date, wr.wk,
         wr.n,
         g.target,
         wr.n >= g.target,
         -- A finished week is on track if it met the target; the current week only once it has, else Claude judges
         -- from days_left and usual_days.
         case when wr.wk + 6 < v_today then wr.n >= g.target
              when wr.wk <= v_today then case when wr.n >= g.target then true end
         end,
         case when wr.wk + 6 < v_today then 0
              when wr.wk <= v_today then (wr.wk + 6) - v_today + 1
              else 7 end,
         null::boolean,
         wr.wk + 6 < v_plan.starts_on,
         '[]'::jsonb,
         wr.last_at,
         wr.ids
    from week_rows wr
    join goals g on g.id = wr.goal_id
   order by 2, 6, 7, 8;
end;
$$;

comment on function public.arnold_get_progress(date, date, uuid) is
'Arnold: progress for every goal of a plan (default: the caller''s active plan) over a Pacific date range, at most 93
days. One "day" row per goal per day; weekly goals also get one "week" row per Monday-to-Sunday week the range touches,
counted over the whole week. elements goals count elements with display_type step and is_completed true on the goal''s
intention''s executions, each dated by its own completed_at in Pacific time; executions goals count closed executions
with outcome done, dated by closed_at in Pacific time.

Columns: count; target and met (daily goals on day rows, all goals on week rows); on_track (past days and weeks: met;
today: met, or no passed pace checkpoint asks for more than count; current week: true once met, else null for Claude to
judge from days_left and usual_days; future: null); days_left (week rows, including today); usual_day (day rows);
before_plan (the day or week ends before the plan''s starts_on); checkpoints (daily goals: [{time, count, passed,
count_by_time, met}]); last_activity_at (newest counted tick or execution in the row); execution_ids (counted
executions, for links). The ONLY place progress is counted: the tools and tasks call this rather than counting.';

revoke all on function public.arnold_get_progress(date, date, uuid) from public, anon;
grant execute on function public.arnold_get_progress(date, date, uuid) to authenticated, service_role;

commit;

-- No table changed. Expected: CONFORMANT.
select public.platform_check_conformance() as conformance;
