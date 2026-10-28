-- Purpose: Overwatch Step 53 (Phase 8b). The portfolio plan: portfolios (Alfred ecosystem, client work, each with its
-- own plans), portfolio_plans (versions, one active per portfolio, each with the theory behind its order),
-- portfolio_lanes (the lanes a version names) and portfolio_slices (a Project group plus the phases done in that
-- slice, ordered within a lane). create_portfolio_plan writes a version whole; portfolio_plans_guard and
-- portfolio_slices_guard keep versions frozen. Also three apps rows with no screen yet: homer, guy and handyman.
-- Kind: schema change (four new tables, registered; one RPC, two trigger functions) plus three apps rows
-- Applied: NO — not yet run.
--
-- Spec: docs/technical-spec-overwatch-q4n.md sections 4.16, 7 and 9. Run as one block in the SQL editor, then
-- supabase/tests/overwatch-q4n/26_portfolio_plans_test.sql and 27_verify_portfolio_plans.sql.
-- Safe to re-run: tables, constraints, indexes, functions, triggers, registration and the apps rows are idempotent.
-- supabase/migrations/181_overwatch_portfolio_plans.sql

begin;

-- ============================================================================
-- 1. portfolios
-- ============================================================================
create table if not exists public.portfolios (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null default auth.uid() references auth.users (id),
  name        text        not null,
  context_ids text[]      not null default '{}',
  position    integer     not null default 0,
  archived    boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint portfolios_name_key unique (user_id, name),
  -- Lets plans name their portfolio and owner together, so a plan cannot sit in another user's portfolio.
  constraint portfolios_id_user_key unique (id, user_id),
  constraint portfolios_name_length check (length(btrim(name)) between 1 and 100),
  constraint portfolios_position_nonnegative check (position >= 0)
);

comment on table public.portfolios is
  'OVERWATCH. A body of work planned on its own: the Alfred ecosystem is one, client work (Team IMPACT, ActBlue) '
  'another. Each has its own versioned plans (portfolio_plans). Spec: docs/technical-spec-overwatch-q4n.md 4.16.';
comment on column public.portfolios.id is 'Row id.';
comment on column public.portfolios.user_id is 'Owner. Owner RLS.';
comment on column public.portfolios.name is 'Unique per user, e.g. "Alfred ecosystem", "Client work".';
comment on column public.portfolios.context_ids is
  'The contexts the portfolio covers (contexts.id). Its Project groups in these contexts that no slice names are '
  'listed as "Not in the plan". Not a foreign key: an unknown id simply matches nothing.';
comment on column public.portfolios.position is 'The order of the portfolio switch on the Overwatch tab, lowest first.';
comment on column public.portfolios.archived is 'True hides it from the switch. Its plans are kept.';
comment on column public.portfolios.created_at is 'Row creation.';
comment on column public.portfolios.updated_at is 'Last change. Stamped by the set_updated_at trigger.';

drop trigger if exists set_updated_at on public.portfolios;
create trigger set_updated_at before update on public.portfolios
  for each row execute function public.update_updated_at();

-- ============================================================================
-- 2. portfolio_plans
-- ============================================================================
create table if not exists public.portfolio_plans (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               uuid        not null default auth.uid() references auth.users (id),
  portfolio_id          uuid        not null,
  active                boolean     not null default true,
  theory                text        not null,
  notes_for_next_review text,
  review_by             date,
  reason                text        not null,
  written_by            text        not null default 'alex',
  supersedes_id         uuid        references public.portfolio_plans (id),
  created_at            timestamptz not null default now(),

  constraint portfolio_plans_portfolio_fk foreign key (portfolio_id, user_id)
    references public.portfolios (id, user_id) on delete cascade,
  constraint portfolio_plans_id_user_key unique (id, user_id),
  constraint portfolio_plans_theory_present check (length(btrim(theory)) > 0),
  constraint portfolio_plans_reason_present check (length(btrim(reason)) > 0),
  constraint portfolio_plans_written_by_values check (written_by in ('alex', 'overwatch'))
);

