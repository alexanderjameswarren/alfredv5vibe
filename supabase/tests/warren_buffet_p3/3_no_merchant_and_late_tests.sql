-- Purpose: Warren Buffet Phase 3 Step 9b fix tests, run after 151_wb_phase3_step9b_no_merchant_matches.sql (spec A51): suggestions for planned items with no merchant (a cashed check, a mobile deposit, a repeating item; never a transfer between our own accounts, a payment already matched, the wrong sign or an amount off by a cent; a payment with no merchant preferred), and wb_action_items' deposit todos, late rows in coming_up, and cut titles.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Suggestion and subscription checks use 2031 dates; the late planned checks use today, because
-- wb_planned_unmatched does. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/3_no_merchant_and_late_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_on date, p_amount numeric, p_desc text, p_merchant uuid default null)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw, merchant_id)
  select a.user_id, a.context_id, p_acct, 'ZZ-P9B-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, p_desc, p_desc, '{}', p_merchant
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_item(p_name text, p_amount numeric, p_due date, p_window int default 5,
                                           p_interval int default null)
returns uuid
language sql
as $$
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, match_window_days,
                                       interval_count, interval_unit)
  select c.user_id, c.id, p_name, p_amount, p_due, case when p_interval is null then 'invoiced' end, p_window,
         p_interval, case when p_interval is not null then 'month' end
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- The suggested match for one planned item: its transaction and due date, or null.
create or replace function pg_temp.zz_sugg(p_item uuid)
returns jsonb
language sql
as $$
  select jsonb_build_object('transaction_id', m.transaction_id, 'occurrence_on', m.occurrence_on, 'n', count(*) over ())
  from public.wb_planned_matches m where m.planned_item_id = p_item and m.status = 'suggested' limit 1;
$$;

create or replace function pg_temp.zz_rows(p_r jsonb, p_section text, p_id text)
returns jsonb
language sql
as $$ select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(p_r -> p_section) e where e ->> 'link_id' = p_id; $$;

