-- Purpose: Warren Buffet Phase 3, Step 8b fix. A planned date or one-off whose confirmed matches leave less than its amount_tolerance unpaid counts as covered (Alex, 2026-10-19: a salary date 0.01 short was listed as missed). New wb_planned_left (the signed amount still due, 0 within tolerance) used everywhere "fully covered" is decided: wb_suggest_planned_matches, wb_confirm_planned_match (auto-paid, A20), wb_unconfirm_planned_match (paid_not_covered), wb_planned_unmatched, wb_project_summary and wb_cash_projection.
-- Kind: schema change (one new function, four replaced functions, two replaced views)
-- Applied: YES — 2026-10-20 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 68 tables; 144 all 24 checks true, edited 136 all 35 true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A45.
-- A15: none of the objects redefined here holds a number that the help states; no help comments are due.
-- No real financial data in this file. Run as one block, then 144_wb_phase3_step8_tolerance_cover_tests.sql; the conformance result at
-- the end must be conformant true.
-- supabase/migrations/143_wb_phase3_step8_tolerance_cover.sql

begin;

-- ============================================================================
-- 1. wb_planned_left: what is still due on a planned amount (A45)
-- ============================================================================
create or replace function public.wb_planned_left(p_amount numeric, p_paid numeric, p_tolerance numeric)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  select sign(p_amount) * case when abs(p_amount) - coalesce(p_paid, 0) <= coalesce(p_tolerance, 0) then 0
                               else abs(p_amount) - coalesce(p_paid, 0) end;
$$;

comment on function public.wb_planned_left(numeric, numeric, numeric) is
  'Warren Buffet: the amount still due on a planned amount (signed like p_amount), given p_paid (the confirmed amount_applied, as a positive number) and the item''s amount_tolerance. 0 when what is left is within the tolerance, so a payment a cent short still covers it (A45); never negative in magnitude.';

-- ============================================================================
-- 2. wb_suggest_planned_matches: as in 135, an occurrence covered within tolerance gets no suggestion
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

  -- New ones: not already decided or suggested, the occurrence (within its tolerance, A45)
  -- and the split not already fully confirmed or suggested elsewhere; the closest date
  -- wins, one per occurrence and one per split.
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
      and public.wb_planned_left(pi.amount, (select sum(abs(m.amount_applied)) from public.wb_planned_matches m
                    where m.status = 'confirmed' and m.planned_item_id = p.planned_item_id
                      and m.occurrence_on is not distinct from p.occ), pi.amount_tolerance) <> 0
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
  'Warren Buffet: suggests planned matches for the given transactions and/or planned items (null = all). A posted split qualifies for a planned item''s due date when it is at the item''s merchant, has the same sign, its amount is within the item''s amount_tolerance and its date within match_window_days. Drafts, cancelled and paid one-offs, and items with no merchant never qualify. A pair already suggested, confirmed or rejected is not suggested again; an occurrence already covered by confirmed matches (within its amount_tolerance, wb_planned_left), a split already fully confirmed, or either one already holding a suggestion, gets none; otherwise the closest date wins, one per occurrence and one per split. amount_applied is the smaller of the two amounts. Suggestions in scope that no longer qualify are deleted. Called by wb_process_transactions and after planned-item writes. Security invoker. Returns suggested and removed counts.';

-- ============================================================================
-- 3. wb_confirm_planned_match: as in 135, a one-off covered within tolerance becomes paid
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

  -- A one-off covered by confirmed matches (within its tolerance, A45) is paid. Never set back automatically.
  if pi.interval_count is null and pi.stage <> 'paid'
     and public.wb_planned_left(pi.amount, (select sum(abs(x.amount_applied)) from public.wb_planned_matches x
          where x.planned_item_id = pi.id and x.status = 'confirmed'), pi.amount_tolerance) = 0
  then
    update public.wb_planned_items set stage = 'paid' where id = pi.id;
    v_paid := true;
  end if;
  return jsonb_build_object('status', 'confirmed', 'stage_paid', v_paid);
end;
$$;

comment on function public.wb_confirm_planned_match(uuid, text, numeric) is
  'Warren Buffet: confirm or reject one suggested planned match. confirm may lower the amount for a part-payment (p_amount, taken with the planned item''s sign); the trigger refuses more than the split. Confirming the last part of a one-off (covered within its amount_tolerance) sets its stage to paid; nothing sets it back automatically. A rejected match is never suggested again. Security invoker.';

