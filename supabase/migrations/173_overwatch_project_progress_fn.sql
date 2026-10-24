-- Purpose: Overwatch Step 13 (Phase 3). public.overwatch_project_progress: the caller's Project groups with their plans
-- and the counted effort: steps_used is the number of distinct step numbers in CLI run tags under the project code
-- (clips.run_tag, Step 4), with the report count and the last report time. Backs the get_project_plans tool.
-- Kind: schema change (one function)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md sections 4.3 and 7. Run as one block in the SQL editor.
-- Safe to re-run: create or replace.
-- supabase/migrations/173_overwatch_project_progress_fn.sql

begin;

-- Run tags look like <code>-s<step>[letter]-<4 chars>: overwatch-q4n-s12b-n6ds is step 12. The code holds only
-- [a-z0-9_-], so it is safe inside the pattern as it stands.
create or replace function public.overwatch_project_progress(
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
  last_report_at      timestamptz)
language sql
stable
set search_path = public, pg_temp
as $$
  select g.id, g.name, g.status, g.context_id, p.group_id is not null,
         p.project_code, p.target_date, p.effort_estimate, p.where_now, p.next_step, p.waiting_on,
         p.waiting_on_kind, p.waiting_on_group_id, p.hurdle_kind, p.status_written_at,
         coalesce(r.steps_used, 0), coalesce(r.reports, 0), r.last_report_at
    from public.item_groups g
    join public.group_types t on t.id = g.group_type_id and t.kind = 'project'
    left join public.project_plans p on p.group_id = g.id
    left join lateral (
      select count(distinct (regexp_match(c.run_tag, '^' || p.project_code || '-s([0-9]+)[a-z]?-[a-z0-9]{4}$'))[1])::int
               as steps_used,
             count(*)::int as reports,
             max(c.created_at) as last_report_at
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
  'project code: steps_used (distinct step numbers), reports and last_report_at. Invoker: RLS on item_groups, '
  'project_plans and clips decides the rows. Backs get_project_plans.';
revoke all on function public.overwatch_project_progress(text[], text[]) from public, anon;
grant execute on function public.overwatch_project_progress(text[], text[]) to authenticated, service_role;

commit;

-- Result: what it returns for the caller's Projects in any status (empty from the SQL editor, which has no auth.uid();
-- the row count is the real check), and conformance (must say CONFORMANT).
select json_build_object(
  'function', (select coalesce(json_agg(t), '[]'::json) from (
      select p.oid::regprocedure::text as signature, p.provolatile = 's' as stable, not p.prosecdef as invoker,
             has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
        from pg_proc p where p.proname = 'overwatch_project_progress'
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