create or replace function pg_temp.wb_test_p3_step9b()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  t      date := date '2031-06-20';
  d      date := (now() at time zone 'America/Los_Angeles')::date;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  chk uuid; sav uuid; merch uuid;
  p_check uuid; p_dep uuid; p_xfer uuid; p_taken uuid; p_other uuid; p_pref uuid; p_rep uuid; p_cent uuid; p_sign uuid;
  x_check uuid; x_dep uuid; x_out uuid; x_in uuid; x_taken uuid; x_pref_m uuid; x_pref_n uuid; x_rep uuid;
  p_in uuid; p_out uuid; p_late uuid; p_old uuid; p_late_in uuid;
  s_late uuid; s_over uuid; s_next uuid;
  r jsonb; r0 jsonb; row jsonb;
  long_text text := repeat('ZZ S9B long receipt text ', 10);
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ checking ' || k, 'spending_cash') returning id into chk;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ savings ' || k, 'reserve_cash') returning id into sav;
  insert into public.wb_merchants (user_id, context_id, name) values (v_user, v_ctx, 'ZZ S9B shop ' || k) returning id into merch;

  -- ---------------------------------------------------------------- 1. suggestions for items with no merchant
  p_check := pg_temp.zz_item('ZZ S9B contractor check', -12345.67, date '2031-06-10');
  x_check := pg_temp.zz_txn(chk, date '2031-06-12', -12345.67, 'DEPOSITED OR CASHED CHECK');
  p_dep := pg_temp.zz_item('ZZ S9B refund in', 2345.67, date '2031-06-09');
  x_dep := pg_temp.zz_txn(chk, date '2031-06-11', 2345.67, 'MOBILE DEPOSIT');
  -- A transfer between our own accounts, paired: never a match.
  p_xfer := pg_temp.zz_item('ZZ S9B looks like a move', -3456.78, date '2031-06-10');
  x_out := pg_temp.zz_txn(chk, date '2031-06-10', -3456.78, 'ONLINE TRANSFER TO SAVINGS');
  x_in := pg_temp.zz_txn(sav, date '2031-06-10', 3456.78, 'ONLINE TRANSFER FROM CHECKING');
  update public.wb_transactions set transfer_pair_id = x_in, kind = 'transfer', kind_source = 'manual' where id = x_out;
  update public.wb_transactions set transfer_pair_id = x_out, kind = 'transfer', kind_source = 'manual' where id = x_in;
  -- A payment already confirmed against another item: never suggested again.
  p_other := pg_temp.zz_item('ZZ S9B first claim', -4567.89, date '2031-06-08');
  p_taken := pg_temp.zz_item('ZZ S9B second claim', -4567.89, date '2031-06-08');
  x_taken := pg_temp.zz_txn(chk, date '2031-06-08', -4567.89, 'CHECK 1001');
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status, source)
  select p_other, s.id, null, -4567.89, 'confirmed', 'manual' from public.wb_splits s where s.transaction_id = x_taken;
  -- Two payments fit: the one with no merchant wins, though the other is closer in date.
  p_pref := pg_temp.zz_item('ZZ S9B handyman', -5678.90, date '2031-06-10');
  x_pref_m := pg_temp.zz_txn(chk, date '2031-06-10', -5678.90, 'ZZ SHOP', merch);
  x_pref_n := pg_temp.zz_txn(chk, date '2031-06-13', -5678.90, 'CHECK 1002');
  -- A repeating item with no merchant.
  p_rep := pg_temp.zz_item('ZZ S9B monthly cash', -678.91, date '2031-05-15', 5, 1);
  x_rep := pg_temp.zz_txn(chk, date '2031-06-16', -678.91, 'ZELLE TO ZZ PERSON');
  -- Tolerance 0 means exact; the sign must agree.
  p_cent := pg_temp.zz_item('ZZ S9B off by a cent', -789.12, date '2031-06-10');
  perform pg_temp.zz_txn(chk, date '2031-06-10', -789.13, 'CHECK 1003');
  p_sign := pg_temp.zz_item('ZZ S9B wrong way', 891.23, date '2031-06-10');
  perform pg_temp.zz_txn(chk, date '2031-06-10', -891.23, 'CHECK 1004');

  perform public.wb_suggest_planned_matches(null,
    array[p_check, p_dep, p_xfer, p_taken, p_other, p_pref, p_rep, p_cent, p_sign]);

  checks := checks || jsonb_build_object(
    'cashed_check_suggested', (pg_temp.zz_sugg(p_check) ->> 'transaction_id')::uuid = x_check,
    'mobile_deposit_suggested', (pg_temp.zz_sugg(p_dep) ->> 'transaction_id')::uuid = x_dep,
    'own_transfer_not_suggested', pg_temp.zz_sugg(p_xfer) is null,
    'matched_payment_not_suggested', pg_temp.zz_sugg(p_taken) is null,
    'no_merchant_payment_preferred', (pg_temp.zz_sugg(p_pref) ->> 'transaction_id')::uuid = x_pref_n,
    'repeating_suggested_on_its_date', (pg_temp.zz_sugg(p_rep) ->> 'transaction_id')::uuid = x_rep
                                       and pg_temp.zz_sugg(p_rep) ->> 'occurrence_on' = '2031-06-15'
                                       and (pg_temp.zz_sugg(p_rep) ->> 'n')::int = 1,
    'exact_when_tolerance_0', pg_temp.zz_sugg(p_cent) is null,
    'same_sign_only', pg_temp.zz_sugg(p_sign) is null,
    'merchant_payment_left_for_merchant', not exists (select 1 from public.wb_planned_matches m where m.transaction_id = x_pref_m));

  -- Processing a transaction suggests too (the path the daily sync takes).
  delete from public.wb_planned_matches where planned_item_id = p_check;
  perform public.wb_suggest_planned_matches(array[x_check], null);
  checks := checks || jsonb_build_object(
    'suggested_from_the_transaction_side', (pg_temp.zz_sugg(p_check) ->> 'transaction_id')::uuid = x_check);

  -- ---------------------------------------------------------------- 2-4. wb_action_items
  p_in := pg_temp.zz_item('ZZ S9B money in', 500, date '2031-06-25');
  p_out := pg_temp.zz_item('ZZ S9B money out', -500, date '2031-06-26');
  p_late := pg_temp.zz_item('ZZ S9B late bill', -70, d - 2, 5);
  p_late_in := pg_temp.zz_item('ZZ S9B late deposit', 70, d - 2, 5);
  p_old := pg_temp.zz_item('ZZ S9B old bill', -80, d - 20, 5);
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ S9B late stream ' || k, 'monthly', 9, 'active', t - 3) returning id into s_late;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ S9B overdue stream ' || k, 'monthly', 9, 'active', t - 10) returning id into s_over;
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, next_expected_on)
  values (v_user, v_ctx, 'ZZ S9B next stream ' || k, 'monthly', 9, 'active', t + 3) returning id into s_next;
  insert into public.inbox (id, captured_text, suggested_context_id, user_id) values
    (k || 'b1', long_text, v_ctx, v_user),
    (k || 'b2', 'ZZ S9B short', v_ctx, v_user);

  r := public.wb_action_items(14, 1000, 60, t);
  r0 := public.wb_action_items();

  checks := checks || jsonb_build_object(
    'todo_money_in_deposit', (pg_temp.zz_rows(r, 'coming_up', p_in::text) -> 0 ->> 'todo') = 'Deposit it; it will be matched once it posts.',
    'todo_money_out_pay', (pg_temp.zz_rows(r, 'coming_up', p_out::text) -> 0 ->> 'todo') = 'Pay it; it will be matched once it posts.');

  row := pg_temp.zz_rows(r, 'coming_up', s_late::text) -> 0;
  checks := checks || jsonb_build_object(
    'late_subscription_in_coming_up', (row ->> 'late')::boolean and row ->> 'severity' = 'amber'
                                      and (row ->> 'on')::date = t - 3 and row ->> 'title' like '%(late, due %',
    'overdue_subscription_not_in_coming_up', jsonb_array_length(pg_temp.zz_rows(r, 'coming_up', s_over::text)) = 0,
    'next_subscription_not_late', (pg_temp.zz_rows(r, 'coming_up', s_next::text) -> 0 ->> 'late')::boolean = false
                                  and (pg_temp.zz_rows(r, 'coming_up', s_next::text) -> 0 ->> 'severity') = 'info');

  row := pg_temp.zz_rows(r0, 'coming_up', p_late::text) -> 0;
  checks := checks || jsonb_build_object(
    'late_planned_in_coming_up', (row ->> 'late')::boolean and row ->> 'severity' = 'amber' and (row ->> 'on')::date = d - 2
                                 and (row ->> 'amount')::numeric = -70,
    'late_planned_not_overdue', jsonb_array_length(pg_temp.zz_rows(r0, 'overdue', p_late::text)) = 0,
    'late_deposit_todo', (pg_temp.zz_rows(r0, 'coming_up', p_late_in::text) -> 0 ->> 'todo') like 'Deposit it;%',
    'past_window_still_overdue', (pg_temp.zz_rows(r0, 'overdue', p_old::text) -> 0 ->> 'severity') = 'amber'
                                 and jsonb_array_length(pg_temp.zz_rows(r0, 'coming_up', p_old::text)) = 0);

  checks := checks || jsonb_build_object(
    'cut_title_ends_with_ellipsis', (select length(e ->> 'title') = 120 and right(e ->> 'title', 1) = '…'
                                     from jsonb_array_elements(pg_temp.zz_rows(r0, 'money_inbox', k || 'b1')) e),
    'short_title_untouched', (pg_temp.zz_rows(r0, 'money_inbox', k || 'b2') -> 0 ->> 'title') = 'ZZ S9B short');

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step9b();
