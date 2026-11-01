-- Purpose: Warren Buffet Phase 4, Step 4 (run tag warren_buffet_p4-r6d-s4-c5rk; spec P4-D2, P4-D4). Adds wb_transactions.source ('sync' or 'history_import', default 'sync') and wb_accounts.history_from, exposes source on wb_transaction_list, and keeps imported rows out of wb_review_queue and needs_review, the card fee and interest flags, planned-match suggestions, wb_planned_start_from_history, and the rule-health findings merchant_no_category, too_broad and often_overridden. Imported rows still count for interval data. wb_process_transactions is unchanged: it reaches suggestions only through wb_suggest_planned_matches.
-- Kind: schema change (two new columns, four replaced views, three replaced functions)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D2 and P4-D4.
-- If what is left out changes, update "Imported history is left out" in src/money/helpText.js and its test.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p4/2_history_source_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/191_history_source.sql

begin;

-- ============================================================================
-- 1. The columns
-- ============================================================================
alter table public.wb_transactions add column if not exists source text not null default 'sync';
alter table public.wb_transactions drop constraint if exists wb_transactions_source_check;
alter table public.wb_transactions add constraint wb_transactions_source_check
  check (source in ('sync', 'history_import'));
comment on column public.wb_transactions.source is
  'sync = from SimpleFIN; history_import = from a history file (P4-D4), kept out of review, fee flags, planned matching and three rule-health findings.';

alter table public.wb_accounts add column if not exists history_from date;
comment on column public.wb_accounts.history_from is
  'The account''s earliest imported date (P4-D2). Null when no history was imported.';

-- ============================================================================
-- 2. wb_review_queue: as in 135, synced rows only (P4-D4)
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
  where x.source = 'sync'
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
  -- The newest synced charge of each detected (watching) subscription, until it is confirmed or
  -- dismissed. "Keep watching" marks that charge reviewed, which clears the row until the
  -- next charge (unreviewed) becomes the newest.
  select lc.id, 'new_recurring', s.name, null
  from public.wb_subscriptions s
  left join public.wb_merchants m on m.id = s.merchant_id
  cross join lateral (
    select x.id, x.reviewed from public.wb_transactions x
    where x.subscription_id = s.id and not x.pending and x.source = 'sync'
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
  'App: Warren Buffet. One row per synced transaction and reason (imported history never appears, P4-D4): no_kind, missing_required_tag (detail = group), transfer_candidate, split_mismatch, price_change (detail = subscription and expected price; active subscriptions, cleared by recording the new price or marking reviewed), new_recurring (detail = subscription; the newest synced charge of a watching subscription while it is unreviewed: "Keep watching" marks it reviewed, the next charge brings it back; confirming or dismissing ends it) and planned_match (one row per suggested planned match, detail = planned item and due date; planned_match_id and the planned_* and match_amount columns describe it; confirming or rejecting ends it). Tag, transfer and price reasons cover posted, unreviewed rows only; split_mismatch and planned_match show even when reviewed. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 3. wb_transaction_list: as in 140, needs_review false for imported rows, source at the end
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
    x.source = 'sync' and (
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
                    where y.subscription_id = sub.id and not y.pending and y.source = 'sync'
                    order by coalesce(y.posted_at, y.transacted_at) desc, y.id desc limit 1))
    or exists (select 1 from public.wb_planned_matches pm where pm.transaction_id = x.id and pm.status = 'suggested')
    )
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
  sub.name                                                                           as subscription_name,
  coalesce((
    select array_agg(distinct p.name order by p.name)
    from public.wb_splits s
    join public.wb_projects p on p.id = s.project_id
    where s.transaction_id = x.id
  ), '{}'::text[])                                                                   as project_names,
  x.source
from public.wb_transactions x
join public.wb_accounts a on a.id = x.account_id
left join public.wb_merchants m on m.id = x.merchant_id
left join public.wb_subscriptions sub on sub.id = x.subscription_id;

comment on view public.wb_transaction_list is
  'App: Warren Buffet. Transactions with account label, merchant name, tag_names (text[], filter with overlaps), split_count, needs_review (true when the row is in wb_review_queue, including a suggested planned match; always false for imported history), excluded_tags (tags removed by hand, which no rule puts back: tag_id, tag_name, rule_id, source, removed_at), notes, the linked subscription (subscription_id, subscription_source, subscription_name), project_names (text[], the projects on any of its splits), and source (sync or history_import). No raw jsonb. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 4. wb_suggest_planned_matches: as in 151, synced payments only (P4-D4)
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
        where not x.pending
          and x.source = 'sync'
          and (p_transaction_ids is null or x.id = any (p_transaction_ids))) t;
  -- Nothing to pair, but suggestions in scope that no longer fit must still go.
  if v_from is null then
    v_from := current_date;
    v_to := current_date;
  end if;

  -- Every pair that qualifies now: a posted split, same sign, amount within tolerance, date
  -- within the window, at the item's merchant; or, for an item with no merchant, any payment
  -- with no confirmed match that is not a transfer between our own accounts (A51). Drafts,
  -- cancelled and paid one-offs never qualify. Kept as jsonb so no temp table is needed.
  select coalesce(jsonb_agg(jsonb_build_object(
           'planned_item_id', pi.id,
           'occ', case when o.recurring then o.occurrence_on end,
           'split_id', s.id,
           'transaction_id', x.id,
           'applied', sign(pi.amount) * least(abs(s.amount), abs(pi.amount)),
           'ddiff', abs(c.d - o.occurrence_on),
           'adiff', abs(abs(s.amount) - abs(pi.amount)),
           -- A no-merchant item prefers a payment with no merchant (a check, a deposit, a transfer out of the household).
           'pref', case when pi.merchant_id is null and x.merchant_id is not null then 1 else 0 end,
           'by_merchant', pi.merchant_id is not null)), '[]'::jsonb)
  into v_pairs
  from public.wb_planned_occurrences(v_from, v_to, false) o
  join public.wb_planned_items pi on pi.id = o.planned_item_id
  join public.wb_transactions x
    on not x.pending
   and x.source = 'sync'
   and (x.merchant_id = pi.merchant_id
        or (pi.merchant_id is null
            and x.transfer_pair_id is null
            and not exists (select 1 from public.wb_planned_matches m
                            where m.transaction_id = x.id and m.status = 'confirmed')))
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where coalesce(pi.stage, '') <> 'paid'
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
  -- and the split not already fully confirmed or suggested elsewhere. Per occurrence the
  -- preferred payment, then the closest date, wins; per split an item at its merchant wins.
  with cands as (
    select p.*
    from jsonb_to_recordset(v_pairs) as p(planned_item_id uuid, occ date, split_id uuid, transaction_id uuid,
                                          applied numeric, ddiff int, adiff numeric, pref int, by_merchant boolean)
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
                                   order by o.pref, o.ddiff, o.adiff, o.transaction_id, o.split_id) as rn
    from cands o
  ),
  per_split as (
    select q.*, row_number() over (partition by q.split_id
                                   order by (not q.by_merchant), q.ddiff, q.adiff, q.planned_item_id, q.occ) as rn2
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
  'Warren Buffet: suggests planned matches for the given transactions and/or planned items (null = all). Imported history is never suggested (P4-D4). A posted split qualifies for a planned item''s due date when it has the same sign, its amount is within the item''s amount_tolerance (exact when 0) and its date within match_window_days, and it is at the item''s merchant; for an item with no merchant, any payment qualifies that has no confirmed match and is not a transfer between our own accounts (transfer_pair_id set), and payments with no merchant are preferred (A51). Drafts, cancelled and paid one-offs never qualify. A pair already suggested, confirmed or rejected is not suggested again; an occurrence already covered by confirmed matches (within its amount_tolerance, wb_planned_left), a split already fully confirmed, or either one already holding a suggestion, gets none; otherwise the preferred payment and then the closest date wins, one per occurrence, and one per split, where an item at the payment''s merchant comes first. amount_applied is the smaller of the two amounts. Suggestions in scope that no longer qualify are deleted. Called by wb_process_transactions and after planned-item writes. Security invoker. Returns suggested and removed counts.';

-- ============================================================================
-- 5. wb_planned_start_from_history: as in 140, synced payments only (P4-D4)
-- ============================================================================
create or replace function public.wb_planned_start_from_history(
  p_merchant_id      uuid,
  p_amount           numeric,
  p_amount_tolerance numeric default 0,
  p_today            date default null
)
returns date
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with t as (select coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date) as d),
  -- The first burn month, so every payment the burn rate counts is matched.
  w as (select coalesce((select min(b.month) from t, public.wb_burn_rate_on(t.d) b), t.d) as first_day, t.d from t)
  select min(c.d)
  from w
  join public.wb_transactions x on x.merchant_id = p_merchant_id and not x.pending and x.source = 'sync'
  cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
  join public.wb_splits s on s.transaction_id = x.id
  where p_merchant_id is not null
    and coalesce(p_amount, 0) <> 0
    and c.d between w.first_day and w.d
    and sign(s.amount) = sign(p_amount)
    and abs(abs(s.amount) - abs(p_amount)) <= coalesce(p_amount_tolerance, 0)
    -- A split already fully confirmed against other planned items is not this item's.
    and coalesce((select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                  where pm.split_id = s.id and pm.status = 'confirmed'), 0) < abs(s.amount);
