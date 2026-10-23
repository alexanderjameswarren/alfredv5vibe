-- Purpose: Warren Buffet Phase 3 Step 11 fix tests, run after the step 11 fixes migration (spec A57, A58): unfinished titles end with "…"; a paid one-off is never coming due, and an overdue one-off is a cause; the move amount is the shortfall at the lowest balance in the next 30 days; a late repeating date counts on day 1 unless a suggestion covers it; a fee's refund is a refund-kind credit used once, and refunds are not card-bill payments; next_30_projected covers 30 days; confirming a match clears the other suggestions for its date and its split; a past-due card bill is a flag only.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Dated checks use 2031-06-20 and compare against the projection itself, so real data does not decide
-- them; the title checks use today. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/6_step11_fixes_tests.sql

create or replace function pg_temp.zz_acct(p_name text, p_role text, p_close int default null, p_due int default null)
returns uuid
language sql
as $$
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role, statement_close_day, payment_due_day, autopay)
  select c.user_id, c.id, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), p_name, p_role, p_close, p_due,
         case when p_close is not null then 'none' end
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create or replace function pg_temp.zz_txn(p_acct uuid, p_on date, p_amount numeric, p_desc text, p_kind text default null)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw, kind)
  select a.user_id, a.context_id, p_acct, 'ZZ-P11-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, p_desc, p_desc, '{}', p_kind
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_item(p_name text, p_amount numeric, p_due date, p_stage text default 'invoiced',
                                           p_window int default 5, p_interval int default null)
returns uuid
language sql
as $$
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, match_window_days, interval_count, interval_unit)
  select c.user_id, c.id, p_name, p_amount, p_due, case when p_interval is null then p_stage end, p_window,
         p_interval, case when p_interval is not null then 'month' end
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create or replace function pg_temp.zz_rows(p_r jsonb, p_section text, p_id text)
returns jsonb
language sql
as $$ select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_r -> p_section) e where e ->> 'link_id' = p_id; $$;

create or replace function pg_temp.zz_title(p_r jsonb, p_section text, p_id text)
returns text
language sql
as $$ select e ->> 'title' from jsonb_array_elements(p_r -> p_section) e where e ->> 'link_id' = p_id limit 1; $$;

create or replace function pg_temp.zz_out(p_day date)
returns numeric
language sql
as $$ select planned_out from public.wb_cash_projection(false, date '2031-06-20') where day = p_day; $$;

