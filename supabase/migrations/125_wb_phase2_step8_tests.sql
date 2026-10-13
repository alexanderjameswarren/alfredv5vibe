-- Purpose: Warren Buffet Phase 2 Step 8a tests: billing intervals (weeks and months, next_expected_on and overdue), the cadence backfill and the trigger keeping a named cadence's interval, the constraint, and hand unlinks (dates refresh, reprocess never relinks, no price_change on an unlinked charge).
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-13 by Alex after 124: 22/22 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/125_wb_phase2_step8_tests.sql

create or replace function pg_temp.wb_test_step8_intervals()
returns void
language plpgsql
as $$
declare
  v_ctx    text := 'muvitejhrgt3rgi8t6q';
  v_user   uuid;
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_acct   uuid;
  v_tag    text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  m_weeks  uuid;
  m_months uuid;
  m_plain  uuid;
  m_pool   uuid;
  s_weeks  uuid;
  s_months uuid;
  s_plain  uuid;
  s_named  uuid;
  s_pool   uuid;
  t_w      uuid;
  t_m      uuid;
  t_p      uuid;
  t_pool1  uuid;
  t_pool2  uuid;
  t_oneoff uuid;
  v_err    text;
  checks   jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  -- The backfill: every named cadence carries its fixed interval (real rows, read only).
  checks := checks || jsonb_build_object(
    'backfill_consistent', not exists (
      select 1 from public.wb_subscriptions
      where (cadence = 'monthly'   and (interval_count, interval_unit) is distinct from (1, 'month'))
         or (cadence = 'quarterly' and (interval_count, interval_unit) is distinct from (3, 'month'))
         or (cadence = 'annual'    and (interval_count, interval_unit) is distinct from (12, 'month'))));

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ weeks ' || v_tag, array['zzweeks' || v_tag]) returning id into m_weeks;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ months ' || v_tag, array['zzmonths' || v_tag]) returning id into m_months;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ plain ' || v_tag, array['zzplain' || v_tag]) returning id into m_plain;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ pool ' || v_tag, array['zzpool' || v_tag]) returning id into m_pool;

  -- The trigger: a named cadence gets its interval; a change of cadence follows; other clears.
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, status)
  values (v_user, v_ctx, 'ZZ named ' || v_tag, 'monthly', 'active')
  returning id into s_named;
  checks := checks || jsonb_build_object(
    'insert_fills_monthly', (select interval_count = 1 and interval_unit = 'month' from public.wb_subscriptions where id = s_named));
  update public.wb_subscriptions set cadence = 'annual' where id = s_named;
  checks := checks || jsonb_build_object(
    'cadence_change_follows', (select interval_count = 12 and interval_unit = 'month' from public.wb_subscriptions where id = s_named));
  update public.wb_subscriptions set cadence = 'other' where id = s_named;
  checks := checks || jsonb_build_object(
    'other_without_interval_clears', (select interval_count is null and interval_unit is null from public.wb_subscriptions where id = s_named));
  begin
    update public.wb_subscriptions set cadence = 'monthly', interval_count = 2 where id = s_named;
    -- The trigger forces 1 month for monthly, so this succeeds with the fixed interval.
    v_err := (select interval_count::text from public.wb_subscriptions where id = s_named);
  exception when check_violation then
    v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('named_cadence_keeps_fixed_interval', v_err = '1');
  begin
    update public.wb_subscriptions set interval_count = 2 where id = s_named;
    v_err := null;
  exception when check_violation then
    v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('constraint_refuses_odd_monthly', v_err = 'refused');

  -- Every 2 weeks: last charged 10 days ago, so next is in 4 days; not overdue.
  insert into public.wb_subscriptions (name, merchant_id, cadence, interval_count, interval_unit, expected_amount, status)
  values ('ZZ weeks ' || v_tag, m_weeks, 'other', 2, 'week', 40.00, 'active') returning id into s_weeks;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-w', ((v_today - 10) + time '12:00') at time zone 'America/Los_Angeles', -40.00,
          upper('zzweeks' || v_tag) || ' 1', '{}')
  returning id into t_w;
  perform public.wb_process_transactions(array[t_w]);
  checks := checks || jsonb_build_object(
    'weeks_next_expected', (select next_expected_on = v_today + 4 from public.wb_subscriptions where id = s_weeks),
    'weeks_not_overdue', (select not overdue from public.wb_subscription_overview where id = s_weeks),
    'overview_shows_interval', (select interval_count = 2 and interval_unit = 'week' from public.wb_subscription_overview where id = s_weeks));
  -- The same charge 30 days ago: next was 16 days ago, so overdue.
  update public.wb_transactions set posted_at = ((v_today - 30) + time '12:00') at time zone 'America/Los_Angeles' where id = t_w;
  perform public.wb_refresh_subscriptions(array[s_weeks]);
  checks := checks || jsonb_build_object(
    'weeks_overdue', (select overdue and days_past_expected = 16 from public.wb_subscription_overview where id = s_weeks));

  -- Every 2 months: next is the charge date plus 2 months; not overdue yet.
  insert into public.wb_subscriptions (name, merchant_id, cadence, interval_count, interval_unit, expected_amount, status)
  values ('ZZ months ' || v_tag, m_months, 'other', 2, 'month', 90.00, 'active') returning id into s_months;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-m', ((v_today - 40) + time '12:00') at time zone 'America/Los_Angeles', -90.00,
          upper('zzmonths' || v_tag) || ' 1', '{}')
  returning id into t_m;
  perform public.wb_process_transactions(array[t_m]);
  checks := checks || jsonb_build_object(
    'months_next_expected', (select next_expected_on = (v_today - 40 + interval '2 months')::date from public.wb_subscriptions where id = s_months),
    'months_not_overdue', (select not overdue from public.wb_subscription_overview where id = s_months));

  -- Other with no interval: no next date, never overdue (as before).
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, status)
  values ('ZZ plain ' || v_tag, m_plain, 'other', 15.00, 'active') returning id into s_plain;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-p', ((v_today - 200) + time '12:00') at time zone 'America/Los_Angeles', -15.00,
          upper('zzplain' || v_tag) || ' 1', '{}')
  returning id into t_p;
  perform public.wb_process_transactions(array[t_p]);
  checks := checks || jsonb_build_object(
    'plain_no_next', (select next_expected_on is null and last_charged_on = v_today - 200 from public.wb_subscriptions where id = s_plain),
    'plain_never_overdue', (select not overdue from public.wb_subscription_overview where id = s_plain));

  -- Unlink a one-off: two regular charges and one one-off, all linked by processing.
  insert into public.wb_subscriptions (name, merchant_id, cadence, expected_amount, status)
  values ('ZZ pool ' || v_tag, m_pool, 'monthly', 50.00, 'active') returning id into s_pool;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-p1', ((v_today - 45) + time '12:00') at time zone 'America/Los_Angeles', -50.00,
          upper('zzpool' || v_tag) || ' 1', '{}') returning id into t_pool1;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-p2', ((v_today - 15) + time '12:00') at time zone 'America/Los_Angeles', -50.00,
          upper('zzpool' || v_tag) || ' 2', '{}') returning id into t_pool2;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-S8-x', ((v_today - 5) + time '12:00') at time zone 'America/Los_Angeles', -125.00,
          upper('zzpool' || v_tag) || ' FILTER', '{}') returning id into t_oneoff;
  perform public.wb_process_transactions(array[t_pool1, t_pool2, t_oneoff]);
  checks := checks || jsonb_build_object(
    'one_off_skews_dates', (select last_charged_on = v_today - 5 from public.wb_subscriptions where id = s_pool),
    'one_off_flagged_before', exists (select 1 from public.wb_review_queue where transaction_id = t_oneoff and reason = 'price_change'));

  perform public.wb_link_subscription(array[t_oneoff], null, 'manual');
  checks := checks || jsonb_build_object(
    'unlink_refreshes_last', (select last_charged_on = v_today - 15 from public.wb_subscriptions where id = s_pool),
    'unlink_refreshes_next', (select next_expected_on = (v_today - 15 + interval '1 month')::date from public.wb_subscriptions where id = s_pool),
    'unlinked_no_price_change', not exists (select 1 from public.wb_review_queue where transaction_id = t_oneoff and reason = 'price_change'));

  perform public.wb_process_transactions(array[t_pool1, t_pool2, t_oneoff]);
  checks := checks || jsonb_build_object(
    'reprocess_never_relinks', (select subscription_id is null and subscription_source = 'manual' from public.wb_transactions where id = t_oneoff),
    'reprocess_keeps_dates', (select last_charged_on = v_today - 15 from public.wb_subscriptions where id = s_pool),
    'regular_charges_still_linked', (select count(*) = 2 from public.wb_transactions where subscription_id = s_pool));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step8_intervals();