-- One active plan per portfolio.
create unique index if not exists portfolio_plans_one_active on public.portfolio_plans (portfolio_id) where active;

comment on table public.portfolio_plans is
  'OVERWATCH. A version of a portfolio''s plan: the theory that ordered it, its lanes (portfolio_lanes) and their '
  'slices (portfolio_slices). Rows are only inserted, by create_portfolio_plan; one is active per portfolio '
  '(portfolio_plans_one_active). portfolio_plans_guard lets only active go from true to false. Spec: '
  'docs/technical-spec-overwatch-q4n.md 4.16.';
comment on column public.portfolio_plans.id is 'Row id.';
comment on column public.portfolio_plans.user_id is 'Owner. Owner RLS; must own the portfolio (portfolio_plans_portfolio_fk).';
comment on column public.portfolio_plans.portfolio_id is 'The portfolio this version plans.';
comment on column public.portfolio_plans.active is
  'True on the version in force. Goes false only when create_portfolio_plan writes the next; never back to true.';
comment on column public.portfolio_plans.theory is
  'Alex''s ordering principles for this version, e.g. "bugs first, then tools that make the work faster, then X '
  'because it solves Y". The next review reads it.';
comment on column public.portfolio_plans.notes_for_next_review is 'What to reconsider at the next review, and when; or null.';
comment on column public.portfolio_plans.review_by is 'The date to review the plan by, or null. The plan page shows it red once passed.';
comment on column public.portfolio_plans.reason is 'Why this version replaced the last.';
comment on column public.portfolio_plans.written_by is 'alex, or overwatch when the nightly job''s proposal was accepted.';
comment on column public.portfolio_plans.supersedes_id is 'The version this one replaced, or null for the first.';
comment on column public.portfolio_plans.created_at is
  'When this version was written: always the writing transaction''s time (portfolio_plans_guard), which is how the '
  'guard knows lanes and slices are being written with their plan.';

create index if not exists portfolio_plans_portfolio_idx on public.portfolio_plans (portfolio_id, created_at desc);

-- ============================================================================
-- 3. portfolio_lanes
-- ============================================================================
create table if not exists public.portfolio_lanes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id),
  plan_id    uuid        not null,
  name       text        not null,
  position   integer     not null,
  note       text,
  created_at timestamptz not null default now(),

  constraint portfolio_lanes_plan_fk foreign key (plan_id, user_id)
    references public.portfolio_plans (id, user_id) on delete cascade,
  constraint portfolio_lanes_name_key unique (plan_id, name),
  constraint portfolio_lanes_position_key unique (plan_id, position),
  -- Lets a slice name its lane and plan together, so a slice cannot sit in a lane of another version.
  constraint portfolio_lanes_id_plan_user_key unique (id, plan_id, user_id),
  constraint portfolio_lanes_name_length check (length(btrim(name)) between 1 and 60),
  constraint portfolio_lanes_position_positive check (position >= 1)
);

comment on table public.portfolio_lanes is
  'OVERWATCH. The lanes a plan version names, as many as it needs (e.g. "Main", "SAM", "Client work"). A lane belongs '
  'to its version and is frozen once written: renaming, adding or removing one is a new version '
  '(portfolio_slices_guard). Spec: docs/technical-spec-overwatch-q4n.md 4.16.';
comment on column public.portfolio_lanes.id is 'Row id.';
comment on column public.portfolio_lanes.user_id is 'Owner. Owner RLS; must own the plan (portfolio_lanes_plan_fk).';
comment on column public.portfolio_lanes.plan_id is 'The plan version this lane belongs to.';
comment on column public.portfolio_lanes.name is 'Unique within the version.';
comment on column public.portfolio_lanes.position is 'The order lanes show in, from 1; unique within the version.';
comment on column public.portfolio_lanes.note is
  'What the lane is for, or null, e.g. "the heavy work, one slice at a time". Shown on the plan page.';
comment on column public.portfolio_lanes.created_at is 'Row creation.';

