-- Purpose: Warren Buffet Phase 2, Step 7d. "Keep watching" for a detected subscription: new_recurring now skips a watching subscription whose newest charge is reviewed, so marking that charge reviewed clears the row until the next (unreviewed) charge brings it back. wb_transaction_list's needs_review follows the same rule. Nothing else changes; price_change is untouched.
-- Kind: schema change (two replaced views)
-- Applied: YES — 2026-10-12 by Alex ("Success. No rows returned"); 123 all 15 checks true.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4.8 and 4.9.
-- No real financial data in this file. Run as one block, then 123_wb_phase2_step7d_tests.sql.
-- supabase/migrations/122_wb_phase2_step7d_keep_watching.sql

begin;

-- ============================================================================
-- 1. wb_review_queue: as in 120, with new_recurring skipping a reviewed newest charge
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
  select b.transaction_id, 'no_kind'::text as reason, null::text as detail
  from base b
  where b.kind is null
  union all
  select b.transaction_id, 'missing_required_tag', g.name
  from base b
  join public.wb_tag_groups g on b.kind = any (g.required_for_kinds)
  where not b.pending
    and not b.reviewed
    and exists (
      select 1 from public.wb_splits s
      where s.transaction_id = b.transaction_id
        and not exists (select 1 from public.wb_split_tags st where st.split_id = s.id and st.group_id = g.id))
  union all
  select b.transaction_id, 'transfer_candidate', null
  from base b
  where b.transfer_candidate and b.transfer_pair_id is null and not b.pending and not b.reviewed
  union all
  select b.transaction_id, 'split_mismatch', format('%s split(s) sum to %s', coalesce(s.n, 0), coalesce(s.total, 0))
  from base b
  left join lateral (
    select count(*) as n, sum(sp.amount) as total from public.wb_splits sp where sp.transaction_id = b.transaction_id
  ) s on true
  where coalesce(s.n, 0) = 0 or s.total <> b.amount
  union all
  -- A charge on an active subscription that differs from its price by more than the tolerance.
  select b.transaction_id, 'price_change', format('%s: expected %s', s.name, p.price)
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
  select lc.id, 'new_recurring', s.name
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
  ), '{}'::text[]) as tag_names
from reasons r
join base b on b.transaction_id = r.transaction_id;

comment on view public.wb_review_queue is
  'App: Warren Buffet. One row per transaction and reason: no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch, price_change (detail = subscription and expected price; active subscriptions, cleared by recording the new price or marking reviewed) and new_recurring (detail = subscription; the newest charge of a watching subscription while it is unreviewed: "Keep watching" marks it reviewed, the next charge brings it back; confirming or dismissing ends it). Tag, transfer and price reasons cover posted, unreviewed rows only; split_mismatch shows even when reviewed. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 2. wb_transaction_list: as in 120, needs_review kept in step with new_recurring
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
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, and the linked subscription (subscription_id, subscription_source, subscription_name). No raw jsonb. security_invoker, so wb_ RLS applies.';

grant select on public.wb_review_queue     to authenticated, service_role;
grant select on public.wb_transaction_list to authenticated, service_role;

commit;
