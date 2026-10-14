-- Purpose: Warren Buffet Phase 3, Step 2 (Migration C). Tables wb_projects, wb_planned_items, wb_planned_matches and wb_settings; wb_splits.project_id; wb_replace_splits rebuilt so a re-split keeps project links and planned matches (rows are reused by position; matches on a dropped split move to position 0).
-- Kind: schema change (four tables, one column, three trigger functions, one replaced function)
-- Applied: YES — 2026-10-14 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 67 tables; 134 all 41 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md sections 3.1-3.6 and A14.
-- No real financial data in this file. No wb_settings row is seeded: the safety floor is set at seeding.
-- Run as one block, then 134_wb_phase3_step2_tests.sql; the conformance result at the end must be conformant true.
-- supabase/migrations/133_wb_phase3_step2_tables.sql

begin;

-- ============================================================================
-- 1. wb_projects
-- ============================================================================
create table if not exists public.wb_projects (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id text not null references public.contexts(id),
  name       text not null,
  status     text not null default 'active',
  budget     numeric(14,2),
  starts_on  date,
  ends_on    date,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint wb_projects_name_check check (btrim(name) <> ''),
  constraint wb_projects_status_check check (status in ('active', 'on_hold', 'done', 'cancelled')),
  constraint wb_projects_budget_check check (budget is null or budget >= 0),
  constraint wb_projects_dates_check check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

create unique index if not exists wb_projects_name_key on public.wb_projects (context_id, lower(name));

comment on table public.wb_projects is
  'App: Warren Buffet. A group of payments, such as a remodel or a trip. Splits join a project through wb_splits.project_id; planned items through wb_planned_items.project_id. Optional: a one-off planned item needs no project.';
comment on column public.wb_projects.status is 'active, on_hold, done or cancelled.';
comment on column public.wb_projects.budget is 'Optional total budget, positive.';

drop trigger if exists wb_projects_touch_updated_at on public.wb_projects;
create trigger wb_projects_touch_updated_at before update on public.wb_projects
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 2. wb_planned_items
-- ============================================================================
create table if not exists public.wb_planned_items (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id        text not null references public.contexts(id),
  project_id        uuid references public.wb_projects(id) on delete set null,
  name              text not null,
  counterparty      text,
  merchant_id       uuid references public.wb_merchants(id) on delete set null,
  amount            numeric(14,2) not null,
  due_on            date not null,
  interval_count    int,
  interval_unit     text,
  ends_on           date,
  stage             text,
  is_draft          boolean not null default false,
  tax_year          int,
  amount_tolerance  numeric(14,2) not null default 0,
  match_window_days int not null default 10,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint wb_planned_items_name_check check (btrim(name) <> ''),
  constraint wb_planned_items_amount_check check (amount <> 0),
  constraint wb_planned_items_interval_check check (
    (interval_count is null and interval_unit is null)
    or (interval_count between 1 and 120 and interval_unit is not null and interval_unit in ('week', 'month'))),
  -- Stage applies to one-off items only (spec A5). "is not null" keeps a null stage from passing as unknown.
  constraint wb_planned_items_stage_check check (
    (interval_count is null and stage is not null
     and stage in ('draft', 'estimate', 'quoted', 'invoiced', 'paid', 'cancelled'))
    or (interval_count is not null and stage is null)),
  -- A one-off draft is stage draft; is_draft is for recurring items only (spec A14).
  constraint wb_planned_items_is_draft_check check (not is_draft or interval_count is not null),
  constraint wb_planned_items_ends_check check (
    ends_on is null or (interval_count is not null and ends_on >= due_on)),
  constraint wb_planned_items_tax_year_check check (tax_year is null or tax_year between 2000 and 2100),
  constraint wb_planned_items_tolerance_check check (amount_tolerance >= 0),
  constraint wb_planned_items_window_check check (match_window_days between 0 and 90)
);

create index if not exists wb_planned_items_project_idx on public.wb_planned_items (project_id) where project_id is not null;
create index if not exists wb_planned_items_due_idx on public.wb_planned_items (due_on);

comment on table public.wb_planned_items is
  'App: Warren Buffet. Future money in or out. Signed amount: in positive, out negative. A one-off has a stage; a recurring item (interval_count + interval_unit) has none and repeats from due_on until ends_on. Drafts (stage draft, or is_draft on a recurring item) stay out of free cash unless a scenario includes them. Premiums and expected income are recurring items. Subscriptions are never stored here: they are computed from wb_subscriptions.';
comment on column public.wb_planned_items.amount is 'Signed: money in positive, money out negative. For a recurring item, the amount of each occurrence.';
comment on column public.wb_planned_items.due_on is 'A one-off''s date; a recurring item''s first (or next) occurrence.';
comment on column public.wb_planned_items.stage is 'One-off only: draft (what if; kept out of free cash unless a scenario includes drafts), estimate, quoted, invoiced, paid, cancelled. Null for a recurring item.';
comment on column public.wb_planned_items.is_draft is 'Recurring items only: a what-if, kept out of free cash unless a scenario includes drafts. A one-off draft uses stage draft instead.';
comment on column public.wb_planned_items.tax_year is 'Optional tax year this money belongs to.';
comment on column public.wb_planned_items.merchant_id is 'Optional merchant, used by match suggestions.';
comment on column public.wb_planned_items.amount_tolerance is 'Dollars either side of the amount that a payment may differ by and still be suggested as a match.';
comment on column public.wb_planned_items.match_window_days is 'Days either side of the due date in which a payment may be suggested as a match.';

drop trigger if exists wb_planned_items_touch_updated_at on public.wb_planned_items;
create trigger wb_planned_items_touch_updated_at before update on public.wb_planned_items
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 3. wb_planned_matches
-- ============================================================================
create table if not exists public.wb_planned_matches (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  planned_item_id uuid not null references public.wb_planned_items(id) on delete restrict,
  split_id        uuid not null references public.wb_splits(id) on delete restrict,
  transaction_id  uuid not null references public.wb_transactions(id),
  occurrence_on   date,
  amount_applied  numeric(14,2) not null,
  status          text not null default 'suggested',
  source          text not null default 'default',
  decided_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint wb_planned_matches_key unique nulls not distinct (planned_item_id, split_id, occurrence_on),
  constraint wb_planned_matches_amount_check check (amount_applied <> 0),
  constraint wb_planned_matches_status_check check (status in ('suggested', 'confirmed', 'rejected')),
  constraint wb_planned_matches_source_check check (source in ('default', 'claude', 'manual'))
);

create index if not exists wb_planned_matches_split_idx on public.wb_planned_matches (split_id);
create index if not exists wb_planned_matches_transaction_idx on public.wb_planned_matches (transaction_id);

comment on table public.wb_planned_matches is
  'App: Warren Buffet. Links a planned item (and, for a recurring item, one occurrence) to a split that paid it, with the amount applied (partial payments allowed). suggested rows come from the suggestion function and wait in the review queue; confirmed and rejected are decisions, and a rejected row stops the same suggestion coming back. user_id, context_id and transaction_id are filled by trigger.';
comment on column public.wb_planned_matches.occurrence_on is 'The occurrence date a payment settles. Required for a recurring planned item; null for a one-off.';
comment on column public.wb_planned_matches.amount_applied is 'Same sign as the planned item. Confirmed amounts on one split never exceed that split''s amount.';
comment on column public.wb_planned_matches.status is 'suggested, confirmed or rejected.';
comment on column public.wb_planned_matches.source is 'default = the suggestion function; claude or manual = made by hand.';

-- Owner and context from the planned item, transaction from the split, then the checks
-- that need the parents.
create or replace function public.wb_planned_matches_fill()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  p         record;
  v_tid     uuid;
  v_split   numeric;
  v_pending boolean;
  v_used    numeric;
begin
  select pi.user_id, pi.context_id, pi.amount, pi.interval_count into p
  from public.wb_planned_items pi where pi.id = new.planned_item_id;
  if not found then
    raise exception 'wb_planned_matches: planned item % not found', new.planned_item_id using errcode = '23503';
  end if;
  select s.transaction_id, s.amount, x.pending into v_tid, v_split, v_pending
  from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where s.id = new.split_id;
  if not found then
    raise exception 'wb_planned_matches: split % not found', new.split_id using errcode = '23503';
  end if;

  new.user_id := p.user_id;
  new.context_id := p.context_id;
  new.transaction_id := v_tid;

  if v_pending then
    raise exception 'wb_planned_matches: a pending transaction cannot be matched' using errcode = '23514';
  end if;
  if p.interval_count is not null and new.occurrence_on is null then
    raise exception 'wb_planned_matches: a recurring planned item needs occurrence_on' using errcode = '23514';
  end if;
  if p.interval_count is null and new.occurrence_on is not null then
    raise exception 'wb_planned_matches: a one-off planned item has no occurrence_on' using errcode = '23514';
  end if;
  if sign(new.amount_applied) <> sign(p.amount) then
    raise exception 'wb_planned_matches: amount_applied must have the planned item''s sign' using errcode = '23514';
  end if;
  if new.status = 'confirmed' then
    select coalesce(sum(abs(m.amount_applied)), 0) into v_used
    from public.wb_planned_matches m
    where m.split_id = new.split_id and m.status = 'confirmed' and m.id <> new.id;
    if v_used + abs(new.amount_applied) > abs(v_split) then
      raise exception 'wb_planned_matches: confirmed matches on this split would exceed its amount' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists wb_planned_matches_fill on public.wb_planned_matches;
create trigger wb_planned_matches_fill before insert or update on public.wb_planned_matches
  for each row execute function public.wb_planned_matches_fill();

drop trigger if exists wb_planned_matches_touch_updated_at on public.wb_planned_matches;
create trigger wb_planned_matches_touch_updated_at before update on public.wb_planned_matches
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 4. wb_settings
-- ============================================================================
create table if not exists public.wb_settings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id     text not null references public.contexts(id),
  safety_floor   numeric(14,2),
  horizon_months int not null default 12,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint wb_settings_context_key unique (context_id),
  constraint wb_settings_floor_check check (safety_floor is null or safety_floor >= 0),
  constraint wb_settings_horizon_check check (horizon_months between 1 and 24)
);

