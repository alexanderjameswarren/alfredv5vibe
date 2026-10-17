-- Purpose: Warren Buffet Phase 3, Step 4a. Rules can set a project (wb_rules.set_project_id; wb_splits.project_source keeps hand values and hand removals). wb_planned_occurrences lists planned items' due dates in a range. wb_suggest_planned_matches suggests planned matches (merchant + amount within tolerance + date within window); wb_process_transactions sets rule projects and calls it at the end. wb_confirm_planned_match confirms or rejects a suggestion and marks a fully paid one-off paid. wb_review_queue gains planned_match; wb_transaction_list.needs_review follows.
-- Kind: schema change (two columns, one trigger, three new functions, two replaced functions, two replaced views)
-- Applied: YES — 2026-10-17 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 67 tables; 136 all 35 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md sections 3.5-3.7 and A17-A21.
-- A15: none of the objects redefined here holds a number that the help states; no help comments are due.
-- No real financial data in this file. Run as one block, then 136_wb_phase3_step4_tests.sql; the
-- conformance result at the end must be conformant true.
-- supabase/migrations/135_wb_phase3_step4_match_suggestions.sql

begin;

-- ============================================================================
-- 1. Columns
-- ============================================================================
alter table public.wb_rules
  add column if not exists set_project_id uuid references public.wb_projects(id) on delete set null;
comment on column public.wb_rules.set_project_id is 'Optional project the rule puts on a single-split transaction. The first matching rule wins; a project set or removed by hand or by Claude is never changed.';

alter table public.wb_splits add column if not exists project_source text;
alter table public.wb_splits drop constraint if exists wb_splits_project_source_check;
alter table public.wb_splits add constraint wb_splits_project_source_check check (
  (project_source is null or project_source in ('rule', 'claude', 'manual'))
  and (project_id is null or project_source is not null));
comment on column public.wb_splits.project_source is 'Who set project_id: rule, claude or manual. claude and manual are never changed by processing; a null project_id with source claude or manual is a project removed by hand, which no rule puts back. A project written with no source counts as manual (trigger).';

-- A project written with no source (the app, the SQL editor) is a hand value.
create or replace function public.wb_splits_fill_project_source()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.project_id is not null and new.project_source is null then
    new.project_source := 'manual';
  end if;
  return new;
end;
$$;

drop trigger if exists wb_splits_fill_project_source on public.wb_splits;
create trigger wb_splits_fill_project_source before insert or update of project_id, project_source on public.wb_splits
  for each row execute function public.wb_splits_fill_project_source();

