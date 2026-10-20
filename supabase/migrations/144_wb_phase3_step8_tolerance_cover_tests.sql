-- Purpose: Warren Buffet Phase 3 Step 8b fix tests, run after 143_wb_phase3_step8_tolerance_cover.sql: wb_planned_left, and a bill and income each just within and just outside amount_tolerance in wb_planned_unmatched, wb_confirm_planned_match (auto-paid), wb_unconfirm_planned_match (paid_not_covered), wb_suggest_planned_matches, wb_project_summary and wb_cash_projection.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-20 by Alex after 143: 24/24 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Every check reads fixture rows only, or a change caused by them, so real data does not matter.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/144_wb_phase3_step8_tolerance_cover_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_merchant uuid, p_on date, p_amount numeric)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee,
                                      raw, merchant_id, merchant_source)
  select a.user_id, a.context_id, p_acct, 'ZZ-P8T-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, 'ZZ P8T test', 'ZZ P8T test', '{}', p_merchant, case when p_merchant is not null then 'manual' end
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_split(p_txn uuid)
returns uuid
language sql
as $$ select id from public.wb_splits where transaction_id = p_txn order by position limit 1; $$;

-- A planned item with one confirmed match of p_paid (signed like p_amount).
create or replace function pg_temp.zz_item(p_acct uuid, p_name text, p_amount numeric, p_tol numeric, p_due date,
                                           p_recurring boolean, p_paid numeric, p_project uuid default null)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
  v_t  uuid;
begin
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage,
                                       interval_count, interval_unit, ends_on, amount_tolerance)
  select a.user_id, a.context_id, p_project, p_name, p_amount, p_due,
         case when p_recurring then null else 'quoted' end,
         case when p_recurring then 1 end, case when p_recurring then 'month' end,
         case when p_recurring then p_due end, p_tol
  from public.wb_accounts a where a.id = p_acct
  returning id into v_id;
  if p_paid is not null then
    v_t := pg_temp.zz_txn(p_acct, null, p_due, p_paid);
    insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
    values (v_id, pg_temp.zz_split(v_t), case when p_recurring then p_due end, p_paid, 'confirmed', 'manual');
  end if;
  return v_id;
end;
$$;

