-- Purpose: Warren Buffet Phase 3, Step 11 fixes (Alex, 2026-10-23, run tags warren_buffet_p3-q5k-s31-v4ha, -s32-c6rn and -s33-n2gy; spec A57, A58). wb_cash_projection counts a late repeating date (past due, inside its match window, not Not needed) on day 1, and treats a suggested match like a confirmed one, so a payment that has posted is never counted again. wb_confirm_planned_match removes the other suggestions for the same date and the same payment part once a match is confirmed. wb_action_items: a paid one-off is never coming due; the amount to move is the shortfall at the lowest balance in the next 30 days (shortfall_30d), shown only when the balance goes below the floor in those 30 days; causes come from the path; a fee's refund is a refund-kind credit used once, and refunds are not card-bill payments; next_30_projected covers exactly 30 days; a past-due card bill is a flag only; and an intention or inbox title that stops mid-line ends with "…".
-- Kind: schema change (three replaced functions)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A24, A45, A49 to A53, A57 and A58.
-- A15: the numbers below that help states (14, 1000, 60, 90, 30, 2, 7) carry their comment where they are defined.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p3/6_step11_fixes_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/158_wb_phase3_step11_fixes.sql

begin;

-- ============================================================================
-- 1. wb_cash_projection: as in 143, with late repeating dates on day 1 and suggested matches counted (A58)
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
    -- Due dates in the horizon, less what is confirmed or suggested against each (A5, A58): a suggested
    -- match is a payment that has posted, so it is already in the balance. 0 within tolerance (A45).
    select o.occurrence_on as d,
           public.wb_planned_left(o.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status in ('confirmed', 'suggested')
               and pm.occurrence_on is not distinct from case when o.recurring then o.occurrence_on end),
             pi.amount_tolerance) as amt
    from public.wb_planned_occurrences(v_today, v_end, p_include_drafts) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring or o.stage <> 'paid'
    union all
    -- An overdue one-off with something still unpaid counts on day 1 (A7).
    select v_today,
           public.wb_planned_left(pi.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = pi.id and pm.status in ('confirmed', 'suggested')), pi.amount_tolerance)
    from public.wb_planned_items pi
    where pi.interval_count is null
      and pi.due_on < v_today
      and pi.stage not in ('paid', 'cancelled')
      and (p_include_drafts or pi.stage <> 'draft')
    union all
    -- A late repeating date counts on day 1 too (A58, as A24 does for subscriptions): past due, still
    -- inside its match window, and not marked Not needed. Older missed dates still do not (A25).
    select v_today,
           public.wb_planned_left(o.amount, (
             select sum(abs(pm.amount_applied)) from public.wb_planned_matches pm
             where pm.planned_item_id = o.planned_item_id and pm.status in ('confirmed', 'suggested')
               and pm.occurrence_on = o.occurrence_on), pi.amount_tolerance)
    from public.wb_planned_occurrences(v_today - 366, v_today - 1, p_include_drafts) o
    join public.wb_planned_items pi on pi.id = o.planned_item_id
    where o.recurring
      and v_today - o.occurrence_on <= pi.match_window_days
      and not exists (select 1 from public.wb_planned_skips sk
                      where sk.planned_item_id = o.planned_item_id and sk.occurrence_on = o.occurrence_on)
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
  'Warren Buffet: spending cash day by day from p_today across the horizon (wb_settings.horizon_months, else 12). Starts from spending_cash balances minus what is owed on credit_card and emergency_credit accounts (unused credit never counts; balances as of p_today). Each day adds planned income and bills on their due dates less what is confirmed or suggested against them (a suggestion is a payment that has posted; nothing when what is left is within the item''s amount_tolerance, A45, A58), subscription charges, and the burn rate spread evenly (median x 12 / 365). On day 1 it also counts an overdue one-off with something unpaid (A7) and a repeating date past due but still inside its match window and not marked Not needed (A58); older missed repeating dates do not count (A25). Drafts (stage draft, or is_draft) only when p_include_drafts. Security invoker.';

