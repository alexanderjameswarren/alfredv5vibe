-- Purpose: Overwatch Step 11 (Phase 2). public.project_plans (planning fields for a Project group, one row per group) and
-- public.project_links (notify_on_ship, no_parallel, depends_on between Projects), with one guard function that refuses
-- any group that is not a Project (group_types.kind = 'project') or not the caller's own.
-- Kind: schema change (two new tables, one trigger function, two triggers)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md sections 4.3 and 4.4. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/10_project_plans_test.sql.
-- Safe to re-run: the tables, triggers and registrations are idempotent.
-- supabase/migrations/171_overwatch_project_plans.sql

begin;

-- ============================================================================
-- 1. project_plans
-- ============================================================================
create table if not exists public.project_plans (
  group_id            text        primary key references public.item_groups (id) on delete cascade,
  user_id             uuid        not null default auth.uid() references auth.users (id),
  project_code        text,
  target_date         date,
  effort_estimate     integer,
  where_now           text,
  next_step           text,
  waiting_on          text,
  waiting_on_kind     text,
  waiting_on_group_id text        references public.item_groups (id) on delete set null,
  hurdle_kind         text,
  status_written_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint project_plans_code_format check (project_code is null or project_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint project_plans_effort_positive check (effort_estimate is null or effort_estimate between 1 and 500),
  constraint project_plans_waiting_kind_values
    check (waiting_on_kind is null or waiting_on_kind in ('alex', 'decision', 'project', 'hurdle')),
  constraint project_plans_waiting_group_is_project_kind
    check (waiting_on_group_id is null or waiting_on_kind = 'project'),
  constraint project_plans_not_waiting_on_itself check (waiting_on_group_id is distinct from group_id),
  constraint project_plans_hurdle_kind_values
    check (hurdle_kind is null or hurdle_kind in ('technology', 'time', 'money', 'skill'))
);

-- A project code names one project.
create unique index if not exists project_plans_code_once
  on public.project_plans (user_id, project_code) where project_code is not null;

comment on table public.project_plans is
  'OVERWATCH. Planning fields for a Project group (group_types.kind = project), one row per group. Actual effort is not '
  'stored: it is the number of distinct step numbers in run tags under project_code. Written by update_project_plan '
  '(tier 2). Spec: docs/technical-spec-overwatch-q4n.md section 4.3.';
comment on column public.project_plans.group_id is
  'The Project group, an item_groups.id. One plan per group; deleting the group deletes its plan. project_plans_check_group '
  'refuses a group that is not a Project or not the caller''s.';
comment on column public.project_plans.user_id is 'Owner. Must own the group too (project_plans_check_group). Owner RLS.';
comment on column public.project_plans.project_code is
  'The CLI project code, e.g. overwatch-q4n, which links run tags (clips.run_tag) to this project. One per user.';
comment on column public.project_plans.target_date is 'The date Alex wants it done by, or null.';
comment on column public.project_plans.effort_estimate is 'Estimated CLI steps, 1 to 500, or null.';
comment on column public.project_plans.where_now is 'One line: where it stands.';
comment on column public.project_plans.next_step is 'One line: the next step.';
comment on column public.project_plans.waiting_on is 'One line: what it is waiting on, or null.';
comment on column public.project_plans.waiting_on_kind is
  'What kind of wait: alex, decision, project (set waiting_on_group_id) or hurdle (set hurdle_kind), or null.';
comment on column public.project_plans.waiting_on_group_id is
  'The Project it waits on, when waiting_on_kind is project. Must be a Project of the same user, never itself.';
comment on column public.project_plans.hurdle_kind is 'Why it is parked: technology, time, money or skill, or null.';
comment on column public.project_plans.status_written_at is
  'When the status line (where_now, next_step, waiting_on, waiting_on_kind) last changed. Stamped by project_plans_check_group; '
  'the stall check reads it.';
comment on column public.project_plans.created_at is 'Row creation.';
comment on column public.project_plans.updated_at is 'Last change. Stamped by project_plans_check_group.';

-- ============================================================================
-- 2. project_links
-- ============================================================================
create table if not exists public.project_links (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  from_group_id text        not null references public.item_groups (id) on delete cascade,
  to_group_id   text        not null references public.item_groups (id) on delete cascade,
  kind          text        not null,
  note          text,
  created_by    text        not null default 'alex',
  created_at    timestamptz not null default now(),

  constraint project_links_kind_values check (kind in ('notify_on_ship', 'no_parallel', 'depends_on')),
  constraint project_links_created_by_values check (created_by in ('alex', 'overwatch')),
  constraint project_links_not_to_itself check (from_group_id <> to_group_id),
  constraint project_links_once unique (user_id, from_group_id, to_group_id, kind)
);

comment on table public.project_links is
  'OVERWATCH. Links between Project groups: notify_on_ship (when from ships, tell to), no_parallel (learned from repeated '
  'claim blocks; do not run the two at once) and depends_on (from waits on to). Both ends must be the user''s Projects '
  '(project_plans_check_group). Spec: docs/technical-spec-overwatch-q4n.md section 4.4.';
comment on column public.project_links.id is 'Row id.';
comment on column public.project_links.user_id is 'Owner. Must own both groups (project_plans_check_group). Owner RLS.';
comment on column public.project_links.from_group_id is 'The Project the link starts from.';
comment on column public.project_links.to_group_id is 'The Project it points to. Never the same as from_group_id.';
comment on column public.project_links.kind is 'notify_on_ship, no_parallel or depends_on. One of each per pair and direction.';
comment on column public.project_links.note is 'Why the link exists, in plain words.';
comment on column public.project_links.created_by is 'alex, or overwatch when the nightly job proposed it and Alex agreed.';
comment on column public.project_links.created_at is 'Row creation.';

-- ============================================================================
-- 3. The guard (both tables) and the stamps (project_plans)
-- ============================================================================
create or replace function public.project_plans_check_group()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- Read as jsonb: the two tables have different columns, and a field the row lacks would fail even in an unused branch.
  v_row    jsonb := to_jsonb(new);
  v_groups text[];
  v_g      text;
begin
  v_groups := case tg_table_name
    when 'project_plans' then array_remove(array[v_row ->> 'group_id', v_row ->> 'waiting_on_group_id'], null)
    else array[v_row ->> 'from_group_id', v_row ->> 'to_group_id']
  end;
  foreach v_g in array v_groups loop
    if not exists (select 1 from public.item_groups g join public.group_types t on t.id = g.group_type_id
                    where g.id = v_g and g.user_id = new.user_id and t.kind = 'project') then
      raise exception '% refused: group % is not one of your Project groups (group_types.kind = project).', tg_table_name, v_g
        using errcode = '23514';
    end if;
  end loop;

  if tg_table_name = 'project_plans' then
    new.updated_at := now();
    if tg_op = 'INSERT' then
      new.status_written_at := case when coalesce(new.where_now, new.next_step, new.waiting_on, new.waiting_on_kind) is not null
                                    then now() end;
    elsif (new.where_now, new.next_step, new.waiting_on, new.waiting_on_kind)
          is distinct from (old.where_now, old.next_step, old.waiting_on, old.waiting_on_kind) then
      new.status_written_at := now();
    else
      new.status_written_at := old.status_written_at;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.project_plans_check_group() is
  'Overwatch: refuses a project_plans or project_links row whose group is not the same user''s Project group '
  '(group_types.kind = project); stamps project_plans.updated_at, and status_written_at when the status line changes.';
revoke all on function public.project_plans_check_group() from public, anon;

drop trigger if exists project_plans_check_group on public.project_plans;
create trigger project_plans_check_group
  before insert or update on public.project_plans
  for each row execute function public.project_plans_check_group();

drop trigger if exists project_plans_check_group on public.project_links;
create trigger project_plans_check_group
  before insert or update on public.project_links
  for each row execute function public.project_plans_check_group();

-- ============================================================================
-- 4. Register both: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table(
  'public.project_plans',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Planning fields for a Project group, one row per group. Written by update_project_plan (tier 2).'
);
select platform.register_table(
  'public.project_links',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Links between Project groups: notify_on_ship, no_parallel, depends_on. Written by create_project_link.'
);

commit;

-- ============================================================================
-- 5. Result: both tables, their registration, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attrelid::regclass::text as table_name, count(*) as columns,
             count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a
       where a.attrelid in ('public.project_plans'::regclass, 'public.project_links'::regclass)
         and a.attnum > 0 and not a.attisdropped
       group by 1 order by 1
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read from platform.registry
       where table_name in ('public.project_plans', 'public.project_links') order by 1
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
