-- Purpose: Overwatch Step 33 (Phase 6). What the /overwatch tab needs from the database:
--   1. public.overwatch_app_last_activity: each app's newest activity, one row per user and app, so "Quiet lately"
--      is one read and not one per app. security_invoker, so activity's owner RLS decides the rows.
--   2. overwatch_project_progress gains first_report_at (the earliest CLI report under the project code), so the
--      estimated finish from pace works on the tab and in the nightly note. A new output column changes the
--      function's return type, so it is dropped and recreated in the same transaction, grants included.
--   3. The overwatch apps row's icon moves from Radar to TowerControl (Alex's choice, 2026-10-25).
-- Kind: schema change (one view, one function recreated) plus a one-row data update
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 9. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/22_tab_views_test.sql and 23_verify_tab_views.sql.
-- Safe to re-run: the view is create or replace, the function is dropped if it exists, and the icon update only
-- touches a row still on Radar.
-- supabase/migrations/178_overwatch_tab_views.sql

begin;

-- ============================================================================
-- 1. Each app's newest activity
-- ============================================================================
create or replace view public.overwatch_app_last_activity
with (security_invoker = true) as
select a.user_id,
       a.app_id,
       max(a.occurred_at) as last_occurred_at,
       count(*)::int      as rows_logged
  from public.activity a
 group by a.user_id, a.app_id;

comment on view public.overwatch_app_last_activity is
  'OVERWATCH. One row per user and app: when the app last had activity (any kind, any source) and how many activity '
  'rows it has. Backs the tab''s Quiet lately section, compared with app_profiles.rhythm_days. security_invoker, so '
  'activity''s owner RLS decides the rows. Spec: docs/technical-spec-overwatch-q4n.md section 9.';
comment on column public.overwatch_app_last_activity.user_id is 'Owner of the activity rows.';
comment on column public.overwatch_app_last_activity.app_id is 'The app, an apps.id.';
comment on column public.overwatch_app_last_activity.last_occurred_at is 'When its newest activity row happened.';
comment on column public.overwatch_app_last_activity.rows_logged is 'How many activity rows the app has.';

select platform.grant_table('public.overwatch_app_last_activity');

-- ============================================================================
-- 2. overwatch_project_progress with first_report_at
-- ============================================================================
drop function if exists public.overwatch_project_progress(text[], text[]);

create function public.overwatch_project_progress(
  p_status    text[] default array['active'],
  p_group_ids text[] default null)
returns table (
  group_id            text,
  name                text,
  group_status        text,
  context_id          text,
  has_plan            boolean,
  project_code        text,
  target_date         date,
  effort_estimate     integer,
  where_now           text,
  next_step           text,
  waiting_on          text,
  waiting_on_kind     text,
  waiting_on_group_id text,
  hurdle_kind         text,
  status_written_at   timestamptz,
  steps_used          integer,
  reports             integer,
  last_report_at      timestamptz,
  first_report_at     timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select g.id, g.name, g.status, g.context_id, p.group_id is not null,
         p.project_code, p.target_date, p.effort_estimate, p.where_now, p.next_step, p.waiting_on,
         p.waiting_on_kind, p.waiting_on_group_id, p.hurdle_kind, p.status_written_at,
         coalesce(r.steps_used, 0), coalesce(r.reports, 0), r.last_report_at, r.first_report_at
    from public.item_groups g
    join public.group_types t on t.id = g.group_type_id and t.kind = 'project'
    left join public.project_plans p on p.group_id = g.id
    left join lateral (
      select count(distinct (regexp_match(c.run_tag, '^' || p.project_code || '-s([0-9]+)[a-z]?-[a-z0-9]{4}$'))[1])::int
               as steps_used,
             count(*)::int as reports,
             max(c.created_at) as last_report_at,
             min(c.created_at) as first_report_at
        from public.clips c
       where p.project_code is not null
         and c.run_tag like p.project_code || '-s%'
         and c.run_tag ~ ('^' || p.project_code || '-s[0-9]+[a-z]?-[a-z0-9]{4}$')
    ) r on true
   where g.archived = false
     and (p_status is null or g.status = any (p_status))
     and (p_group_ids is null or g.id = any (p_group_ids))
   order by r.last_report_at desc nulls last, g.name
$$;

comment on function public.overwatch_project_progress(text[], text[]) is
  'Overwatch: the caller''s unarchived Project groups (group_types.kind = project) in the given statuses (default '
  'active; null for all), each with its project_plans row if any, and the counted effort from clips.run_tag under the '
  'project code: steps_used (distinct step numbers), reports, last_report_at and first_report_at (the pace for the '
  'estimated finish). Invoker: RLS on item_groups, project_plans and clips decides the rows. Backs get_project_plans '
  'and the /overwatch tab.';
revoke all on function public.overwatch_project_progress(text[], text[]) from public, anon;
grant execute on function public.overwatch_project_progress(text[], text[]) to authenticated, service_role;

-- ============================================================================
-- 3. Overwatch's icon
-- ============================================================================
update public.apps set icon = 'TowerControl' where id = 'overwatch' and icon = 'Radar';

commit;

-- ============================================================================
-- 4. Check
-- ============================================================================
select json_build_object(
  'view', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname, c.reloptions,
             has_table_privilege('anon', c.oid, 'select') as anon_can_select,
             has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select
        from pg_class c where c.oid = 'public.overwatch_app_last_activity'::regclass
    ) t),
  'function', (select coalesce(json_agg(t), '[]'::json) from (
      select p.oid::regprocedure::text as signature, not p.prosecdef as invoker,
             pg_get_function_result(p.oid) like '%first_report_at%' as has_first_report_at,
             has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
        from pg_proc p where p.proname = 'overwatch_project_progress'
    ) t),
  'overwatch_icon', (select icon from public.apps where id = 'overwatch'),
  'conformance', public.platform_check_conformance()
) as result;