-- ============================================================================
-- 2. wb_planned_occurrences: due dates of planned items in a date range
-- ============================================================================
create or replace function public.wb_planned_occurrences(p_from date, p_to date, p_include_drafts boolean default false)
returns table (planned_item_id uuid, occurrence_on date, amount numeric, recurring boolean, stage text, is_draft boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select pi.id, pi.due_on, pi.amount, false, pi.stage, pi.stage = 'draft'
  from public.wb_planned_items pi
  where pi.interval_count is null
    and pi.stage <> 'cancelled'
    and (p_include_drafts or pi.stage <> 'draft')
    and pi.due_on between p_from and p_to
  union all
  select pi.id, o.d, pi.amount, true, null, pi.is_draft
  from public.wb_planned_items pi
  cross join lateral (
    select (case when pi.interval_unit = 'month'
                 then pi.due_on + make_interval(months => k * pi.interval_count)
                 else pi.due_on + make_interval(days => 7 * k * pi.interval_count) end)::date as d
    from generate_series(0, greatest(0, ceil((p_to - pi.due_on)::numeric
           / (case when pi.interval_unit = 'month' then 28 else 7 end * pi.interval_count))::int)) k
  ) o
  where pi.interval_count is not null
    and (p_include_drafts or not pi.is_draft)
    and o.d between p_from and p_to
    and (pi.ends_on is null or o.d <= pi.ends_on);
$$;

comment on function public.wb_planned_occurrences(date, date, boolean) is
  'Warren Buffet: every due date of the planned items between p_from and p_to. A one-off has one (its due_on); a recurring item repeats from due_on by its interval until ends_on, each date counted from due_on (so a month-end date stays month-end). Cancelled one-offs are left out; drafts (stage draft, or is_draft on a recurring item) only when p_include_drafts. Security invoker.';

-- ============================================================================
-- 3. wb_suggest_planned_matches
-- ============================================================================
create or replace function public.wb_suggest_planned_matches(
  p_transaction_ids  uuid[] default null,
  p_planned_item_ids uuid[] default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n_removed int := 0;
  n_added   int := 0;
  v_from    date;
  v_to      date;
  v_pairs   jsonb;
begin
  -- The date range to look at: around the payments in scope, or wide for a full pass.
  select min(d) - 90, max(d) + 90 into v_from, v_to
  from (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
        from public.wb_transactions x
        where not x.pending and x.merchant_id is not null
          and (p_transaction_ids is null or x.id = any (p_transaction_ids))) t;
  -- Nothing to pair, but suggestions in scope that no longer fit must still go.
  if v_from is null then
    v_from := current_date;
    v_to := current_date;
  end if;

  -- Every pair that qualifies now: a posted split at the item's merchant, same sign,
  -- amount within tolerance, date within the window. Drafts, cancelled and paid
  -- one-offs never qualify. Kept as jsonb so no temp table is needed.
  select coalesce(jsonb_agg(jsonb_build_object(
           'planned_item_id', pi.id,
           'occ', case when o.recurring then o.occurrence_on end,
           'split_id', s.id,
           'transaction_id', x.id,
           'applied', sign(pi.amount) * least(abs(s.amount), abs(pi.amount)),
           'ddiff', abs(c.d - o.occurrence_on),
           'adiff', abs(abs(s.amount) - abs(pi.amount)))), '[]'::jsonb)
  into v_pairs
  from public.wb_planned_occurrences(v_from, v_to, false) o
  join public.wb_planned_items pi on pi.id = o.planned_item_id
  join public.wb_transactions x on x.merchant_id = pi.merchant_id and not x.pending
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where pi.merchant_id is not null
    and coalesce(pi.stage, '') <> 'paid'
    and (p_transaction_ids is null or x.id = any (p_transaction_ids))
    and (p_planned_item_ids is null or pi.id = any (p_planned_item_ids))
    and sign(s.amount) = sign(pi.amount)
    and abs(abs(s.amount) - abs(pi.amount)) <= pi.amount_tolerance
    and abs(c.d - o.occurrence_on) <= pi.match_window_days;

  -- Stale suggestions in scope go.
  delete from public.wb_planned_matches m
  where m.status = 'suggested'
    and (p_transaction_ids is null or m.transaction_id = any (p_transaction_ids))
    and (p_planned_item_ids is null or m.planned_item_id = any (p_planned_item_ids))
    and not exists (
      select 1
      from jsonb_to_recordset(v_pairs) as p(planned_item_id uuid, occ date, split_id uuid)
      where p.planned_item_id = m.planned_item_id and p.split_id = m.split_id
        and p.occ is not distinct from m.occurrence_on);
  get diagnostics n_removed = row_count;

  -- New ones: not already decided or suggested, the occurrence and the split not
  -- already fully confirmed or suggested elsewhere; the closest date wins, one per
  -- occurrence and one per split.
  with cands as (
    select p.*
    from jsonb_to_recordset(v_pairs) as p(planned_item_id uuid, occ date, split_id uuid, transaction_id uuid,
                                          applied numeric, ddiff int, adiff numeric)
    join public.wb_planned_items pi on pi.id = p.planned_item_id
    join public.wb_splits s on s.id = p.split_id
    where not exists (select 1 from public.wb_planned_matches m
                      where m.planned_item_id = p.planned_item_id and m.split_id = p.split_id
                        and m.occurrence_on is not distinct from p.occ)
      and not exists (select 1 from public.wb_planned_matches m
                      where m.status = 'suggested'
                        and (m.split_id = p.split_id
                             or (m.planned_item_id = p.planned_item_id and m.occurrence_on is not distinct from p.occ)))
      and coalesce((select sum(abs(m.amount_applied)) from public.wb_planned_matches m
                    where m.status = 'confirmed' and m.planned_item_id = p.planned_item_id
                      and m.occurrence_on is not distinct from p.occ), 0) < abs(pi.amount)
      and coalesce((select sum(abs(m.amount_applied)) from public.wb_planned_matches m
                    where m.status = 'confirmed' and m.split_id = p.split_id), 0) < abs(s.amount)
  ),
  per_occ as (
    select o.*, row_number() over (partition by o.planned_item_id, o.occ
                                   order by o.ddiff, o.adiff, o.transaction_id, o.split_id) as rn
    from cands o
  ),
  per_split as (
    select q.*, row_number() over (partition by q.split_id
                                   order by q.ddiff, q.adiff, q.planned_item_id, q.occ) as rn2
    from per_occ q
    where q.rn = 1
  )
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  select planned_item_id, split_id, occ, applied, 'suggested', 'default'
  from per_split
  where rn2 = 1;
  get diagnostics n_added = row_count;

  return jsonb_build_object('suggested', n_added, 'removed', n_removed);
end;
$$;

comment on function public.wb_suggest_planned_matches(uuid[], uuid[]) is
  'Warren Buffet: suggests planned matches for the given transactions and/or planned items (null = all). A posted split qualifies for a planned item''s due date when it is at the item''s merchant, has the same sign, its amount is within the item''s amount_tolerance and its date within match_window_days. Drafts, cancelled and paid one-offs, and items with no merchant never qualify. A pair already suggested, confirmed or rejected is not suggested again; an occurrence or split already fully confirmed, or already holding a suggestion, gets none; otherwise the closest date wins, one per occurrence and one per split. amount_applied is the smaller of the two amounts. Suggestions in scope that no longer qualify are deleted. Called by wb_process_transactions and after planned-item writes. Security invoker. Returns suggested and removed counts.';

-- ============================================================================
-- 4. wb_confirm_planned_match
-- ============================================================================
create or replace function public.wb_confirm_planned_match(p_match_id uuid, p_action text, p_amount numeric default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m      record;
  pi     record;
  v_paid boolean := false;
begin
  if p_action not in ('confirm', 'reject') then
    raise exception 'wb_confirm_planned_match: action must be confirm or reject' using errcode = '22023';
  end if;
  select * into m from public.wb_planned_matches where id = p_match_id for update;
  if not found then
    raise exception 'wb_confirm_planned_match: no match % that you can see', p_match_id using errcode = '23503';
  end if;
  if m.status <> 'suggested' then
    raise exception 'wb_confirm_planned_match: this match was already %', m.status using errcode = '22023';
  end if;
  select * into pi from public.wb_planned_items where id = m.planned_item_id;

  if p_action = 'reject' then
    update public.wb_planned_matches set status = 'rejected', decided_at = now() where id = p_match_id;
    return jsonb_build_object('status', 'rejected', 'stage_paid', false);
  end if;

  if p_amount is not null and p_amount = 0 then
    raise exception 'wb_confirm_planned_match: the amount cannot be zero' using errcode = '22023';
  end if;
  update public.wb_planned_matches
  set status = 'confirmed', decided_at = now(),
      amount_applied = case when p_amount is null then amount_applied else sign(pi.amount) * abs(p_amount) end
  where id = p_match_id;

  -- A one-off fully covered by confirmed matches is paid. Never set back automatically.
  if pi.interval_count is null and pi.stage <> 'paid'
     and (select coalesce(sum(abs(x.amount_applied)), 0) from public.wb_planned_matches x
          where x.planned_item_id = pi.id and x.status = 'confirmed') >= abs(pi.amount)
  then
    update public.wb_planned_items set stage = 'paid' where id = pi.id;
    v_paid := true;
  end if;
  return jsonb_build_object('status', 'confirmed', 'stage_paid', v_paid);
end;
$$;

comment on function public.wb_confirm_planned_match(uuid, text, numeric) is
  'Warren Buffet: confirm or reject one suggested planned match. confirm may lower the amount for a part-payment (p_amount, taken with the planned item''s sign); the trigger refuses more than the split. Confirming the last part of a one-off sets its stage to paid; nothing sets it back automatically. A rejected match is never suggested again. Security invoker.';

-- ============================================================================
-- 5. wb_replace_splits: as in 133, plus project_source follows a given project_id
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
      set amount         = (e.s ->> 'amount')::numeric,
          description    = nullif(btrim(e.s ->> 'description'), ''),
          tax_year       = (e.s ->> 'tax_year')::int,
          notes          = nullif(btrim(e.s ->> 'notes'), ''),
          position       = e.pos::int - 1,
          project_id     = case when e.s ? 'project_id' then (e.s ->> 'project_id')::uuid else project_id end,
          project_source = case when e.s ? 'project_id' then p_source else project_source end
      where id = v_split;
      delete from public.wb_split_tags where split_id = v_split;
    else
      insert into public.wb_splits (transaction_id, amount, description, tax_year, notes, position, project_id, project_source)
      values (p_transaction_id, (e.s ->> 'amount')::numeric, nullif(btrim(e.s ->> 'description'), ''),
              (e.s ->> 'tax_year')::int, nullif(btrim(e.s ->> 'notes'), ''), e.pos::int - 1,
              (e.s ->> 'project_id')::uuid, case when e.s ? 'project_id' then p_source end)
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
             'project_source', s.project_source,
             'tag_ids', coalesce((select jsonb_agg(st.tag_id) from public.wb_split_tags st where st.split_id = s.id), '[]'::jsonb))
           order by s.position)
    from public.wb_splits s where s.transaction_id = p_transaction_id));