comment on table public.wb_settings is
  'App: Warren Buffet. One row per context of money settings. The floor value is entered by Alex at seeding and never written into a committed file.';
comment on column public.wb_settings.safety_floor is 'Cash kept back: free cash = the lowest projected spending-cash balance over the horizon minus this. Positive.';
comment on column public.wb_settings.horizon_months is 'Months the cash projection looks ahead. Default 12.';

drop trigger if exists wb_settings_touch_updated_at on public.wb_settings;
create trigger wb_settings_touch_updated_at before update on public.wb_settings
  for each row execute function public.wb_touch_updated_at();

-- ============================================================================
-- 5. wb_splits.project_id
-- ============================================================================
alter table public.wb_splits
  add column if not exists project_id uuid references public.wb_projects(id) on delete set null;
create index if not exists wb_splits_project_idx on public.wb_splits (project_id) where project_id is not null;
comment on column public.wb_splits.project_id is 'Optional project this part of a transaction belongs to; set by hand or (Phase 3 Step 4) by a rule. Project-linked splits leave the burn rate.';

-- ============================================================================
-- 6. wb_replace_splits: as in 114, but split rows are reused by position, so
--    their ids, project links and planned matches survive a re-split.
-- ============================================================================
create or replace function public.wb_replace_splits(p_transaction_id uuid, p_splits jsonb, p_source text default 'claude')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_amount numeric;
  v_sum    numeric;
  v_split  uuid;
  v_first  uuid;
  v_old    uuid[];
  v_n      int;
  e        record;