-- ============================================================================
-- 2. wb_confirm_planned_match: as in 143, and the other suggestions for the date and the split go (A58)
-- ============================================================================
create or replace function public.wb_confirm_planned_match(p_match_id uuid, p_action text, p_amount numeric default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m         record;
  pi        record;
  v_paid    boolean := false;
  n_removed int := 0;
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

  -- A58: the other suggestions for this date of this item, and for this payment part, go, so a later
  -- confirm cannot match the same date or the same payment twice.
  delete from public.wb_planned_matches x
  where x.status = 'suggested' and x.id <> p_match_id
    and ((x.planned_item_id = m.planned_item_id and x.occurrence_on is not distinct from m.occurrence_on)
         or x.split_id = m.split_id);
  get diagnostics n_removed = row_count;

  -- A one-off covered by confirmed matches (within its tolerance, A45) is paid. Never set back automatically.
  if pi.interval_count is null and pi.stage <> 'paid'
     and public.wb_planned_left(pi.amount, (select sum(abs(x.amount_applied)) from public.wb_planned_matches x
          where x.planned_item_id = pi.id and x.status = 'confirmed'), pi.amount_tolerance) = 0
  then
    update public.wb_planned_items set stage = 'paid' where id = pi.id;
    v_paid := true;
  end if;
  return jsonb_build_object('status', 'confirmed', 'stage_paid', v_paid, 'suggestions_removed', n_removed);
end;
$$;

comment on function public.wb_confirm_planned_match(uuid, text, numeric) is
  'Warren Buffet: confirm or reject one suggested planned match. confirm may lower the amount for a part-payment (p_amount, taken with the planned item''s sign); the trigger refuses more than the split. On confirm, the other suggestions for the same item and date, and for the same split, are deleted (A58; suggestions_removed counts them). Confirming the last part of a one-off (covered within its amount_tolerance) sets its stage to paid; nothing sets it back automatically. A rejected match is never suggested again. Used by the app, by update_wb_planned_match and by create_wb_planned_match. Security invoker.';

-- ============================================================================
-- 3. wb_action_items: as in 153, with the A57 and A58 fixes
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
        and c.d between v_today - c_flag_days and v_today
        and concat_ws(' ', x.description, x.payee) ~* '(interest charge|finance charge|late fee|late payment|annual fee|over ?limit fee|returned payment)'
    ),
    credits as (
      select r.id, r.account_id, r.amount, c.d,
             row_number() over (partition by r.account_id, r.amount order by c.d, r.id) as rn
      from public.wb_transactions r
      cross join lateral (select (coalesce(r.posted_at, r.transacted_at) at time zone 'America/Los_Angeles')::date as d) c
      where not r.pending and r.amount > 0
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
  'Warren Buffet: the money to-do list, one JSON object (spec A49 to A53, A57, A58). Sections: flags (card interest and fees in the last 90 days, red until the charge is reviewed with a note (shown as note), when it clears; a refund-kind credit of the same amount on that card, used once and never a transfer or a payment, turns it info with refund (amount, on, link) but does not clear it; and a card bill past due and unpaid, which is then left out of card_bills), reconcile (review queue counts by reason), overdue (wb_planned_unmatched past the match window, and subscriptions more than 7 days late), coming_up (planned items less what is covered, A45, never a one-off at stage paid, and subscriptions, in the next p_days; dates past due but not yet overdue come first, with late true and amber; big true for money out over p_big_amount), big_bites (payments out of more than p_big_amount in the next p_big_days, what-ifs included and marked, no paid one-offs), card_bills (from statement_close_day, payment_due_day and autopay: the balance on the last close day less card payments since, refunds not counted; a card with no days set asks for them), needs_attention (sync problems, stale or missing balances, subscriptions to review or confirm, accounts with no role, rule health), money_intentions and money_inbox (Alfred records in the Money context, as RLS allows; a title longer than 120 characters is cut, and a title that stops mid-line is kept, both ending with an ellipsis), below_floor (when the projection goes below the safety floor in the next 30 days, window_days: first_below_on, the "by" date, and closing_then; low_30d_on and low_30d_balance, the lowest day in those 30 days; shortfall_30d, the amount to move from the reserve, floor less that low; path, the starting balance, every dated event and a weekly burn row up to the low day, each with the projected balance after it and below when it is under the floor; causes, the path''s payments out and its burn; first_below_on and shortfall_30d are null when the 30 days stay above the floor), and cash_flow (money in less money out: last_30_actual from settled spending-cash and card rows, leaving out paired transfers and transfers received on a card; next_30_projected, the projection''s change over the next 30 days, today included; typical_month, wb_true_cost.net_monthly; runway_months, the reserve over a monthly shortfall, null when typical_month is not negative). Every row has type, severity (red, amber, info), title, todo, amount, on and a link (link_kind, link_id). Security invoker; read by the app and get_wb_action_items.';

-- Grants are kept by create or replace; restated so the file stands alone (150, A50).
revoke all on function public.wb_action_items(int, numeric, int, date) from public, anon, service_role;
grant execute on function public.wb_action_items(int, numeric, int, date) to authenticated;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run supabase/tests/warren_buffet_p3/6_step11_fixes_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