end;
$$;

comment on function public.wb_replace_splits(uuid, jsonb, text) is
  'Warren Buffet: replace all splits of one transaction, with their tags (source claude or manual), in one transaction. Amounts must sum to the transaction amount. Existing split rows are reused by position, so their ids, project links and planned matches survive; project_id (and project_source, set to the caller''s source) changes only where the input gives the key (null clears it, and the clearing sticks); splits beyond the new count are deleted after their planned matches move to the first split. A tag added here by hand clears its wb_tag_exclusions row.';

-- ============================================================================
-- 6. wb_process_transactions: as in 120, plus rule projects (5c) and planned
--    match suggestions over the processed posted rows (7)
-- ============================================================================
create or replace function public.wb_process_transactions(ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id         uuid;
  t            record;
  cur          record;
  r            record;
  v_tag        record;
  v_merchant   uuid;
  v_msource    text;
  v_mkind      text;
  v_clean      text;
  v_kind       text;
  v_ksource    text;
  v_p2p        boolean;
  v_date       date;
  v_fwd        int;
  v_rev        int;
  v_match      record;
  v_split      uuid;
  v_nsplits    int;
  v_matched    uuid[];
  v_sub        uuid;
  v_nsubs      int;
  v_subs       uuid[] := '{}';
  v_project    uuid;
  v_psource    text;
  v_posted     uuid[] := '{}';
  v_sugg       jsonb;
  n_processed  int := 0;
  n_paired     int := 0;
  n_candidates int := 0;
  n_tags       int := 0;
  n_rules      int := 0;
  n_linked     int := 0;
  n_projects   int := 0;
begin
  if ids is null or cardinality(ids) = 0 then
    return jsonb_build_object('processed', 0, 'paired', 0, 'transfer_candidates', 0, 'rule_tags', 0, 'rules_updated', 0,
                              'subscriptions_linked', 0, 'rule_projects', 0, 'matches_suggested', 0);
  end if;

  for v_id in
    select x.id from public.wb_transactions x
    where x.id = any(ids)
    order by coalesce(x.posted_at, x.transacted_at), x.id
  loop
    -- Read fresh each time: pairing an earlier row may have changed this one.
    select x.*, a.role as account_role, a.source as account_source
    into t
    from public.wb_transactions x
    join public.wb_accounts a on a.id = x.account_id
    where x.id = v_id;
    continue when not found;

    -- 2. Merchant (before cleaning, which strips the city only when one matched).
    if t.merchant_source in ('claude', 'manual') then
      v_merchant := t.merchant_id;
      v_msource  := t.merchant_source;
    else
      v_merchant := null;
      if t.payee is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.payee)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      if v_merchant is null and t.description is not null then
        select m.id into v_merchant
        from public.wb_merchants m, unnest(m.match_patterns) p
        where position(lower(p) in lower(t.description)) > 0
        order by length(p) desc, m.name, m.id
        limit 1;
      end if;
      v_msource := case when v_merchant is null then null else 'default' end;
    end if;
    select default_kind into v_mkind from public.wb_merchants where id = v_merchant;

    -- 1. Clean.
    v_clean := public.wb_clean_description(coalesce(nullif(btrim(t.description), ''), t.payee), v_merchant is not null);

    -- 3. Default kind.
    v_kind    := t.kind;
    v_ksource := t.kind_source;
    if coalesce(t.kind_source, 'default') not in ('claude', 'manual') and t.transfer_pair_id is null then
      v_kind    := public.wb_default_kind(t.account_role, t.amount, t.description, t.payee, v_mkind);
      v_ksource := 'default';
    end if;
    v_p2p := public.wb_is_p2p_phrase(concat_ws(' ', t.description, t.payee));

    update public.wb_transactions
    set clean_description  = v_clean,
        merchant_id        = v_merchant,
        merchant_source    = v_msource,
        kind               = v_kind,
        kind_source        = v_ksource,
        transfer_candidate = false
    where id = t.id;

    v_date := (coalesce(t.posted_at, t.transacted_at) at time zone 'America/Los_Angeles')::date;

    -- 4. Transfer pairing: posted rows on household accounts, never claude/manual.
    --    A payment to a person is tried too, but only pairs; it is never a candidate.
    if not t.pending
       and t.transfer_pair_id is null
       and (v_kind = 'transfer' or v_p2p)
       and coalesce(v_ksource, 'default') not in ('claude', 'manual')
       and t.account_source = 'simplefin'
       and t.account_role not in ('closed', 'history_rollup')
    then
      select count(*)::int into v_fwd
      from public.wb_transactions c
      join public.wb_accounts ca on ca.id = c.account_id
      where c.id <> t.id
        and c.amount = -t.amount
        and not c.pending
        and c.transfer_pair_id is null
        and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
        and ca.source = 'simplefin'
        and ca.role not in ('closed', 'history_rollup')
        and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
              (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

      v_rev := 0;
      if v_fwd = 1 then
        select c.id, c.account_id, c.amount,
               (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date as d
        into v_match
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> t.id
          and c.amount = -t.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(t.account_id, t.amount, v_date, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);

        select count(*)::int into v_rev
        from public.wb_transactions c
        join public.wb_accounts ca on ca.id = c.account_id
        where c.id <> v_match.id
          and c.amount = -v_match.amount
          and not c.pending
          and c.transfer_pair_id is null
          and coalesce(c.kind_source, 'default') not in ('claude', 'manual')
          and ca.source = 'simplefin'
          and ca.role not in ('closed', 'history_rollup')
          and public.wb_transfer_match(v_match.account_id, v_match.amount, v_match.d, c.account_id, c.amount,
                (coalesce(c.posted_at, c.transacted_at) at time zone 'America/Los_Angeles')::date);
      end if;

      if public.wb_pair_decision(v_fwd, v_rev) = 'pair' then
        update public.wb_transactions
        set transfer_pair_id = v_match.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = t.id;
        update public.wb_transactions
        set transfer_pair_id = t.id, kind = 'transfer', kind_source = 'default', transfer_candidate = false
        where id = v_match.id;
        v_kind     := 'transfer';
        v_ksource  := 'default';
        n_paired   := n_paired + 1;
      elsif v_kind = 'transfer' then
        update public.wb_transactions set transfer_candidate = true where id = t.id;
        n_candidates := n_candidates + 1;
      end if;
    end if;

    -- 5. Rules: posted rows only. Rule tags are replaced; claude/manual tags stay,
    --    and a tag removed by hand (wb_tag_exclusions) is never put back.
    v_matched := '{}';
    v_project := null;
    if not t.pending then
      v_posted := v_posted || t.id;
      select count(*)::int, (array_agg(s.id order by s.position, s.id))[1]
      into v_nsplits, v_split
      from public.wb_splits s
      where s.transaction_id = t.id;

      delete from public.wb_split_tags st
      using public.wb_splits s
      where st.split_id = s.id and s.transaction_id = t.id and st.source = 'rule';

      select x.kind, x.kind_source, x.merchant_id, x.merchant_source, x.transfer_pair_id, x.clean_description
      into cur
      from public.wb_transactions x
      where x.id = t.id;

      for r in
        select * from public.wb_rules where active order by priority, created_at, id
      loop
        continue when not public.wb_rule_matches(r.match, t.account_id, t.amount, t.payee, t.description,
                                                 cur.clean_description, cur.merchant_id, cur.kind);
        v_matched := v_matched || r.id;

        if r.set_kind is not null
           and coalesce(cur.kind_source, 'default') not in ('claude', 'manual')
           and cur.transfer_pair_id is null
        then
          update public.wb_transactions set kind = r.set_kind, kind_source = 'rule' where id = t.id;
          cur.kind := r.set_kind;
          cur.kind_source := 'rule';
        end if;

        if r.set_merchant_id is not null and coalesce(cur.merchant_source, 'default') not in ('claude', 'manual') then
          update public.wb_transactions set merchant_id = r.set_merchant_id, merchant_source = 'rule' where id = t.id;
          cur.merchant_id := r.set_merchant_id;
          cur.merchant_source := 'rule';
        end if;

        -- The first matching rule that sets a project wins.
        if r.set_project_id is not null and v_project is null then
          v_project := r.set_project_id;
        end if;

        -- Tags only on a single-split transaction; multi-split ones are left to people.
        if v_nsplits = 1 then
          for v_tag in
            select tg.id, tg.group_id, g.exclusive
            from unnest(r.add_tag_ids) with ordinality as x(tag_id, ord)
            join public.wb_tags tg on tg.id = x.tag_id and tg.is_active
            join public.wb_tag_groups g on g.id = tg.group_id
            order by x.ord
          loop
            continue when exists (
              select 1 from public.wb_tag_exclusions e where e.transaction_id = t.id and e.tag_id = v_tag.id);
            continue when v_tag.exclusive and exists (
              select 1 from public.wb_split_tags where split_id = v_split and group_id = v_tag.group_id);
            insert into public.wb_split_tags (split_id, tag_id, source, rule_id)
            values (v_split, v_tag.id, 'rule', r.id)
            on conflict (split_id, tag_id) do nothing;
            if found then
              n_tags := n_tags + 1;
            end if;
          end loop;
        end if;
      end loop;

      -- 5c. Project, on a single-split transaction only. A project set or removed
      --     by hand or by Claude stays; a rule's project goes when no rule sets one.
      if v_nsplits = 1 then
        select s.project_source into v_psource from public.wb_splits s where s.id = v_split;
        if coalesce(v_psource, 'rule') = 'rule' then
          update public.wb_splits
          set project_id = v_project, project_source = case when v_project is null then null else 'rule' end
          where id = v_split
            and (project_id is distinct from v_project
                 or project_source is distinct from case when v_project is null then null else 'rule' end);
          if found and v_project is not null then
            n_projects := n_projects + 1;
          end if;
        end if;
      end if;

      -- 5b. Subscription: a posted spend charge links to its merchant's one
      --     non-cancelled subscription, or, when it has several, to the one whose
      --     price is within its tolerance. Hand links (claude/manual) stay.
      if coalesce(t.subscription_source, 'default') not in ('claude', 'manual') then
        v_sub := null;
        if cur.kind = 'spend' and t.amount < 0 and cur.merchant_id is not null then
          select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
          from public.wb_subscriptions s
          where s.merchant_id = cur.merchant_id and s.status <> 'cancelled';
          if v_nsubs > 1 then
            select count(*)::int, (array_agg(s.id))[1] into v_nsubs, v_sub
            from public.wb_subscriptions s
            where s.merchant_id = cur.merchant_id and s.status <> 'cancelled'
              and abs(-t.amount - public.wb_subscription_price_on(s.id, v_date)) <= s.amount_tolerance;
            if v_nsubs <> 1 then
              v_sub := null;
            end if;
          end if;
        end if;
        if v_sub is distinct from t.subscription_id then
          update public.wb_transactions
          set subscription_id = v_sub, subscription_source = case when v_sub is null then null else 'default' end
          where id = t.id;
          if v_sub is not null then
            n_linked := n_linked + 1;
          end if;
        end if;
      end if;
    end if;
    if t.subscription_id is not null then
      v_subs := v_subs || t.subscription_id;
    end if;
    if v_sub is not null then
      v_subs := v_subs || v_sub;
    end if;
    v_sub := null;

    -- 6. Done.
    update public.wb_transactions
    set matched_rule_ids = v_matched, processed_at = now()
    where id = t.id;
    n_processed := n_processed + 1;
  end loop;

  perform public.wb_refresh_subscriptions(v_subs);

  -- Rule hit counts, recomputed (not incremented) and written only when changed.
  with h as (
    select ru.id,
           count(x.id)::int as n,
           max(coalesce(x.posted_at, x.transacted_at)) as last_hit
    from public.wb_rules ru
    left join public.wb_transactions x on ru.id = any(x.matched_rule_ids)
    group by ru.id
  )
  update public.wb_rules ru
  set hit_count = h.n, last_hit_at = h.last_hit
  from h
  where ru.id = h.id
    and (ru.hit_count is distinct from h.n or ru.last_hit_at is distinct from h.last_hit);
  get diagnostics n_rules = row_count;

  -- 7. Planned match suggestions for the posted rows processed here.
  v_sugg := case when cardinality(v_posted) > 0
                 then public.wb_suggest_planned_matches(v_posted, null)
                 else jsonb_build_object('suggested', 0) end;

  return jsonb_build_object(
    'processed', n_processed,
    'paired', n_paired,
    'transfer_candidates', n_candidates,
    'rule_tags', n_tags,
    'rules_updated', n_rules,
    'subscriptions_linked', n_linked,
    'rule_projects', n_projects,
    'matches_suggested', (v_sugg ->> 'suggested')::int);
end;
$$;

comment on function public.wb_process_transactions(uuid[]) is
  'Warren Buffet: clean, merchant, default kind, transfer pairing, rules (kind, merchant, tags and, on a single split, the first matching rule''s project), subscription links, then planned match suggestions for the given transactions (Phase 2 spec §5, §4.8; Phase 3 spec §3.5). Security invoker. Never changes a claude or manual kind, merchant, tag, project or subscription link, and never puts back a tag or project removed by hand; pairs, tags, sets projects and links posted rows only; a payment to a person pairs only on a unique match and is never a transfer candidate. Safe to re-run. Returns counts.';

-- ============================================================================
-- 7. wb_review_queue: as in 122, plus planned_match (one row per suggested
--    match) and its columns at the end
-- ============================================================================
create or replace view public.wb_review_queue
with (security_invoker = true) as
with base as (
  select
    x.id                                                                       as transaction_id,
    x.account_id,
    coalesce(a.display_name, a.name)                                           as account_label,
    (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as txn_date,
    x.amount,
    x.description,
    x.clean_description,
    x.payee,
    x.merchant_id,
    m.name                                                                     as merchant_name,
    x.merchant_source,
    x.kind,
    x.kind_source,
    x.pending,
    x.reviewed,
    x.transfer_candidate,
    x.transfer_pair_id
  from public.wb_transactions x
  join public.wb_accounts a on a.id = x.account_id
  left join public.wb_merchants m on m.id = x.merchant_id
),
reasons as (
  select b.transaction_id, 'no_kind'::text as reason, null::text as detail, null::uuid as planned_match_id
  from base b
  where b.kind is null
  union all
  select b.transaction_id, 'missing_required_tag', g.name, null
  from base b
  join public.wb_tag_groups g on b.kind = any (g.required_for_kinds)
  where not b.pending
    and not b.reviewed
    and exists (
      select 1 from public.wb_splits s
      where s.transaction_id = b.transaction_id
        and not exists (select 1 from public.wb_split_tags st where st.split_id = s.id and st.group_id = g.id))
  union all
  select b.transaction_id, 'transfer_candidate', null, null
  from base b
  where b.transfer_candidate and b.transfer_pair_id is null and not b.pending and not b.reviewed
  union all
  select b.transaction_id, 'split_mismatch', format('%s split(s) sum to %s', coalesce(s.n, 0), coalesce(s.total, 0)), null
  from base b
  left join lateral (
    select count(*) as n, sum(sp.amount) as total from public.wb_splits sp where sp.transaction_id = b.transaction_id
  ) s on true
  where coalesce(s.n, 0) = 0 or s.total <> b.amount
  union all
  -- A charge on an active subscription that differs from its price by more than the tolerance.
  select b.transaction_id, 'price_change', format('%s: expected %s', s.name, p.price), null
  from base b
  join public.wb_transactions x on x.id = b.transaction_id
  join public.wb_subscriptions s on s.id = x.subscription_id
  cross join lateral (select public.wb_subscription_price_on(s.id, b.txn_date) as price) p
  where s.status = 'active'
    and not b.pending
    and not b.reviewed
    and abs(-b.amount - p.price) > s.amount_tolerance
  union all
  -- The newest charge of each detected (watching) subscription, until it is confirmed or
  -- dismissed. "Keep watching" marks that charge reviewed, which clears the row until the
  -- next charge (unreviewed) becomes the newest.
  select lc.id, 'new_recurring', s.name, null
  from public.wb_subscriptions s
  left join public.wb_merchants m on m.id = s.merchant_id
  cross join lateral (
    select x.id, x.reviewed from public.wb_transactions x
    where x.subscription_id = s.id and not x.pending
    order by coalesce(x.posted_at, x.transacted_at) desc, x.id desc
    limit 1
  ) lc
  where s.status = 'watching'
    and not coalesce(m.not_subscription, false)
    and not lc.reviewed
  union all
  -- A suggested planned match, until it is confirmed or rejected (shown even when reviewed).
  select pm.transaction_id, 'planned_match',
         format('%s, due %s', pi.name, to_char(coalesce(pm.occurrence_on, pi.due_on), 'YYYY-MM-DD')), pm.id
  from public.wb_planned_matches pm
  join public.wb_planned_items pi on pi.id = pm.planned_item_id
  where pm.status = 'suggested'
)
select
  r.reason,
  r.detail,
  b.*,
  coalesce((
    select array_agg(distinct tg.name order by tg.name)
    from public.wb_splits s
    join public.wb_split_tags st on st.split_id = s.id
    join public.wb_tags tg on tg.id = st.tag_id
    where s.transaction_id = b.transaction_id
  ), '{}'::text[]) as tag_names,
  r.planned_match_id,
  pm.planned_item_id,
  pi.name                                     as planned_item_name,
  coalesce(pm.occurrence_on, pi.due_on)       as planned_on,
  pi.amount                                   as planned_amount,
  pm.amount_applied                           as match_amount,
  pi.amount_tolerance                         as planned_tolerance,
  pi.match_window_days                        as planned_window_days
from reasons r
join base b on b.transaction_id = r.transaction_id
left join public.wb_planned_matches pm on pm.id = r.planned_match_id
left join public.wb_planned_items pi on pi.id = pm.planned_item_id;

comment on view public.wb_review_queue is
  'App: Warren Buffet. One row per transaction and reason: no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch, price_change (detail = subscription and expected price; active subscriptions, cleared by recording the new price or marking reviewed), new_recurring (detail = subscription; the newest charge of a watching subscription while it is unreviewed: "Keep watching" marks it reviewed, the next charge brings it back; confirming or dismissing ends it) and planned_match (one row per suggested planned match, detail = planned item and due date; planned_match_id and the planned_* and match_amount columns describe it; confirming or rejecting ends it). Tag, transfer and price reasons cover posted, unreviewed rows only; split_mismatch and planned_match show even when reviewed. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 8. wb_transaction_list: as in 122, needs_review kept in step with planned_match
-- ============================================================================
create or replace view public.wb_transaction_list
with (security_invoker = true) as
select
  x.id,
  x.account_id,
  coalesce(a.display_name, a.name)                                                   as account_label,
  x.posted_at,
  x.transacted_at,
  (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as txn_date,
  x.amount,
  x.description,
  x.clean_description,
  x.payee,
  x.memo,
  x.mcc,
  x.pending,
  x.merchant_id,
  m.name                                                                             as merchant_name,
  x.merchant_source,
  x.kind,
  x.kind_source,
  x.transfer_pair_id,
  x.transfer_candidate,
  x.reviewed,
  x.processed_at,
  x.first_seen_at,
  x.last_seen_at,
  coalesce((
    select array_agg(distinct tg.name order by tg.name)
    from public.wb_splits s
    join public.wb_split_tags st on st.split_id = s.id
    join public.wb_tags tg on tg.id = st.tag_id
    where s.transaction_id = x.id
  ), '{}'::text[])                                                                   as tag_names,
  (select count(*) from public.wb_splits s where s.transaction_id = x.id)::int        as split_count,
  (
    x.kind is null
    or (not x.pending and not x.reviewed and x.transfer_candidate and x.transfer_pair_id is null)
    or (not x.pending and not x.reviewed and exists (
          select 1
          from public.wb_tag_groups g
          join public.wb_splits s on s.transaction_id = x.id
          where x.kind = any (g.required_for_kinds)
            and not exists (select 1 from public.wb_split_tags st where st.split_id = s.id and st.group_id = g.id)))
    or coalesce((select sum(s.amount) from public.wb_splits s where s.transaction_id = x.id), 0) <> x.amount
    or (not x.pending and not x.reviewed and sub.status = 'active'
        and abs(-x.amount - public.wb_subscription_price_on(sub.id,
              (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date)) > sub.amount_tolerance)
    or (not x.pending and not x.reviewed and sub.status = 'watching'
        and not coalesce((select sm.not_subscription from public.wb_merchants sm where sm.id = sub.merchant_id), false)
        and x.id = (select y.id from public.wb_transactions y
                    where y.subscription_id = sub.id and not y.pending
                    order by coalesce(y.posted_at, y.transacted_at) desc, y.id desc limit 1))
    or exists (select 1 from public.wb_planned_matches pm where pm.transaction_id = x.id and pm.status = 'suggested')
  ) is true                                                                          as needs_review,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'tag_id', e.tag_id, 'tag_name', tg.name, 'rule_id', e.rule_id,
             'source', e.source, 'removed_at', e.created_at)
           order by tg.name)
    from public.wb_tag_exclusions e
    join public.wb_tags tg on tg.id = e.tag_id
    where e.transaction_id = x.id
  ), '[]'::jsonb)                                                                    as excluded_tags,
  x.notes,
  x.subscription_id,
  x.subscription_source,
  sub.name                                                                           as subscription_name
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id
left join public.wb_subscriptions sub on sub.id = x.subscription_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue, including a suggested planned match), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, and the linked subscription (subscription_id, subscription_source, subscription_name). No raw jsonb. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 9. Grants
-- ============================================================================
grant execute on function public.wb_planned_occurrences(date, date, boolean) to authenticated, service_role;
grant execute on function public.wb_suggest_planned_matches(uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.wb_confirm_planned_match(uuid, text, numeric) to authenticated, service_role;
grant execute on function public.wb_replace_splits(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.wb_process_transactions(uuid[]) to authenticated, service_role;
grant select on public.wb_review_queue     to authenticated, service_role;
grant select on public.wb_transaction_list to authenticated, service_role;

commit;

-- ============================================================================
-- 10. Conformance: this is the result the SQL editor shows. Expect conformant
--     true and failures []. Then run 136_wb_phase3_step4_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
