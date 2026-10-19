-- Purpose: Warren Buffet Phase 3 Step 8a tests, run after 140_wb_phase3_step8_plan_tab.sql: wb_planned_skips (owner fill, occurrence checks), wb_planned_unmatched (past recurring dates less confirmed, part-paid, skips, overdue one-offs, drafts/paid/cancelled/future left out, within_window, has_suggestion), wb_project_summary (spent, received, net, budget_left, still due, drafts apart, counts, planning), wb_unconfirm_planned_match (rejected, stage kept, paid_not_covered, not suggested again), wb_planned_start_from_history (burn window, sign, tolerance, pending, fully confirmed splits) and wb_transaction_list.project_names.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-19 by Alex after 140: 48/48 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Every check reads fixture rows only, so real planned items and payments do not matter.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/141_wb_phase3_step8_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_merchant uuid, p_on date, p_amount numeric, p_pending boolean default false)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee,
                                      raw, merchant_id, merchant_source, pending)
  select a.user_id, a.context_id, p_acct, 'ZZ-P8-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, 'ZZ P8 test', 'ZZ P8 test', '{}', p_merchant, case when p_merchant is not null then 'manual' end, p_pending
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_split(p_txn uuid)
returns uuid
language sql
as $$ select id from public.wb_splits where transaction_id = p_txn order by position limit 1; $$;

