-- Switchboard 2.0 switchboard_prod-w3k s8: effort counting across every code a Project has had. Kind: schema change
-- (one new table, two trigger functions, one function replaced) plus its backfill.
-- Spec: docs/technical-spec-switchboard_prod-w3k.md 9. Tables touched: project_codes (new), project_plans (trigger).
-- Function replaced: overwatch_project_progress (same signature and columns; the nightly-counts functions read pr.*).
--
-- Until now steps_used counted run tags only under project_plans.project_code, so when a Project moved to a new code
-- (switchboard2-h8r -> switchboard_prod-w3k) its earlier steps stopped counting, and a side thread's code (the
-- switchboard repo's switchboard_prodrepo-w3k) never counted. project_codes keeps every code a Project has had:
--   source plan  a code that was the plan's project_code at some point (the trigger records each one);
--   source side  a code another thread works under for the same Project (update_project_plan add_project_codes).
-- One code belongs to one Project: a code already held by another group is refused, naming that group.

-- ============================================================================
-- 1. project_codes
-- ============================================================================
create table if not exists public.project_codes (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  group_id      text        not null references public.item_groups (id) on delete cascade,
  project_code  text        not null,
  source        text        not null,
  added_at      timestamptz not null default now(),

  constraint project_codes_code_format check (project_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint project_codes_source_values check (source in ('plan', 'side')),
  constraint project_codes_code_once unique (user_id, project_code)
);
create index if not exists project_codes_group_idx on public.project_codes (group_id);

comment on table public.project_codes is
  'OVERWATCH. Every project code a Project group has had, so its effort counts across them: overwatch_project_progress '
  'counts run tags under each. source plan rows come from the project_plans trigger (each code the plan has held); source '
  'side rows from update_project_plan add_project_codes (another thread''s code for the same Project). One code belongs to '
  'one Project. Spec: docs/technical-spec-switchboard_prod-w3k.md 9.';
comment on column public.project_codes.id is 'Row id.';
comment on column public.project_codes.user_id is 'Owner. Must own the group too (project_codes_check_group). Owner RLS.';
comment on column public.project_codes.group_id is
  'The Project group, an item_groups.id; deleting the group deletes its codes. Must be the owner''s Project group.';
comment on column public.project_codes.project_code is
  'A project code, as in run tags (<code>-s<n>-<4>). Unique per user: a code belongs to one Project.';
comment on column public.project_codes.source is
  'plan: the plan''s project_code held it at some point. side: added as another thread''s code for this Project.';
comment on column public.project_codes.added_at is 'When the code was recorded here.';

-- The group must be the owner's Project; a code held by another group is refused with that group's id and name.
create or replace function public.project_codes_check_group()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_other text;
begin
  if not exists (select 1 from public.item_groups g join public.group_types t on t.id = g.group_type_id
                  where g.id = new.group_id and g.user_id = new.user_id and t.kind = 'project') then
    raise exception 'project_codes refused: group % is not one of your Project groups (group_types.kind = project).', new.group_id
      using errcode = '23514';
  end if;
  select coalesce(g.name, c.group_id) || ' (' || c.group_id || ')' into v_other
    from public.project_codes c left join public.item_groups g on g.id = c.group_id
   where c.user_id = new.user_id and c.project_code = new.project_code and c.group_id <> new.group_id
     and c.id <> new.id
   limit 1;
  if v_other is not null then
    raise exception 'project_codes refused: % already belongs to %.', new.project_code, v_other using errcode = '23505';
  end if;
  return new;
end;
$$;
comment on function public.project_codes_check_group() is
  'Overwatch: refuses a project_codes row whose group is not the same user''s Project group, or whose code another '
  'group already holds (naming that group). Trigger function; no execute grant needed.';
revoke all on function public.project_codes_check_group() from public, anon;

drop trigger if exists project_codes_check_group on public.project_codes;
create trigger project_codes_check_group
  before insert or update on public.project_codes
  for each row execute function public.project_codes_check_group();

select platform.register_table('public.project_codes');

-- ============================================================================
-- 2. project_plans: every code the plan holds is recorded, the old one kept when it changes
-- ============================================================================
create or replace function public.project_plans_record_code()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and old.project_code is not null then
    insert into public.project_codes (user_id, group_id, project_code, source)
    select old.user_id, old.group_id, old.project_code, 'plan'
     where not exists (select 1 from public.project_codes c
                        where c.user_id = old.user_id and c.project_code = old.project_code and c.group_id = old.group_id);
  end if;
  if new.project_code is not null then
    -- project_codes_check_group refuses a code another group holds, so the plan change fails with it.
    insert into public.project_codes (user_id, group_id, project_code, source)
    select new.user_id, new.group_id, new.project_code, 'plan'
     where not exists (select 1 from public.project_codes c
                        where c.user_id = new.user_id and c.project_code = new.project_code and c.group_id = new.group_id);
  end if;
  return null;
end;
$$;
comment on function public.project_plans_record_code() is
  'Overwatch: after a project_plans insert, or an update of project_code, records the old code (on update) and the new '
  'code in project_codes as source plan, so no code a Project has had is lost. A code another Project holds is refused. '
  'Trigger function; no execute grant needed.';
revoke all on function public.project_plans_record_code() from public, anon;

drop trigger if exists project_plans_record_code on public.project_plans;
create trigger project_plans_record_code
  after insert or update of project_code on public.project_plans
  for each row execute function public.project_plans_record_code();

-- ============================================================================
-- 3. Backfill. Each named Project must exist with its plan; otherwise the whole migration stops.
-- ============================================================================
do $$
declare
  c_named constant jsonb := jsonb_build_array(
    -- Switchboard 2.0: its earlier plan code, the two switchboard repo threads, and its current code.
    jsonb_build_object('group_id', 'mvsmdaag09pvs6wddm03', 'code', 'switchboard2-h8r',         'source', 'plan'),
    jsonb_build_object('group_id', 'mvsmdaag09pvs6wddm03', 'code', 'switchboard_repo-k7m',     'source', 'side'),
    jsonb_build_object('group_id', 'mvsmdaag09pvs6wddm03', 'code', 'switchboard_prodrepo-w3k', 'source', 'side'),
    jsonb_build_object('group_id', 'mvsmdaag09pvs6wddm03', 'code', 'switchboard_prod-w3k',     'source', 'plan'),
    -- ActBlue Common Defense: Fix A's thread, and its current code.
    jsonb_build_object('group_id', 'mw9h5nd2tqlxtvmz0bj', 'code', 'cd_ab_recurring_fix-t6k',  'source', 'side'),
    jsonb_build_object('group_id', 'mw9h5nd2tqlxtvmz0bj', 'code', 'cd_ab_diagnose-r4m',       'source', 'plan'));
  v_e    jsonb;
  v_user uuid;
begin
  for v_e in select * from jsonb_array_elements(c_named) loop
    select p.user_id into v_user from public.project_plans p where p.group_id = v_e->>'group_id';
    if v_user is null then
      raise exception 'project_codes backfill: no project_plans row for group %; nothing was written.', v_e->>'group_id';
    end if;
    insert into public.project_codes (user_id, group_id, project_code, source)
    select v_user, v_e->>'group_id', v_e->>'code', v_e->>'source'
     where not exists (select 1 from public.project_codes c
                        where c.user_id = v_user and c.project_code = v_e->>'code' and c.group_id = v_e->>'group_id');
  end loop;

  -- Every other plan's current code.
  insert into public.project_codes (user_id, group_id, project_code, source)
  select p.user_id, p.group_id, p.project_code, 'plan'
    from public.project_plans p
   where p.project_code is not null
     and not exists (select 1 from public.project_codes c where c.user_id = p.user_id and c.project_code = p.project_code);
end;
$$;

-- ============================================================================
-- 4. overwatch_project_progress over every code. Same signature and columns.
-- ============================================================================
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
      -- Steps are distinct (code, step number) pairs: s4 under two codes counts twice, s4 and s4b under one once.
      select count(distinct (k.code, m.step))::int as steps_used,
             count(*)::int as reports,
             max(c.created_at) as last_report_at,
             min(c.created_at) as first_report_at
        from (select pc.project_code as code from public.project_codes pc where pc.group_id = g.id
              union
              select p.project_code where p.project_code is not null) k
        join public.clips c
          on c.run_tag like k.code || '-s%'
         and c.run_tag ~ ('^' || k.code || '-s[0-9]+[a-z]?-[a-z0-9]{4}$')
        cross join lateral (select (regexp_match(c.run_tag, '^' || k.code || '-s([0-9]+)[a-z]?-[a-z0-9]{4}$'))[1] as step) m
    ) r on true
   where g.archived = false
     and (p_status is null or g.status = any (p_status))
     and (p_group_ids is null or g.id = any (p_group_ids))
   order by r.last_report_at desc nulls last, g.name
$$;

comment on function public.overwatch_project_progress(text[], text[]) is
  'Overwatch: the caller''s unarchived Project groups (group_types.kind = project) in the given statuses (default '
  'active; null for all), each with its project_plans row if any, and the counted effort from clips.run_tag under every '
  'code the Project has had (project_codes, plus the plan''s current code): steps_used (distinct code and step number '
  'pairs), reports, last_report_at and first_report_at (the pace for the estimated finish). Invoker: RLS on item_groups, '
  'project_plans, project_codes and clips decides the rows. Backs get_project_plans, the /overwatch tab and the nightly counts.';
revoke all on function public.overwatch_project_progress(text[], text[]) from public, anon;
grant execute on function public.overwatch_project_progress(text[], text[]) to authenticated, service_role;

-- ============================================================================
-- 5. Result: must say CONFORMANT. Then run supabase/tests/switchboard_prod-w3k/2_project_codes.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
