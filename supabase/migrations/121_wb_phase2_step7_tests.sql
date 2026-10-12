-- Purpose: Warren Buffet Phase 2 Step 7a tests for subscriptions: detection (monthly, similar size within 10% of the median, not_subscription skipped), new_recurring, linking by merchant and by price within amount_tolerance, price_change with and without tolerance and cleared by a new price, hand links kept by processing, next_expected_on with a prepaid term_end_date, and overdue in wb_subscription_overview.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-12 by Alex after 120: 39/39 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/121_wb_phase2_step7_tests.sql

create or replace function pg_temp.wb_test_step7_subscriptions()
returns void
language plpgsql
as $$
declare
  v_ctx    text := 'muvitejhrgt3rgi8t6q';
  v_user   uuid;
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_acct   uuid;
  -- A unique letters-only word, so no real row matches the merchant patterns.
  v_tag    text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  m_stream uuid;  -- monthly, steady: detected
  m_flag   uuid;  -- monthly, steady, but not_subscription: skipped
  m_store  uuid;  -- monthly, sizes vary: skipped
  m_often  uuid;  -- steady size, every 10 days: skipped
  m_two    uuid;  -- two subscriptions, told apart by price
  m_term   uuid;  -- prepaid term
  s_stream uuid;
  s_lo     uuid;
  s_hi     uuid;
  s_term   uuid;
  s_late   uuid;
  t_hi     uuid;
  t_mid    uuid;
  t_odd    uuid;
  t_up     uuid;
  t_hand   uuid;
  t_last   uuid;
  v_ids    uuid[] := '{}';
  v_res    jsonb;
  checks   jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;

  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ stream ' || v_tag, array['zzstream' || v_tag]) returning id into m_stream;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns, not_subscription)
  values (v_user, v_ctx, 'ZZ insure ' || v_tag, array['zzinsure' || v_tag], true) returning id into m_flag;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ store ' || v_tag, array['zzstore' || v_tag]) returning id into m_store;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ often ' || v_tag, array['zzoften' || v_tag]) returning id into m_often;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ two ' || v_tag, array['zztwo' || v_tag]) returning id into m_two;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ term ' || v_tag, array['zzterm' || v_tag]) returning id into m_term;

  -- Charges for detection: (pattern, days ago, amount).
  with f(p, ago, amt) as (values
    ('zzstream', 95, 9.99), ('zzstream', 65, 9.99), ('zzstream', 35, 10.49), ('zzstream', 5, 10.49),
    ('zzinsure', 90, 50.00), ('zzinsure', 60, 50.00), ('zzinsure', 30, 50.00),
    ('zzstore', 90, 20.00), ('zzstore', 60, 45.00), ('zzstore', 30, 30.00),
    ('zzoften', 30, 7.00), ('zzoften', 20, 7.00), ('zzoften', 10, 7.00)),
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
    select v_user, v_ctx, v_acct, 'ZZ-S7-' || f.p || f.ago, ((v_today - f.ago) + time '12:00') at time zone 'America/Los_Angeles',
           -f.amt, upper(f.p || v_tag) || ' 0001', '{}'
    from f
    returning id)
  select array_agg(id) into v_ids from ins;
  perform public.wb_process_transactions(v_ids);

  v_res := public.wb_detect_subscriptions(v_today);
  select id into s_stream from public.wb_subscriptions where merchant_id = m_stream;
  checks := checks || jsonb_build_object(
    'detect_creates_watching', (select status = 'watching' and cadence = 'monthly' and expected_amount = 10.49
                                from public.wb_subscriptions where id = s_stream),
    'detect_links_all_four', (select count(*) = 4 from public.wb_transactions where subscription_id = s_stream and subscription_source = 'default'),
    'detect_records_price', (select count(*) = 1 and min(amount) = 10.49 and min(source) = 'detected'
                             from public.wb_subscription_prices where subscription_id = s_stream),
    'detect_skips_not_subscription', not exists (select 1 from public.wb_subscriptions where merchant_id = m_flag),
    'detect_skips_varied_sizes', not exists (select 1 from public.wb_subscriptions where merchant_id = m_store),
    'detect_skips_not_monthly', not exists (select 1 from public.wb_subscriptions where merchant_id = m_often),
    'detect_sets_dates', (select last_charged_on = v_today - 5 and next_expected_on = (v_today - 5 + interval '1 month')::date
                          from public.wb_subscriptions where id = s_stream));

  -- Run again: nothing new.
  v_res := public.wb_detect_subscriptions(v_today);
  checks := checks || jsonb_build_object(
    'detect_idempotent', (select count(*) = 1 from public.wb_subscriptions where merchant_id = m_stream));

  -- new_recurring: the newest charge only; dismissing the merchant hides it.
  checks := checks || jsonb_build_object(
    'new_recurring_newest_only', (select count(*) = 1 from public.wb_review_queue q
                                  join public.wb_transactions x on x.id = q.transaction_id
                                  where q.reason = 'new_recurring' and x.subscription_id = s_stream
                                    and q.txn_date = v_today - 5),
    'new_recurring_needs_review', (select needs_review from public.wb_transaction_list
                                   where subscription_id = s_stream and txn_date = v_today - 5));
  update public.wb_merchants set not_subscription = true where id = m_stream;
  checks := checks || jsonb_build_object(
    'dismiss_hides_new_recurring', not exists (select 1 from public.wb_review_queue q
                                               join public.wb_transactions x on x.id = q.transaction_id
                                               where q.reason = 'new_recurring' and x.subscription_id = s_stream));
  update public.wb_merchants set not_subscription = false where id = m_stream;

  -- Confirmed, the two older 9.99 charges predate the detected 10.49 price, compare with
  -- it (the oldest-row fallback) and are flagged.
  update public.wb_subscriptions set status = 'active' where id = s_stream;
  checks := checks || jsonb_build_object(
    'active_no_new_recurring', not exists (select 1 from public.wb_review_queue q
                                           join public.wb_transactions x on x.id = q.transaction_id
                                           where q.reason = 'new_recurring' and x.subscription_id = s_stream),
    'old_price_flagged_without_history', (select count(*) = 2 from public.wb_review_queue q
                                          join public.wb_transactions x on x.id = q.transaction_id
                                          where q.reason = 'price_change' and x.subscription_id = s_stream));
  -- Recording the history (9.99, rising to 10.49 35 days ago) clears them, as Step 8 will seed.
  insert into public.wb_subscription_prices (subscription_id, effective_on, amount, source)
  values (s_stream, v_today - 95, 9.99, 'manual'), (s_stream, v_today - 35, 10.49, 'manual');
  checks := checks || jsonb_build_object(
    'price_history_clears_flags', not exists (select 1 from public.wb_review_queue q
                                              join public.wb_transactions x on x.id = q.transaction_id
                                              where q.reason = 'price_change' and x.subscription_id = s_stream));

  -- D3: two subscriptions at one merchant, told apart by price within tolerance.
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, status)
  values ('ZZ two low ' || v_tag, m_two, 'monthly', 5.00, 'active') returning id into s_lo;
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, amount_tolerance, status)
  values ('ZZ two high ' || v_tag, m_two, 'monthly', 12.00, 0.50, 'active') returning id into s_hi;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-hi', ((v_today - 3) + time '12:00') at time zone 'America/Los_Angeles', -12.30, upper('zztwo' || v_tag) || ' A', '{}')
  returning id into t_hi;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-mid', ((v_today - 3) + time '12:00') at time zone 'America/Los_Angeles', -7.00, upper('zztwo' || v_tag) || ' B', '{}')
  returning id into t_mid;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-odd', ((v_today - 2) + time '12:00') at time zone 'America/Los_Angeles', -5.25, upper('zztwo' || v_tag) || ' C', '{}')
  returning id into t_odd;
  v_res := public.wb_process_transactions(array[t_hi, t_mid, t_odd]);
  checks := checks || jsonb_build_object(
    'owner_copied_from_merchant', (select user_id = v_user and context_id = v_ctx from public.wb_subscriptions where id = s_lo),
    'link_within_tolerance', (select subscription_id = s_hi from public.wb_transactions where id = t_hi),
    'link_none_when_no_price_fits', (select subscription_id is null from public.wb_transactions where id = t_mid),
    'link_exact_without_tolerance_fails', (select subscription_id is null from public.wb_transactions where id = t_odd),
    'processing_counts_links', (v_res ->> 'subscriptions_linked')::int = 1,
    'tolerance_no_price_change', not exists (select 1 from public.wb_review_queue where transaction_id = t_hi and reason = 'price_change'));

  -- D3 on price_change: a single subscription links regardless of price; tolerance decides the flag.
  update public.wb_subscriptions set status = 'cancelled' where id = s_hi;
  v_res := public.wb_process_transactions(array[t_odd]);
  checks := checks || jsonb_build_object(
    'single_sub_links_any_price', (select subscription_id = s_lo from public.wb_transactions where id = t_odd),
    'exact_price_change_flagged', exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'price_change'),
    'price_change_needs_review', (select needs_review from public.wb_transaction_list where id = t_odd));
  update public.wb_subscriptions set amount_tolerance = 0.25 where id = s_lo;
  checks := checks || jsonb_build_object(
    'tolerance_clears_flag', not exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'price_change'));
  update public.wb_subscriptions set amount_tolerance = 0 where id = s_lo;
  update public.wb_transactions set reviewed = true where id = t_odd;
  checks := checks || jsonb_build_object(
    'reviewed_dismisses_one_off', not exists (select 1 from public.wb_review_queue where transaction_id = t_odd and reason = 'price_change'));

  -- A new price, recorded, clears the flag on later charges.
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-up', ((v_today - 1) + time '12:00') at time zone 'America/Los_Angeles', -6.00, upper('zztwo' || v_tag) || ' D', '{}')
  returning id into t_up;
  perform public.wb_process_transactions(array[t_up]);
  checks := checks || jsonb_build_object(
    'rise_flagged', exists (select 1 from public.wb_review_queue where transaction_id = t_up and reason = 'price_change'));
  insert into public.wb_subscription_prices (subscription_id, effective_on, amount, source, transaction_id)
  values (s_lo, v_today - 1, 6.00, 'claude', t_up);
  checks := checks || jsonb_build_object(
    'new_price_clears_flag', not exists (select 1 from public.wb_review_queue where transaction_id = t_up and reason = 'price_change'),
    'overview_current_and_previous', (select current_price = 6.00 and previous_price is null and price_count = 1
                                      from public.wb_subscription_overview where id = s_lo));

  -- Hand links stay through processing, including a hand unlink.
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-hand', ((v_today - 1) + time '12:00') at time zone 'America/Los_Angeles', -6.00, upper('zztwo' || v_tag) || ' E', '{}')
  returning id into t_hand;
  perform public.wb_process_transactions(array[t_hand]);
  v_res := public.wb_link_subscription(array[t_hand], null, 'manual');
  perform public.wb_process_transactions(array[t_hand]);
  checks := checks || jsonb_build_object(
    'hand_unlink_kept', (select subscription_id is null and subscription_source = 'manual' from public.wb_transactions where id = t_hand),
    'link_reports_unlinked', (v_res ->> 'unlinked')::int = 1);
  perform public.wb_link_subscription(array[t_hand], s_hi, 'claude');
  perform public.wb_process_transactions(array[t_hand]);
  checks := checks || jsonb_build_object(
    'hand_link_kept', (select subscription_id = s_hi and subscription_source = 'claude' from public.wb_transactions where id = t_hand),
    'hand_link_refreshes_dates', (select last_charged_on = v_today - 1 from public.wb_subscriptions where id = s_hi));

  -- Prepaid term: last charged 60 days ago, monthly, term ends in 30 days.
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, term_end_date, auto_renew, status)
  values ('ZZ term ' || v_tag, m_term, 'monthly', 30.00, v_today + 30, true, 'active') returning id into s_term;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S7-term', ((v_today - 60) + time '12:00') at time zone 'America/Los_Angeles', -30.00, upper('zzterm' || v_tag) || ' 1', '{}')
  returning id into t_last;
  perform public.wb_process_transactions(array[t_last]);
  checks := checks || jsonb_build_object(
    'term_sets_next_expected', (select next_expected_on = v_today + 30 from public.wb_subscriptions where id = s_term),
    'term_not_overdue', (select not overdue from public.wb_subscription_overview where id = s_term));

  -- Without the term the same charge is overdue (60 days > 1 month + 7).
  update public.wb_subscriptions set term_end_date = null where id = s_term;
  perform public.wb_refresh_subscriptions(array[s_term]);
  checks := checks || jsonb_build_object(
    'no_term_overdue', (select overdue from public.wb_subscription_overview where id = s_term));
  -- Ended term that does not renew: not overdue.
  update public.wb_subscriptions set term_end_date = v_today - 20, auto_renew = false where id = s_term;
  perform public.wb_refresh_subscriptions(array[s_term]);
  checks := checks || jsonb_build_object(
    'ended_term_no_renew_not_overdue', (select not overdue from public.wb_subscription_overview where id = s_term));
  -- Paused or watching rows are never overdue; inside the 7-day grace is not overdue.
  update public.wb_subscriptions set term_end_date = null, auto_renew = null, status = 'paused' where id = s_term;
  perform public.wb_refresh_subscriptions(array[s_term]);
  checks := checks || jsonb_build_object(
    'paused_not_overdue', (select not overdue from public.wb_subscription_overview where id = s_term));
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, status)
  values ('ZZ late ' || v_tag, m_term, 'monthly', 30.00, 'active') returning id into s_late;
  perform public.wb_link_subscription(array[t_last], s_late, 'manual');
  update public.wb_transactions set posted_at = ((v_today - 35) + time '12:00') at time zone 'America/Los_Angeles' where id = t_last;
  perform public.wb_refresh_subscriptions(array[s_late]);
  checks := checks || jsonb_build_object(
    'grace_not_overdue', (select not overdue and days_past_expected between 1 and 7 from public.wb_subscription_overview where id = s_late));

  -- The list view's needs_review is never null.
  checks := checks || jsonb_build_object(
    'needs_review_never_null', not exists (select 1 from public.wb_transaction_list where account_id = v_acct and needs_review is null));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step7_subscriptions();
