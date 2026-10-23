-- Purpose: Warren Buffet Phase 3, Step 9b fixes (Alex, 2026-10-23, run tag warren_buffet_p3-q5k-s18-u2fc; spec A51). wb_suggest_planned_matches: a planned item with no merchant is suggested a posted payment of the same sign and amount (within its tolerance) inside its window, when that payment has no confirmed match and is not a transfer between our own accounts; payments with no merchant are preferred. wb_action_items: no-merchant todos say Pay it or Deposit it; planned dates and subscription charges past due but not yet overdue stay in coming_up, marked late and amber; a cut title ends with "…".
-- Kind: schema change (two replaced functions)
-- Applied: YES, 2026-10-23 (conformant; tests 3_ 21/21, 2_ 40/40)
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A50 and A51.
-- A15: the numbers below that help will state (14, 1000, 60, 30, 2, 7) carry their comment where they are defined.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p3/3_no_merchant_and_late_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/151_wb_phase3_step9b_no_merchant_matches.sql

begin;

-- ============================================================================
-- 1. wb_suggest_planned_matches: as in 143, plus items with no merchant (A51)
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
  'Warren Buffet: suggests planned matches for the given transactions and/or planned items (null = all). A posted split qualifies for a planned item''s due date when it has the same sign, its amount is within the item''s amount_tolerance (exact when 0) and its date within match_window_days, and it is at the item''s merchant; for an item with no merchant, any payment qualifies that has no confirmed match and is not a transfer between our own accounts (transfer_pair_id set), and payments with no merchant are preferred (A51). Drafts, cancelled and paid one-offs never qualify. A pair already suggested, confirmed or rejected is not suggested again; an occurrence already covered by confirmed matches (within its amount_tolerance, wb_planned_left), a split already fully confirmed, or either one already holding a suggestion, gets none; otherwise the preferred payment and then the closest date wins, one per occurrence, and one per split, where an item at the payment''s merchant comes first. amount_applied is the smaller of the two amounts. Suggestions in scope that no longer qualify are deleted. Called by wb_process_transactions and after planned-item writes. Security invoker. Returns suggested and removed counts.';

