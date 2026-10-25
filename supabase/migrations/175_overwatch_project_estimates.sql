-- Purpose: Overwatch Step 21 (Phase 5). public.project_estimates: every estimate a Project has had, oldest first:
-- one initial (never changed), scope increases and decreases, re-estimates, and one final with the actual steps used.
-- record_project_estimate writes a row and, except for final, sets project_plans.effort_estimate in the same
-- transaction. Seeds the Overwatch project's two rows: initial 40, then scope_increase +4 at step 18 (current 44).
-- Kind: schema change (new table, two functions) plus two seeded rows and one project_plans update
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.12. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/17_project_estimates_test.sql.
-- Safe to re-run: every create is idempotent, and the seed runs only when the project has no estimates yet.
-- supabase/migrations/175_overwatch_project_estimates.sql

begin;

-- ============================================================================
-- 1. The table
-- ============================================================================
create table if not exists public.project_estimates (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null default auth.uid() references auth.users (id),
  group_id     text        not null references public.item_groups (id) on delete cascade,
  kind         text        not null,
  estimate     integer     not null,
  cli_estimate integer,
  steps_added  integer,
  at_step      integer,
  reason       text        not null,
  created_at   timestamptz not null default now(),

  constraint project_estimates_kind_values
    check (kind in ('initial', 'scope_increase', 'scope_decrease', 're_estimate', 'final')),
  constraint project_estimates_estimate_range check (estimate between 0 and 1000),
  constraint project_estimates_cli_estimate_where
    check (cli_estimate is null or (kind in ('initial', 're_estimate') and cli_estimate between 1 and 1000)),
  constraint project_estimates_steps_added_sign
    check ((kind = 'scope_increase' and steps_added > 0)
           or (kind = 'scope_decrease' and steps_added < 0)
           or (kind not in ('scope_increase', 'scope_decrease') and steps_added is null)),
  constraint project_estimates_at_step_positive check (at_step is null or at_step >= 0),
  constraint project_estimates_reason_one_line check (length(trim(reason)) between 1 and 300)
);

create unique index if not exists project_estimates_one_initial on public.project_estimates (group_id) where kind = 'initial';
create unique index if not exists project_estimates_one_final on public.project_estimates (group_id) where kind = 'final';
create index if not exists project_estimates_group_idx on public.project_estimates (group_id, created_at);

comment on table public.project_estimates is
  'OVERWATCH. Every estimate a Project has had, in CLI steps, oldest first. Rows are only inserted: the initial row is '
  'the original estimate and never changes; scope_increase and scope_decrease carry steps_added; re_estimate is a new '
  'guess with no change of scope; final records the actual steps used. project_plans.effort_estimate is the current '
  'figure. Accuracy is judged against the original and against the scope-adjusted estimate (initial plus every '
  'steps_added). Spec: docs/technical-spec-overwatch-q4n.md section 4.12.';
comment on column public.project_estimates.id is 'Row id.';
comment on column public.project_estimates.user_id is 'Owner; must own the Project group too. Owner RLS.';
comment on column public.project_estimates.group_id is 'The Project group (group_types.kind = project).';
comment on column public.project_estimates.kind is 'initial, scope_increase, scope_decrease, re_estimate or final.';
comment on column public.project_estimates.estimate is
  'The project''s estimate in CLI steps after this row; for final, the actual steps used. Steps count as steps_used '
  'counts them: a lettered sub-step (s4b) is step 4.';
comment on column public.project_estimates.cli_estimate is
  'The figure the CLI gave, before estimate_correction_factor; on initial and re_estimate rows only.';
comment on column public.project_estimates.steps_added is
  'Steps added (positive, scope_increase) or removed (negative, scope_decrease); null otherwise.';
comment on column public.project_estimates.at_step is 'The step number (from the run tag) it happened at, if known.';
comment on column public.project_estimates.reason is 'One line: why.';
comment on column public.project_estimates.created_at is 'When the row was written.';

-- ============================================================================
-- 2. The guard: insert-only, and only on the caller's own Projects
-- ============================================================================
create or replace function public.project_estimates_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'project_estimates rows are not edited: record a new row with record_project_estimate.'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.item_groups g join public.group_types t on t.id = g.group_type_id
                  where g.id = new.group_id and g.user_id = new.user_id and t.kind = 'project') then
    raise exception 'project_estimates refused: group % is not one of your Project groups (group_types.kind = project).',
      new.group_id using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.project_estimates_guard() is
  'Overwatch: project_estimates rows are insert-only, and only for the same user''s Project groups.';
revoke all on function public.project_estimates_guard() from public, anon;

drop trigger if exists project_estimates_guard on public.project_estimates;
create trigger project_estimates_guard
  before insert or update on public.project_estimates
  for each row execute function public.project_estimates_guard();