-- ============================================================================
-- 4. portfolio_slices
-- ============================================================================
create table if not exists public.portfolio_slices (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null default auth.uid() references auth.users (id),
  plan_id           uuid        not null,
  lane_id           uuid        not null,
  position          integer     not null,
  group_id          text        not null references public.item_groups (id) on delete cascade,
  phases            text,
  why               text,
  status            text        not null default 'planned',
  paused_reason     text,
  status_changed_at timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  constraint portfolio_slices_lane_fk foreign key (lane_id, plan_id, user_id)
    references public.portfolio_lanes (id, plan_id, user_id) on delete cascade,
  constraint portfolio_slices_position_key unique (lane_id, position),
  constraint portfolio_slices_position_positive check (position >= 1),
  constraint portfolio_slices_status_values check (status in ('planned', 'in_progress', 'done', 'paused')),
  constraint portfolio_slices_paused_reason
    check ((status = 'paused') = (paused_reason is not null and length(btrim(paused_reason)) > 0)),
  constraint portfolio_slices_phases_present check (phases is null or length(btrim(phases)) > 0)
);

-- At most one slice in progress per lane.
create unique index if not exists portfolio_slices_one_in_progress
  on public.portfolio_slices (lane_id) where status = 'in_progress';
create index if not exists portfolio_slices_plan_idx on public.portfolio_slices (plan_id);
create index if not exists portfolio_slices_group_idx on public.portfolio_slices (group_id);

comment on table public.portfolio_slices is
  'OVERWATCH. The ordered work of a plan version, within its lanes: a Project group plus the phases done in that '
  'slice, so a project can be partly done, paused, and resumed in a later slice (A phases 2-3, B phase 1, A phase 4). '
  'Written with its plan by create_portfolio_plan; on the active plan only the status may change '
  '(portfolio_slices_guard). Spec: docs/technical-spec-overwatch-q4n.md 4.16.';
comment on column public.portfolio_slices.id is 'Row id.';
comment on column public.portfolio_slices.user_id is 'Owner. Owner RLS; must own the lane (portfolio_slices_lane_fk).';
comment on column public.portfolio_slices.plan_id is
  'The plan version, kept for the guard and for reads; must be the lane''s plan (portfolio_slices_lane_fk).';
comment on column public.portfolio_slices.lane_id is 'The lane it sits in.';
comment on column public.portfolio_slices.position is 'The order within the lane, from 1; unique within the lane.';
comment on column public.portfolio_slices.group_id is
  'The Project group (group_types.kind = project) of the same user; checked by portfolio_slices_guard. Deleting the '
  'group deletes its slices.';
comment on column public.portfolio_slices.phases is 'The phases this slice covers, e.g. "Phases 2 and 3"; null means the whole project.';
comment on column public.portfolio_slices.why is 'Its place in terms of the plan''s theory.';
comment on column public.portfolio_slices.status is
  'planned, in_progress, done or paused. At most one in_progress per lane (portfolio_slices_one_in_progress).';
comment on column public.portfolio_slices.paused_reason is 'Why it is paused: required when paused, null otherwise.';
comment on column public.portfolio_slices.status_changed_at is 'When status last changed. Stamped by portfolio_slices_guard.';
comment on column public.portfolio_slices.created_at is 'Row creation.';

-- ============================================================================
-- 5. The guards
-- ============================================================================
create or replace function public.portfolio_plans_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not new.active then
      raise exception 'portfolio_plans: a plan is written active; use create_portfolio_plan.' using errcode = '23514';
    end if;
    new.created_at := now();
    return new;
  end if;

  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.portfolio_id is distinct from old.portfolio_id or new.theory is distinct from old.theory
     or new.notes_for_next_review is distinct from old.notes_for_next_review
     or new.review_by is distinct from old.review_by or new.reason is distinct from old.reason
     or new.written_by is distinct from old.written_by or new.supersedes_id is distinct from old.supersedes_id
     or new.created_at is distinct from old.created_at then
    raise exception 'portfolio_plans rows are not edited: write a new version with create_portfolio_plan.'
      using errcode = '23514';
  end if;
  if new.active and not old.active then
    raise exception 'portfolio_plans: a superseded plan cannot become active again; write a new version instead.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.portfolio_plans_guard() is
  'Overwatch: a portfolio plan is inserted active, stamped with the transaction time; after that only active may '
  'change, true to false.';
