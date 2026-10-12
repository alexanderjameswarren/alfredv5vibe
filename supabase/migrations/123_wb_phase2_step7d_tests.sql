-- Purpose: Warren Buffet Phase 2 Step 7d tests for "Keep watching": a reviewed newest charge clears new_recurring (and needs_review) even with older unreviewed charges; the next charge brings the row back; a dismissed merchant stays out; price_change is unaffected.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-12 by Alex after 122: 15/15 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/123_wb_phase2_step7d_tests.sql

create or replace function pg_temp.wb_test_step7d_keep_watching()
returns void
language plpgsql
as $$
declare
  v_ctx    text := 'muvitejhrgt3rgi8t6q';
  v_user   uuid;
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_acct   uuid;
  v_tag    text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  m_watch  uuid;
  m_price  uuid;
  s_watch  uuid;
  s_price  uuid;
  t_newest uuid;
  t_next   uuid;
  t_odd    uuid;
  v_ids    uuid[];
  checks   jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ watch ' || v_tag, array['zzwatch' || v_tag]) returning id into m_watch;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ price ' || v_tag, array['zzprice' || v_tag]) returning id into m_price;

  -- Three monthly charges, detected as a watching subscription.
  with f(ago) as (values (70), (40), (10)),
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
    select v_user, v_ctx, v_acct, 'ZZ-S7D-' || f.ago, ((v_today - f.ago) + time '12:00') at time zone 'America/Los_Angeles',
           -20.00, upper('zzwatch' || v_tag) || ' 0001', '{}'
    from f
    returning id)
  select array_agg(id) into v_ids from ins;
  perform public.wb_process_transactions(v_ids);
  perform public.wb_detect_subscriptions(v_today);
  select id into s_watch from public.wb_subscriptions where merchant_id = m_watch;
  select id into t_newest from public.wb_transactions where external_id = 'ZZ-S7D-10' and account_id = v_acct;

  checks := checks || jsonb_build_object(
    'watching_detected', s_watch is not null,
    'newest_in_queue', exists (select 1 from public.wb_review_queue where transaction_id = t_newest and reason = 'new_recurring'));

  -- Keep watching: the newest charge is reviewed; the older two stay unreviewed.
  update public.wb_transactions set reviewed = true where id = t_newest;
  checks := checks || jsonb_build_object(
    'reviewed_clears_row', not exists (
      select 1 from public.wb_review_queue q join public.wb_transactions x on x.id = q.transaction_id
      where q.reason = 'new_recurring' and x.subscription_id = s_watch),
    'reviewed_clears_needs_review', (select not needs_review from public.wb_transaction_list where id = t_newest),
    'older_charges_not_new_recurring', not exists (
      select 1 from public.wb_review_queue q
      where q.reason = 'new_recurring' and q.transaction_id in (select id from unnest(v_ids) as u(id)) and q.transaction_id <> t_newest));

  -- The next charge brings the row back, on that charge.
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7D-next', ((v_today - 1) + time '12:00') at time zone 'America/Los_Angeles', -20.00,
          upper('zzwatch' || v_tag) || ' 0002', '{}')
  returning id into t_next;
  perform public.wb_process_transactions(array[t_next]);
  checks := checks || jsonb_build_object(
    'next_charge_linked', (select subscription_id = s_watch from public.wb_transactions where id = t_next),
    'next_charge_brings_row_back', exists (select 1 from public.wb_review_queue where transaction_id = t_next and reason = 'new_recurring'),
    'next_charge_needs_review', (select needs_review from public.wb_transaction_list where id = t_next),
    'one_row_per_subscription', (select count(*) = 1 from public.wb_review_queue q join public.wb_transactions x on x.id = q.transaction_id
                                 where q.reason = 'new_recurring' and x.subscription_id = s_watch));

  -- Dismissed stays out, reviewed or not.
  update public.wb_merchants set not_subscription = true where id = m_watch;
  checks := checks || jsonb_build_object(
    'dismissed_stays_out', not exists (select 1 from public.wb_review_queue where transaction_id = t_next and reason = 'new_recurring'));

  -- price_change is unaffected: an active subscription's differing, unreviewed charge is flagged.
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, status)
  values ('ZZ price ' || v_tag, m_price, 'monthly', 8.00, 'active') returning id into s_price;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7D-odd', ((v_today - 2) + time '12:00') at time zone 'America/Los_Angeles', -9.00,
          upper('zzprice' || v_tag) || ' 0001', '{}')
  returning id into t_odd;
  perform public.wb_process_transactions(array[t_odd]);
  checks := checks || jsonb_build_object(
    'price_change_still_flagged', exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'price_change'),
    'price_change_needs_review', (select needs_review from public.wb_transaction_list where id = t_odd),
    'active_not_new_recurring', not exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'new_recurring'));
  update public.wb_transactions set reviewed = true where id = t_odd;
  checks := checks || jsonb_build_object(
    'price_change_reviewed_dismisses', not exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'price_change'),
    'needs_review_never_null', not exists (select 1 from public.wb_transaction_list where account_id = v_acct and needs_review is null));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step7d_keep_watching();
