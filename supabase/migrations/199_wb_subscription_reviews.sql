-- Purpose: Warren Buffet money chat, Step 15. Actionable subscription reviews: usage clues, a review history, the function that saves a review and moves the review date, and the new overview fields.
-- Kind: schema change (one new column, one new table, two new functions, one replaced view)
-- Applied: yes, run c4f317cb-8d51-4fde-b300-6c83e9d35926, Nov 3 2026
--
-- Spec: docs/technical-spec-warren_buffet_p4-r6d-money_chat.md sections 3 and 4.
-- Additive: the live tools and the app keep working before the new tools deploy.
-- Queue as one block, then supabase/tests/warren_buffet_p4-r6d/1_subscription_reviews_tests.sql, then check_platform_conformance.
-- supabase/migrations/199_wb_subscription_reviews.sql

begin;

-- ============================================================================
-- 1. Usage clues
-- ============================================================================
alter table public.wb_subscriptions add column if not exists usage_clues text;
comment on column public.wb_subscriptions.usage_clues is
  'Where and how to tell this subscription is used: which app, intention, tag or merchant to look at, and what counts as one use. Read by Claude during a review. Null means no clue yet, so Claude asks.';

-- ============================================================================
-- 2. The review history
-- ============================================================================
create table if not exists public.wb_subscription_reviews (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete restrict,
  context_id      text not null references public.contexts(id),
  subscription_id uuid not null references public.wb_subscriptions(id) on delete cascade,
  reviewed_on     date not null default ((now() at time zone 'America/Los_Angeles')::date),
  period_from     date,
  period_to       date,
  uses            integer,
  amount_paid     numeric(12,2),
  cost_per_use    numeric(12,2),
  verdict         text not null,
  market_check    text,
  next_review_on  date,
  notes           text,
  created_at      timestamptz not null default now(),

  constraint wb_subscription_reviews_verdict_check check (verdict in ('keep', 'downgrade', 'switch', 'shop_around', 'cancel')),
  constraint wb_subscription_reviews_period_check check (
    (period_from is null) = (period_to is null) and (period_to is null or period_to >= period_from)),
  constraint wb_subscription_reviews_uses_check check (uses is null or uses >= 0),
  constraint wb_subscription_reviews_amount_check check (amount_paid is null or amount_paid >= 0),
  constraint wb_subscription_reviews_cost_check check (cost_per_use is null or (cost_per_use >= 0 and uses > 0)),
  constraint wb_subscription_reviews_next_check check (
    (verdict = 'cancel' or next_review_on is not null) and (next_review_on is null or next_review_on > reviewed_on)),
  constraint wb_subscription_reviews_market_check check (
    market_check is null or (char_length(market_check) <= 300 and market_check !~ '[\r\n]'))
);

create index if not exists wb_subscription_reviews_latest_idx
  on public.wb_subscription_reviews (subscription_id, reviewed_on desc, created_at desc);

comment on table public.wb_subscription_reviews is
  'App: Warren Buffet. One row per review of a subscription: was it used, what it cost per use, the market check and the verdict. Saved by wb_record_subscription_review. Uses come only from a usage clue''s source or from Alex. A verdict changes nothing on the subscription: cancelling, downgrading or switching are separate calls. user_id and context_id are copied from the subscription by trigger.';
comment on column public.wb_subscription_reviews.id is 'Primary key.';
comment on column public.wb_subscription_reviews.user_id is 'Owner, copied from the subscription by trigger.';
comment on column public.wb_subscription_reviews.context_id is 'Household context, copied from the subscription by trigger.';
comment on column public.wb_subscription_reviews.subscription_id is 'The subscription reviewed. Its reviews go when it does.';
comment on column public.wb_subscription_reviews.reviewed_on is 'The Pacific date of the review. Two on one day are allowed; the newest created_at counts as the last.';
comment on column public.wb_subscription_reviews.period_from is 'First day of the period looked at. Set together with period_to.';
comment on column public.wb_subscription_reviews.period_to is 'Last day of the period looked at. Set together with period_from.';
comment on column public.wb_subscription_reviews.uses is 'Uses counted in the period, from a usage clue''s source or from Alex. Null means not countable; 0 means counted and unused.';
comment on column public.wb_subscription_reviews.amount_paid is 'Amount paid in the period, positive dollars like wb_subscription_prices. Null when unknown.';
comment on column public.wb_subscription_reviews.cost_per_use is 'amount_paid divided by uses, positive dollars. Null when uses is null or 0.';
comment on column public.wb_subscription_reviews.verdict is 'keep, downgrade, switch, shop_around or cancel.';
comment on column public.wb_subscription_reviews.market_check is 'One short dated line with its source: what a fair price looked like at this review. Null when none was done.';
comment on column public.wb_subscription_reviews.next_review_on is 'The date this review moved review_date to. Required unless the verdict is cancel, and after reviewed_on.';
comment on column public.wb_subscription_reviews.notes is 'Anything else worth keeping from the review.';
comment on column public.wb_subscription_reviews.created_at is 'When the row was saved.';

