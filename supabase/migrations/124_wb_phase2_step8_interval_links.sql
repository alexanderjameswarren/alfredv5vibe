-- Purpose: Warren Buffet Phase 2, Step 8a. Billing intervals: wb_subscriptions gains interval_count + interval_unit (week or month), so "every 2 months" and "every 2 weeks" have a next_expected_on and can be overdue. Backfilled from cadence (monthly 1 month, quarterly 3, annual 12); cadence other with no interval keeps today's behaviour (no next date, never overdue). A trigger keeps the interval in step with a named cadence. wb_refresh_subscriptions uses the interval; wb_subscription_overview shows it. Hand unlinks already go through wb_link_subscription (source manual, never relinked, dates refreshed).
-- Kind: schema change (two columns, one constraint, one new trigger function, one replaced function, one replaced view, a backfill of existing rows)
-- Applied: YES — 2026-10-13 by Alex. Conformant; by_cadence annual 12 month (8), monthly 1 month (23), quarterly 3 month (1), other null (4). 125 all 22 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md section 4.8.
-- No real financial data in this file. Run as one block, then 125_wb_phase2_step8_tests.sql;
-- check_platform_conformance must report CONFORMANT.
-- supabase/migrations/124_wb_phase2_step8_interval_links.sql

begin;

-- ============================================================================
-- 1. Columns and the rule tying them to cadence
-- ============================================================================
alter table public.wb_subscriptions
  add column if not exists interval_count int,
  add column if not exists interval_unit  text;

alter table public.wb_subscriptions drop constraint if exists wb_subscriptions_interval_check;
alter table public.wb_subscriptions add constraint wb_subscriptions_interval_check check (
  ((interval_count is null) = (interval_unit is null))
  and (interval_count is null or interval_count between 1 and 104)
  and (interval_unit is null or interval_unit in ('week', 'month'))
  -- A named cadence has its fixed interval; only cadence other is free (or empty).
  and (cadence = 'other'
       or (cadence = 'monthly'   and interval_count = 1  and interval_unit = 'month')
       or (cadence = 'quarterly' and interval_count = 3  and interval_unit = 'month')
       or (cadence = 'annual'    and interval_count = 12 and interval_unit = 'month'))
) not valid;

comment on column public.wb_subscriptions.interval_count is
  'Billing interval, with interval_unit: every N weeks or months. Fixed for a named cadence (monthly 1 month, quarterly 3, annual 12); free for cadence other, where null means no next date and never overdue.';
comment on column public.wb_subscriptions.interval_unit is 'week or month; set together with interval_count.';

-- A named cadence sets its interval; switching to other without a new interval clears it.
create or replace function public.wb_subscriptions_fill_interval()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.cadence <> 'other' and (tg_op = 'INSERT' or new.cadence is distinct from old.cadence) then
    new.interval_count := case new.cadence when 'monthly' then 1 when 'quarterly' then 3 when 'annual' then 12 end;
    new.interval_unit  := 'month';
  elsif tg_op = 'UPDATE' and new.cadence = 'other' and old.cadence <> 'other'
        and new.interval_count is not distinct from old.interval_count
        and new.interval_unit is not distinct from old.interval_unit then
    new.interval_count := null;
    new.interval_unit  := null;
  end if;
  return new;
end;
$$;

drop trigger if exists wb_subscriptions_fill_interval on public.wb_subscriptions;
create trigger wb_subscriptions_fill_interval before insert or update on public.wb_subscriptions
  for each row execute function public.wb_subscriptions_fill_interval();

