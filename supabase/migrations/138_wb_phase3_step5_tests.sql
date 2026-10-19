-- Purpose: Warren Buffet Phase 3 Step 5a tests, run after 137_wb_phase3_step5_projection.sql: wb_monthly_equivalent (the cases moneyFormat.test checks too, A12), wb_subscription_occurrences, wb_burn_rate_on (median, mean, project, subscription and partial-match exclusions), wb_cash_projection (A4 start, planned dates less confirmed, drafts, A7 day 1, A25 missed recurring dates, paid items, subscriptions, burn per day), wb_free_cash (low point, floor, floor_missing, reserve) and wb_true_cost.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-17 by Alex after 137: 42/42 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Dates are in 2031, so real data does not reach the burn months; everything else is measured as a
-- change caused by the fixtures, so real balances and subscriptions do not matter.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/138_wb_phase3_step5_tests.sql

create or replace function pg_temp.wb_test_p3_step5a()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  d0     date := date '2031-06-15';
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  a_cash uuid; a_card uuid; a_card2 uuid; a_emerg uuid; a_res uuid;
  sa uuid; sb uuid; sc uuid; sd uuid; se uuid; sf uuid;
  x_may uuid; x_part uuid;
  v_ids  uuid[];
  p_pay  uuid; p_part uuid;
  f0 record; f1 record;
  v_n    numeric; v_m numeric;
  tc0 record; tc1 record;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  -- ---------------------------------------------------------------- A12
  checks := checks || jsonb_build_object(
    'me_month', public.wb_monthly_equivalent(120, 12, 'month') = 10,
    'me_monthly', public.wb_monthly_equivalent(15, 1, 'month') = 15,
    'me_week', public.wb_monthly_equivalent(12, 1, 'week') = 52,
    'me_fortnight', public.wb_monthly_equivalent(30, 2, 'week') = 65,
    'me_no_interval', public.wb_monthly_equivalent(30, null, null) is null);

  -- Horizon 3 months, no floor (rolled back with everything else).
  insert into public.wb_settings (user_id, context_id, horizon_months, safety_floor) values (v_user, v_ctx, 3, null)
  on conflict (context_id) do update set horizon_months = 3, safety_floor = null;

  checks := checks || jsonb_build_object('precondition_no_real_2031_spending', not exists (
    select 1 from public.wb_transactions x
    where (coalesce(x.posted_at, x.transacted_at) at time zone 'America/Los_Angeles')::date between date '2031-03-01' and date '2031-06-30'));

  -- ---------------------------------------------------------------- A4: start balance
  select * into f0 from public.wb_free_cash(false, d0);
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'manual', null, 'ZZ cash ' || k, 'spending_cash') returning id into a_cash;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'manual', null, 'ZZ card ' || k, 'credit_card') returning id into a_card;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'manual', null, 'ZZ card in credit ' || k, 'credit_card') returning id into a_card2;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'manual', null, 'ZZ emergency ' || k, 'emergency_credit') returning id into a_emerg;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'manual', null, 'ZZ reserve ' || k, 'reserve_cash') returning id into a_res;
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source) values
    (v_user, v_ctx, a_cash,  date '2031-06-01', 1000, 'manual'),
    (v_user, v_ctx, a_cash,  date '2031-07-01', 9999, 'manual'),   -- after today: ignored
    (v_user, v_ctx, a_card,  date '2031-06-01', -200, 'manual'),
    (v_user, v_ctx, a_card2, date '2031-06-01',   50, 'manual'),   -- a credit balance is not cash
    (v_user, v_ctx, a_emerg, date '2031-06-01',  -70, 'manual'),
    (v_user, v_ctx, a_res,   date '2031-06-01', 5000, 'manual');
  select * into f1 from public.wb_free_cash(false, d0);
  checks := checks || jsonb_build_object(
    'start_cash_minus_owed', f1.start_balance - f0.start_balance = 730,
    'spending_cash_only_as_of_today', f1.spending_cash - f0.spending_cash = 1000,
    'credit_owed_cards_and_emergency', f1.credit_owed - f0.credit_owed = -270,
    'reserve_own_line', f1.reserve_cash - f0.reserve_cash = 5000,
    'reserve_not_in_free_cash', f1.free_cash - f0.free_cash = 730);

  -- ---------------------------------------------------------------- subscriptions
  select coalesce(sum(subscriptions), 0) into v_n from public.wb_cash_projection(false, d0);
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ sub monthly', 'monthly', 10, 'active', date '2031-06-20') returning id into sa;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ sub overdue', 'monthly', 10, 'active', date '2031-06-01') returning id into sb;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ sub paused', 'monthly', 10, 'paused', date '2031-06-20') returning id into sc;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on, term_end_date, auto_renew)
  values (v_user, v_ctx, 'ZZ sub prepaid', 'monthly', 10, 'active', date '2031-12-31', date '2031-12-31', false) returning id into sd;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, interval_count, interval_unit, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ sub fortnight', 'other', 2, 'week', 5, 'active', date '2031-06-16') returning id into se;
  checks := checks || jsonb_build_object(
    'sub_monthly_dates', (select array_agg(occurrence_on order by occurrence_on)
                          from public.wb_subscription_occurrences(d0, date '2031-09-14', d0) where subscription_id = sa)
                         = array[date '2031-06-20', date '2031-07-20', date '2031-08-20'],
    'sub_overdue_on_day_one', (select array_agg(occurrence_on order by occurrence_on)
                               from public.wb_subscription_occurrences(d0, date '2031-09-14', d0) where subscription_id = sb)
                              = array[d0, date '2031-07-01', date '2031-08-01', date '2031-09-01'],
    'sub_paused_and_prepaid_none', not exists (select 1 from public.wb_subscription_occurrences(d0, date '2031-09-14', d0)
                                               where subscription_id in (sc, sd)),
    'sub_weekly_count', (select count(*) from public.wb_subscription_occurrences(d0, date '2031-09-14', d0) where subscription_id = se) = 7,
    'sub_amount_negative', (select bool_and(amount = -10) from public.wb_subscription_occurrences(d0, date '2031-09-14', d0) where subscription_id = sa));
  select coalesce(sum(subscriptions), 0) into v_m from public.wb_cash_projection(false, d0);
  checks := checks || jsonb_build_object('projection_counts_subscriptions', v_m - v_n = -105);

  -- ---------------------------------------------------------------- burn
  with f(n, d, amt, kind) as (values
      (1, date '2031-03-10', -300.00, 'spend'),
      (2, date '2031-04-10', -100.00, 'spend'),
      (3, date '2031-04-11',   20.00, 'refund'),
      (4, date '2031-04-12',  -20.00, 'fee'),
      (5, date '2031-05-10', -200.00, 'spend'),
      (6, date '2031-05-11', -500.00, 'spend'),   -- on a project
      (7, date '2031-05-12',  -50.00, 'spend'),   -- a subscription charge
      (8, date '2031-05-13', -400.00, 'spend'),   -- 300 of it confirmed to a planned item
      (9, date '2031-05-14',  999.00, 'income'),  -- not spending
      (10, date '2031-06-10', -40.00, 'spend')),  -- this month: not in the burn months
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, kind, kind_source, raw)
    select v_user, v_ctx, a_card, 'ZZ-S5-' || lpad(f.n::text, 2, '0') || '-' || k, (f.d + time '12:00') at time zone 'America/Los_Angeles',
           f.amt, 'ZZ BURN ' || f.n, f.kind, 'manual', '{}'
    from f returning id, external_id)
  select array_agg(id order by external_id) into v_ids from ins;
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ S5 project ' || k);
  update public.wb_splits set project_id = (select id from public.wb_projects where name = 'ZZ S5 project ' || k)
  where transaction_id = v_ids[6];
  update public.wb_transactions set subscription_id = sc where id = v_ids[7];
  x_may := v_ids[8]; x_part := v_ids[10];
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S5 paid in May', -300, date '2031-05-10', 'invoiced') returning id into p_pay;
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (p_pay, (select id from public.wb_splits where transaction_id = x_may), -300, 'confirmed', 'manual');

  checks := checks || jsonb_build_object(
    'burn_months', (select array_agg(month order by month) from public.wb_burn_rate_on(d0))
                   = array[date '2031-03-01', date '2031-04-01', date '2031-05-01'],
    'burn_included', (select array_agg(included order by month) from public.wb_burn_rate_on(d0)) = array[-300, -100, -300]::numeric[],
    'burn_exclusions_may', (select project_excluded = -500 and subscription_excluded = -50 and matched_excluded = -300
                            from public.wb_burn_rate_on(d0) where month = date '2031-05-01'),
    'burn_median', (select max(burn_median) from public.wb_burn_rate_on(d0)) = -300,
    'burn_mean', (select max(burn_mean) from public.wb_burn_rate_on(d0)) = -233.33,
    'burn_per_day', (select bool_and(burn = round(-300::numeric * 12 / 365, 2)) from public.wb_cash_projection(false, d0)));

  -- ---------------------------------------------------------------- planned items
  select coalesce(sum(planned_out), 0) into v_n from public.wb_cash_projection(false, d0);
  select closing into v_m from public.wb_cash_projection(false, d0) where day = date '2031-09-14';
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage) values
    (v_user, v_ctx, 'ZZ S5 bill', -123, date '2031-07-01', 'estimate'),
    (v_user, v_ctx, 'ZZ S5 draft bill', -77, date '2031-07-02', 'draft'),
    (v_user, v_ctx, 'ZZ S5 overdue', -60, date '2031-06-01', 'invoiced'),
    (v_user, v_ctx, 'ZZ S5 already paid', -999, date '2031-07-03', 'paid');
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ S5 part paid', -100, date '2031-07-10', 'quoted') returning id into p_part;
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (p_part, (select id from public.wb_splits where transaction_id = x_part), -40, 'confirmed', 'manual');
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit, is_draft) values
    (v_user, v_ctx, 'ZZ S5 draft income', 40, date '2031-06-20', 1, 'month', true);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit) values
    (v_user, v_ctx, 'ZZ S5 premium', -25, date '2031-05-15', 1, 'month');

  checks := checks || jsonb_build_object(
    'bill_on_its_day', (select planned_out from public.wb_cash_projection(false, d0) where day = date '2031-07-01') = -123,
    'paid_item_none', (select planned_out from public.wb_cash_projection(false, d0) where day = date '2031-07-03') = 0,
    'part_paid_remaining', (select planned_out from public.wb_cash_projection(false, d0) where day = date '2031-07-10') = -60,
    -- Day 1: the overdue bill (60) and the premium due today (25); the May bill matched in full adds nothing.
    'day_one_overdue_and_premium', (select planned_out from public.wb_cash_projection(false, d0) where day = d0) = -85,
    -- The premium's missed 15 May is not counted: only 15 Jun, Jul and Aug.
    'missed_recurring_date_not_counted', (select sum(planned_out) from public.wb_cash_projection(false, d0)) - v_n = -123 - 60 - 60 - 75,
    'end_balance_delta', (select closing from public.wb_cash_projection(false, d0) where day = date '2031-09-14') - v_m = -318,
    'draft_out_by_default', (select planned_out from public.wb_cash_projection(false, d0) where day = date '2031-07-02') = 0,
    'draft_on_request', (select planned_out from public.wb_cash_projection(true, d0) where day = date '2031-07-02') = -77,
    'recurring_draft_on_request', (select sum(planned_in) from public.wb_cash_projection(true, d0)) = 120
                                  and (select sum(planned_in) from public.wb_cash_projection(false, d0)) = 0);
  select * into f0 from public.wb_free_cash(false, d0);

  -- ---------------------------------------------------------------- free cash and the floor
  checks := checks || jsonb_build_object(
    'low_is_min_closing', f0.low_balance = (select min(closing) from public.wb_cash_projection(false, d0))
                          and f0.low_on = (select min(day) from public.wb_cash_projection(false, d0)
                                           where closing = (select min(closing) from public.wb_cash_projection(false, d0))),
    'floor_missing_uses_zero', f0.floor_missing and f0.safety_floor = 0 and f0.free_cash = f0.low_balance,
    'horizon_from_settings', f0.horizon_months = 3
                             and (select max(day) from public.wb_cash_projection(false, d0)) = date '2031-09-14');
  update public.wb_settings set safety_floor = 100 where context_id = v_ctx;
  select * into f0 from public.wb_free_cash(false, d0);
  checks := checks || jsonb_build_object(
    'floor_subtracted', not f0.floor_missing and f0.free_cash = f0.low_balance - 100);

  -- ---------------------------------------------------------------- true cost (today's view)
  select * into tc0 from public.wb_true_cost;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit) values
    (v_user, v_ctx, 'ZZ S5 tc bill', -30, current_date, 1, 'month'),
    (v_user, v_ctx, 'ZZ S5 tc pay', 10, current_date, 1, 'week');
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit, is_draft) values
    (v_user, v_ctx, 'ZZ S5 tc draft', -1000, current_date, 1, 'month', true);
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ sub tc', 'annual', 120, 'active', current_date + 30) returning id into sf;
  select * into tc1 from public.wb_true_cost;
  checks := checks || jsonb_build_object(
    'tc_recurring_out', tc1.recurring_out_monthly - tc0.recurring_out_monthly = -30,
    'tc_income_weekly', tc1.expected_income_monthly - tc0.expected_income_monthly = 43.33,
    'tc_subscription_annual', tc1.subscriptions_monthly - tc0.subscriptions_monthly = -10,
    'tc_total', tc1.true_cost_monthly - tc0.true_cost_monthly = -40,
    'tc_net', tc1.net_monthly - tc0.net_monthly = 3.33,
    'tc_draft_left_out', tc1.recurring_out_monthly - tc0.recurring_out_monthly > -1000);

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step5a();