-- ============================================================================
-- 4. wb_unconfirm_planned_match: as in 140, paid_not_covered allows the tolerance
-- ============================================================================
create or replace function public.wb_unconfirm_planned_match(p_match_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m      record;
  pi     record;
  v_paid numeric;
begin
  select * into m from public.wb_planned_matches where id = p_match_id for update;
  if not found then
    raise exception 'wb_unconfirm_planned_match: no match % that you can see', p_match_id using errcode = '23503';
  end if;
  if m.status <> 'confirmed' then
    raise exception 'wb_unconfirm_planned_match: this match is %, not confirmed', m.status using errcode = '22023';
  end if;
  update public.wb_planned_matches set status = 'rejected', decided_at = now() where id = p_match_id;

  select * into pi from public.wb_planned_items where id = m.planned_item_id;
  select coalesce(sum(abs(x.amount_applied)), 0) into v_paid
  from public.wb_planned_matches x
  where x.planned_item_id = pi.id and x.status = 'confirmed';

  -- The stage is never changed here (A20); the app asks whether to set it back.
  return jsonb_build_object(
    'status', 'rejected',
    'planned_item_id', pi.id,
    'stage', pi.stage,
    'confirmed_total', sign(pi.amount) * v_paid,
    'paid_not_covered', pi.interval_count is null and pi.stage = 'paid'
                        and public.wb_planned_left(pi.amount, v_paid, pi.amount_tolerance) <> 0);
end;
$$;

comment on function public.wb_unconfirm_planned_match(uuid) is
  'Warren Buffet: remove a confirmed planned match. The match becomes rejected, so the same pair is never suggested again. The planned item''s stage is never changed (A20); paid_not_covered is true when a paid one-off is no longer covered (more than its amount_tolerance left, A45), so the app can ask whether to set it back to invoiced. Returns status, planned_item_id, stage, confirmed_total (signed) and paid_not_covered. Security invoker.';

-- ============================================================================
-- 5. wb_planned_unmatched: as in 140, a date covered within tolerance is not missed
-- ============================================================================
create or replace view public.wb_planned_unmatched
with (security_invoker = true) as
with t as (select (now() at time zone 'America/Los_Angeles')::date as d),
occ as (
  -- Recurring items' past dates (drafts left out), and overdue one-offs that are not
  -- drafts, paid or cancelled.
  select o.planned_item_id, o.occurrence_on as due_on, o.occurrence_on, true as recurring
  from t
  cross join lateral public.wb_planned_occurrences(
    coalesce((select min(due_on) from public.wb_planned_items where interval_count is not null), t.d), t.d - 1, false) o
  where o.recurring
  union all
  select pi.id, pi.due_on, null::date, false
  from public.wb_planned_items pi, t
  where pi.interval_count is null
    and pi.due_on < t.d
    and pi.stage not in ('draft', 'paid', 'cancelled')
),
done as (
  select o.*,
         coalesce((select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
                     and pm.occurrence_on is not distinct from o.occurrence_on), 0) as paid
  from occ o
)
select
  d.planned_item_id,
  pi.name,
  pi.project_id,
  pr.name                                                  as project_name,
  pi.merchant_id,
  m.name                                                   as merchant_name,
  d.recurring,
  d.due_on,
  d.occurrence_on,
  pi.stage,
  pi.amount,
  round(sign(pi.amount) * d.paid, 2)                       as confirmed_total,
  round(public.wb_planned_left(pi.amount, d.paid, pi.amount_tolerance), 2) as remaining,
  (t.d - d.due_on)                                         as days_late,
  (t.d - d.due_on) <= pi.match_window_days                 as within_window,
  exists (select 1 from public.wb_planned_matches pm
          where pm.planned_item_id = d.planned_item_id and pm.status = 'suggested'
            and pm.occurrence_on is not distinct from d.occurrence_on) as has_suggestion
from done d
cross join t
join public.wb_planned_items pi on pi.id = d.planned_item_id
left join public.wb_projects pr on pr.id = pi.project_id
left join public.wb_merchants m on m.id = pi.merchant_id
where public.wb_planned_left(pi.amount, d.paid, pi.amount_tolerance) <> 0
  and not exists (select 1 from public.wb_planned_skips sk
                  where sk.planned_item_id = d.planned_item_id
                    and sk.occurrence_on is not distinct from d.occurrence_on);

comment on view public.wb_planned_unmatched is
  'App: Warren Buffet. Missed dates: every due date before today (Pacific) that its confirmed matches do not cover (more than the item''s amount_tolerance left, A45). Recurring items give one row per past date from due_on (occurrence_on set); a one-off gives one row once its date is past, unless it is a draft, paid or cancelled (occurrence_on null). Recurring drafts are left out. A date in wb_planned_skips (Not needed) is left out. confirmed_total and remaining carry the item''s sign; days_late counts from the due date; within_window is true while a payment may still be suggested (days_late <= match_window_days); has_suggestion when one waits in Review. The weekly cleanup reads this view (A25). security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 6. wb_project_summary: as in 140, amounts still due are 0 within tolerance
-- ============================================================================
create or replace view public.wb_project_summary
with (security_invoker = true) as
with t as (select (now() at time zone 'America/Los_Angeles')::date as d,
                  coalesce((select horizon_months from public.wb_settings order by created_at limit 1), 12) as h),
pay as (
  -- Posted splits on each project. Spent is money out (negative); received is money in.
  select s.project_id,
         coalesce(sum(s.amount) filter (where s.amount < 0), 0) as spent,
         coalesce(sum(s.amount) filter (where s.amount > 0), 0) as received,
         count(*)::int                                           as payment_count,
         max((coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date) as last_payment_on
  from public.wb_splits s
  join public.wb_transactions x on x.id = s.transaction_id
  where s.project_id is not null and not x.pending
  group by s.project_id
),
items as (
  select pi.project_id,
         count(*) filter (where coalesce(pi.stage, '') <> 'cancelled')::int                                as item_count,
         count(*) filter (where pi.stage = 'draft' or pi.is_draft)::int                                    as draft_count
  from public.wb_planned_items pi
  where pi.project_id is not null
  group by pi.project_id
),
due as (
  -- What is still to come, less what is confirmed (0 within tolerance, A45): one-offs not
  -- paid or cancelled (overdue ones included), and recurring dates from today to the end of the horizon.
  select q.project_id, q.draft,
         sum(q.left_amt) filter (where q.left_amt < 0) as due_out,
         sum(q.left_amt) filter (where q.left_amt > 0) as due_in
  from (
    select pi.project_id, pi.stage = 'draft' as draft,
           public.wb_planned_left(pi.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status = 'confirmed'), pi.amount_tolerance) as left_amt
    from public.wb_planned_items pi
    where pi.project_id is not null and pi.interval_count is null and pi.stage not in ('paid', 'cancelled')
    union all
    select pi.project_id, pi.is_draft,
           public.wb_planned_left(o.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
               and pm.occurrence_on = o.occurrence_on), pi.amount_tolerance)
    from t
    cross join lateral public.wb_planned_occurrences(t.d, (t.d + make_interval(months => t.h))::date - 1, true) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring and pi.project_id is not null
  ) q
  group by q.project_id, q.draft
)
select
  p.id                                                         as project_id,
  p.name,
  p.status,
  p.budget,
  p.starts_on,
  p.ends_on,
  round(coalesce(pay.spent, 0), 2)                             as spent,
  round(coalesce(pay.received, 0), 2)                          as received,
  round(coalesce(pay.spent, 0) + coalesce(pay.received, 0), 2) as net,
  case when p.budget is not null then round(p.budget + coalesce(pay.spent, 0), 2) end as budget_left,
  round(coalesce((select d.due_out from due d where d.project_id = p.id and not d.draft), 0), 2) as planned_out_due,
  round(coalesce((select d.due_in  from due d where d.project_id = p.id and not d.draft), 0), 2) as planned_in_due,
  round(coalesce((select d.due_out from due d where d.project_id = p.id and d.draft), 0), 2)     as draft_out_due,
  round(coalesce((select d.due_in  from due d where d.project_id = p.id and d.draft), 0), 2)     as draft_in_due,
  coalesce(items.item_count, 0)                                as item_count,
  coalesce(items.draft_count, 0)                               as draft_count,
  coalesce(pay.payment_count, 0)                               as payment_count,
  pay.last_payment_on,
  (coalesce(items.item_count, 0) > 0
   and items.draft_count = items.item_count
   and coalesce(pay.payment_count, 0) = 0)                     as planning