begin
  if p_source not in ('claude', 'manual') then
    raise exception 'wb_replace_splits: source must be claude or manual' using errcode = '22023';
  end if;
  if jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 then
    raise exception 'wb_replace_splits: splits must be a non-empty array' using errcode = '22023';
  end if;
  select amount into v_amount from public.wb_transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'wb_replace_splits: no transaction % that you can see', p_transaction_id using errcode = '23503';
  end if;
  select sum((s ->> 'amount')::numeric) into v_sum from jsonb_array_elements(p_splits) s;
  if v_sum is distinct from v_amount then
    raise exception 'wb_replace_splits: splits sum to %, but the transaction is %', v_sum, v_amount using errcode = '23514';
  end if;
  -- Two tags from one exclusive group on one split.
  if exists (
    select 1
    from jsonb_array_elements(p_splits) with ordinality as sp(s, pos)
    cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    join public.wb_tags tg on tg.id = t.tag_id::uuid
    join public.wb_tag_groups g on g.id = tg.group_id and g.exclusive
    group by sp.pos, g.id
    having count(*) > 1
  ) then
    raise exception 'wb_replace_splits: a split has two tags from one exclusive group' using errcode = '23505';
  end if;

  select array_agg(s.id order by s.position, s.created_at, s.id) into v_old
  from public.wb_splits s where s.transaction_id = p_transaction_id;
  v_old := coalesce(v_old, '{}');
  v_n := jsonb_array_length(p_splits);

  for e in select s, pos from jsonb_array_elements(p_splits) with ordinality as sp(s, pos) order by pos
  loop
    if e.pos <= cardinality(v_old) then
      v_split := v_old[e.pos];
      update public.wb_splits
      set amount      = (e.s ->> 'amount')::numeric,
          description = nullif(btrim(e.s ->> 'description'), ''),
          tax_year    = (e.s ->> 'tax_year')::int,
          notes       = nullif(btrim(e.s ->> 'notes'), ''),
          position    = e.pos::int - 1,
          project_id  = case when e.s ? 'project_id' then (e.s ->> 'project_id')::uuid else project_id end
      where id = v_split;
      delete from public.wb_split_tags where split_id = v_split;
    else
      insert into public.wb_splits (transaction_id, amount, description, tax_year, notes, position, project_id)
      values (p_transaction_id, (e.s ->> 'amount')::numeric, nullif(btrim(e.s ->> 'description'), ''),
              (e.s ->> 'tax_year')::int, nullif(btrim(e.s ->> 'notes'), ''), e.pos::int - 1,
              (e.s ->> 'project_id')::uuid)
      returning id into v_split;
    end if;
    if e.pos = 1 then
      v_first := v_split;
    end if;
    insert into public.wb_split_tags (split_id, tag_id, source)
    select v_split, t.tag_id::uuid, p_source
    from jsonb_array_elements_text(coalesce(e.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id)
    on conflict (split_id, tag_id) do nothing;
  end loop;

  -- Splits past the new count go; their planned matches move to the first split.
  if cardinality(v_old) > v_n then
    update public.wb_planned_matches
    set split_id = v_first
    where split_id = any (v_old[v_n + 1:]);
    delete from public.wb_splits where id = any (v_old[v_n + 1:]);
  end if;
  -- A split made smaller than what is already confirmed against it.
  if exists (
    select 1 from public.wb_splits s
    join public.wb_planned_matches m on m.split_id = s.id and m.status = 'confirmed'
    where s.transaction_id = p_transaction_id
    group by s.id, s.amount
    having sum(abs(m.amount_applied)) > abs(s.amount)
  ) then
    raise exception 'wb_replace_splits: a split would be smaller than the planned matches confirmed against it' using errcode = '23514';
  end if;

  -- Tags put on by hand here are wanted again: their removals no longer apply.
  delete from public.wb_tag_exclusions x
  where x.transaction_id = p_transaction_id
    and x.tag_id in (
      select t.tag_id::uuid
      from jsonb_array_elements(p_splits) sp(s)
      cross join lateral jsonb_array_elements_text(coalesce(sp.s -> 'tag_ids', '[]'::jsonb)) as t(tag_id));

  return jsonb_build_object('transaction_id', p_transaction_id, 'splits', (
    select jsonb_agg(jsonb_build_object('id', s.id, 'position', s.position, 'amount', s.amount,
             'description', s.description, 'tax_year', s.tax_year, 'project_id', s.project_id,
             'tag_ids', coalesce((select jsonb_agg(st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb))
           order by s.position)
    from public.wb_splits s where s.transaction_id = p_transaction_id));
end;
$$;

comment on function public.wb_replace_splits(uuid, jsonb, text) is
  'Warren Buffet: replace all splits of one transaction, with their tags (source claude or manual), in one transaction. Amounts must sum to the transaction amount. Existing split rows are reused by position, so their ids, project links and planned matches survive; project_id changes only where the input gives the key (null clears it); splits beyond the new count are deleted after their planned matches move to the first split. A tag added here by hand clears its wb_tag_exclusions row.';

grant execute on function public.wb_replace_splits(uuid, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 7. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
select platform.register_table(
  'public.wb_projects',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Projects that group payments. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_planned_items',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Planned future money in or out, one-off or recurring. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_planned_matches',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Planned items linked to the splits that paid them. Owner OR shared-context RLS (mirrors intents).'
);
select platform.register_table(
  'public.wb_settings',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. Money settings, one row per context: safety floor and horizon. Owner OR shared-context RLS (mirrors intents).'
);

drop policy if exists wb_projects_access on public.wb_projects;
create policy wb_projects_access on public.wb_projects
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_planned_items_access on public.wb_planned_items;
create policy wb_planned_items_access on public.wb_planned_items
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_planned_matches_access on public.wb_planned_matches;
create policy wb_planned_matches_access on public.wb_planned_matches
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

drop policy if exists wb_settings_access on public.wb_settings;
create policy wb_settings_access on public.wb_settings
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;

-- ============================================================================
-- 8. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 134_wb_phase3_step2_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