$$;

comment on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) is
  'Warren Buffet: the date of the earliest posted, synced payment at the merchant (imported history is left out, P4-D4), with the amount''s sign and within the tolerance, from the first burn month (wb_burn_rate_on) to p_today, leaving out splits already fully confirmed against other planned items. Null when there is none, or no merchant. Used as the first due date of a new repeating item, so every payment the burn rate counts is matched (A34). Security invoker.';

-- ============================================================================
-- 6. wb_action_items: as in 158, fee flags and their refunds from synced rows only (P4-D4)
-- ============================================================================
create or replace function public.wb_action_items(
  p_days       int     default 14,
  p_big_amount numeric default 1000,
  p_big_days   int     default 60,
  p_today      date    default null
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  -- If you change 14, 1000 or 60 (the defaults above), 90, 30, 2 or 7, update the Overview help entries
  -- in src/money/helpText.js and ruleNumbers.js (ACTION_*, CASH_FLOW_DAYS and FUNDS_TRANSFER_DAYS), and their test.
  c_flag_days     constant int := 90;   -- card fees and interest looked back over (A53)
  c_manual_stale  constant int := 30;   -- a hand-entered balance older than this needs checking
  c_synced_stale  constant int := 2;    -- as STALE_ACCOUNT_DAYS in moneyFormat.js
  c_sub_grace     constant int := 7;    -- as wb_subscription_overview.overdue (OVERDUE_GRACE_DAYS)
  c_flow_days     constant int := 30;   -- the Cash flow card's two windows, back and ahead
  c_move_days     constant int := 30;   -- the funds transfer window: the lowest balance in the next 30 days (A58)
  c_title_max     constant int := 120;
  -- A title that stops mid-line (A57), as UNFINISHED in src/money/OverviewScreen.jsx.
  c_unfinished    constant text := '([,;:–—-]|\m(and|or|but|to|the|of|with|for|a|an|if|so|then|because|on|in|at|by|from))\s*$';
  -- A credit that is a card payment, whatever kind processing gave it (A58).
  c_payment_words constant text := '(payment|thank you|autopay|autopmt|pymt)';
  c_money         constant text := 'muvitejhrgt3rgi8t6q';
  v_today   date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_flags   jsonb := '[]';
  v_cards   jsonb := '[]';
  v_attn    jsonb := '[]';
  v_below   jsonb;
  v_cash    jsonb;
  v_row     jsonb;
  v_path    jsonb;
  v_causes  jsonb;
  card      record;
  v_close   date;
  v_due     date;
  v_owed    numeric;
  v_paid    numeric;
  v_month   date;
  v_floor   numeric;
  v_first   record;
  v_low30   record;
  v_low     record;
  v_last30  numeric;
  v_next30  numeric;
  v_typical numeric;
  run       record;
begin
  -- ---------------------------------------------------------------- card bills
  for card in
    select a.id, coalesce(a.display_name, a.name) as label, a.statement_close_day, a.payment_due_day, a.autopay
    from public.wb_accounts a
    where a.role = 'credit_card' and not coalesce(a.is_hidden, false)
    order by 2
  loop
    if card.statement_close_day is null or card.payment_due_day is null then
      v_cards := v_cards || jsonb_build_object(
        'type', 'card_days_missing', 'severity', 'amber',
        'title', format('Set %s''s statement and due days', card.label),
        'todo', 'Tell Claude the day the statement closes and the day payment is due (both on the statement), and whether autopay is on.',
        'amount', null, 'on', null, 'link_kind', 'account', 'link_id', card.id);
      continue;
    end if;
    -- The last close day on or before today, then the first due day after it (short months use their last day).
    v_month := date_trunc('month', v_today)::date;
    v_close := v_month + (least(card.statement_close_day, extract(day from (v_month + interval '1 month - 1 day'))::int) - 1);
    if v_close > v_today then
      v_month := (v_month - interval '1 month')::date;
      v_close := v_month + (least(card.statement_close_day, extract(day from (v_month + interval '1 month - 1 day'))::int) - 1);
    end if;
    v_month := date_trunc('month', v_close)::date;
    v_due := v_month + (least(card.payment_due_day, extract(day from (v_month + interval '1 month - 1 day'))::int) - 1);
    if v_due <= v_close then
      v_month := (v_month + interval '1 month')::date;
      v_due := v_month + (least(card.payment_due_day, extract(day from (v_month + interval '1 month - 1 day'))::int) - 1);
    end if;

    select -least(bs.balance, 0) into v_owed
    from public.wb_balance_snapshots bs
    where bs.account_id = card.id and bs.as_of <= v_close
    order by bs.as_of desc limit 1;
    if v_owed is null then
      v_cards := v_cards || jsonb_build_object(
        'type', 'card_bill_unknown', 'severity', 'info',
        'title', format('%s: no balance from the %s statement yet', card.label, to_char(v_close, 'Mon FMDD')),
        'todo', 'Nothing to do: the bill shows once a balance from the statement date has synced.',
        'amount', null, 'on', v_due, 'link_kind', 'account', 'link_id', card.id);
      continue;
    end if;
    continue when v_owed = 0;

    -- Payments to the card since the close. A refund is not a payment (A58), unless it reads like one.
    select coalesce(sum(x.amount), 0) into v_paid
    from public.wb_transactions x
    where x.account_id = card.id and not x.pending and x.amount > 0
      and (coalesce(x.kind, '') <> 'refund' or concat_ws(' ', x.description, x.payee) ~* c_payment_words)
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date > v_close
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date <= v_today;
    continue when v_paid >= v_owed;

    v_row := jsonb_build_object(
      'type', 'card_bill',
      'severity', case when v_due < v_today then 'red' when v_due <= v_today + p_days then 'amber' else 'info' end,
      'title', case when v_due < v_today then format('%s bill is past due', card.label)
                    else format('Pay %s by %s', card.label, to_char(v_due, 'Mon FMDD')) end,
      'todo', case when card.autopay = 'full' then 'Autopay pays the full balance; check it went through.'
                   when card.autopay = 'minimum' then 'Autopay pays only the minimum: pay the rest by hand to avoid interest.'
                   else 'Pay the statement balance from checking by the due date.' end,
      'amount', -round(v_owed - v_paid, 2), 'on', v_due, 'link_kind', 'account', 'link_id', card.id,
      'statement_on', v_close, 'statement_balance', -round(v_owed, 2), 'paid_since', round(v_paid, 2),
      'autopay', card.autopay);
    -- A past-due bill is a flag, and only a flag (A58).
    if v_due < v_today then
      v_flags := v_flags || v_row;
    else
      v_cards := v_cards || v_row;
    end if;
  end loop;

  -- ---------------------------------------------------------------- flags: card interest and fees (A53, A58)
  -- Looked back c_flag_days. A flag clears only when the charge is marked handled: reviewed, with a
  -- note (the transaction page's own fields). A refund turns a flag info but never clears it alone. A
  -- refund is a refund-kind credit of the same amount on the same card, on or after the fee: never a
  -- paired transfer or a payment, and each credit refunds one fee at most (paired in date order).
  -- Imported history is left out of both sides, so it cannot shift that pairing (P4-D4).
  v_flags := (
    with fees as (
      select x.id, x.account_id, x.amount, x.description, x.clean_description, x.notes, x.reviewed, c.d,
             coalesce(a.display_name, a.name) as label,
             row_number() over (partition by x.account_id, x.amount order by c.d, x.id) as rn
      from public.wb_transactions x
      join public.wb_accounts a on a.id = x.account_id
      cross join lateral (select (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
      where a.role in ('credit_card', 'emergency_credit')
        and not x.pending and x.amount < 0
        and x.source = 'sync'
        and c.d between v_today - c_flag_days and v_today
        and concat_ws(' ', x.description, x.payee) ~* '(interest charge|finance charge|late fee|late payment|annual fee|over ?limit fee|returned payment)'
    ),
    credits as (
      select r.id, r.account_id, r.amount, c.d,
             row_number() over (partition by r.account_id, r.amount order by c.d, r.id) as rn
      from public.wb_transactions r
      cross join lateral (select (coalesce(r.posted_at, r.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
      where not r.pending and r.amount > 0
        and r.source = 'sync'
        and r.transfer_pair_id is null
        and coalesce(r.kind, '') = 'refund'
        and concat_ws(' ', r.description, r.payee) !~* c_payment_words
        and r.account_id in (select f.account_id from fees f)
    )
    select coalesce(jsonb_agg(z.f order by z.f ->> 'on' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'type', 'card_charge', 'severity', case when cr.id is null then 'red' else 'info' end,
               'title', format('%s on %s', initcap(coalesce(nullif(x.clean_description, ''), x.description)), x.label),
               'todo', case when cr.id is null
                            then 'A card charged interest or a fee. Check the due date was not missed, and pay in full to stop it. When it is dealt with, write a note on the charge and tick Reviewed.'
                            else 'The refund came. Write a note on the charge and tick Reviewed to clear this.' end,
               'note', nullif(btrim(x.notes), ''),
               'refund', case when cr.id is not null then jsonb_build_object(
                           'amount', cr.amount, 'on', cr.d, 'link_kind', 'transaction', 'link_id', cr.id) end,
               'amount', x.amount,
               'on', x.d,
               'link_kind', 'transaction', 'link_id', x.id) as f
      from fees x
      left join credits cr on cr.account_id = x.account_id and cr.amount = -x.amount and cr.rn = x.rn and cr.d >= x.d
      where not (x.reviewed and nullif(btrim(x.notes), '') is not null)
    ) z
  ) || v_flags;

  -- ---------------------------------------------------------------- needs attention
  select r.status, r.started_at, r.error_message into run
  from public.platform_runs r
  where r.app = 'warren_buffet'
  order by r.started_at desc limit 1;
  if found and run.status not in ('ok', 'running') then
    v_attn := v_attn || jsonb_build_object(
      'type', 'sync_problem', 'severity', 'red',
      'title', format('Bank sync %s', replace(run.status, '_', ' ')),
      'todo', case when coalesce(run.error_message, '') ~* '(attention|auth|sign ?in|log ?in|credential)'
                   then 'Sign in to that bank again in SimpleFIN Bridge.'
                   else 'Check the bank connections in SimpleFIN Bridge.' end,
      'detail', run.error_message, 'amount', null, 'on', (run.started_at at time zone 'America/Los_Angeles')::date,
      'link_kind', null, 'link_id', null);
  end if;

  v_attn := v_attn || (
    select coalesce(jsonb_agg(r order by r ->> 'title'), '[]'::jsonb)
    from (
      -- A synced account with no new balance for days.
      select jsonb_build_object('type', 'stale_synced', 'severity', 'amber',
               'title', format('%s not updated for %s days', l.label, v_today - l.as_of),
               'todo', 'Check its connection in SimpleFIN Bridge.',
               'amount', null, 'on', l.as_of, 'link_kind', 'account', 'link_id', l.account_id) as r
      from public.wb_account_latest l
      where l.source = 'simplefin' and not coalesce(l.is_hidden, false) and coalesce(l.role, '') <> 'closed'
        and l.as_of is not null and v_today - l.as_of >= c_synced_stale
      union all
      -- A hand-entered balance that is old, or was never entered.
      select jsonb_build_object('type', case when l.as_of is null then 'manual_no_balance' else 'stale_manual' end,
               'severity', 'amber',
               'title', case when l.as_of is null then format('%s has no balance yet', l.label)
                             else format('%s balance is %s days old', l.label, v_today - l.as_of) end,
               'todo', case when l.role = 'rewards' then format('Check the %s balance and tell Claude the new number.', coalesce(l.reward_unit, 'rewards'))
                            else 'Look up the balance and tell Claude the new number.' end,
               'amount', null, 'on', l.as_of, 'link_kind', 'account', 'link_id', l.account_id)
      from public.wb_account_latest l
      where l.source = 'manual' and not coalesce(l.is_hidden, false) and coalesce(l.role, '') not in ('closed', 'history_rollup')
        and (l.as_of is null or v_today - l.as_of > c_manual_stale)
      union all
      select jsonb_build_object('type', 'no_role', 'severity', 'amber',
               'title', format('%s has no role', coalesce(a.display_name, a.name)),
               'todo', 'Give it a role so it counts in net worth and free cash.',
               'amount', null, 'on', null, 'link_kind', 'account', 'link_id', a.id)
      from public.wb_accounts a
      where coalesce(a.role, 'unassigned') = 'unassigned' and not coalesce(a.is_hidden, false)
      union all
      select jsonb_build_object('type', 'subscription_review', 'severity', 'amber',
               'title', format('Review %s', s.name),
               'todo', format('Its review date has passed%s. Keep it, or cancel before it renews.',
                              case when s.next_expected_on is not null then format('; it renews %s', to_char(s.next_expected_on, 'Mon FMDD')) else '' end),
               'amount', -s.current_price, 'on', s.next_expected_on, 'link_kind', 'subscription', 'link_id', s.id)
      from public.wb_subscription_overview s
      where s.status = 'active' and s.review_date is not null and s.review_date <= v_today
      union all
      select jsonb_build_object('type', 'subscription_watching', 'severity', 'info',
               'title', format('Is %s a subscription?', s.name),
               'todo', 'Confirm it or dismiss it.',
               'amount', -s.current_price, 'on', s.last_charged_on, 'link_kind', 'subscription', 'link_id', s.id)
      from public.wb_subscription_overview s
      where s.status = 'watching'
      union all
      select jsonb_build_object('type', 'rule_health', 'severity', 'info',
               'title', format('Rule %s: %s', coalesce(h.rule_name, h.merchant_name), replace(h.finding, '_', ' ')),
               'todo', 'Ask Claude to look at it in the weekly cleanup.',
               'detail', h.detail, 'amount', null, 'on', null,
               'link_kind', case when h.merchant_id is not null then 'merchant' end, 'link_id', h.merchant_id)
      from public.wb_rule_health h
    ) x
  );

  -- ---------------------------------------------------------------- below the floor (A49, A58): read the projection, copy none of it
  -- The amount to move is the shortfall at the lowest projected balance in the next c_move_days days
  -- (today through today + c_move_days - 1), by the first day below. Shown only when the balance goes
  -- below the floor within those days; first_below_on is null otherwise.
  select s.safety_floor into v_floor from public.wb_settings s order by s.created_at limit 1;
  select * into v_low from public.wb_free_cash(false, v_today);
  if v_floor is null then
    v_below := jsonb_build_object('floor_missing', true, 'floor', null, 'window_days', c_move_days,
      'first_below_on', null, 'shortfall_30d', null, 'causes', '[]'::jsonb, 'path', '[]'::jsonb,
      'todo', 'Ask Claude to set a safety floor; until then nothing is checked against it.');
  else
    select p.day, p.closing into v_first
    from public.wb_cash_projection(false, v_today) p
    where p.day < v_today + c_move_days and p.closing < v_floor
    order by p.day limit 1;
    select p.day, p.closing into v_low30
    from public.wb_cash_projection(false, v_today) p
    where p.day < v_today + c_move_days
    order by p.closing, p.day limit 1;

    if v_first.day is not null then
      -- The path to the lowest day (A53): the starting balance, then every planned item, deposit and
      -- subscription charge in date order, and the burn rate as one row per week. balance is the
      -- projection's closing that day; below marks a balance under the floor. The planned rows are the
      -- projection's own: due dates less what is confirmed or suggested, an overdue one-off on today, and
      -- a late repeating date on today (A58).
      v_path := (
        with proj as (
          select p.day, p.opening, p.closing, p.burn
          from public.wb_cash_projection(false, v_today) p
          where p.day <= v_low30.day
        ),
        ev as (
          select o.occurrence_on as d, pi.name as title, public.wb_planned_left(o.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status in ('confirmed', 'suggested')
                     and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
                   pi.amount_tolerance) as amount,
                 'planned' as type, 'planned_item' as link_kind, pi.id::text as link_id, 1 as ord
          from public.wb_planned_occurrences(v_today, v_low30.day, false) o
          join public.wb_planned_items pi on pi.id = o.planned_item_id
          where o.recurring or o.stage <> 'paid'
          union all
          select v_today, pi.name || ' (overdue)', public.wb_planned_left(pi.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = pi.id and pm.status in ('confirmed', 'suggested')), pi.amount_tolerance),
                 'planned', 'planned_item', pi.id::text, 1
          from public.wb_planned_items pi
          where pi.interval_count is null and pi.due_on < v_today
            and pi.stage not in ('paid', 'cancelled', 'draft')
          union all
          select v_today, pi.name || ' (late)', public.wb_planned_left(o.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status in ('confirmed', 'suggested')
                     and pm.occurrence_on = o.occurrence_on), pi.amount_tolerance),
                 'planned', 'planned_item', pi.id::text, 1
          from public.wb_planned_occurrences(v_today - 366, v_today - 1, false) o
          join public.wb_planned_items pi on pi.id = o.planned_item_id
          where o.recurring and v_today - o.occurrence_on <= pi.match_window_days
            and not exists (select 1 from public.wb_planned_skips sk
                            where sk.planned_item_id = o.planned_item_id and sk.occurrence_on = o.occurrence_on)
          union all
          select so.occurrence_on, so.name, so.amount, 'subscription', 'subscription', so.subscription_id::text, 1
          from public.wb_subscription_occurrences(v_today, v_low30.day, v_today) so
          union all
          -- One row per week from today, on the week's last day (or the lowest day).
          select max(pr.day), 'Everyday spending at the burn rate', round(sum(pr.burn), 2), 'burn', null, null, 2
          from proj pr
          group by (pr.day - v_today) / 7
        )
        select jsonb_build_array(jsonb_build_object(
                 'type', 'start', 'title', 'Starting balance', 'amount', null, 'on', v_today,
                 'balance', (select pr.opening from proj pr where pr.day = v_today),
                 'below', (select pr.opening < v_floor from proj pr where pr.day = v_today),
                 'link_kind', null, 'link_id', null))
               || coalesce(jsonb_agg(jsonb_build_object(
                    'type', e.type, 'title', e.title, 'amount', e.amount, 'on', e.d, 'balance', pr.closing,
                    'below', pr.closing < v_floor, 'link_kind', e.link_kind, 'link_id', e.link_id)
                  order by e.d, e.ord, e.amount, e.title), '[]'::jsonb)
        from ev e
        join proj pr on pr.day = e.d
        where e.amount <> 0);
      -- The causes are the path's payments out, and the burn over the same days as one row (A58).
      v_causes := (
        select coalesce(jsonb_agg(c order by (c ->> 'amount')::numeric), '[]'::jsonb)
        from (
          select e as c from jsonb_array_elements(v_path) e
          where e ->> 'type' in ('planned', 'subscription') and (e ->> 'amount')::numeric < 0
          union all
          select jsonb_build_object('type', 'burn', 'title', 'Everyday spending at the burn rate',
                   'amount', sum((e ->> 'amount')::numeric), 'on', null, 'link_kind', null, 'link_id', null)
          from jsonb_array_elements(v_path) e
          where e ->> 'type' = 'burn'
          having sum((e ->> 'amount')::numeric) < 0
        ) z);
    end if;

    v_below := jsonb_build_object(
      'floor_missing', false,
      'floor', v_floor,
      'window_days', c_move_days,
      'first_below_on', v_first.day,
      'closing_then', v_first.closing,
      'low_30d_on', case when v_first.day is not null then v_low30.day end,
      'low_30d_balance', case when v_first.day is not null then v_low30.closing end,
      'shortfall_30d', case when v_first.day is not null then round(v_floor - v_low30.closing, 2) end,
      'reserve_balance', v_low.reserve_cash,
      'severity', case when v_first.day is null then 'info' when v_first.day <= v_today + p_days then 'red' else 'amber' end,
      'todo', case when v_first.day is null
                   then format('Nothing to do: the projection stays above the floor for the next %s days.', c_move_days)
                   else format('Move %s from the reserve by %s, or delay one of the payments listed.',
                               to_char(round(v_floor - v_low30.closing, 2), 'FM$999,999,999,990.00'),
                               to_char(v_first.day, 'Mon FMDD')) end,
      'causes', coalesce(v_causes, '[]'::jsonb),
      'path', coalesce(v_path, '[]'::jsonb));
  end if;

  -- ---------------------------------------------------------------- cash flow (A52): in less out, back, ahead and typical
  -- Settled rows on spending-cash and card accounts in the last c_flow_days days (today included),
  -- leaving out transfers between our own accounts: a paired transfer, or a transfer received on a card.
  select coalesce(sum(x.amount), 0) into v_last30
  from public.wb_transactions x
  join public.wb_accounts a on a.id = x.account_id
  where a.role in ('spending_cash', 'credit_card')
    and not x.pending
    and x.transfer_pair_id is null
    and not (a.role = 'credit_card' and coalesce(x.kind, '') = 'transfer')
    and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date
        between v_today - (c_flow_days - 1) and v_today;
  -- The projection's change over the next c_flow_days days, today included (A58): its closing on the
  -- last of those days less its opening today (no drafts).
  select max(p.closing) filter (where p.day = v_today + c_flow_days - 1) - max(p.opening) filter (where p.day = v_today)
  into v_next30
  from public.wb_cash_projection(false, v_today) p;
  select t.net_monthly into v_typical from public.wb_true_cost t;
  v_cash := jsonb_build_object(
    'days', c_flow_days,
    'last_30_actual', round(v_last30, 2),
    'next_30_projected', round(v_next30, 2),
    'typical_month', round(v_typical, 2),
    'reserve_balance', v_low.reserve_cash,
    'runway_months', case when v_typical < 0 and v_low.reserve_cash is not null
                          then round(v_low.reserve_cash / -v_typical, 1) end);

  return jsonb_build_object(
    'today', v_today, 'days', p_days, 'big_amount', p_big_amount, 'big_days', p_big_days,
    'flags', v_flags,

    'reconcile', (
      select coalesce(jsonb_agg(r order by r ->> 'type'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'reconcile_' || q.reason, 'severity', 'amber',
                 'title', format('%s %s', count(*),
                   case q.reason
                     when 'no_kind' then 'not processed yet'
                     when 'missing_required_tag' then 'need a category'
                     when 'transfer_candidate' then 'look like transfers'
                     when 'split_mismatch' then 'have parts that do not add up'
                     when 'price_change' then 'subscription price changes'
                     when 'new_recurring' then 'new repeating charges'
                     when 'planned_match' then 'suggested matches to confirm'
                     else replace(q.reason, '_', ' ') end),
                 'todo', 'Open Review and work through them.',
                 'count', count(*), 'amount', null, 'on', null, 'link_kind', 'review_reason', 'link_id', q.reason) as r
        from public.wb_review_queue q
        group by q.reason
      ) x),

    -- Overdue: past the item's match window, or a charge more than c_sub_grace days late. Anything
    -- past due but not yet that late stays in coming_up, marked late (A51).
    'overdue', (
      select coalesce(jsonb_agg(r order by r ->> 'on'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', case when u.recurring then 'missed_date' else 'overdue_one_off' end,
                 'severity', 'amber',
                 'title', format('%s, due %s', u.name, to_char(u.due_on, 'Mon FMDD')),
                 'todo', case when u.has_suggestion then 'A match is waiting in Review: confirm it.'
                              else 'Match the payment, or ask Claude to mark the date Not needed.' end,
                 'amount', u.remaining, 'on', u.due_on, 'link_kind', 'planned_item', 'link_id', u.planned_item_id) as r
        from public.wb_planned_unmatched u
        where not u.within_window
        union all
        select jsonb_build_object('type', 'overdue_subscription', 'severity', 'amber',
                 'title', format('%s charge is %s days late', s.name, s.days_past_expected),
                 'todo', 'Check the charge was made, or update when it next bills.',
                 'amount', -s.current_price, 'on', s.next_expected_on, 'link_kind', 'subscription', 'link_id', s.id)
        from public.wb_subscription_overview s
        where s.overdue
      ) x),

    -- big: money out larger than p_big_amount, so the app and Claude can bold it (A52). A one-off at
    -- stage paid is never coming due (A58), as in the projection.
    'coming_up', (
      select coalesce(jsonb_agg(r order by r ->> 'on', r ->> 'title'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', case when o.recurring then 'planned_repeating' else 'planned_one_off' end,
                 'severity', 'info', 'title', pi.name, 'late', false,
                 'big', z.left_amt < 0 and -z.left_amt > p_big_amount,
                 'todo', case when pi.merchant_id is null and o.amount > 0 then 'Deposit it; it will be matched once it posts.'
                              when pi.merchant_id is null then 'Pay it; it will be matched once it posts.'
                              else 'It will be matched once the payment posts.' end,
                 'amount', z.left_amt, 'on', o.occurrence_on, 'link_kind', 'planned_item', 'link_id', pi.id) as r
        from public.wb_planned_occurrences(v_today, v_today + p_days, false) o
        join public.wb_planned_items pi on pi.id = o.planned_item_id
        cross join lateral (select public.wb_planned_left(o.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
                     and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
                   pi.amount_tolerance) as left_amt) z
        where z.left_amt <> 0 and (o.recurring or o.stage <> 'paid')
        union all
        -- Past due, still inside the match window: late, not yet overdue.
        select jsonb_build_object('type', case when u.recurring then 'planned_repeating' else 'planned_one_off' end,
                 'severity', 'amber', 'late', true,
                 'big', u.remaining < 0 and -u.remaining > p_big_amount,
                 'title', format('%s (late, due %s)', u.name, to_char(u.due_on, 'Mon FMDD')),
                 'todo', case when u.has_suggestion then 'A match is waiting in Review: confirm it.'
                              when u.merchant_id is null and u.amount > 0 then 'Deposit it; it will be matched once it posts.'
                              when u.merchant_id is null then 'Pay it; it will be matched once it posts.'
                              else 'The payment may still post; it will be matched once it does.' end,
                 'amount', u.remaining, 'on', u.due_on, 'link_kind', 'planned_item', 'link_id', u.planned_item_id)
        from public.wb_planned_unmatched u
        where u.within_window
        union all
        select jsonb_build_object('type', 'subscription',
                 'severity', case when so.overdue_charge then 'amber' else 'info' end,
                 'late', so.overdue_charge,
                 'big', so.amount < 0 and -so.amount > p_big_amount,
                 'title', so.name || case when so.overdue_charge then format(' (late, due %s)', to_char(ws.next_expected_on, 'Mon FMDD')) else '' end,
                 'todo', case when so.overdue_charge then format('The charge has not shown yet and may still post; after %s days it counts as overdue.', c_sub_grace)
                              else 'Nothing to do unless you mean to cancel it first.' end,
                 'amount', so.amount, 'on', case when so.overdue_charge then ws.next_expected_on else so.occurrence_on end,
                 'link_kind', 'subscription', 'link_id', so.subscription_id)
        from public.wb_subscription_occurrences(v_today, v_today + p_days, v_today) so
        join public.wb_subscriptions ws on ws.id = so.subscription_id
        where not (so.overdue_charge and v_today > ws.next_expected_on + c_sub_grace)
      ) x),

    'big_bites', (
      select coalesce(jsonb_agg(r order by r ->> 'on', r ->> 'title'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'planned', 'severity', case when o.occurrence_on <= v_today + p_days then 'amber' else 'info' end,
                 'title', pi.name, 'what_if', o.is_draft,
                 'todo', case when o.is_draft then 'A what-if, not counted in free cash: decide before the date.'
                              else 'Make sure the cash is there by the date.' end,
                 'amount', z.left_amt, 'on', o.occurrence_on, 'link_kind', 'planned_item', 'link_id', pi.id,
                 'project_id', pi.project_id) as r
        from public.wb_planned_occurrences(v_today, v_today + p_big_days, true) o
        join public.wb_planned_items pi on pi.id = o.planned_item_id
        cross join lateral (select public.wb_planned_left(o.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
                     and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
                   pi.amount_tolerance) as left_amt) z
        where z.left_amt < 0 and -z.left_amt > p_big_amount and (o.recurring or o.stage <> 'paid')
        union all
        select jsonb_build_object('type', 'subscription', 'severity', case when so.occurrence_on <= v_today + p_days then 'amber' else 'info' end,
                 'title', so.name, 'what_if', false, 'todo', 'Make sure the cash is there by the date.',
                 'amount', so.amount, 'on', so.occurrence_on, 'link_kind', 'subscription', 'link_id', so.subscription_id)
        from public.wb_subscription_occurrences(v_today, v_today + p_big_days, v_today) so
        where -so.amount > p_big_amount
      ) x),

    'card_bills', v_cards,
    'needs_attention', v_attn,

    -- Alfred's own tables, read through their RLS like any other select. A title that stops mid-line
    -- ends with "…" (A57), as one cut at c_title_max does.
    'money_intentions', (
      select coalesce(jsonb_agg(r order by (r ->> 'severity') = 'amber' desc, r ->> 'title'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'intention', 'severity', case when i.status = 'active' then 'amber' else 'info' end,
                 'title', case when i.text ~* c_unfinished then rtrim(i.text) || '…' else i.text end,
                 'todo', 'Open it in Alfred.', 'status', i.status,
                 'amount', null, 'on', i.target_start_date, 'link_kind', 'intention', 'link_id', i.id) as r
        from public.intents i
        where i.context_id = c_money and i.is_intention is true and not coalesce(i.archived, false) and i.status <> 'closed'
      ) x),
    'money_inbox', (
      select coalesce(jsonb_agg(r order by r ->> 'on' desc), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'inbox_item', 'severity', 'info',
                 'title', case when length(t.full_title) > c_title_max then left(t.full_title, c_title_max - 1) || '…'
                               when t.full_title ~* c_unfinished then rtrim(t.full_title) || '…'
                               else t.full_title end,
                 'todo', 'Triage it in the inbox.',
                 'amount', null, 'on', (b.created_at at time zone 'America/Los_Angeles')::date,
                 'link_kind', 'inbox_item', 'link_id', b.id) as r
        from public.inbox b
        cross join lateral (select coalesce(nullif(b.suggested_intent_text, ''), b.captured_text) as full_title) t
        where b.suggested_context_id = c_money and not coalesce(b.archived, false)
      ) x),

    'below_floor', v_below,
    'cash_flow', v_cash
  );
end;
$$;

comment on function public.wb_action_items(int, numeric, int, date) is
  'Warren Buffet: the money to-do list, one JSON object (spec A49 to A53, A57, A58). Sections: flags (card interest and fees in the last 90 days, synced rows only (P4-D4), red until the charge is reviewed with a note (shown as note), when it clears; a synced refund-kind credit of the same amount on that card, used once and never a transfer or a payment, turns it info with refund (amount, on, link) but does not clear it; and a card bill past due and unpaid, which is then left out of card_bills), reconcile (review queue counts by reason), overdue (wb_planned_unmatched past the match window, and subscriptions more than 7 days late), coming_up (planned items less what is covered, A45, never a one-off at stage paid, and subscriptions, in the next p_days; dates past due but not yet overdue come first, with late true and amber; big true for money out over p_big_amount), big_bites (payments out of more than p_big_amount in the next p_big_days, what-ifs included and marked, no paid one-offs), card_bills (from statement_close_day, payment_due_day and autopay: the balance on the last close day less card payments since, refunds not counted; a card with no days set asks for them), needs_attention (sync problems, stale or missing balances, subscriptions to review or confirm, accounts with no role, rule health), money_intentions and money_inbox (Alfred records in the Money context, as RLS allows; a title longer than 120 characters is cut, and a title that stops mid-line is kept, both ending with an ellipsis), below_floor (when the projection goes below the safety floor in the next 30 days, window_days: first_below_on, the "by" date, and closing_then; low_30d_on and low_30d_balance, the lowest day in those 30 days; shortfall_30d, the amount to move from the reserve, floor less that low; path, the starting balance, every dated event and a weekly burn row up to the low day, each with the projected balance after it and below when it is under the floor; causes, the path''s payments out and its burn; first_below_on and shortfall_30d are null when the 30 days stay above the floor), and cash_flow (money in less money out: last_30_actual from settled spending-cash and card rows, leaving out paired transfers and transfers received on a card; next_30_projected, the projection''s change over the next 30 days, today included; typical_month, wb_true_cost.net_monthly; runway_months, the reserve over a monthly shortfall, null when typical_month is not negative). Every row has type, severity (red, amber, info), title, todo, amount, on and a link (link_kind, link_id). Security invoker; read by the app and get_wb_action_items.';

-- ============================================================================
-- 7. wb_rule_health_all: as in 190, three findings from synced rows only (P4-D4)
-- ============================================================================
create or replace view public.wb_rule_health_all
with (security_invoker = true) as
with findings as (
  with
  today as (select (now() at time zone 'America/Los_Angeles')::date as d),
  -- never_fires numbers (A16, A54, A55, P4-D1): flagged once the quiet days exceed both factor x the expected
  -- interval and floor_days; the interval falls back to annual_days or quarter_days from notes, then default_days.
  params as (select 1.5::numeric as factor, 30 as floor_days, 30 as default_days, 91 as quarter_days, 365 as annual_days,
                    3 as min_charges, 10 as week_gap_days, 17 as two_week_gap_days),
  rule_merchant as (
    select r.*, (r.match ->> 'merchant_id')::uuid as merchant_id
    from public.wb_rules r
    where r.active
  ),
  -- Imported rows stay here for the interval; overrides and of_n read the synced ones (P4-D4).
  hits as (
    select r.id as rule_id, x.id as transaction_id, x.kind, x.kind_source, x.source,
           (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
    from rule_merchant r
    join public.wb_transactions x on r.id = any (x.matched_rule_ids) and not x.pending
  ),
  -- How often a rule should match (P4-D1): the most common rounded gap between the merchant's linked charges,
  -- ties to the longer. With too few charges: the merchant's shortest subscription interval, else the median
  -- gap between the rule's matches, else the notes' annual or quarterly days, else default_days.
  rule_interval as (
    select r.id as rule_id,
           coalesce(
             (select b.days
              from (select case when g.gap <= p.week_gap_days then 7::numeric
                                when g.gap <= p.two_week_gap_days then 14::numeric
                                else greatest(round(g.gap / 30.4), 1) * 30.4 end as days,
                           count(*) over () as n_gaps
                    from (select dd.d - lag(dd.d) over (order by dd.d) as gap
                          from (select distinct (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date as d
                                from public.wb_transactions x
                                join public.wb_subscriptions s on s.id = x.subscription_id
                                where x.merchant_id = r.merchant_id and not x.pending and x.kind = 'spend'
                                  and s.status <> 'cancelled') dd) g
                    where g.gap is not null) b
              where b.n_gaps + 1 >= p.min_charges
              group by b.days
              order by count(*) desc, b.days desc
              limit 1),
             (select min(case when s.interval_unit = 'month' then s.interval_count * 30.4 else s.interval_count * 7 end)
              from public.wb_subscriptions s
              where s.merchant_id = r.merchant_id and s.status <> 'cancelled' and s.interval_count is not null),
             (select percentile_cont(0.5) within group (order by g.gap)
              from (select dd.d - lag(dd.d) over (order by dd.d) as gap
                    from (select distinct h.d from hits h where h.rule_id = r.id) dd) g
              where g.gap is not null),
             case when coalesce(r.notes, '') ~* '(annual|yearly)' then p.annual_days
                  when coalesce(r.notes, '') ~* 'quarter' then p.quarter_days end,
             p.default_days)::numeric as days
    from rule_merchant r
    cross join params p
  ),
  overrides as (
    select h.rule_id, h.transaction_id,
           exists (
             select 1 from public.wb_splits s
             join public.wb_split_tags st on st.split_id = s.id
             join public.wb_tags rt on rt.id = any (r.add_tag_ids)
             where s.transaction_id = h.transaction_id
               and st.source in ('claude', 'manual')
               and st.group_exclusive and st.group_id = rt.group_id
               and st.tag_id <> all (r.add_tag_ids))                                      as tag_swap,
           exists (
             select 1 from public.wb_tag_exclusions e
             where e.transaction_id = h.transaction_id and e.rule_id = h.rule_id)         as tag_removed,
           (r.set_kind is not null and h.kind_source in ('claude', 'manual') and h.kind is distinct from r.set_kind) as kind_changed,
           (cardinality(r.add_tag_ids) > 0
            and (select count(*) from public.wb_splits s where s.transaction_id = h.transaction_id) > 1) as re_split,
           -- A project the rule set, changed or removed by hand (a removal is a null project_id with
           -- source claude or manual).
           (r.set_project_id is not null and exists (
             select 1 from public.wb_splits s
             where s.transaction_id = h.transaction_id
               and s.project_source in ('claude', 'manual')
               and s.project_id is distinct from r.set_project_id))                       as project_changed
    from hits h
    join rule_merchant r on r.id = h.rule_id
    where h.source = 'sync'
  ),
  payee_keys as (
    select x.merchant_id,
           nullif(btrim(regexp_replace(regexp_replace(
             split_part(lower(coalesce(nullif(btrim(x.payee), ''), x.clean_description, '')), '*', 1),
             '[0-9]', '', 'g'), '\s+', ' ', 'g')), '') as payee
    from public.wb_transactions x
    where x.merchant_id is not null and not x.pending and x.source = 'sync'
  ),
  merchant_payees as (
    select k.merchant_id,
           count(*)::int as n_txns,
           coalesce(array_agg(distinct k.payee) filter (where k.payee is not null), '{}') as payees
    from payee_keys k
    group by k.merchant_id
  )
  -- never_fires (A16, A54, A55): quiet for more than factor x the expected interval AND more than
  -- floor_days, counted from the last match, or from creation when it never matched. n stays 0, so an
  -- acknowledgement holds until the rule fires.
  select 'never_fires'::text as finding, r.id as rule_id, r.name as rule_name, r.merchant_id, m.name as merchant_name,
         0 as n, null::int as of_n,
         format('%s; expected about every %s.',
                case when r.last_hit_at is null
                     then format('No match since it was created on %s', (r.created_at at time zone 'America/Los_Angeles')::date)
                     else format('Last match on %s', (r.last_hit_at at time zone 'America/Los_Angeles')::date) end,
                case when round(ri.days) <= 1 then 'day' else round(ri.days) || ' days' end) as detail
  from rule_merchant r
  join rule_interval ri on ri.rule_id = r.id
  cross join today
  cross join params p
  left join public.wb_merchants m on m.id = r.merchant_id
  where today.d - coalesce((r.last_hit_at at time zone 'America/Los_Angeles')::date, (r.created_at at time zone 'America/Los_Angeles')::date)
        > greatest(ceil(p.factor * ri.days)::int, p.floor_days)
  union all
  select 'too_broad', null, null, mp.merchant_id, m.name,
         cardinality(mp.payees), mp.n_txns,
         'Payees: ' || array_to_string((select array_agg(p order by p) from unnest(mp.payees) p), '; ')
  from merchant_payees mp
  join public.wb_merchants m on m.id = mp.merchant_id
  where cardinality(mp.payees) >= 3
    and exists (select 1 from rule_merchant r where r.merchant_id = mp.merchant_id)
  union all
  -- often_overridden detail (A55): "tag swapped on 2, removed on 2, kind changed on 1 (of 5)".
  select 'often_overridden', r.id, r.name, r.merchant_id, m.name, o.n, o.of_n,
         concat_ws(', ',
           case when o.swaps > 0 then format('tag swapped on %s', o.swaps) end,
           case when o.removals > 0 then format('%s on %s', case when o.swaps > 0 then 'removed' else 'tag removed' end, o.removals) end,
           case when o.kinds > 0 then format('kind changed on %s', o.kinds) end,
           case when o.splits > 0 then format('re-split on %s', o.splits) end,
           case when o.projects > 0 then format('project changed on %s', o.projects) end)
         || format(' (of %s)', o.of_n)
  from rule_merchant r
  left join public.wb_merchants m on m.id = r.merchant_id
  join lateral (
    select count(*) filter (where tag_swap or tag_removed or kind_changed or re_split or project_changed)::int as n,
           (select count(*) from hits h where h.rule_id = r.id and h.source = 'sync')::int as of_n,
           count(*) filter (where tag_swap)::int as swaps,
           count(*) filter (where tag_removed)::int as removals,
           count(*) filter (where kind_changed)::int as kinds,
           count(*) filter (where re_split)::int as splits,
           count(*) filter (where project_changed)::int as projects
    from overrides ov where ov.rule_id = r.id
  ) o on true
  where o.n >= 2 and o.n * 4 >= o.of_n
  union all
  select 'duplicate_rules', null, null, r.merchant_id, m.name, count(*)::int, null,
         'Rules: ' || string_agg(r.name, '; ' order by r.priority, r.created_at)
  from rule_merchant r
  left join public.wb_merchants m on m.id = r.merchant_id
  where r.merchant_id is not null
  group by r.merchant_id, m.name
  having count(*) >= 2
  union all
  select 'rule_missing', null, null, m.id, m.name, t.n, null,
         format('%s transactions tagged by hand or by Claude, and no rule.', t.n)
  from public.wb_merchants m
  join lateral (
    select count(distinct x.id)::int as n
    from public.wb_transactions x
    join public.wb_splits s on s.transaction_id = x.id
    join public.wb_split_tags st on st.split_id = s.id
    where x.merchant_id = m.id and not x.pending and st.source in ('claude', 'manual')
  ) t on true
  where t.n >= 3
    and not exists (select 1 from rule_merchant r where r.merchant_id = m.id)
  union all
  select 'merchant_no_category', null, null, m.id, m.name, c.n, null,
         format('%s spend transactions, none with a Category.', c.n)
  from public.wb_merchants m
  join lateral (
    select count(*)::int as n,
           bool_or(exists (
             select 1 from public.wb_splits s
             join public.wb_split_tags st on st.split_id = s.id
             join public.wb_tag_groups g on g.id = st.group_id
             where s.transaction_id = x.id and g.name = 'Category')) as any_category
    from public.wb_transactions x
    where x.merchant_id = m.id and not x.pending and x.kind in ('spend', 'refund', 'fee') and x.source = 'sync'
  ) c on true
  where c.n > 0 and not coalesce(c.any_category, false)
)
select
  f.finding, f.rule_id, f.rule_name, f.merchant_id, f.merchant_name, f.n, f.of_n, f.detail,
  coalesce(f.rule_id, f.merchant_id)                 as subject_id,
  (a.id is not null and f.n <= a.acked_n)            as acknowledged,
  a.acked_n,
  a.reason                                           as ack_reason,
  a.updated_at                                       as acked_at
from findings f
left join public.wb_rule_health_acks a
  on a.finding = f.finding and a.subject_id = coalesce(f.rule_id, f.merchant_id);

comment on view public.wb_rule_health_all is
  'App: Warren Buffet. Every rule-health finding (see wb_rule_health) with subject_id (the rule, else the merchant) and its acknowledgement: acknowledged is true while n has not grown past acked_n, with ack_reason and acked_at. never_fires (A16, A54, A55, P4-D1): an active rule quiet for more than both 1.5 times its expected interval and 30 days, counted from its last match or, when it never matched, from its creation; the interval is the most common gap between the merchant''s linked charges (up to 10 days counts as a week, up to 17 as two weeks, longer rounds to whole months, a tie goes to the longer), and with fewer than 3 linked charges the merchant''s shortest subscription interval, else the median gap between its matches, else 365 or 91 days when its notes say annual or quarterly, else 30. detail gives the date and the interval ("expected about every day" or "every N days"). often_overridden counts tag swaps and removals, kind changes, re-splits, and a project the rule set that was changed or removed by hand; detail reads "tag swapped on 2, removed on 2 (of 5)". Imported history is left out of too_broad, often_overridden and merchant_no_category, and counts for the interval (P4-D4). security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 8. wb_rule_health: as in 190, restated over the new view
-- ============================================================================
create or replace view public.wb_rule_health
with (security_invoker = true) as
select finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail
from public.wb_rule_health_all
where not acknowledged;

comment on view public.wb_rule_health is
  'App: Warren Buffet. One row per finding not acknowledged (finding, rule_id, rule_name, merchant_id, merchant_name, n, of_n, detail): never_fires (quiet for more than both 1.5 times the rule''s expected interval and 30 days, A54, A55, P4-D1), too_broad (merchant-level: 3+ distinct normalized payees on a merchant with a rule), often_overridden (n of of_n hits beaten by hand, at least 2 and 25%, a changed project included), duplicate_rules, rule_missing, merchant_no_category. too_broad, often_overridden and merchant_no_category read synced rows only (P4-D4). An acknowledged finding (wb_rule_health_acks) is hidden until its n grows past the acknowledged n; wb_rule_health_all has them all. Read by get_wb_rule_health, wb_action_items and the weekly cleanup task, which proposes fixes and never writes them. security_invoker, so wb_ RLS applies.';

-- ============================================================================
-- 9. Grants: nothing to anon or public. wb_action_items stays authenticated only, as 158 set it.
-- ============================================================================
revoke all on public.wb_review_queue from public, anon;
revoke all on public.wb_transaction_list from public, anon;
revoke all on public.wb_rule_health_all from public, anon;
revoke all on public.wb_rule_health from public, anon;
grant select on public.wb_review_queue to authenticated, service_role;
grant select on public.wb_transaction_list to authenticated, service_role;
grant select on public.wb_rule_health_all to authenticated, service_role;
grant select on public.wb_rule_health to authenticated, service_role;

revoke all on function public.wb_suggest_planned_matches(uuid[], uuid[]) from public, anon;
revoke all on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) from public, anon;
grant execute on function public.wb_suggest_planned_matches(uuid[], uuid[]) to authenticated, service_role;
grant execute on function public.wb_planned_start_from_history(uuid, numeric, numeric, date) to authenticated, service_role;

revoke all on function public.wb_action_items(int, numeric, int, date) from public, anon, service_role;
grant execute on function public.wb_action_items(int, numeric, int, date) to authenticated;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run supabase/tests/warren_buffet_p4/2_history_source_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