from public.wb_projects p
left join pay on pay.project_id = p.id
left join items on items.project_id = p.id;

comment on view public.wb_project_summary is
  'App: Warren Buffet. One row per project. spent = posted money out on the project''s splits (negative); received = posted money in (positive, such as an insurer''s payment); net = spent + received. budget_left = budget + spent: the budget is measured against spent, not net (A36). planned_out_due and planned_in_due = what is still to come on its planned items, less what is confirmed (0 when within the item''s amount_tolerance, A45): one-offs not paid or cancelled (overdue included) and recurring dates over the horizon; draft_out_due and draft_in_due are the same for drafts, kept apart. item_count leaves out cancelled items. planning is true when every item is a draft and nothing has been paid on the project (A35); it is derived, never stored. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 7. wb_cash_projection: as in 137, what is still due is 0 within tolerance
-- ============================================================================
create or replace function public.wb_cash_projection(p_include_drafts boolean default false, p_today date default null)
returns table (day date, opening numeric, planned_in numeric, planned_out numeric, subscriptions numeric,
               burn numeric, closing numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_end   date;
  v_start numeric;
  v_burn  numeric;
begin
  v_end := (v_today + make_interval(months =>
             coalesce((select horizon_months from public.wb_settings order by created_at limit 1), 12)))::date - 1;

  -- Spending cash minus what is owed on cards and emergency credit; unused credit never counts (A4).
  select coalesce(sum(case when a.role = 'spending_cash' then b.balance
                           else least(b.balance, 0) end), 0)
  into v_start
  from public.wb_accounts a
  cross join lateral (select bs.balance from public.wb_balance_snapshots bs
                      where bs.account_id = a.id and bs.as_of <= v_today
                      order by bs.as_of desc limit 1) b
  where a.role in ('spending_cash', 'credit_card', 'emergency_credit');

  -- Everyday spending at the burn rate, spread evenly per day.
  select coalesce(max(br.burn_median), 0) * 12 / 365 into v_burn from public.wb_burn_rate_on(v_today) br;

  return query
  with days as (select generate_series(v_today, v_end, interval '1 day')::date as d),
  planned as (
    -- Due dates in the horizon, less what is already confirmed against each (A5), 0 within tolerance (A45).
    select o.occurrence_on as d,
           public.wb_planned_left(o.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
               and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
             pi.amount_tolerance) as amt
    from public.wb_planned_occurrences(v_today, v_end, p_include_drafts) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring or o.stage <> 'paid'
    union all
    -- An overdue one-off with something still unpaid counts on day 1 (A7). Missed dates of
    -- recurring items do not (A25); the weekly cleanup lists them as unmatched.
    select v_today,
           public.wb_planned_left(pi.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status = 'confirmed'), pi.amount_tolerance)
    from public.wb_planned_items pi
    where pi.interval_count is null
      and pi.due_on < v_today
      and pi.stage not in ('paid', 'cancelled')
      and (p_include_drafts or pi.stage <> 'draft')
  ),
  subs as (
    select so.occurrence_on as d, so.amount from public.wb_subscription_occurrences(v_today, v_end, v_today) so
  ),
  per_day as (
    select dd.d,
           coalesce((select sum(p.amt) from planned p where p.d = dd.d and p.amt > 0), 0) as p_in,
           coalesce((select sum(p.amt) from planned p where p.d = dd.d and p.amt < 0), 0) as p_out,
           coalesce((select sum(s.amount) from subs s where s.d = dd.d), 0) as sub,
           v_burn as brn
    from days dd
  ),
  run as (
    select pd.*, v_start + sum(pd.p_in + pd.p_out + pd.sub + pd.brn) over (order by pd.d) as close_bal
    from per_day pd
  )
  select r.d, round(r.close_bal - (r.p_in + r.p_out + r.sub + r.brn), 2), round(r.p_in, 2), round(r.p_out, 2),
         round(r.sub, 2), round(r.brn, 2), round(r.close_bal, 2)
  from run r
  order by r.d;
