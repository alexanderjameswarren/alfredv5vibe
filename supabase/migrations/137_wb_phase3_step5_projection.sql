-- Purpose: Warren Buffet Phase 3, Step 5a. The numbers behind free cash: wb_monthly_equivalent (the JS monthlyEquivalent rule in SQL), wb_subscription_occurrences and the wb_subscription_outflows view, wb_burn_rate_on and the wb_burn_rate view, the wb_true_cost view, wb_cash_projection (day by day over the horizon) and wb_free_cash (lowest point minus the safety floor, with the reserve on its own line).
-- Kind: schema change (six new functions, three new views)
-- Applied: YES — 2026-10-17 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 67 tables; 138 all 42 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md sections 2 (decisions 3, 7, 8, 9), 3.7 and A2-A8, A12, A14, A22-A28.
-- A15: help numbers in this file carry their "update help entry" comment where they are defined.
-- No real financial data in this file. Run as one block, then 138_wb_phase3_step5_tests.sql; the
-- conformance result at the end must be conformant true.
-- supabase/migrations/137_wb_phase3_step5_projection.sql

begin;

-- ============================================================================
-- 1. wb_monthly_equivalent: the same rule as moneyFormat.monthlyEquivalent (A12)
-- ============================================================================
create or replace function public.wb_monthly_equivalent(p_amount numeric, p_interval_count int, p_interval_unit text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  -- If you change 52 or 12, update help entries subscriptions.monthly_total,
  -- subscriptions.breakdown and overview.true_cost in src/money/helpText.js, its test,
  -- and moneyFormat.monthlyEquivalent (WEEKS_PER_YEAR, MONTHS_PER_YEAR).
  select case
    when p_amount is null or coalesce(p_interval_count, 0) <= 0 then null
    when p_interval_unit = 'month' then p_amount / p_interval_count
    when p_interval_unit = 'week'  then p_amount * 52 / 12 / p_interval_count
  end;
$$;

comment on function public.wb_monthly_equivalent(numeric, int, text) is
  'Warren Buffet: an amount per interval as a monthly amount: months divide by the count, weeks multiply by 52 / 12 / count; null with no interval. The same rule as moneyFormat.monthlyEquivalent in the app (spec A12).';

-- ============================================================================
-- 2. wb_subscription_occurrences and wb_subscription_outflows (decision 3, A24)
-- ============================================================================
create or replace function public.wb_subscription_occurrences(p_from date, p_to date, p_today date default null)
returns table (subscription_id uuid, name text, occurrence_on date, amount numeric, overdue_charge boolean)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with t as (select coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date) as d),
  subs as (
    select s.id, s.name, s.next_expected_on, s.interval_count, s.interval_unit,
           -public.wb_subscription_price_on(s.id, t.d) as amount, t.d as today
    from public.wb_subscriptions s
    cross join t
    where s.status = 'active'
      and s.interval_count is not null
      and s.next_expected_on is not null
      -- A prepaid term that does not renew expects no charge.
      and not (s.term_end_date is not null and s.auto_renew is false)
  )
  -- A charge already due and not yet seen counts once, on today (A24).
  select s.id, s.name, s.today, s.amount, true
  from subs s
  where s.next_expected_on < s.today and s.today between p_from and p_to and s.amount is not null
  union all
  select s.id, s.name, o.d, s.amount, false
  from subs s
  cross join lateral (
    select (case when s.interval_unit = 'month'
                 then s.next_expected_on + make_interval(months => k * s.interval_count)
                 else s.next_expected_on + make_interval(days => 7 * k * s.interval_count) end)::date as d
    from generate_series(0, greatest(0, ceil((p_to - s.next_expected_on)::numeric
           / (case when s.interval_unit = 'month' then 28 else 7 end * s.interval_count))::int)) k
  ) o
  where s.amount is not null
    and o.d >= s.today
    and o.d between p_from and p_to;
$$;

comment on function public.wb_subscription_occurrences(date, date, date) is
  'Warren Buffet: the expected charges of active subscriptions between p_from and p_to: from next_expected_on, stepping by the billing interval, at the price on p_today (negative, money out). A charge already past its expected date and not yet seen counts once, on p_today. Watching, paused and cancelled subscriptions, ones with no interval, and prepaid terms that do not renew give none. Security invoker.';

create or replace view public.wb_subscription_outflows
with (security_invoker = true) as
select o.*
from (select (now() at time zone 'America/Los_Angeles')::date as d,
             coalesce((select horizon_months from public.wb_settings order by created_at limit 1), 12) as h) t
cross join lateral public.wb_subscription_occurrences(t.d, (t.d + make_interval(months => t.h))::date - 1, t.d) o;

comment on view public.wb_subscription_outflows is
  'App: Warren Buffet. Expected subscription charges from today across the horizon (wb_settings.horizon_months, else 12): wb_subscription_occurrences for today. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 3. wb_burn_rate_on and wb_burn_rate (decision 8, A3, A23, A26)