create or replace function pg_temp.wb_test_p3_step8a()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  d      date := (now() at time zone 'America/Los_Angeles')::date;
  d1     date;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  v_acct uuid;
  mA uuid; mB uuid; mC uuid;
  pP uuid; pQ uuid; pR uuid;
  pi_r uuid; pi_o uuid; pi_paid uuid; pi_dr uuid; pi_fut uuid; pi_rdr uuid;
  pi_q uuid; pi_qd uuid; pi_qx uuid; pi_qr uuid; pi_qq uuid;
  pi_u uuid; pi_ur uuid; pi_other uuid;
  t1 uuid; t2 uuid; t3 uuid; tp1 uuid; tp2 uuid; tpp uuid; tq uuid; tu uuid; tur uuid; tm uuid;
  h1 uuid; h2 uuid; h3 uuid; h4 uuid; h5 uuid; h6 uuid;
  v_mid  uuid;
  v_res  jsonb;
  v_err  text;
  s      record;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card ' || k, 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ mA ' || k, array[k || 'ma']) returning id into mA;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ mB ' || k, array[k || 'mb']) returning id into mB;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ mC ' || k, array[k || 'mc']) returning id into mC;

  -- ---------------------------------------------------------------- missed dates
  -- Monthly on day 5, three months back, ending two months later: three past dates.
  d1 := (date_trunc('month', d) - interval '3 months')::date + 4;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, interval_count, interval_unit, ends_on)
  values (v_user, v_ctx, 'ZZ P8 premium', mA, -50, d1, 1, 'month', (d1 + interval '2 months')::date) returning id into pi_r;
  t1 := pg_temp.zz_txn(v_acct, mA, d1, -50);
  t2 := pg_temp.zz_txn(v_acct, mA, (d1 + interval '1 month')::date, -20);
  t3 := pg_temp.zz_txn(v_acct, mA, (d1 + interval '1 month')::date, -30);
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source) values
    (pi_r, pg_temp.zz_split(t1), d1, -50, 'confirmed', 'manual'),
    (pi_r, pg_temp.zz_split(t2), (d1 + interval '1 month')::date, -20, 'confirmed', 'manual'),
    (pi_r, pg_temp.zz_split(t3), (d1 + interval '1 month')::date, -30, 'suggested', 'manual');
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ P8 overdue', -100, d - 5, 'invoiced', 10) returning id into pi_o;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ P8 paid', -100, d - 5, 'paid') returning id into pi_paid;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ P8 draft', -100, d - 5, 'draft') returning id into pi_dr;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ P8 future', -100, d + 5, 'quoted') returning id into pi_fut;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit, is_draft)
  values (v_user, v_ctx, 'ZZ P8 rec draft', -10, d1, 1, 'month', true) returning id into pi_rdr;

  checks := checks || jsonb_build_object(
    'um_full_match_gone', not exists (select 1 from public.wb_planned_unmatched where planned_item_id = pi_r and occurrence_on = d1),
    'um_part_paid_left', (select confirmed_total = -20 and remaining = -30 and recurring and due_on = occurrence_on
                          from public.wb_planned_unmatched where planned_item_id = pi_r and occurrence_on = (d1 + interval '1 month')::date),
    'um_has_suggestion', (select has_suggestion from public.wb_planned_unmatched
                          where planned_item_id = pi_r and occurrence_on = (d1 + interval '1 month')::date),
    'um_unpaid_date', (select remaining = -50 and not has_suggestion and days_late = d - (d1 + interval '2 months')::date
                       from public.wb_planned_unmatched where planned_item_id = pi_r and occurrence_on = (d1 + interval '2 months')::date),
    'um_recurring_count', (select count(*) from public.wb_planned_unmatched where planned_item_id = pi_r) = 2,
    'um_overdue_one_off', (select not recurring and occurrence_on is null and due_on = d - 5 and days_late = 5 and within_window
                                  and remaining = -100 and stage = 'invoiced'
                           from public.wb_planned_unmatched where planned_item_id = pi_o),
    'um_left_out', not exists (select 1 from public.wb_planned_unmatched where planned_item_id in (pi_paid, pi_dr, pi_fut, pi_rdr)));
  update public.wb_planned_items set match_window_days = 2 where id = pi_o;
  checks := checks || jsonb_build_object(
    'um_past_window', (select not within_window from public.wb_planned_unmatched where planned_item_id = pi_o));

  -- Skips
  insert into public.wb_planned_skips (planned_item_id, occurrence_on, reason)
  values (pi_r, (d1 + interval '2 months')::date, 'ZZ before the sync');
  insert into public.wb_planned_skips (planned_item_id) values (pi_o);
  checks := checks || jsonb_build_object(
    'skip_fills_owner', (select user_id = v_user and context_id = v_ctx from public.wb_planned_skips
                         where planned_item_id = pi_r),
    'skip_hides_date', not exists (select 1 from public.wb_planned_unmatched
                                   where planned_item_id = pi_r and occurrence_on = (d1 + interval '2 months')::date),
    'skip_keeps_other_dates', exists (select 1 from public.wb_planned_unmatched
                                      where planned_item_id = pi_r and occurrence_on = (d1 + interval '1 month')::date),
    'skip_one_off', not exists (select 1 from public.wb_planned_unmatched where planned_item_id = pi_o));
  begin
    insert into public.wb_planned_skips (planned_item_id) values (pi_r);
    v_err := 'none';
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('skip_recurring_needs_date', v_err like '%needs occurrence_on%');
  begin
    insert into public.wb_planned_skips (planned_item_id, occurrence_on) values (pi_fut, d);
    v_err := 'none';
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('skip_one_off_no_date', v_err like '%has no occurrence_on%');
  begin
    insert into public.wb_planned_skips (planned_item_id) values (pi_o);
    v_err := 'none';
  exception when unique_violation then v_err := 'unique';
  end;
  checks := checks || jsonb_build_object('skip_once', v_err = 'unique');
  delete from public.wb_planned_items where id = pi_o;
  checks := checks || jsonb_build_object(
    'skip_goes_with_item', not exists (select 1 from public.wb_planned_skips where planned_item_id = pi_o));

  -- ---------------------------------------------------------------- project summary
  insert into public.wb_projects (user_id, context_id, name, budget) values (v_user, v_ctx, 'ZZ P8 claim ' || k, 1000) returning id into pP;
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ P8 dream ' || k) returning id into pQ;
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ P8 empty ' || k) returning id into pR;
  tp1 := pg_temp.zz_txn(v_acct, mB, d - 20, -300);
  tp2 := pg_temp.zz_txn(v_acct, null, d - 10, 120);
  tpp := pg_temp.zz_txn(v_acct, mB, d - 1, -999, true);
  update public.wb_splits set project_id = pP where transaction_id in (tp1, tp2, tpp);
  insert into public.wb_planned_items (user_id, context_id, project_id, name, merchant_id, amount, due_on, stage)
  values (v_user, v_ctx, pP, 'ZZ P8 contractor', mB, -500, d + 10, 'quoted') returning id into pi_q;
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_q, pg_temp.zz_split(tp1), -200, 'confirmed', 'manual');
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage)
  values (v_user, v_ctx, pP, 'ZZ P8 extra', -400, d + 20, 'draft') returning id into pi_qd;
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage)
  values (v_user, v_ctx, pP, 'ZZ P8 dropped', -50, d + 20, 'cancelled') returning id into pi_qx;
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, interval_count, interval_unit, ends_on)
  values (v_user, v_ctx, pP, 'ZZ P8 insurer', 60, d, 1, 'month', (d + interval '1 month')::date) returning id into pi_qr;
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage)
  values (v_user, v_ctx, pQ, 'ZZ P8 trip', -900, d + 60, 'draft') returning id into pi_qq;

  select * into s from public.wb_project_summary where project_id = pP;
  checks := checks || jsonb_build_object(
    'ps_spent_gross_out', s.spent = -300,
    'ps_received', s.received = 120,
    'ps_net', s.net = -180,
    'ps_budget_against_spent', s.budget_left = 700,
    'ps_due_out_less_confirmed', s.planned_out_due = -300,
    'ps_due_in_recurring', s.planned_in_due = 120,
    'ps_drafts_apart', s.draft_out_due = -400 and s.draft_in_due = 0,
    'ps_counts', s.item_count = 3 and s.draft_count = 1 and s.payment_count = 2,
    'ps_pending_left_out', s.last_payment_on = d - 10,
    'ps_not_planning', not s.planning);
  select * into s from public.wb_project_summary where project_id = pQ;
  checks := checks || jsonb_build_object(
    'ps_planning_all_drafts', s.planning and s.spent = 0 and s.budget_left is null and s.draft_out_due = -900);
  checks := checks || jsonb_build_object(
    'ps_empty_not_planning', (select not planning and item_count = 0 and net = 0 from public.wb_project_summary where project_id = pR));
  tq := pg_temp.zz_txn(v_acct, null, d - 3, -5);
  update public.wb_splits set project_id = pQ where transaction_id = tq;
  checks := checks || jsonb_build_object(
    'ps_payment_ends_planning', (select not planning from public.wb_project_summary where project_id = pQ));

  -- ---------------------------------------------------------------- project_names
  tm := pg_temp.zz_txn(v_acct, null, d - 2, -40);
  perform public.wb_replace_splits(tm, jsonb_build_array(
    jsonb_build_object('amount', -10, 'project_id', pQ),
    jsonb_build_object('amount', -20, 'project_id', pP),
    jsonb_build_object('amount', -10)), 'manual');
  checks := checks || jsonb_build_object(
    'tl_project_names_single', (select project_names = array['ZZ P8 claim ' || k] from public.wb_transaction_list where id = tp1),
    'tl_project_names_sorted', (select project_names = array['ZZ P8 claim ' || k, 'ZZ P8 dream ' || k] from public.wb_transaction_list where id = tm),
    'tl_project_names_empty', (select project_names = '{}'::text[] from public.wb_transaction_list where id = t1));

  -- ---------------------------------------------------------------- unconfirm
  tu := pg_temp.zz_txn(v_acct, mB, d - 4, -100);
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ P8 invoice', mB, -100, d - 4, 'invoiced', 5) returning id into pi_u;
  perform public.wb_suggest_planned_matches(null, array[pi_u]);
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi_u and status = 'suggested';
  v_res := public.wb_confirm_planned_match(v_mid, 'confirm');
  checks := checks || jsonb_build_object('un_precondition_paid', (v_res ->> 'stage_paid')::boolean);
  v_res := public.wb_unconfirm_planned_match(v_mid);
  checks := checks || jsonb_build_object(
    'un_rejected', (select status = 'rejected' and decided_at is not null from public.wb_planned_matches where id = v_mid),
    'un_stage_kept', (select stage = 'paid' from public.wb_planned_items where id = pi_u),
    'un_asks_set_back', (v_res ->> 'paid_not_covered')::boolean and v_res ->> 'stage' = 'paid'
                        and (v_res ->> 'confirmed_total')::numeric = 0);
  begin
    perform public.wb_unconfirm_planned_match(v_mid);
    v_err := 'none';
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('un_only_confirmed', v_err like '%not confirmed%');
  update public.wb_planned_items set stage = 'invoiced' where id = pi_u;
  perform public.wb_suggest_planned_matches(null, array[pi_u]);
  checks := checks || jsonb_build_object(
    'un_not_suggested_again', not exists (select 1 from public.wb_planned_matches where planned_item_id = pi_u and status = 'suggested'),
    'un_shows_missed', exists (select 1 from public.wb_planned_unmatched where planned_item_id = pi_u));
  tur := pg_temp.zz_txn(v_acct, mA, d - 1, -15);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ P8 rec', -15, d - 1, 1, 'month') returning id into pi_ur;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (pi_ur, pg_temp.zz_split(tur), d - 1, -15, 'confirmed', 'manual') returning id into v_mid;
  v_res := public.wb_unconfirm_planned_match(v_mid);
  checks := checks || jsonb_build_object(
    'un_recurring_no_ask', not (v_res ->> 'paid_not_covered')::boolean and v_res -> 'stage' = 'null'::jsonb);

  -- ---------------------------------------------------------------- start from history
  -- Today 2031-06-15: the burn months are March to May, so the window starts 2031-03-01.
  h1 := pg_temp.zz_txn(v_acct, mC, date '2031-02-20', -40);
  h2 := pg_temp.zz_txn(v_acct, mC, date '2031-03-10', -40);
  h3 := pg_temp.zz_txn(v_acct, mC, date '2031-03-05', -41);
  h4 := pg_temp.zz_txn(v_acct, mC, date '2031-06-10', -40);
  h5 := pg_temp.zz_txn(v_acct, mC, date '2031-03-02', 40);
  h6 := pg_temp.zz_txn(v_acct, mC, date '2031-03-01', -40, true);
  checks := checks || jsonb_build_object(
    'sh_window_sign_pending', public.wb_planned_start_from_history(mC, -40, 0, date '2031-06-15') = date '2031-03-10',
    'sh_tolerance', public.wb_planned_start_from_history(mC, -40, 2, date '2031-06-15') = date '2031-03-05',
    'sh_income_sign', public.wb_planned_start_from_history(mC, 40, 0, date '2031-06-15') = date '2031-03-02',
    'sh_window_moves_with_today', public.wb_planned_start_from_history(mC, -40, 0, date '2031-03-09') = date '2031-02-20',
    'sh_nothing_after_today', public.wb_planned_start_from_history(mC, -40, 0, date '2031-02-19') is null,
    'sh_no_merchant', public.wb_planned_start_from_history(null, -40, 0, date '2031-06-15') is null,
    'sh_none_found', public.wb_planned_start_from_history(mC, -999, 0, date '2031-06-15') is null);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ P8 other', -40, date '2031-03-10', 'invoiced') returning id into pi_other;
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_other, pg_temp.zz_split(h2), -40, 'confirmed', 'manual');
  checks := checks || jsonb_build_object(
    'sh_skips_used_split', public.wb_planned_start_from_history(mC, -40, 0, date '2031-06-15') = date '2031-06-10');

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step8a();