end;
$$;

comment on function public.wb_cash_projection(boolean, date) is
  'Warren Buffet: spending cash day by day from p_today across the horizon (wb_settings.horizon_months, else 12). Starts from spending_cash balances minus what is owed on credit_card and emergency_credit accounts (unused credit never counts; balances as of p_today). Each day adds planned income and bills on their due dates less what is confirmed against them (nothing when what is left is within the item''s amount_tolerance, A45), subscription charges, and the burn rate spread evenly (median x 12 / 365). An overdue one-off with something unpaid counts on day 1; a missed recurring date does not. Drafts (stage draft, or is_draft) only when p_include_drafts. Security invoker.';

-- ============================================================================
-- 8. Grants
-- ============================================================================
grant execute on function public.wb_planned_left(numeric, numeric, numeric) to authenticated, service_role;
grant execute on function public.wb_suggest_planned_matches(uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.wb_confirm_planned_match(uuid, text, numeric) to authenticated, service_role;
grant execute on function public.wb_unconfirm_planned_match(uuid) to authenticated, service_role;
grant execute on function public.wb_cash_projection(boolean, date) to authenticated, service_role;
grant select on public.wb_planned_unmatched to authenticated, service_role;
grant select on public.wb_project_summary   to authenticated, service_role;

commit;

-- ============================================================================
-- 9. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 144_wb_phase3_step8_tolerance_cover_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