revoke all on function public.portfolio_plans_guard() from public, anon;

drop trigger if exists portfolio_plans_guard on public.portfolio_plans;
create trigger portfolio_plans_guard
  before insert or update on public.portfolio_plans
  for each row execute function public.portfolio_plans_guard();

-- One function for lanes and slices: both are written only with their plan, and frozen after.
create or replace function public.portfolio_slices_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_plan  public.portfolio_plans%rowtype;
  v_kind  text;
  v_owner uuid;
begin
  select * into v_plan from public.portfolio_plans where id = new.plan_id;

  if tg_op = 'INSERT' then
    -- The plan's created_at is its writing transaction's now(), so this allows only create_portfolio_plan's inserts.
    if v_plan.id is null or not v_plan.active or v_plan.created_at <> now() then
      raise exception '%: lanes and slices are written with their plan, in one create_portfolio_plan call.',
        tg_table_name using errcode = '23514';
    end if;
    if tg_table_name = 'portfolio_slices' then
      select t.kind, g.user_id into v_kind, v_owner
        from public.item_groups g join public.group_types t on t.id = g.group_type_id
       where g.id = new.group_id;
      if v_owner is null or v_owner <> new.user_id then
        raise exception 'portfolio_slices: group % is not one of your groups.', new.group_id using errcode = '23514';
      end if;
      if v_kind is distinct from 'project' then
        raise exception 'portfolio_slices: group % is not a Project group.', new.group_id using errcode = '23514';
      end if;
      new.status_changed_at := now();
    end if;
    return new;
  end if;

  if tg_table_name = 'portfolio_lanes' then
    raise exception 'portfolio_lanes are not edited: renaming, adding or removing a lane is a new version.'
      using errcode = '23514';
  end if;
  if not v_plan.active then
    raise exception 'portfolio_slices: this plan version has been superseded and is frozen.' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.plan_id is distinct from old.plan_id or new.lane_id is distinct from old.lane_id
     or new.position is distinct from old.position or new.group_id is distinct from old.group_id
     or new.phases is distinct from old.phases or new.why is distinct from old.why
     or new.created_at is distinct from old.created_at then
    raise exception 'portfolio_slices: only status and paused_reason change in place; moving or editing a slice is '
      'a new version.' using errcode = '23514';
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

comment on function public.portfolio_slices_guard() is
  'Overwatch: lanes and slices are inserted only with their plan (same transaction, plan active); a slice must name '
  'a Project group of the same user. After that lanes never change, a superseded version''s slices never change, and '
  'the active version''s slices change only status and paused_reason (status_changed_at stamped).';
revoke all on function public.portfolio_slices_guard() from public, anon;

drop trigger if exists portfolio_slices_guard on public.portfolio_lanes;
create trigger portfolio_slices_guard
  before insert or update on public.portfolio_lanes
  for each row execute function public.portfolio_slices_guard();
drop trigger if exists portfolio_slices_guard on public.portfolio_slices;
create trigger portfolio_slices_guard
  before insert or update on public.portfolio_slices
  for each row execute function public.portfolio_slices_guard();