create or replace function public.wb_subscription_reviews_copy_owner()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select s.user_id, s.context_id into new.user_id, new.context_id
  from public.wb_subscriptions s
  where s.id = new.subscription_id;
  if not found then
    raise exception 'wb_subscription_reviews: subscription % not found', new.subscription_id using errcode = '23503';
  end if;
  return new;
end;
$$;
revoke all on function public.wb_subscription_reviews_copy_owner() from public, anon;

drop trigger if exists wb_subscription_reviews_copy_owner on public.wb_subscription_reviews;
create trigger wb_subscription_reviews_copy_owner before insert or update on public.wb_subscription_reviews
  for each row execute function public.wb_subscription_reviews_copy_owner();

-- ============================================================================
-- 3. Save a review and move the review date, together
-- ============================================================================
create or replace function public.wb_record_subscription_review(
  p_subscription_id uuid,
  p_verdict         text,
  p_next_review_on  date default null,
  p_reviewed_on     date default null,
  p_period_from     date default null,
  p_period_to       date default null,
  p_uses            integer default null,
  p_amount_paid     numeric default null,
  p_cost_per_use    numeric default null,
  p_market_check    text default null,
  p_notes           text default null
)
returns public.wb_subscription_reviews
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row public.wb_subscription_reviews;
begin
  if p_next_review_on is null and p_verdict is distinct from 'cancel' then
    raise exception 'wb_record_subscription_review: a next review date is required unless the verdict is cancel. Nothing was changed.'
      using errcode = '22023';
  end if;
  perform 1 from public.wb_subscriptions s where s.id = p_subscription_id for update;
  if not found then
    raise exception 'wb_record_subscription_review: no subscription % that you can see. Nothing was changed.', p_subscription_id
      using errcode = '22023';
  end if;

  insert into public.wb_subscription_reviews (
    subscription_id, context_id, reviewed_on, period_from, period_to, uses, amount_paid, cost_per_use,
    verdict, market_check, next_review_on, notes)
  select s.id, s.context_id, coalesce(p_reviewed_on, (now() at time zone 'America/Los_Angeles')::date),
         p_period_from, p_period_to, p_uses, p_amount_paid, p_cost_per_use,
         p_verdict, p_market_check, p_next_review_on, p_notes
  from public.wb_subscriptions s
  where s.id = p_subscription_id
  returning * into v_row;

  -- Only the review date moves. A cancel with no next date leaves it alone.
  if p_next_review_on is not null then
    update public.wb_subscriptions set review_date = p_next_review_on where id = p_subscription_id;
  end if;
  return v_row;
end;
$$;

comment on function public.wb_record_subscription_review(uuid, text, date, date, date, date, integer, numeric, numeric, text, text) is
  'App: Warren Buffet. Saves one subscription review and moves the subscription''s review_date to p_next_review_on, in one transaction. Requires a next date unless the verdict is cancel, and changes nothing else on the subscription. Security invoker, so wb_ RLS applies. Called by record_wb_subscription_review.';
revoke all on function public.wb_record_subscription_review(uuid, text, date, date, date, date, integer, numeric, numeric, text, text) from public, anon;
grant execute on function public.wb_record_subscription_review(uuid, text, date, date, date, date, integer, numeric, numeric, text, text) to authenticated;

-- ============================================================================
-- 4. wb_subscription_overview: as in 124, plus usage_clues, last_reviewed_on and last_verdict at the end
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
  s.interval_unit,
  s.usage_clues,
  lr.reviewed_on                                                            as last_reviewed_on,
  lr.verdict                                                                as last_verdict
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
) pr on true
left join lateral (
  select r.reviewed_on, r.verdict
  from public.wb_subscription_reviews r
  where r.subscription_id = s.id
  order by r.reviewed_on desc, r.created_at desc
  limit 1
) lr on true;

comment on view public.wb_subscription_overview is
  'App: Warren Buffet. One row per subscription with merchant, billed-through and bundle names, current_price (today), previous_price and last_change_on, charge_count, the billing interval (interval_count, interval_unit), usage_clues, the last review (last_reviewed_on, last_verdict; null when never reviewed), and overdue: active, more than 7 days past next_expected_on, and not before term_end_date (after it, only when auto_renew is not false). Cadence other with no interval has no next date and is never overdue. Missing charges live here, not in wb_review_queue. security_invoker, so wb_ RLS applies.';

select platform.grant_table('public.wb_subscription_overview');

-- ============================================================================
-- 5. Register with the platform, then the shared-context policy (mirrors intents)
-- ============================================================================
select platform.register_table(
  'public.wb_subscription_reviews',
  p_policy_mode => 'none',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Warren Buffet. One row per subscription review, with its verdict and market check. Owner OR shared-context RLS (mirrors intents).'
);

alter table public.wb_subscription_reviews enable row level security;

drop policy if exists wb_subscription_reviews_access on public.wb_subscription_reviews;
create policy wb_subscription_reviews_access on public.wb_subscription_reviews
  for all
  using      ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)))
  with check ((user_id = auth.uid()) or (context_id in (select id from public.contexts where shared = true)));

commit;