create or replace function pg_temp.wb_test_p3_step11()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  t      date := date '2031-06-20';
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  chk uuid; ec uuid; cc uuid; cc2 uuid;
  p_paid uuid; p_ok uuid; p_over uuid; p_late uuid; p_late2 uuid; p_d1 uuid; p_d2 uuid; p_d3 uuid; p_a uuid; p_b uuid;
  f1 uuid; f2 uuid; f3 uuid; f4 uuid; cr1 uuid; x1 uuid; x2 uuid; x_late uuid;
  s_a uuid; s_b uuid; s_late uuid; m1 uuid; m2 uuid; m3 uuid;
  out_before numeric; out_late numeric; out_sugg numeric;
  c5 numeric; low30 numeric; low30_on date; lowall numeric; first_on date;
  r jsonb; r2 jsonb; r0 jsonb; b jsonb; conf jsonb;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  chk := pg_temp.zz_acct('ZZ checking ' || k, 'spending_cash');
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source)
  values (v_user, v_ctx, chk, t, 100000000, 'manual');

  -- ---------------------------------------------------------------- 3. a late repeating date on day 1, unless suggested
  out_before := pg_temp.zz_out(t);
  p_late := pg_temp.zz_item('ZZ S11 monthly late', -777.77, t - 2, null, 5, 1);
  out_late := pg_temp.zz_out(t);
  x_late := pg_temp.zz_txn(chk, t - 1, -777.77, 'ZZ LATE PAYMENT POSTED');
  select id into s_late from public.wb_splits where transaction_id = x_late;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (p_late, s_late, t - 2, -777.77, 'suggested', 'default');
  out_sugg := pg_temp.zz_out(t);
  checks := checks || jsonb_build_object(
    'late_repeating_counts_on_day_1', out_late - out_before = -777.77,
    'suggested_match_not_counted_twice', out_sugg = out_before);

  -- ---------------------------------------------------------------- 1. paid one-offs; overdue one-offs as causes
  p_paid := pg_temp.zz_item('ZZ S11 paid by hand', -2222, t + 3, 'paid');
  p_ok := pg_temp.zz_item('ZZ S11 still owed', -2500, t + 4);
  p_over := pg_temp.zz_item('ZZ S11 overdue', -333, t - 5);
  p_late2 := pg_temp.zz_item('ZZ S11 monthly late, no match', -11.11, t - 1, null, 5, 1);

  -- ---------------------------------------------------------------- 4. refunds
  ec := pg_temp.zz_acct('ZZ line ' || k, 'emergency_credit');
  f1 := pg_temp.zz_txn(ec, t - 20, -31, 'LATE FEE');
  f2 := pg_temp.zz_txn(ec, t - 15, -31, 'LATE FEE');
  cr1 := pg_temp.zz_txn(ec, t - 10, 31, 'LATE FEE REVERSAL', 'refund');          -- refunds f1 only
  f3 := pg_temp.zz_txn(ec, t - 20, -44, 'ANNUAL FEE');
  x1 := pg_temp.zz_txn(ec, t - 10, 44, 'ZZ TRANSFER IN', 'transfer');            -- a paired transfer: not a refund
  x2 := pg_temp.zz_txn(chk, t - 10, -44, 'ZZ TRANSFER OUT', 'transfer');
  update public.wb_transactions set transfer_pair_id = x2 where id = x1;
  update public.wb_transactions set transfer_pair_id = x1 where id = x2;
  f4 := pg_temp.zz_txn(ec, t - 20, -55, 'INTEREST CHARGE');
  perform pg_temp.zz_txn(ec, t - 9, 55, 'ONLINE PAYMENT THANK YOU', 'refund');   -- a payment, whatever its kind
  -- A card bill: 100 owed at the close, a 100 refund and a 40 payment since: 60 still owed.
  cc := pg_temp.zz_acct('ZZ card ' || k, 'credit_card', 1, 25);
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source)
  values (v_user, v_ctx, cc, date '2031-06-01', -100, 'manual');
  perform pg_temp.zz_txn(cc, date '2031-06-05', 100, 'ZZ STORE REFUND', 'refund');
  perform pg_temp.zz_txn(cc, date '2031-06-06', 40, 'ONLINE PAYMENT', 'transfer');
  -- 7. A card bill past due.
  cc2 := pg_temp.zz_acct('ZZ card two ' || k, 'credit_card', 1, 15);
  insert into public.wb_balance_snapshots (user_id, context_id, account_id, as_of, balance, source)
  values (v_user, v_ctx, cc2, date '2031-06-01', -80, 'manual');

  -- ---------------------------------------------------------------- 2. the floor: a drop at t+5, the 30-day low at t+20, a deeper one at t+40
  p_d1 := pg_temp.zz_item('ZZ S11 drop one', -1000000, t + 5);
  p_d2 := pg_temp.zz_item('ZZ S11 drop two', -2000000, t + 20);
  p_d3 := pg_temp.zz_item('ZZ S11 drop three', -900000000, t + 40);
  insert into public.wb_settings (user_id, context_id, horizon_months) values (v_user, v_ctx, 12)
  on conflict (context_id) do nothing;
  select closing into c5 from public.wb_cash_projection(false, t) where day = t + 5;
  update public.wb_settings set safety_floor = c5 + 1 where context_id = v_ctx;
  select p.closing, p.day into low30, low30_on from public.wb_cash_projection(false, t) p
  where p.day < t + 30 order by p.closing, p.day limit 1;
  select min(closing) into lowall from public.wb_cash_projection(false, t);
  select min(day) into first_on from public.wb_cash_projection(false, t) where day < t + 30 and closing < c5 + 1;

  r := public.wb_action_items(14, 1000, 60, t);
  b := r -> 'below_floor';

  checks := checks || jsonb_build_object(
    'paid_one_off_not_coming_up', jsonb_array_length(pg_temp.zz_rows(r, 'coming_up', p_paid::text)) = 0,
    'paid_one_off_not_big', jsonb_array_length(pg_temp.zz_rows(r, 'big_bites', p_paid::text)) = 0,
    'owed_one_off_still_coming_up', jsonb_array_length(pg_temp.zz_rows(r, 'coming_up', p_ok::text)) = 1
                                    and jsonb_array_length(pg_temp.zz_rows(r, 'big_bites', p_ok::text)) = 1,
    'paid_one_off_not_a_cause', jsonb_array_length(pg_temp.zz_rows(b, 'causes', p_paid::text)) = 0,
    'overdue_one_off_is_a_cause', (pg_temp.zz_rows(b, 'causes', p_over::text) -> 0 ->> 'amount')::numeric = -333,
    'late_repeating_in_path', exists (select 1 from jsonb_array_elements(b -> 'path') e
                                      where e ->> 'link_id' = p_late2::text and e ->> 'title' like '%(late)')
                              and not exists (select 1 from jsonb_array_elements(b -> 'path') e
                                              where e ->> 'link_id' = p_late::text and e ->> 'title' like '%(late)'));

  checks := checks || jsonb_build_object(
    'move_is_the_30_day_low', (b ->> 'shortfall_30d')::numeric = round(c5 + 1 - low30, 2)
                               and (b ->> 'low_30d_on')::date = low30_on,
    'move_is_not_the_horizon_low', (b ->> 'shortfall_30d')::numeric <> round(c5 + 1 - lowall, 2),
    'by_the_first_day_below', (b ->> 'first_below_on')::date = first_on and first_on = t + 5,
    'no_other_move_amounts', not (b ? 'shortfall_then') and not (b ? 'shortfall_at_low'),
    'todo_names_the_amount', b ->> 'todo' like 'Move $%from the reserve by %',
    'path_ends_on_the_low_day', (select max((e ->> 'on')::date) from jsonb_array_elements(b -> 'path') e) = low30_on);

  -- Below only after 30 days: nothing to move.
  update public.wb_settings set safety_floor = greatest(low30 - 1, 0) where context_id = v_ctx;
  r2 := public.wb_action_items(14, 1000, 60, t);
  checks := checks || jsonb_build_object(
    'no_move_when_30_days_stay_above', r2 -> 'below_floor' -> 'first_below_on' = 'null'::jsonb
                                       and r2 -> 'below_floor' -> 'shortfall_30d' = 'null'::jsonb
                                       and r2 -> 'below_floor' -> 'path' = '[]'::jsonb);

  checks := checks || jsonb_build_object(
    'refund_kind_credit_refunds_the_first_fee', (pg_temp.zz_rows(r, 'flags', f1::text) -> 0 ->> 'severity') = 'info'
                                                and (pg_temp.zz_rows(r, 'flags', f1::text) -> 0 -> 'refund' ->> 'link_id') = cr1::text,
    'one_credit_refunds_one_fee', (pg_temp.zz_rows(r, 'flags', f2::text) -> 0 ->> 'severity') = 'red',
    'paired_transfer_is_not_a_refund', (pg_temp.zz_rows(r, 'flags', f3::text) -> 0 ->> 'severity') = 'red',
    'payment_is_not_a_refund', (pg_temp.zz_rows(r, 'flags', f4::text) -> 0 ->> 'severity') = 'red',
    'refund_is_not_a_card_payment', (pg_temp.zz_rows(r, 'card_bills', cc::text) -> 0 ->> 'amount')::numeric = -60,
    'past_due_bill_is_a_flag', (pg_temp.zz_rows(r, 'flags', cc2::text) -> 0 ->> 'type') = 'card_bill',
    'past_due_bill_not_in_card_bills', jsonb_array_length(pg_temp.zz_rows(r, 'card_bills', cc2::text)) = 0,
    'next_30_is_30_days', (r -> 'cash_flow' ->> 'next_30_projected')::numeric
                          = (select round(max(closing) filter (where day = t + 29) - max(opening) filter (where day = t), 2)
                             from public.wb_cash_projection(false, t)));

  -- ---------------------------------------------------------------- 6. confirming clears the other suggestions
  p_a := pg_temp.zz_item('ZZ S11 item A', -66.66, t + 100);
  p_b := pg_temp.zz_item('ZZ S11 item B', -66.66, t + 100);
  x1 := pg_temp.zz_txn(chk, t + 99, -66.66, 'ZZ PAY A');
  x2 := pg_temp.zz_txn(chk, t + 98, -66.66, 'ZZ PAY B');
  select id into s_a from public.wb_splits where transaction_id = x1;
  select id into s_b from public.wb_splits where transaction_id = x2;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (p_a, s_a, null, -66.66, 'suggested', 'default') returning id into m1;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (p_a, s_b, null, -66.66, 'suggested', 'default') returning id into m2;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  values (p_b, s_a, null, -66.66, 'suggested', 'default') returning id into m3;
  conf := public.wb_confirm_planned_match(m1, 'confirm');
  checks := checks || jsonb_build_object(
    'confirm_clears_same_date', not exists (select 1 from public.wb_planned_matches where id = m2),
    'confirm_clears_same_split', not exists (select 1 from public.wb_planned_matches where id = m3),
    'confirm_reports_removed', (conf ->> 'suggestions_removed')::int = 2 and conf ->> 'status' = 'confirmed');

  -- ---------------------------------------------------------------- A57: unfinished titles (today)
  insert into public.intents (id, text, is_intention, context_id, user_id, status) values
    (k || 'i1', 'ZZ S11 confirm the card did not charge, and', true, v_ctx, v_user, 'active'),
    (k || 'i2', 'ZZ S11 call the bank', true, v_ctx, v_user, 'active'),
    (k || 'i3', 'ZZ S11 Q4 plan:', true, v_ctx, v_user, 'someday'),
    (k || 'i4', 'ZZ S11 pick a brand', true, v_ctx, v_user, 'someday');
  insert into public.inbox (id, captured_text, suggested_intent_text, suggested_context_id, user_id) values
    (k || 'b1', 'ZZ S11 receipt', 'ZZ S11 file the receipt from', v_ctx, v_user),
    (k || 'b2', 'ZZ S11 short', null, v_ctx, v_user),
    (k || 'b3', repeat('ZZ S11 long text and ', 10), null, v_ctx, v_user);
  r0 := public.wb_action_items();
  checks := checks || jsonb_build_object(
    'intention_trailing_and', pg_temp.zz_title(r0, 'money_intentions', k || 'i1') = 'ZZ S11 confirm the card did not charge, and…',
    'intention_finished_untouched', pg_temp.zz_title(r0, 'money_intentions', k || 'i2') = 'ZZ S11 call the bank',
    'intention_trailing_colon', pg_temp.zz_title(r0, 'money_intentions', k || 'i3') = 'ZZ S11 Q4 plan:…',
    'intention_word_containing_and_untouched', pg_temp.zz_title(r0, 'money_intentions', k || 'i4') = 'ZZ S11 pick a brand',
    'inbox_trailing_from', pg_temp.zz_title(r0, 'money_inbox', k || 'b1') = 'ZZ S11 file the receipt from…',
    'inbox_finished_untouched', pg_temp.zz_title(r0, 'money_inbox', k || 'b2') = 'ZZ S11 short',
    'inbox_long_cut_once', (select length(x) = 120 and right(x, 1) = '…' and right(x, 2) <> '……'
                            from pg_temp.zz_title(r0, 'money_inbox', k || 'b3') x));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step11();