-- ============================================================================
-- 6. create_portfolio_plan: a whole new version (plan, lanes, slices) in one transaction, caller's rows under RLS
-- ============================================================================
create or replace function public.create_portfolio_plan(
  p_portfolio_id          uuid,
  p_theory                text,
  p_notes_for_next_review text,
  p_review_by             date,
  p_reason                text,
  p_written_by            text,
  p_lanes                 jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_portfolio public.portfolios%rowtype;
  v_old       uuid;
  v_new       public.portfolio_plans%rowtype;
  v_lane      jsonb;
  v_slice     jsonb;
  v_lane_id   uuid;
  v_bad       text;
  v_slices    int := 0;
begin
  if coalesce(btrim(p_theory), '') = '' then
    raise exception 'create_portfolio_plan: a theory is required.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'create_portfolio_plan: a reason is required.' using errcode = '22023';
  end if;
  if p_lanes is null or jsonb_typeof(p_lanes) <> 'array' or jsonb_array_length(p_lanes) = 0 then
    raise exception 'create_portfolio_plan: lanes must be a non-empty JSON array.' using errcode = '22023';
  end if;

  -- Shape: each lane an object with a name, a whole-number position and (optionally) a slices array; each slice an
  -- object with a whole-number position and a group_id.
  select coalesce(l->>'name', '(number ' || ord || ')') into v_bad
    from jsonb_array_elements(p_lanes) with ordinality as x(l, ord)
   where jsonb_typeof(l) <> 'object' or coalesce(btrim(l->>'name'), '') = ''
      or coalesce(l->>'position', '') !~ '^[0-9]{1,6}$'
      or (l ? 'slices' and jsonb_typeof(l->'slices') <> 'array')
   limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: lane % needs a name, a whole-number position and a slices array.', v_bad
      using errcode = '22023';
  end if;
  select l->>'name' into v_bad
    from jsonb_array_elements(p_lanes) l, jsonb_array_elements(coalesce(l->'slices', '[]'::jsonb)) s
   where jsonb_typeof(s) <> 'object' or coalesce(s->>'position', '') !~ '^[0-9]{1,6}$'
      or coalesce(s->>'group_id', '') = ''
   limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: every slice in lane "%" needs a whole-number position and a group_id.',
      v_bad using errcode = '22023';
  end if;

  -- Duplicates, named before the constraints would catch them.
  select n into v_bad from (select btrim(l->>'name') n from jsonb_array_elements(p_lanes) l) x
   group by n having count(*) > 1 limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: lane name "%" appears twice.', v_bad using errcode = '23505';
  end if;
  select p into v_bad from (select l->>'position' p from jsonb_array_elements(p_lanes) l) x
   group by p having count(*) > 1 limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: two lanes have position %.', v_bad using errcode = '23505';
  end if;
  select format('"%s" has two slices at position %s', l->>'name', s->>'position') into v_bad
    from jsonb_array_elements(p_lanes) l, jsonb_array_elements(coalesce(l->'slices', '[]'::jsonb)) s
   group by l->>'name', s->>'position' having count(*) > 1 limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: lane %.', v_bad using errcode = '23505';
  end if;
  select l->>'name' into v_bad
    from jsonb_array_elements(p_lanes) l, jsonb_array_elements(coalesce(l->'slices', '[]'::jsonb)) s
   where s->>'status' = 'in_progress'
   group by l->>'name' having count(*) > 1 limit 1;
  if v_bad is not null then
    raise exception 'create_portfolio_plan: lane "%" has more than one slice in progress.', v_bad
      using errcode = '23505';
  end if;

  -- Lock the portfolio so two writers cannot both supersede its active plan.
  select * into v_portfolio from public.portfolios where id = p_portfolio_id and user_id = auth.uid() for update;
  if v_portfolio.id is null then
    raise exception 'create_portfolio_plan: portfolio % was not found.', p_portfolio_id using errcode = 'P0002';
  end if;
  if v_portfolio.archived then
    raise exception 'create_portfolio_plan: portfolio "%" is archived.', v_portfolio.name using errcode = '22023';
  end if;

  update public.portfolio_plans set active = false
   where portfolio_id = p_portfolio_id and active
  returning id into v_old;

  insert into public.portfolio_plans
    (portfolio_id, active, theory, notes_for_next_review, review_by, reason, written_by, supersedes_id)
  values (p_portfolio_id, true, p_theory, nullif(btrim(p_notes_for_next_review), ''), p_review_by, p_reason,
          coalesce(p_written_by, 'alex'), v_old)
  returning * into v_new;

  for v_lane in select l from jsonb_array_elements(p_lanes) l order by (l->>'position')::int loop
    insert into public.portfolio_lanes (plan_id, name, position, note)
    values (v_new.id, btrim(v_lane->>'name'), (v_lane->>'position')::int, nullif(btrim(v_lane->>'note'), ''))
    returning id into v_lane_id;

    for v_slice in select s from jsonb_array_elements(coalesce(v_lane->'slices', '[]'::jsonb)) s
                    order by (s->>'position')::int loop
      insert into public.portfolio_slices (plan_id, lane_id, position, group_id, phases, why, status, paused_reason)
      values (v_new.id, v_lane_id, (v_slice->>'position')::int, v_slice->>'group_id',
              nullif(btrim(v_slice->>'phases'), ''), nullif(btrim(v_slice->>'why'), ''),
              coalesce(v_slice->>'status', 'planned'), nullif(btrim(v_slice->>'paused_reason'), ''));
      v_slices := v_slices + 1;
    end loop;
  end loop;

  return to_jsonb(v_new) || jsonb_build_object('lanes', jsonb_array_length(p_lanes), 'slices', v_slices);
end;
$$;

comment on function public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb) is
  'Overwatch: write a new version of the caller''s portfolio plan in one transaction: the active version goes '
  'inactive, the new one is inserted with supersedes_id, then its lanes and their slices with their given statuses. '
  'p_lanes is [{ name, position, note, slices: [{ position, group_id, phases, why, status, paused_reason }] }]. Any '
  'bad input (a group that is not the caller''s Project, duplicate positions or names, two slices in progress in a '
  'lane) refuses the whole call. Returns the new plan with lane and slice counts. Called by the tier-3 '
  'create_portfolio_plan tool.';
