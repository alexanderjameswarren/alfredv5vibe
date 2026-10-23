-- Purpose: Warren Buffet Phase 3, Step 9a. The money to-do list: wb_accounts gains statement_close_day, payment_due_day and autopay (card bills); wb_action_items returns every section of the Overview's Action Items and Dropping below the floor as one JSON object, read by the app and by the get_wb_action_items tool so both give the same answer (spec A49, A50).
-- Kind: schema change (three columns, one new function)
-- Applied: YES, 2026-10-23 (conformant; tests 40/40)
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A49 and A50.
-- A15: the numbers below that help will state (14, 1000, 60, 30, 2) carry their comment where they are defined.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p3/2_action_items_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/150_wb_phase3_step9a_action_items.sql

begin;

-- ============================================================================
-- 1. Card bill settings on wb_accounts (A50). Null until Alex sets them through Claude.
-- ============================================================================
alter table public.wb_accounts add column if not exists statement_close_day int;
alter table public.wb_accounts add column if not exists payment_due_day int;
alter table public.wb_accounts add column if not exists autopay text;
alter table public.wb_accounts drop constraint if exists wb_accounts_statement_close_day_check;
alter table public.wb_accounts add constraint wb_accounts_statement_close_day_check
  check (statement_close_day is null or statement_close_day between 1 and 31);
alter table public.wb_accounts drop constraint if exists wb_accounts_payment_due_day_check;
alter table public.wb_accounts add constraint wb_accounts_payment_due_day_check
  check (payment_due_day is null or payment_due_day between 1 and 31);
alter table public.wb_accounts drop constraint if exists wb_accounts_autopay_check;
alter table public.wb_accounts add constraint wb_accounts_autopay_check
  check (autopay is null or autopay in ('none', 'minimum', 'full'));

comment on column public.wb_accounts.statement_close_day is 'Credit cards: the day of the month the statement closes (1-31; a short month uses its last day). Null until set. Read by wb_action_items for the card bill.';
comment on column public.wb_accounts.payment_due_day is 'Credit cards: the day of the month the statement balance is due (1-31; a short month uses its last day). Null until set.';
comment on column public.wb_accounts.autopay is 'Credit cards: none, minimum or full: what the bank pays automatically on the due day. Null until set.';

-- ============================================================================
-- 2. wb_action_items (A50)
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
  -- If you change 14, 1000 or 60 (the defaults above), 30 or 2, update the Overview help entries
  -- for Action Items in src/money/helpText.js and ruleNumbers.js (step 9e), and their test.
  c_fee_days      constant int := 30;   -- card fees and interest looked back over
  c_manual_stale  constant int := 30;   -- a hand-entered balance older than this needs checking
  c_synced_stale  constant int := 2;    -- as STALE_ACCOUNT_DAYS in moneyFormat.js
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

    'overdue', (
      select coalesce(jsonb_agg(r order by r ->> 'on'), '[]'::jsonb)
      from (
        select jsonb_build_object('type', case when u.recurring then 'missed_date' else 'overdue_one_off' end,
                 'severity', case when u.within_window then 'info' else 'amber' end,
                 'title', format('%s, due %s', u.name, to_char(u.due_on, 'Mon FMDD')),
                 'todo', case when u.has_suggestion then 'A match is waiting in Review: confirm it.'
                              when u.within_window then 'The payment may still post; wait a few days.'
                              else 'Match the payment, or ask Claude to mark the date Not needed.' end,
                 'amount', u.remaining, 'on', u.due_on, 'link_kind', 'planned_item', 'link_id', u.planned_item_id) as r
        from public.wb_planned_unmatched u
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
                 'severity', 'info', 'title', pi.name,
                 'todo', case when pi.merchant_id is null then 'Pay it; then ask Claude to match the payment.'
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
        select jsonb_build_object('type', 'subscription', 'severity', 'info',
                 'title', so.name || case when so.overdue_charge then ' (due now)' else '' end,
                 'todo', 'Nothing to do unless you mean to cancel it first.',
                 'amount', so.amount, 'on', so.occurrence_on, 'link_kind', 'subscription', 'link_id', so.subscription_id)
        from public.wb_subscription_occurrences(v_today, v_today + p_days, v_today) so
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
                 'title', coalesce(nullif(b.suggested_intent_text, ''), left(b.captured_text, 120)),
                 'todo', 'Triage it in the inbox.',
                 'amount', null, 'on', (b.created_at at time zone 'America/Los_Angeles')::date,
                 'link_kind', 'inbox_item', 'link_id', b.id) as r
        from public.inbox b
        where b.suggested_context_id = c_money and not coalesce(b.archived, false)
      ) x),

    'below_floor', v_below
  );
end;
$$;

comment on function public.wb_action_items(int, numeric, int, date) is
  'Warren Buffet: the money to-do list, one JSON object (spec A49, A50). Sections: flags (card interest and fees in the last 30 days; a card bill past due and unpaid), reconcile (review queue counts by reason), overdue (wb_planned_unmatched and overdue subscriptions), coming_up (planned items less what is covered, A45, and subscriptions, in the next p_days), big_bites (payments out of more than p_big_amount in the next p_big_days, what-ifs included and marked), card_bills (from statement_close_day, payment_due_day and autopay: the balance on the last close day less card payments since; a card with no days set asks for them), needs_attention (sync problems, stale or missing balances, subscriptions to review or confirm, accounts with no role, rule health), money_intentions and money_inbox (Alfred records in the Money context, as RLS allows), and below_floor (the first projected day under the safety floor, the shortfall then and at the low point, and the payments up to it; read from wb_cash_projection and wb_free_cash). Every row has type, severity (red, amber, info), title, todo, amount, on and a link (link_kind, link_id). Security invoker; read by the app and get_wb_action_items.';

-- Every reader (the app, and Claude through MCP, whose ctx.db carries the user's token) runs as
-- authenticated. A future server-side job, such as an Edge Function on the service client, would need
-- execute granted to service_role first (spec A50).
revoke all on function public.wb_action_items(int, numeric, int, date) from public, anon, service_role;
grant execute on function public.wb_action_items(int, numeric, int, date) to authenticated;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run supabase/tests/warren_buffet_p3/2_action_items_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
