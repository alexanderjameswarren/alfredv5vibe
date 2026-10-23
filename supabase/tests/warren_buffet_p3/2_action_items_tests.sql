-- Purpose: Warren Buffet Phase 3 Step 9a tests, run after 150_wb_phase3_step9a_action_items.sql: every section of wb_action_items, including a card fee flag, a card with no days set, a card with days set and an unpaid bill past due, a paid bill left out, a big bite outside the 14-day window, a what-if big bite, a below-floor day and its causes, a missing floor, needs-attention rows, money intentions and money inbox items.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Dated checks use 2031-06-20, so real data does not decide them; the overdue, reconcile, intention
-- and inbox checks use today, because their views do. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/2_action_items_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_on date, p_amount numeric, p_desc text)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
  select a.user_id, a.context_id, p_acct, 'ZZ-P9-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, p_desc, p_desc, '{}'
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_acct(p_name text, p_source text, p_role text, p_close int default null,
                                           p_due int default null, p_autopay text default null)
returns uuid
language sql
as $$
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role, statement_close_day, payment_due_day, autopay)
  select c.user_id, c.id, p_source, case when p_source = 'simplefin' then 'ZZ-TEST-' || gen_random_uuid() end,
         p_name, p_role, p_close, p_due, p_autopay
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- The rows of one section that point at one record.
create or replace function pg_temp.zz_rows(p_r jsonb, p_section text, p_id text)
returns jsonb
language sql
as $$ select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_r -> p_section) e where e ->> 'link_id' = p_id; $$;