create or replace function pg_temp.wb_test_p3_step8b_tolerance()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  d      date := (now() at time zone 'America/Los_Angeles')::date;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  v_acct uuid;
  mT uuid; mT2 uuid;
  pP uuid;
  r_bill_in uuid; r_bill_out uuid; r_inc_in uuid; r_inc_out uuid;
  o_bill_in uuid; o_bill_out uuid; o_inc_in uuid; o_inc_out uuid;
  pi_c uuid; pi_ci uuid; pi_u uuid; pi_s1 uuid; pi_s2 uuid;
  t1 uuid; t2 uuid;
  m1 uuid; m2 uuid;
  v_res  jsonb;
  p_out0 numeric; p_out1 numeric; p_in0 numeric; p_in1 numeric;
  s      record;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card ' || k, 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ mT ' || k, array[k || 'mt']) returning id into mT;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ mT2 ' || k, array[k || 'mtt']) returning id into mT2;

  -- ---------------------------------------------------------------- wb_planned_left
  checks := checks || jsonb_build_object(
    'left_bill_within', public.wb_planned_left(-100, 99.50, 1) = 0,
    'left_bill_at_edge', public.wb_planned_left(-100, 99.00, 1) = 0,
    'left_bill_outside', public.wb_planned_left(-100, 98.99, 1) = -1.01,
    'left_income_within', public.wb_planned_left(100, 99.01, 1) = 0,
    'left_income_outside', public.wb_planned_left(100, 98.99, 1) = 1.01,
    'left_no_tolerance', public.wb_planned_left(100, 0, 0) = 100 and public.wb_planned_left(100, 150, 0) = 0,
    'left_nulls', public.wb_planned_left(-100, null, null) = -100);

  -- ---------------------------------------------------------------- missed dates
  r_bill_in  := pg_temp.zz_item(v_acct, 'ZZ T bill in',  -50, 1, d - 10, true, -49.00);
  r_bill_out := pg_temp.zz_item(v_acct, 'ZZ T bill out', -50, 1, d - 10, true, -48.99);
  r_inc_in   := pg_temp.zz_item(v_acct, 'ZZ T pay in',   200, 2, d - 11, true, 198.01);
  r_inc_out  := pg_temp.zz_item(v_acct, 'ZZ T pay out',  200, 2, d - 11, true, 197.99);
  o_bill_in  := pg_temp.zz_item(v_acct, 'ZZ T one bill in',  -100, 1, d - 3, false, -99.50);
  o_bill_out := pg_temp.zz_item(v_acct, 'ZZ T one bill out', -100, 1, d - 3, false, -98.99);
  checks := checks || jsonb_build_object(
    'um_bill_within_not_missed', not exists (select 1 from public.wb_planned_unmatched where planned_item_id = r_bill_in),
    'um_bill_outside_missed', (select remaining = -1.01 from public.wb_planned_unmatched where planned_item_id = r_bill_out),
    'um_income_within_not_missed', not exists (select 1 from public.wb_planned_unmatched where planned_item_id = r_inc_in),
    'um_income_outside_missed', (select remaining = 2.01 from public.wb_planned_unmatched where planned_item_id = r_inc_out),
    'um_one_off_within_not_missed', not exists (select 1 from public.wb_planned_unmatched where planned_item_id = o_bill_in),
    'um_one_off_outside_missed', (select remaining = -1.01 and occurrence_on is null
                                  from public.wb_planned_unmatched where planned_item_id = o_bill_out));

  -- ---------------------------------------------------------------- confirm: auto-paid within tolerance
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, amount_tolerance)
  values (v_user, v_ctx, 'ZZ T confirm bill', -100, d - 2, 'invoiced', 1) returning id into pi_c;
  t1 := pg_temp.zz_txn(v_acct, null, d - 2, -99.50);
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_c, pg_temp.zz_split(t1), -99.50, 'suggested', 'manual') returning id into m1;
  v_res := public.wb_confirm_planned_match(m1, 'confirm');
  checks := checks || jsonb_build_object(
    'confirm_bill_within_paid', (v_res ->> 'stage_paid')::boolean
                                and (select stage = 'paid' from public.wb_planned_items where id = pi_c));
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, amount_tolerance)
  values (v_user, v_ctx, 'ZZ T confirm pay', 100, d - 2, 'invoiced', 1) returning id into pi_ci;
  t2 := pg_temp.zz_txn(v_acct, null, d - 2, 98.99);
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_ci, pg_temp.zz_split(t2), 98.99, 'suggested', 'manual') returning id into m2;
  v_res := public.wb_confirm_planned_match(m2, 'confirm');
  checks := checks || jsonb_build_object(
    'confirm_income_outside_not_paid', not (v_res ->> 'stage_paid')::boolean
                                       and (select stage = 'invoiced' from public.wb_planned_items where id = pi_ci));

  -- ---------------------------------------------------------------- unconfirm: paid_not_covered
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, amount_tolerance)
  values (v_user, v_ctx, 'ZZ T unconfirm', -100, d - 2, 'invoiced', 1) returning id into pi_u;
  t1 := pg_temp.zz_txn(v_acct, null, d - 2, -99.50);
  t2 := pg_temp.zz_txn(v_acct, null, d - 2, -0.40);
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_u, pg_temp.zz_split(t2), -0.40, 'confirmed', 'manual') returning id into m2;
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_u, pg_temp.zz_split(t1), -99.50, 'suggested', 'manual') returning id into m1;
  perform public.wb_confirm_planned_match(m1, 'confirm');
  v_res := public.wb_unconfirm_planned_match(m2);
  checks := checks || jsonb_build_object(
    'unconfirm_still_within_no_ask', not (v_res ->> 'paid_not_covered')::boolean and v_res ->> 'stage' = 'paid');
  v_res := public.wb_unconfirm_planned_match(m1);
  checks := checks || jsonb_build_object(
    'unconfirm_outside_asks', (v_res ->> 'paid_not_covered')::boolean);

  -- ---------------------------------------------------------------- suggestions
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, interval_count, interval_unit,
                                       ends_on, amount_tolerance, match_window_days)
  values (v_user, v_ctx, 'ZZ T sugg in', mT, -50, d - 20, 1, 'month', d - 20, 1, 5) returning id into pi_s1;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, interval_count, interval_unit,
                                       ends_on, amount_tolerance, match_window_days)
  values (v_user, v_ctx, 'ZZ T sugg out', mT2, -50, d - 20, 1, 'month', d - 20, 1, 5) returning id into pi_s2;
  t1 := pg_temp.zz_txn(v_acct, null, d - 20, -49.50);
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (pi_s1, pg_temp.zz_split(t1), d - 20, -49.50, 'confirmed', 'manual');
  t2 := pg_temp.zz_txn(v_acct, null, d - 20, -48.50);
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (pi_s2, pg_temp.zz_split(t2), d - 20, -48.50, 'confirmed', 'manual');
  perform pg_temp.zz_txn(v_acct, mT, d - 19, -50);
  perform pg_temp.zz_txn(v_acct, mT2, d - 19, -50);
  perform public.wb_suggest_planned_matches(null, array[pi_s1, pi_s2]);
  checks := checks || jsonb_build_object(
    'suggest_none_when_covered_within', not exists (select 1 from public.wb_planned_matches where planned_item_id = pi_s1 and status = 'suggested'),
    'suggest_more_when_outside', exists (select 1 from public.wb_planned_matches where planned_item_id = pi_s2 and status = 'suggested'));

  -- ---------------------------------------------------------------- project summary
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ T project ' || k) returning id into pP;
  perform pg_temp.zz_item(v_acct, 'ZZ T p bill in',  -100, 1, d + 10, false, -99.50, pP);
  perform pg_temp.zz_item(v_acct, 'ZZ T p bill out', -100, 1, d + 10, false, -98.99, pP);
  perform pg_temp.zz_item(v_acct, 'ZZ T p pay in',    100, 1, d + 10, false, 99.20, pP);
  perform pg_temp.zz_item(v_acct, 'ZZ T p pay out',   100, 1, d + 10, false, 98.90, pP);
  select * into s from public.wb_project_summary where project_id = pP;
  checks := checks || jsonb_build_object(
    'ps_out_due_only_outside', s.planned_out_due = -1.01,
    'ps_in_due_only_outside', s.planned_in_due = 1.10);

  -- ---------------------------------------------------------------- projection
  select planned_out, planned_in into p_out0, p_in0 from public.wb_cash_projection(false, d) where day = d + 6;
  perform pg_temp.zz_item(v_acct, 'ZZ T f bill in',  -50, 1, d + 6, true, -49.50);
  perform pg_temp.zz_item(v_acct, 'ZZ T f bill out', -50, 1, d + 6, true, -48.50);
  perform pg_temp.zz_item(v_acct, 'ZZ T f pay in',   200, 2, d + 6, true, 198.50);
  perform pg_temp.zz_item(v_acct, 'ZZ T f pay out',  200, 2, d + 6, true, 197.50);
  select planned_out, planned_in into p_out1, p_in1 from public.wb_cash_projection(false, d) where day = d + 6;
  checks := checks || jsonb_build_object(
    'proj_bill_only_outside', p_out1 - p_out0 = -1.50,
    'proj_income_only_outside', p_in1 - p_in0 = 2.50);
  -- An overdue one-off counts on day 1 only when more than its tolerance is left.
  select planned_out into p_out0 from public.wb_cash_projection(false, d) where day = d;
  perform pg_temp.zz_item(v_acct, 'ZZ T late in',  -100, 1, d - 4, false, -99.50);
  perform pg_temp.zz_item(v_acct, 'ZZ T late out', -100, 1, d - 4, false, -98.00);
  select planned_out into p_out1 from public.wb_cash_projection(false, d) where day = d;
  checks := checks || jsonb_build_object('proj_day1_only_outside', p_out1 - p_out0 = -2.00);

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step8b_tolerance();