-- ============================================================================
create or replace function public.wb_burn_rate_on(p_today date default null)
returns table (month date, included numeric, project_excluded numeric, matched_excluded numeric,
               subscription_excluded numeric, burn_median numeric, burn_mean numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  -- If you change 3, update help entries overview.burn_rate and overview.true_cost in
  -- src/money/helpText.js, BURN_MONTHS in src/money/ruleNumbers.js, and the test.
  v_months constant int := 3;
  v_today  date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_first  date;
begin
  v_first := (date_trunc('month', v_today) - make_interval(months => v_months))::date;
  return query
  with months as (
    select (v_first + make_interval(months => g))::date as m from generate_series(0, v_months - 1) g
  ),
  parts as (
    select date_trunc('month', (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles'))::date as m,
           s.amount,
           s.project_id is not null as on_project,
           x.subscription_id is not null as on_subscription,
           coalesce((select sum(pm.amount_applied) from public.wb_planned_matches pm
                     where pm.split_id = s.id and pm.status = 'confirmed'), 0) as matched
    from public.wb_transactions x
    join public.wb_splits s on s.transaction_id = x.id
    where not x.pending
      and x.kind in ('spend', 'refund', 'fee')
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date >= v_first
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date < date_trunc('month', v_today)::date
  ),
  per_month as (
    select mo.m,
           coalesce(sum(case when not p.on_project and not p.on_subscription then p.amount - p.matched end), 0) as inc,
           coalesce(sum(case when p.on_project then p.amount end), 0) as proj,
           coalesce(sum(case when not p.on_project and not p.on_subscription then p.matched end), 0) as mat,
           coalesce(sum(case when not p.on_project and p.on_subscription then p.amount end), 0) as subx
    from months mo
    left join parts p on p.m = mo.m
    group by mo.m
  )
  select pm.m, round(pm.inc, 2), round(pm.proj, 2), round(pm.mat, 2), round(pm.subx, 2),
         round((select percentile_cont(0.5) within group (order by q.inc) from per_month q)::numeric, 2),
         round((select avg(q.inc) from per_month q), 2)
  from per_month pm
  order by pm.m;
end;
$$;

comment on function public.wb_burn_rate_on(date) is
  'Warren Buffet: everyday spending for the 3 full Pacific months before p_today''s month: posted spend, refund and fee splits (signed; refunds reduce it), leaving out project-linked splits, splits on subscription-linked charges, and the confirmed amount_applied of planned matches (the rest of a mixed payment still counts). One row per month with what was left out, plus the median (the burn rate) and the mean on every row. Security invoker.';

create or replace view public.wb_burn_rate
with (security_invoker = true) as
select * from public.wb_burn_rate_on((now() at time zone 'America/Los_Angeles')::date);

comment on view public.wb_burn_rate is
  'App: Warren Buffet. wb_burn_rate_on for today: the 3 full months used, what each left out, the median (the burn rate) and the mean. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 4. wb_true_cost (decision 7, A8, A27)
-- ============================================================================
create or replace view public.wb_true_cost
with (security_invoker = true) as
with t as (select (now() at time zone 'America/Los_Angeles')::date as d),
burn as (select max(b.burn_median) as median, max(b.burn_mean) as mean from public.wb_burn_rate_on((select d from t)) b),
subs as (
  -- Active subscriptions with a price and an interval, each rounded to the cent first, as the app's breakdown does.
  select coalesce(sum(round(public.wb_monthly_equivalent(-public.wb_subscription_price_on(s.id, t.d), s.interval_count, s.interval_unit), 2)), 0) as monthly
  from public.wb_subscriptions s cross join t
  where s.status = 'active' and s.interval_count is not null
    and public.wb_subscription_price_on(s.id, t.d) is not null
),
planned as (
  select coalesce(sum(round(public.wb_monthly_equivalent(pi.amount, pi.interval_count, pi.interval_unit), 2))
                    filter (where pi.amount < 0), 0) as out_monthly,
         coalesce(sum(round(public.wb_monthly_equivalent(pi.amount, pi.interval_count, pi.interval_unit), 2))
                    filter (where pi.amount > 0), 0) as income_monthly
  from public.wb_planned_items pi cross join t
  where pi.interval_count is not null and not pi.is_draft
    and (pi.ends_on is null or pi.ends_on >= t.d)
)
select
  burn.median                                              as burn_monthly,
  burn.mean                                                as burn_mean,
  subs.monthly                                             as subscriptions_monthly,
  planned.out_monthly                                      as recurring_out_monthly,
  coalesce(burn.median, 0) + subs.monthly + planned.out_monthly as true_cost_monthly,
  planned.income_monthly                                   as expected_income_monthly,
  planned.income_monthly + coalesce(burn.median, 0) + subs.monthly + planned.out_monthly as net_monthly
from burn, subs, planned;

comment on view public.wb_true_cost is
  'App: Warren Buffet. Monthly true cost (negative, money out) = burn rate (median) + active subscriptions as a monthly amount + recurring planned outflows as a monthly amount (wb_monthly_equivalent; drafts and ended items left out). expected_income_monthly is recurring planned income as a monthly amount (spec A8); net_monthly is income plus true cost. burn_mean is shown as working. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 5. wb_cash_projection (decision 7, 9; A4, A5, A7, A14, A24, A25)
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
    -- Due dates in the horizon, less what is already confirmed against each (A5).
    select o.occurrence_on as d,
           sign(o.amount) * greatest(abs(o.amount) - coalesce((
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
               and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end), 0), 0) as amt
    from public.wb_planned_occurrences(v_today, v_end, p_include_drafts) o
    where o.recurring or o.stage <> 'paid'
    union all
    -- An overdue one-off with something still unpaid counts on day 1 (A7). Missed dates of
    -- recurring items do not (A25); the weekly cleanup lists them as unmatched.
    select v_today,
           sign(pi.amount) * greatest(abs(pi.amount) - coalesce((
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status = 'confirmed'), 0), 0)
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
  'Warren Buffet: spending cash day by day from p_today across the horizon (wb_settings.horizon_months, else 12). Starts from spending_cash balances minus what is owed on credit_card and emergency_credit accounts (unused credit never counts; balances as of p_today). Each day adds planned income and bills on their due dates less what is confirmed against them, subscription charges, and the burn rate spread evenly (median x 12 / 365). An overdue one-off with something unpaid counts on day 1; a missed recurring date does not. Drafts (stage draft, or is_draft) only when p_include_drafts. Security invoker.';

-- ============================================================================
-- 6. wb_free_cash (decision 7, A28)
-- ============================================================================
create or replace function public.wb_free_cash(p_include_drafts boolean default false, p_today date default null)
returns table (today date, start_balance numeric, spending_cash numeric, credit_owed numeric, reserve_cash numeric,
               low_balance numeric, low_on date, safety_floor numeric, floor_missing boolean, free_cash numeric,
               horizon_months int, burn_monthly numeric, burn_mean numeric)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_cash  numeric;
  v_owed  numeric;
  v_res   numeric;
  v_floor numeric;
  v_h     int;
  v_low   numeric;
  v_on    date;
  v_med   numeric;
  v_mean  numeric;
begin
  select coalesce(sum(b.balance) filter (where a.role = 'spending_cash'), 0),
         coalesce(sum(least(b.balance, 0)) filter (where a.role in ('credit_card', 'emergency_credit')), 0),
         coalesce(sum(b.balance) filter (where a.role = 'reserve_cash'), 0)
  into v_cash, v_owed, v_res
  from public.wb_accounts a
  cross join lateral (select bs.balance from public.wb_balance_snapshots bs
                      where bs.account_id = a.id and bs.as_of <= v_today
                      order by bs.as_of desc limit 1) b
  where a.role in ('spending_cash', 'credit_card', 'emergency_credit', 'reserve_cash');

  select s.safety_floor, s.horizon_months into v_floor, v_h from public.wb_settings s order by s.created_at limit 1;
  select p.closing, p.day into v_low, v_on
  from public.wb_cash_projection(p_include_drafts, v_today) p
  order by p.closing, p.day
  limit 1;
  select max(br.burn_median), max(br.burn_mean) into v_med, v_mean from public.wb_burn_rate_on(v_today) br;

  return query select v_today, round(v_cash + v_owed, 2), round(v_cash, 2), round(v_owed, 2), round(v_res, 2),
                      v_low, v_on, coalesce(v_floor, 0), v_floor is null, round(v_low - coalesce(v_floor, 0), 2),
                      coalesce(v_h, 12), v_med, v_mean;
end;
$$;

comment on function public.wb_free_cash(boolean, date) is
  'Warren Buffet: free cash = the lowest closing balance of wb_cash_projection over the horizon, minus wb_settings.safety_floor (0 with floor_missing true when none is set). Also returns the start (spending cash plus credit owed, which is negative), the reserve on its own line (never counted), the low date, the horizon and the burn rate (median and mean). Security invoker.';

-- ============================================================================
-- 7. Grants
-- ============================================================================
grant execute on function public.wb_monthly_equivalent(numeric, int, text) to authenticated, service_role;
grant execute on function public.wb_subscription_occurrences(date, date, date) to authenticated, service_role;
grant execute on function public.wb_burn_rate_on(date) to authenticated, service_role;
grant execute on function public.wb_cash_projection(boolean, date) to authenticated, service_role;
grant execute on function public.wb_free_cash(boolean, date) to authenticated, service_role;
grant select on public.wb_subscription_outflows to authenticated, service_role;
grant select on public.wb_burn_rate             to authenticated, service_role;
grant select on public.wb_true_cost             to authenticated, service_role;

commit;

-- ============================================================================
-- 8. Conformance: this is the result the SQL editor shows. Expect conformant
--    true and failures []. Then run 138_wb_phase3_step5_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