-- ============================================================================
-- 2. wb_refresh_subscriptions: as in 120, the next date from the interval
-- ============================================================================
create or replace function public.wb_refresh_subscriptions(p_ids uuid[])
returns int
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  with last as (
    select s.id, s.interval_count, s.interval_unit, s.term_end_date,
           max((coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date) as last_on
    from public.wb_subscriptions s
    left join public.wb_transactions x on x.subscription_id = s.id and not x.pending
    where s.id = any (p_ids)
    group by s.id
  ),
  nxt as (
    select l.id, l.last_on,
           (case l.interval_unit
              when 'week'  then l.last_on + 7 * l.interval_count
              when 'month' then (l.last_on + make_interval(months => l.interval_count))::date
            end) as base,
           l.term_end_date
    from last l
  )
  update public.wb_subscriptions s
  set last_charged_on  = n2.last_on,
      next_expected_on = case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                              then n2.term_end_date else n2.base end
  from nxt n2
  where s.id = n2.id
    and (s.last_charged_on is distinct from n2.last_on
         or s.next_expected_on is distinct from
            case when n2.term_end_date is not null and (n2.base is null or n2.term_end_date > n2.base)
                 then n2.term_end_date else n2.base end);
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.wb_refresh_subscriptions(uuid[]) is
  'Warren Buffet: recompute last_charged_on and next_expected_on (last charge plus the billing interval, or term_end_date when later) for the given subscriptions, writing only rows that change. Security invoker.';

-- ============================================================================
-- 3. Backfill from cadence, validate, and refresh every row's dates
-- ============================================================================
update public.wb_subscriptions
set interval_count = case cadence when 'monthly' then 1 when 'quarterly' then 3 when 'annual' then 12 end,
    interval_unit  = 'month'
where cadence <> 'other' and interval_count is null;

alter table public.wb_subscriptions validate constraint wb_subscriptions_interval_check;

select public.wb_refresh_subscriptions(array(select id from public.wb_subscriptions));

-- ============================================================================
-- 4. wb_subscription_overview: as in 120, plus interval_count and interval_unit at the end
-- ============================================================================
create or replace view public.wb_subscription_overview
with (security_invoker = true) as
with today as (select (now() at time zone 'America/Los_Angeles')::date as d)
select
  s.id,
  s.name,
  s.plan,
  s.status,
  s.cadence,
  s.merchant_id,
  m.name                                                                    as merchant_name,
  coalesce(m.not_subscription, false)                                       as merchant_not_subscription,
  s.billed_through_id,
  bt.name                                                                   as billed_through_name,
  s.bundle_id,
  bu.name                                                                   as bundle_name,
  public.wb_subscription_price_on(s.id, today.d)                            as current_price,
  pr.previous_price,
  pr.last_change_on,
  pr.price_count,
  s.expected_amount,
  s.amount_tolerance,
  s.term_end_date,
  s.auto_renew,
  s.review_date,
  s.last_charged_on,
  s.next_expected_on,
  (select count(*) from public.wb_transactions x where x.subscription_id = s.id and not x.pending)::int as charge_count,
  -- A missing charge: active, more than 7 days past the expected date, and not
  -- inside a prepaid term (after the term, only when it renews).
  (s.status = 'active'
   and s.next_expected_on is not null
   and today.d > s.next_expected_on + 7
   and (s.term_end_date is null or (today.d > s.term_end_date and s.auto_renew is not false)))
                                                                            as overdue,
  case when s.next_expected_on is not null then today.d - s.next_expected_on end as days_past_expected,
  s.owner,
  s.notes,
  s.created_at,
  s.updated_at,
  s.interval_count,
  s.interval_unit
from public.wb_subscriptions s
cross join today
left join public.wb_merchants m on m.id = s.merchant_id
left join public.wb_subscriptions bt on bt.id = s.billed_through_id
left join public.wb_subscriptions bu on bu.id = s.bundle_id
left join lateral (
  select count(*)::int as price_count,
         (array_agg(p.amount order by p.effective_on desc))[2]       as previous_price,
         case when count(*) > 1 then max(p.effective_on) end          as last_change_on
  from public.wb_subscription_prices p
  where p.subscription_id = s.id and p.effective_on <= today.d
) pr on true;

comment on view public.wb_subscription_overview is
  'App: Warren Buffet. One row per subscription with merchant, billed-through and bundle names, current_price (today), previous_price and last_change_on, charge_count, the billing interval (interval_count, interval_unit), and overdue: active, more than 7 days past next_expected_on, and not before term_end_date (after it, only when auto_renew is not false). Cadence other with no interval has no next date and is never overdue. Missing charges live here, not in wb_review_queue. security_invoker, so wb_ RLS applies.';

grant select on public.wb_subscription_overview to authenticated, service_role;
grant execute on function public.wb_refresh_subscriptions(uuid[]) to authenticated, service_role;

commit;

-- ============================================================================
-- 5. Conformance and the backfill, as the SQL editor's result. Expect conformant
--    true, failures [], and by_cadence showing monthly 1 month, quarterly 3 month,
--    annual 12 month, and other with no interval. Then run 125_wb_phase2_step8_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t),
  'by_cadence', (select coalesce(json_agg(t), '[]'::json) from (
     select cadence, interval_count, interval_unit, count(*) as n
     from public.wb_subscriptions group by 1, 2, 3 order by 1, 2) t)
) as result;