-- ============================================================================
-- 2. wb_action_items: as in 150, plus late rows in coming_up, deposit todos and cut titles (A51)
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
  -- If you change 14, 1000 or 60 (the defaults above), 30, 2 or 7, update the Overview help entries
  -- for Action Items in src/money/helpText.js and ruleNumbers.js (step 9e), and their test.
  c_fee_days      constant int := 30;   -- card fees and interest looked back over
  c_manual_stale  constant int := 30;   -- a hand-entered balance older than this needs checking
  c_synced_stale  constant int := 2;    -- as STALE_ACCOUNT_DAYS in moneyFormat.js
  c_sub_grace     constant int := 7;    -- as wb_subscription_overview.overdue (OVERDUE_GRACE_DAYS)
  c_title_max     constant int := 120;
  c_money         constant text := 'muvitejhrgt3rgi8t6q';
  v_today   date := coalesce(p_today, (now() at time zone 'America/Los_Angeles')::date);
  v_flags   jsonb := '[]';
  v_cards   jsonb := '[]';
  v_attn    jsonb := '[]';
  v_below   jsonb;
  card      record;
  v_close   date;
  v_due     date;
  v_owed    numeric;
  v_paid    numeric;
  v_month   date;
  v_floor   numeric;
  v_first   record;
  v_low     record;
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

    select coalesce(sum(x.amount), 0) into v_paid
    from public.wb_transactions x
    where x.account_id = card.id and not x.pending and x.amount > 0
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date > v_close
      and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date <= v_today;
    continue when v_paid >= v_owed;

    v_cards := v_cards || jsonb_build_object(
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
    if v_due < v_today then
      v_flags := v_flags || (v_cards -> -1);
    end if;
  end loop;

  -- ---------------------------------------------------------------- flags: card interest and fees
  v_flags := (
    select coalesce(jsonb_agg(f order by f ->> 'on' desc), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'type', 'card_charge', 'severity', 'red',
               'title', format('%s on %s', initcap(coalesce(nullif(x.clean_description, ''), x.description)), coalesce(a.display_name, a.name)),
               'todo', 'A card charged interest or a fee. Check the due date was not missed, and pay in full to stop it.',
               'amount', x.amount,
               'on', (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date,
               'link_kind', 'transaction', 'link_id', x.id) as f
      from public.wb_transactions x
      join public.wb_accounts a on a.id = x.account_id
      where a.role in ('credit_card', 'emergency_credit')
        and not x.pending and x.amount < 0
        and (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date between v_today - c_fee_days and v_today
        and concat_ws(' ', x.description, x.payee) ~* '(interest charge|finance charge|late fee|late payment|annual fee|over ?limit fee|returned payment)'
    ) c
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

  -- ---------------------------------------------------------------- below the floor (A49): read the projection, copy none of it
  select s.safety_floor into v_floor from public.wb_settings s order by s.created_at limit 1;
  select * into v_low from public.wb_free_cash(false, v_today);
  if v_floor is null then
    v_below := jsonb_build_object('floor_missing', true, 'floor', null, 'first_below_on', null, 'causes', '[]'::jsonb,
      'todo', 'Ask Claude to set a safety floor; until then nothing is checked against it.');
  else
    select p.day, p.closing into v_first
    from public.wb_cash_projection(false, v_today) p
    where p.closing < v_floor
    order by p.day limit 1;
    v_below := jsonb_build_object(
      'floor_missing', false,
      'floor', v_floor,
      'first_below_on', v_first.day,
      'closing_then', v_first.closing,
      'shortfall_then', case when v_first.day is not null then round(v_floor - v_first.closing, 2) end,
      'low_balance', v_low.low_balance,
      'low_on', v_low.low_on,
      'shortfall_at_low', case when v_low.low_balance < v_floor then round(v_floor - v_low.low_balance, 2) else 0 end,
      'reserve_balance', v_low.reserve_cash,
      'severity', case when v_first.day is null then 'info' when v_first.day <= v_today + p_days then 'red' else 'amber' end,
      'todo', case when v_first.day is null then 'Nothing to do: the projection stays above the floor.'
                   else 'Move the shortfall at the low point from the reserve before the first day below, or delay one of the payments listed.' end,
      'causes', case when v_first.day is null then '[]'::jsonb else (
        select coalesce(jsonb_agg(c order by (c ->> 'amount')::numeric), '[]'::jsonb)
        from (
          select jsonb_build_object('type', 'planned', 'title', pi.name, 'amount', public.wb_planned_left(o.amount, (
                   select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
                   where pm.planned_item_id = o.planned_item_id and pm.status = 'confirmed'
                     and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end), pi.amount_tolerance),
                   'on', o.occurrence_on, 'link_kind', 'planned_item', 'link_id', pi.id) as c
          from public.wb_planned_occurrences(v_today, v_first.day, false) o
          join public.wb_planned_items pi on pi.id = o.planned_item_id
          where o.amount < 0
          union all
          select jsonb_build_object('type', 'subscription', 'title', so.name, 'amount', so.amount,
                   'on', so.occurrence_on, 'link_kind', 'subscription', 'link_id', so.subscription_id)
          from public.wb_subscription_occurrences(v_today, v_first.day, v_today) so
          union all
          select jsonb_build_object('type', 'burn', 'title', 'Everyday spending at the burn rate',
                   'amount', round(sum(p.burn), 2), 'on', null, 'link_kind', null, 'link_id', null)
          from public.wb_cash_projection(false, v_today) p
          where p.day <= v_first.day
        ) z
        where (c ->> 'amount')::numeric < 0
      ) end);
  end if;

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

    'coming_up', (
      select coalesce(jsonb_agg(r order by r ->> 'on', r ->> 'title'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', case when o.recurring then 'planned_repeating' else 'planned_one_off' end,
                 'severity', 'info', 'title', pi.name, 'late', false,
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
        where z.left_amt <> 0
        union all
        -- Past due, still inside the match window: late, not yet overdue.
        select jsonb_build_object('type', case when u.recurring then 'planned_repeating' else 'planned_one_off' end,
                 'severity', 'amber', 'late', true,
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
        where z.left_amt < 0 and -z.left_amt > p_big_amount
        union all
        select jsonb_build_object('type', 'subscription', 'severity', case when so.occurrence_on <= v_today + p_days then 'amber' else 'info' end,
                 'title', so.name, 'what_if', false, 'todo', 'Make sure the cash is there by the date.',
                 'amount', so.amount, 'on', so.occurrence_on, 'link_kind', 'subscription', 'link_id', so.subscription_id)
        from public.wb_subscription_occurrences(v_today, v_today + p_big_days, v_today) so
        where -so.amount > p_big_amount
      ) x),

    'card_bills', v_cards,
    'needs_attention', v_attn,

    -- Alfred's own tables, read through their RLS like any other select.
    'money_intentions', (
      select coalesce(jsonb_agg(r order by (r ->> 'severity') = 'amber' desc, r ->> 'title'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'intention', 'severity', case when i.status = 'active' then 'amber' else 'info' end,
                 'title', i.text, 'todo', 'Open it in Alfred.', 'status', i.status,
                 'amount', null, 'on', i.target_start_date, 'link_kind', 'intention', 'link_id', i.id) as r
        from public.intents i
        where i.context_id = c_money and i.is_intention is true and not coalesce(i.archived, false) and i.status <> 'closed'
      ) x),
    'money_inbox', (
      select coalesce(jsonb_agg(r order by r ->> 'on' desc), '[]'::jsonb)
      from (
        select jsonb_build_object('type', 'inbox_item', 'severity', 'info',
                 'title', case when length(t.full_title) > c_title_max then left(t.full_title, c_title_max - 1) || '…'
                               else t.full_title end,
                 'todo', 'Triage it in the inbox.',
                 'amount', null, 'on', (b.created_at at time zone 'America/Los_Angeles')::date,
                 'link_kind', 'inbox_item', 'link_id', b.id) as r
        from public.inbox b
        cross join lateral (select coalesce(nullif(b.suggested_intent_text, ''), b.captured_text) as full_title) t
        where b.suggested_context_id = c_money and not coalesce(b.archived, false)
      ) x),

    'below_floor', v_below
  );
end;
$$;

comment on function public.wb_action_items(int, numeric, int, date) is
  'Warren Buffet: the money to-do list, one JSON object (spec A49, A50, A51). Sections: flags (card interest and fees in the last 30 days; a card bill past due and unpaid), reconcile (review queue counts by reason), overdue (wb_planned_unmatched past the match window, and subscriptions more than 7 days late), coming_up (planned items less what is covered, A45, and subscriptions, in the next p_days; dates past due but not yet overdue come first, with late true and amber), big_bites (payments out of more than p_big_amount in the next p_big_days, what-ifs included and marked), card_bills (from statement_close_day, payment_due_day and autopay: the balance on the last close day less card payments since; a card with no days set asks for them), needs_attention (sync problems, stale or missing balances, subscriptions to review or confirm, accounts with no role, rule health), money_intentions and money_inbox (Alfred records in the Money context, as RLS allows; a title longer than 120 characters is cut and ends with an ellipsis), and below_floor (the first projected day under the safety floor, the shortfall then and at the low point, and the payments up to it; read from wb_cash_projection and wb_free_cash). Every row has type, severity (red, amber, info), title, todo, amount, on and a link (link_kind, link_id). Security invoker; read by the app and get_wb_action_items.';

-- Grants are kept by create or replace: wb_action_items stays authenticated only (150), and
-- wb_suggest_planned_matches keeps authenticated and service_role (wb-sync runs processing).
revoke all on function public.wb_action_items(int, numeric, int, date) from public, anon, service_role;
grant execute on function public.wb_action_items(int, numeric, int, date) to authenticated;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run supabase/tests/warren_buffet_p3/3_no_merchant_and_late_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