revoke all on function public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb) from public, anon;
grant execute on function public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb)
  to authenticated, service_role;

-- ============================================================================
-- 7. Register all four: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table('public.portfolios', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. A body of work planned on its own (Alfred ecosystem, client work), with its contexts.');
select platform.register_table('public.portfolio_plans', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. Versions of a portfolio''s plan, one active; written whole by create_portfolio_plan (tier 3).');
select platform.register_table('public.portfolio_lanes', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. The lanes a plan version names; frozen once written.');
select platform.register_table('public.portfolio_slices', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. A Project group and its phases, ordered within a lane; only status changes in place.');

-- ============================================================================
-- 8. Three apps with no screen yet
-- ============================================================================
insert into public.apps (id, name, description, icon, path, button_name) values
  ('homer', 'Homer',
   'Reading and watching: books, series, films and shows finished or wanted, ratings, the release watchlist, streaming alerts and a daily news summary.',
   'BookOpen', null, null),
  ('guy', 'Guy',
   'Vegas concierge: concerts, sporting events, movies in theaters, restaurants and venues coming to Las Vegas, with preferences and ticket prices.',
   'Ticket', null, null),
  -- Working name; it will be renamed later.
  ('handyman', 'Handyman',
   'The house: layout and floor plan, contents, repairs, paint colours and decor, and routine maintenance.',
   'Hammer', null, null)
on conflict (id) do nothing;

commit;

-- ============================================================================
-- 9. Result: the tables, registration and grants, the function's grants, the new apps, conformance (CONFORMANT)
-- ============================================================================
select json_build_object(
  'tables', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attrelid::regclass::text as table_name, count(*) as columns,
             count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a
       where a.attrelid in ('public.portfolios'::regclass, 'public.portfolio_plans'::regclass,
                            'public.portfolio_lanes'::regclass, 'public.portfolio_slices'::regclass)
         and a.attnum > 0 and not a.attisdropped
       group by 1 order by 1
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read from platform.registry
       where table_name in ('public.portfolios', 'public.portfolio_plans', 'public.portfolio_lanes',
                            'public.portfolio_slices') order by 1
    ) t),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name in ('portfolios', 'portfolio_plans', 'portfolio_lanes', 'portfolio_slices')
       group by table_name, grantee order by table_name, grantee
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role,
             has_function_privilege(r, 'public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb)',
                                    'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'new_apps', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, icon, path, button_name from public.apps where id in ('homer', 'guy', 'handyman') order by id
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