-- ============================================================================
-- 3. record_project_estimate (caller's own rows, under RLS)
-- ============================================================================
-- initial and re_estimate: pass p_cli_estimate (the CLI's figure); estimate = round(cli × estimate_correction_factor
-- from the active plan, default 1.0), unless p_estimate is given. scope_increase and scope_decrease: pass p_steps_added;
-- estimate = current + steps_added. final: pass p_estimate (actual steps), or leave it out to use steps_used.
create or replace function public.record_project_estimate(
  p_group_id     text,
  p_kind         text,
  p_reason       text,
  p_estimate     integer default null,
  p_cli_estimate integer default null,
  p_steps_added  integer default null,
  p_at_step      integer default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current integer;
  v_factor  numeric;
  v_est     integer;
  v_row     public.project_estimates%rowtype;
begin
  if p_kind is null or p_kind not in ('initial', 'scope_increase', 'scope_decrease', 're_estimate', 'final') then
    raise exception 'record_project_estimate: kind must be initial, scope_increase, scope_decrease, re_estimate or final.'
      using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'record_project_estimate: a one-line reason is required.' using errcode = '22023';
  end if;

  select effort_estimate into v_current from public.project_plans where group_id = p_group_id;
  if p_kind <> 'initial' and not exists (select 1 from public.project_estimates
                                          where group_id = p_group_id and kind = 'initial') then
    raise exception 'record_project_estimate: record the initial estimate first.' using errcode = '22023';
  end if;

  if p_kind in ('initial', 're_estimate') then
    if p_estimate is null and p_cli_estimate is null then
      raise exception 'record_project_estimate: % needs the CLI''s figure (p_cli_estimate) or p_estimate.', p_kind
        using errcode = '22023';
    end if;
    select coalesce((settings ->> 'estimate_correction_factor')::numeric, 1.0) into v_factor
      from public.overwatch_plans where user_id = auth.uid() and active;
    v_est := coalesce(p_estimate, round(p_cli_estimate * coalesce(v_factor, 1.0))::integer);
  elsif p_kind in ('scope_increase', 'scope_decrease') then
    if p_steps_added is null then
      raise exception 'record_project_estimate: % needs p_steps_added.', p_kind using errcode = '22023';
    end if;
    if v_current is null then
      raise exception 'record_project_estimate: the project has no current estimate to change.' using errcode = '22023';
    end if;
    v_est := v_current + p_steps_added;
  else -- final
    v_est := coalesce(p_estimate, (select steps_used from public.overwatch_project_progress(null, array[p_group_id])));
    if v_est is null then
      raise exception 'record_project_estimate: no steps counted for this project; pass p_estimate (actual steps).'
        using errcode = '22023';
    end if;
  end if;

  insert into public.project_estimates (group_id, kind, estimate, cli_estimate, steps_added, at_step, reason)
  values (p_group_id, p_kind, v_est,
          case when p_kind in ('initial', 're_estimate') then p_cli_estimate end,
          case when p_kind in ('scope_increase', 'scope_decrease') then p_steps_added end,
          p_at_step, trim(p_reason))
  returning * into v_row;

  -- The plan carries the current figure; a final row records the outcome and leaves it alone.
  if p_kind <> 'final' then
    insert into public.project_plans (group_id, effort_estimate) values (p_group_id, v_est)
    on conflict (group_id) do update set effort_estimate = excluded.effort_estimate;
  end if;
  return to_jsonb(v_row);
end;
$$;

comment on function public.record_project_estimate(text, text, text, integer, integer, integer, integer) is
  'Overwatch: add a project_estimates row and, except for final, set project_plans.effort_estimate to it, in one '
  'transaction. Refuses a second initial or final (unique indexes) and anything but the caller''s Project. Called by '
  'the tier-2 record_project_estimate tool.';
revoke all on function public.record_project_estimate(text, text, text, integer, integer, integer, integer) from public, anon;
grant execute on function public.record_project_estimate(text, text, text, integer, integer, integer, integer)
  to authenticated, service_role;

-- ============================================================================
-- 4. Register: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table(
  'public.project_estimates',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Every estimate a Project has had; insert-only. Written by record_project_estimate (tier 2).'
);

-- ============================================================================
-- 5. Seed the Overwatch project: initial 40 at Step 17, scope_increase +4 at step 18; current 44
-- ============================================================================
do $$
declare
  v_group text := 'mvnv8pa2v6zip3xnpm';
  v_user  uuid := (select user_id from public.item_groups where id = 'mvnv8pa2v6zip3xnpm');
begin
  if v_user is null then
    raise notice 'Overwatch group mvnv8pa2v6zip3xnpm not found; nothing seeded.';
  elsif not exists (select 1 from public.project_estimates where group_id = v_group) then
    insert into public.project_estimates (user_id, group_id, kind, estimate, cli_estimate, at_step, reason, created_at)
    values (v_user, v_group, 'initial', 40, 40, 17, 'Original estimate, made at Step 17.', now() - interval '1 second');
    insert into public.project_estimates (user_id, group_id, kind, estimate, steps_added, at_step, reason)
    values (v_user, v_group, 'scope_increase', 44, 4, 18, 'estimate tracking added (Steps 21-24)');
    insert into public.project_plans (group_id, user_id, effort_estimate) values (v_group, v_user, 44)
    on conflict (group_id) do update set effort_estimate = excluded.effort_estimate;
  end if;
end
$$;

commit;

-- ============================================================================
-- 6. Result: the table, the seeded history, the plan's current figure, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as columns, count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a where a.attrelid = 'public.project_estimates'::regclass and a.attnum > 0 and not a.attisdropped
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read from platform.registry where table_name = 'public.project_estimates'
    ) t),
  'overwatch_history', (select coalesce(json_agg(t), '[]'::json) from (
      select kind, estimate, cli_estimate, steps_added, at_step, reason
        from public.project_estimates where group_id = 'mvnv8pa2v6zip3xnpm' order by created_at
    ) t),
  'overwatch_current_estimate', (select effort_estimate from public.project_plans where group_id = 'mvnv8pa2v6zip3xnpm'),
  'conformance', public.platform_check_conformance()
) as result;