create or replace function pg_temp.wb_test_p3_step9a()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  t      date := date '2031-06-20';
  d      date := (now() at time zone 'America/Los_Angeles')::date;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  cA uuid; cB uuid; cC uuid; cD uuid; mNo uuid; mOld uuid; uU uuid; cash uuid;
  x_fee uuid;
  p_big uuid; p_draft uuid; p_rep uuid; p_small uuid; p_bite uuid; p_late uuid;
  s_small uuid; s_big uuid; s_rev uuid; s_watch uuid;
  r  jsonb; r0 jsonb; rf jsonb;
  row jsonb;
  c26 numeric;
  checks jsonb := '{}'::jsonb;
  shape_ok boolean;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  -- ---------------------------------------------------------------- accounts and balances
  cA := pg_temp.zz_acct('ZZ Visa A ' || k, 'simplefin', 'credit_card', 1, 15, 'minimum');
  cB := pg_temp.zz_acct('ZZ Visa B ' || k, 'simplefin', 'credit_card');
  cC := pg_temp.zz_acct('ZZ Visa C ' || k, 'simplefin', 'credit_card', 1, 25, 'none');
  cD := pg_temp.zz_acct('ZZ Visa D ' || k, 'simplefin', 'credit_card', 1, 25, null);
  mNo := pg_temp.zz_acct('ZZ never ' || k, 'manual', 'rewards');
  mOld := pg_temp.zz_acct('ZZ old miles ' || k, 'manual', 'rewards');
  uU := pg_temp.zz_acct('ZZ no role ' || k, 'simplefin', 'unassigned');
  cash := pg_temp.zz_acct('ZZ cash ' || k, 'simplefin', 'spending_cash');
  update public.wb_accounts set reward_unit = 'miles' where id = mOld;
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source) values
    (v_user, v_ctx, cA, date '2031-05-31', -300, 'manual'),
    (v_user, v_ctx, cA, date '2031-06-01', -500, 'manual'),
    (v_user, v_ctx, cB, t - 5, -10, 'manual'),
    (v_user, v_ctx, cC, date '2031-06-01', -100, 'manual'),
    (v_user, v_ctx, cD, date '2031-06-01', -80, 'manual'),
    (v_user, v_ctx, mOld, t - 60, 5000, 'manual'),
    (v_user, v_ctx, cash, t, 1000000, 'manual');
  perform pg_temp.zz_txn(cA, date '2031-06-05', 200, 'ZZ ONLINE PAYMENT THANK YOU');
  x_fee := pg_temp.zz_txn(cA, date '2031-06-10', -12, 'INTEREST CHARGE ON PURCHASES');
  perform pg_temp.zz_txn(cA, date '2031-03-01', -9, 'LATE FEE');                 -- older than the flag lookback (30, then 90 days)
  perform pg_temp.zz_txn(cC, date '2031-06-03', 100, 'ZZ ONLINE PAYMENT THANK YOU');

  -- ---------------------------------------------------------------- planned items and subscriptions
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9 tax', -5000, date '2031-07-20', 'quoted') returning id into p_big;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9 maybe', -3000, date '2031-07-25', 'draft') returning id into p_draft;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ S9 premium', -2000, date '2031-06-25', 1, 'month') returning id into p_rep;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9 small', -50, date '2031-06-27', 'invoiced') returning id into p_small;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S9 bite', -50000, date '2031-06-26', 'quoted') returning id into p_bite;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ S9 late', -70, d - 20, 'invoiced', 5) returning id into p_late;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ S9 stream ' || k, 'monthly', 20, 'active', date '2031-06-28') returning id into s_small;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ S9 insurance ' || k, 'annual', 1500, 'active', date '2031-07-10') returning id into s_big;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on, review_date)
  values (v_user, v_ctx, 'ZZ S9 review ' || k, 'annual', 40, 'active', date '2031-08-01', t - 1) returning id into s_rev;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status)
  values (v_user, v_ctx, 'ZZ S9 watch ' || k, 'monthly', 5, 'watching') returning id into s_watch;

  -- ---------------------------------------------------------------- sync run, intentions, inbox
  insert into public.platform_runs (user_id, app, job, executor, status, started_at, error_message)
  values (v_user, 'warren_buffet', 'wb-sync', 'workshop', 'partial', now() + interval '1 day',
          'Connection to ZZ Bank may need attention. Auth required');
  insert into public.intents (id, text, is_intention, context_id, user_id, status)
  values (k || 'i1', 'ZZ S9 call the bank', true, v_ctx, v_user, 'active'),
         (k || 'i2', 'ZZ S9 done thing', true, v_ctx, v_user, 'closed');
  insert into public.inbox (id, captured_text, suggested_context_id, user_id) values (k || 'b1', 'ZZ S9 receipt', v_ctx, v_user);
  insert into public.inbox (id, captured_text, suggested_context_id, user_id, archived) values (k || 'b2', 'ZZ S9 old', v_ctx, v_user, true);

  -- ---------------------------------------------------------------- the floor: just above the day the bite lands
  insert into public.wb_settings (user_id, context_id, horizon_months) values (v_user, v_ctx, 12)
  on conflict (context_id) do nothing;
  select closing into c26 from public.wb_cash_projection(false, t) where day = date '2031-06-26';
  update public.wb_settings set safety_floor = c26 + 1 where context_id = v_ctx;

  r := public.wb_action_items(14, 1000, 60, t);
  r0 := public.wb_action_items();

  -- ---------------------------------------------------------------- shape
  shape_ok := not exists (
    select 1
    from unnest(array['flags', 'reconcile', 'overdue', 'coming_up', 'big_bites', 'card_bills', 'needs_attention',
                      'money_intentions', 'money_inbox']) s(name)
    cross join lateral jsonb_array_elements((r0 -> s.name) || (r -> s.name)) e
    where not (e ?& array['type', 'severity', 'title', 'todo', 'amount', 'on', 'link_kind', 'link_id'])
       or e ->> 'severity' not in ('red', 'amber', 'info'));
  checks := checks || jsonb_build_object('every_row_has_the_fields', shape_ok,
    'today_echoed', r ->> 'today' = '2031-06-20' and (r ->> 'days')::int = 14);

  -- ---------------------------------------------------------------- flags
  checks := checks || jsonb_build_object(
    'flag_fee_charge', (select e ->> 'severity' = 'red' and (e ->> 'amount')::numeric = -12
                        from jsonb_array_elements(pg_temp.zz_rows(r, 'flags', x_fee::text)) e),
    'flag_old_fee_left_out', not exists (select 1 from jsonb_array_elements(r -> 'flags') e where (e ->> 'amount')::numeric = -9),
    'flag_card_past_due', (select e ->> 'type' = 'card_bill' from jsonb_array_elements(pg_temp.zz_rows(r, 'flags', cA::text)) e));

  -- ---------------------------------------------------------------- card bills
  row := pg_temp.zz_rows(r, 'card_bills', cA::text) -> 0;
  checks := checks || jsonb_build_object(
    'card_past_due_red', row ->> 'severity' = 'red' and row ->> 'on' = '2031-06-15',
    'card_amount_is_statement_less_paid', (row ->> 'amount')::numeric = -300 and (row ->> 'statement_balance')::numeric = -500
                                          and (row ->> 'paid_since')::numeric = 200 and row ->> 'statement_on' = '2031-06-01',
    'card_minimum_autopay_says_so', row ->> 'todo' like '%only the minimum%',
    'card_no_days_asks', (pg_temp.zz_rows(r, 'card_bills', cB::text) -> 0 ->> 'type') = 'card_days_missing',
    'card_paid_left_out', jsonb_array_length(pg_temp.zz_rows(r, 'card_bills', cC::text)) = 0,
    'card_due_soon_amber', (pg_temp.zz_rows(r, 'card_bills', cD::text) -> 0 ->> 'severity') = 'amber'
                           and (pg_temp.zz_rows(r, 'card_bills', cD::text) -> 0 ->> 'on') = '2031-06-25');

  -- ---------------------------------------------------------------- coming up and big bites
  checks := checks || jsonb_build_object(
    'coming_small_one_off', (pg_temp.zz_rows(r, 'coming_up', p_small::text) -> 0 ->> 'amount')::numeric = -50,
    'coming_repeating', (pg_temp.zz_rows(r, 'coming_up', p_rep::text) -> 0 ->> 'on') = '2031-06-25',
    'coming_subscription', (pg_temp.zz_rows(r, 'coming_up', s_small::text) -> 0 ->> 'on') = '2031-06-28',
    'coming_leaves_out_later', jsonb_array_length(pg_temp.zz_rows(r, 'coming_up', p_big::text)) = 0
                               and jsonb_array_length(pg_temp.zz_rows(r, 'coming_up', p_draft::text)) = 0,
    'big_outside_14_days', (pg_temp.zz_rows(r, 'big_bites', p_big::text) -> 0 ->> 'on') = '2031-07-20',
    'big_what_if_marked', (pg_temp.zz_rows(r, 'big_bites', p_draft::text) -> 0 ->> 'what_if')::boolean,
    'big_repeating_soon_amber', (pg_temp.zz_rows(r, 'big_bites', p_rep::text) -> 0 ->> 'severity') = 'amber',
    'big_subscription', (pg_temp.zz_rows(r, 'big_bites', s_big::text) -> 0 ->> 'amount')::numeric = -1500,
    'big_leaves_out_small', jsonb_array_length(pg_temp.zz_rows(r, 'big_bites', p_small::text)) = 0
                            and jsonb_array_length(pg_temp.zz_rows(r, 'big_bites', s_small::text)) = 0);

  -- ---------------------------------------------------------------- below the floor
  checks := checks || jsonb_build_object(
    'below_first_day', r -> 'below_floor' ->> 'first_below_on' = '2031-06-26',
    'below_shortfall_then', (r -> 'below_floor' ->> 'shortfall_then')::numeric = 1,
    'below_shortfall_at_low', (r -> 'below_floor' ->> 'shortfall_at_low')::numeric
                              = round(c26 + 1 - (r -> 'below_floor' ->> 'low_balance')::numeric, 2),
    'below_causes_include_bite', exists (select 1 from jsonb_array_elements(r -> 'below_floor' -> 'causes') e
                                         where e ->> 'link_id' = p_bite::text and (e ->> 'amount')::numeric = -50000),
    'below_causes_not_after', not exists (select 1 from jsonb_array_elements(r -> 'below_floor' -> 'causes') e
                                          where (e ->> 'on')::date > date '2031-06-26'),
    'below_reserve_line', r -> 'below_floor' ? 'reserve_balance');
  update public.wb_settings set safety_floor = null where context_id = v_ctx;
  rf := public.wb_action_items(14, 1000, 60, t);
  checks := checks || jsonb_build_object(
    'below_floor_missing', (rf -> 'below_floor' ->> 'floor_missing')::boolean and rf -> 'below_floor' -> 'first_below_on' = 'null'::jsonb);

  -- ---------------------------------------------------------------- needs attention
  checks := checks || jsonb_build_object(
    'attn_stale_synced', (pg_temp.zz_rows(r, 'needs_attention', cB::text) -> 0 ->> 'type') = 'stale_synced',
    'attn_no_balance', (pg_temp.zz_rows(r, 'needs_attention', mNo::text) -> 0 ->> 'type') = 'manual_no_balance',
    'attn_stale_manual_rewards', (pg_temp.zz_rows(r, 'needs_attention', mOld::text) -> 0 ->> 'todo') like 'Check the miles balance%',
    'attn_no_role', (pg_temp.zz_rows(r, 'needs_attention', uU::text) -> 0 ->> 'type') = 'no_role',
    'attn_review_date', (pg_temp.zz_rows(r, 'needs_attention', s_rev::text) -> 0 ->> 'type') = 'subscription_review',
    'attn_watching', (pg_temp.zz_rows(r, 'needs_attention', s_watch::text) -> 0 ->> 'type') = 'subscription_watching',
    'attn_sync_problem', exists (select 1 from jsonb_array_elements(r -> 'needs_attention') e
                                 where e ->> 'type' = 'sync_problem' and e ->> 'severity' = 'red'
                                   and e ->> 'todo' like '%SimpleFIN Bridge%'));

  -- ---------------------------------------------------------------- today's sections
  checks := checks || jsonb_build_object(
    'reconcile_counts_by_reason', exists (select 1 from jsonb_array_elements(r0 -> 'reconcile') e
                                          where e ->> 'link_kind' = 'review_reason' and e ->> 'link_id' = 'no_kind'
                                            and (e ->> 'count')::int >= 1),
    'overdue_one_off', (pg_temp.zz_rows(r0, 'overdue', p_late::text) -> 0 ->> 'type') = 'overdue_one_off',
    'intention_open', (pg_temp.zz_rows(r0, 'money_intentions', k || 'i1') -> 0 ->> 'severity') = 'amber',
    'intention_closed_left_out', jsonb_array_length(pg_temp.zz_rows(r0, 'money_intentions', k || 'i2')) = 0,
    'inbox_unprocessed', (pg_temp.zz_rows(r0, 'money_inbox', k || 'b1') -> 0 ->> 'link_kind') = 'inbox_item',
    'inbox_archived_left_out', jsonb_array_length(pg_temp.zz_rows(r0, 'money_inbox', k || 'b2')) = 0);

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step9a();
