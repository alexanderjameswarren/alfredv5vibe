-- Purpose: Warren Buffet Phase 3 Step 4a tests, run after 135_wb_phase3_step4_match_suggestions.sql: wb_planned_occurrences, rule projects and project_source in processing and wb_replace_splits, wb_suggest_planned_matches (merchant, sign, tolerance, window, drafts, pending, one per split, recurring occurrences, stale removal), wb_confirm_planned_match (confirm, partial, paid, reject), and planned_match in wb_review_queue and wb_transaction_list.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-17 by Alex after 135: 35/35 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/136_wb_phase3_step4_tests.sql

create or replace function pg_temp.wb_test_p3_step4a()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  k      text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  v_acct uuid;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid; m5 uuid;
  p1 uuid; p2 uuid;
  r1 uuid; r2 uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s7 uuid; s8 uuid; s9 uuid; s10 uuid;
  pi1 uuid; pi2 uuid; pi3 uuid; pi4 uuid; pi5 uuid; pi6 uuid; pi_draft uuid; pi_cxl uuid; pi_w uuid; pi_rd uuid;
  v_ids  uuid[];
  v_res  jsonb;
  v_mid  uuid;
  v_err  text;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ m1 ' || k, array[k || 'mone']) returning id into m1;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ m2 ' || k, array[k || 'mtwo']) returning id into m2;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ m3 ' || k, array[k || 'mthree']) returning id into m3;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ m4 ' || k, array[k || 'mfour']) returning id into m4;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns) values (v_user, v_ctx, 'ZZ m5 ' || k, array[k || 'mfive']) returning id into m5;

  -- ---------------------------------------------------------------- occurrences
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ month-end', -10, date '2026-01-31', 1, 'month') returning id into pi_w;
  checks := checks || jsonb_build_object('occ_month_end',
    (select array_agg(occurrence_on order by occurrence_on) from public.wb_planned_occurrences(date '2026-01-01', date '2026-04-30')
     where planned_item_id = pi_w) = array[date '2026-01-31', date '2026-02-28', date '2026-03-31', date '2026-04-30']);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit, ends_on)
  values (v_user, v_ctx, 'ZZ fortnight', -10, date '2026-01-01', 2, 'week', date '2026-01-29') returning id into pi_rd;
  checks := checks || jsonb_build_object('occ_weeks_until_end',
    (select array_agg(occurrence_on order by occurrence_on) from public.wb_planned_occurrences(date '2026-01-01', date '2026-03-31')
     where planned_item_id = pi_rd) = array[date '2026-01-01', date '2026-01-15', date '2026-01-29']);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ draft', -10, date '2026-02-01', 'draft') returning id into pi_draft;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, v_ctx, 'ZZ cancelled', -10, date '2026-02-01', 'cancelled') returning id into pi_cxl;
  update public.wb_planned_items set is_draft = true where id = pi_rd;
  checks := checks || jsonb_build_object(
    'occ_drafts_out', not exists (select 1 from public.wb_planned_occurrences(date '2026-01-01', date '2026-03-31')
                                  where planned_item_id in (pi_draft, pi_rd)),
    'occ_drafts_on_request', (select count(*) from public.wb_planned_occurrences(date '2026-01-01', date '2026-03-31', true)
                              where planned_item_id in (pi_draft, pi_rd)) = 4,
    'occ_cancelled_out', not exists (select 1 from public.wb_planned_occurrences(date '2026-01-01', date '2026-03-31', true)
                                     where planned_item_id = pi_cxl));
  delete from public.wb_planned_items where id in (pi_w, pi_rd, pi_draft, pi_cxl);

  -- ---------------------------------------------------------------- rule projects
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ P1 ' || k) returning id into p1;
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ P2 ' || k) returning id into p2;
  insert into public.wb_rules (user_id, context_id, name, priority, match, set_project_id, created_by)
  values (v_user, v_ctx, 'ZZ r1', 10, jsonb_build_object('merchant_id', m1), p1, 'claude') returning id into r1;
  insert into public.wb_rules (user_id, context_id, name, priority, match, set_project_id, created_by)
  values (v_user, v_ctx, 'ZZ r2', 20, jsonb_build_object('merchant_id', m1), p2, 'claude') returning id into r2;
  with f(n) as (values (1), (2), (3), (4)), ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
    select v_user, v_ctx, v_acct, 'ZZ-P4-T' || f.n, ((date '2026-02-01' + f.n) + time '12:00') at time zone 'America/Los_Angeles',
           -40.00, 'ZZ ONE ' || f.n, k || 'mone', '{}'
    from f returning id, external_id)
  select array_agg(id order by external_id) into v_ids from ins;
  t1 := v_ids[1]; t2 := v_ids[2]; t3 := v_ids[3]; t4 := v_ids[4];
  update public.wb_splits set project_id = p2 where transaction_id = t2;                         -- hand value, no source given
  update public.wb_splits set project_id = null, project_source = 'manual' where transaction_id = t3;  -- hand removal
  perform public.wb_replace_splits(t4, jsonb_build_array(jsonb_build_object('amount', -10.00),
                                                         jsonb_build_object('amount', -30.00, 'project_id', p2)), 'manual');
  v_res := public.wb_process_transactions(v_ids);
  checks := checks || jsonb_build_object(
    'direct_write_is_manual', (select project_source = 'manual' from public.wb_splits where transaction_id = t2),
    'rule_project_first_wins', (select project_id = p1 and project_source = 'rule' from public.wb_splits where transaction_id = t1),
    'manual_project_kept', (select project_id = p2 from public.wb_splits where transaction_id = t2),
    'hand_removal_sticks', (select project_id is null and project_source = 'manual' from public.wb_splits where transaction_id = t3),
    'multi_split_untouched', (select array_agg(project_id order by position) = array[null, p2]::uuid[]
                              from public.wb_splits where transaction_id = t4),
    'replace_sets_source', (select project_source = 'manual' from public.wb_splits where transaction_id = t4 and position = 1),
    'result_counts_projects', (v_res ->> 'rule_projects')::int = 1 and v_res ? 'matches_suggested');
  update public.wb_rules set active = false where id in (r1, r2);
  perform public.wb_process_transactions(array[t1]);
  checks := checks || jsonb_build_object(
    'rule_project_cleared', (select project_id is null and project_source is null from public.wb_splits where transaction_id = t1));

  -- ---------------------------------------------------------------- suggestions
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, amount_tolerance, match_window_days)
  values (v_user, v_ctx, 'ZZ invoice', m2, -200, date '2026-03-10', 'invoiced', 5, 10) returning id into pi1;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, amount_tolerance, match_window_days)
  values (v_user, v_ctx, 'ZZ what if', m2, -300, date '2026-03-20', 'draft', 0, 3) returning id into pi2;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, interval_count, interval_unit, match_window_days)
  values (v_user, v_ctx, 'ZZ premium', m3, -50, date '2026-01-05', 1, 'month', 5) returning id into pi3;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ twin a', m4, -80, date '2026-03-01', 'quoted', 5) returning id into pi4;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ twin b', m4, -80, date '2026-03-03', 'quoted', 5) returning id into pi5;
  insert into public.wb_planned_items (user_id, context_id, name, merchant_id, amount, due_on, stage, match_window_days)
  values (v_user, v_ctx, 'ZZ full', m5, -100, date '2026-03-15', 'estimate', 5) returning id into pi6;

  with f(n, d, amt, p, pend) as (values
      (1, date '2026-03-14', -198.00, 'mtwo', false),   -- s1: pi1, within tolerance and window
      (2, date '2026-04-10', -200.00, 'mtwo', false),   -- s2: outside the window
      (3, date '2026-03-11', -150.00, 'mtwo', false),   -- s3: outside the tolerance
      (4, date '2026-03-10',  200.00, 'mtwo', false),   -- s4: wrong sign
      (5, date '2026-03-10', -200.00, 'mtwo', true),    -- s5: pending
      (6, date '2026-03-20', -300.00, 'mtwo', false),   -- s6: only the draft fits
      (7, date '2026-01-06',  -50.00, 'mthree', false), -- s7: pi3, 5 Jan
      (8, date '2026-02-04',  -50.00, 'mthree', false), -- s8: pi3, 5 Feb
      (9, date '2026-03-02',  -80.00, 'mfour', false),  -- s9: fits pi4 and pi5, one wins
      (10, date '2026-03-15', -100.00, 'mfive', false)), -- s10: pi6
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, transacted_at, pending,
                                        amount, description, payee, raw)
    select v_user, v_ctx, v_acct, 'ZZ-P4-S' || lpad(f.n::text, 2, '0'),
           case when f.pend then null else (f.d + time '12:00') at time zone 'America/Los_Angeles' end,
           (f.d + time '12:00') at time zone 'America/Los_Angeles', f.pend,
           f.amt, 'ZZ PAY ' || f.n, k || f.p, '{}'
    from f returning id, external_id)
  select array_agg(id order by external_id) into v_ids from ins;
  s1 := v_ids[1]; s2 := v_ids[2]; s3 := v_ids[3]; s4 := v_ids[4]; s5 := v_ids[5];
  s6 := v_ids[6]; s7 := v_ids[7]; s8 := v_ids[8]; s9 := v_ids[9]; s10 := v_ids[10];
  v_res := public.wb_process_transactions(v_ids);

  checks := checks || jsonb_build_object(
    'suggested_on_process', (select count(*) = 1 from public.wb_planned_matches where planned_item_id = pi1 and transaction_id = s1 and status = 'suggested'),
    'applied_is_smaller', (select amount_applied = -198.00 from public.wb_planned_matches where planned_item_id = pi1),
    'outside_window_tolerance_sign_pending_none',
      not exists (select 1 from public.wb_planned_matches where transaction_id in (s2, s3, s4, s5)),
    'draft_none', not exists (select 1 from public.wb_planned_matches where planned_item_id = pi2),
    'recurring_occurrences', (select array_agg(occurrence_on order by occurrence_on) from public.wb_planned_matches where planned_item_id = pi3)
                             = array[date '2026-01-05', date '2026-02-05'],
    'one_per_split', (select count(*) = 1 from public.wb_planned_matches where transaction_id = s9),
    'result_counts_suggestions', (v_res ->> 'matches_suggested')::int = 5);

  -- Queue and list.
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi1;
  checks := checks || jsonb_build_object(
    'queue_row', (select planned_match_id = v_mid and planned_item_id = pi1 and planned_item_name = 'ZZ invoice'
                         and planned_on = date '2026-03-10' and planned_amount = -200 and match_amount = -198
                         and planned_tolerance = 5 and planned_window_days = 10 and detail = 'ZZ invoice, due 2026-03-10'
                  from public.wb_review_queue where reason = 'planned_match' and transaction_id = s1),
    'list_needs_review', (select needs_review from public.wb_transaction_list where id = s1));
  update public.wb_transactions set reviewed = true where id = s1;
  checks := checks || jsonb_build_object(
    'queue_shows_when_reviewed', exists (select 1 from public.wb_review_queue where reason = 'planned_match' and transaction_id = s1));

  -- A planned-item write: the draft becomes real and is suggested; a changed amount drops a stale one.
  update public.wb_planned_items set stage = 'estimate' where id = pi2;
  v_res := public.wb_suggest_planned_matches(null, array[pi2]);
  checks := checks || jsonb_build_object(
    'planned_write_suggests', (select count(*) = 1 from public.wb_planned_matches where planned_item_id = pi2 and transaction_id = s6));
  update public.wb_planned_items set amount = -500 where id = pi1;
  v_res := public.wb_suggest_planned_matches(null, array[pi1]);
  checks := checks || jsonb_build_object(
    'stale_removed', not exists (select 1 from public.wb_planned_matches where planned_item_id = pi1) and (v_res ->> 'removed')::int = 1);
  update public.wb_planned_items set amount = -200 where id = pi1;
  perform public.wb_suggest_planned_matches(array[s1], null);
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi1;
  checks := checks || jsonb_build_object('resuggested', v_mid is not null);

  -- Confirm: partial is not paid; full is paid; the row leaves the queue.
  v_res := public.wb_confirm_planned_match(v_mid, 'confirm', null);
  checks := checks || jsonb_build_object(
    'confirmed', (select status = 'confirmed' and decided_at is not null from public.wb_planned_matches where id = v_mid),
    'partial_not_paid', (select stage = 'invoiced' from public.wb_planned_items where id = pi1) and not (v_res ->> 'stage_paid')::boolean,
    'confirmed_leaves_queue', not exists (select 1 from public.wb_review_queue where reason = 'planned_match' and transaction_id = s1),
    'list_clear_after_confirm', (select not needs_review from public.wb_transaction_list where id = s1));
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi6;
  v_res := public.wb_confirm_planned_match(v_mid, 'confirm', null);
  checks := checks || jsonb_build_object(
    'full_sets_paid', (select stage = 'paid' from public.wb_planned_items where id = pi6) and (v_res ->> 'stage_paid')::boolean);
  begin
    perform public.wb_confirm_planned_match(v_mid, 'reject', null);
    v_err := null;
  exception when invalid_parameter_value then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('decided_refused', v_err = 'refused');

  -- A lowered amount on confirm, with the planned item's sign.
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi2;
  perform public.wb_confirm_planned_match(v_mid, 'confirm', 120);
  checks := checks || jsonb_build_object(
    'lowered_amount', (select amount_applied = -120 from public.wb_planned_matches where id = v_mid),
    'lowered_not_paid', (select stage = 'estimate' from public.wb_planned_items where id = pi2));

  -- Reject: never suggested again.
  select id into v_mid from public.wb_planned_matches where planned_item_id = pi3 and occurrence_on = date '2026-01-05';
  perform public.wb_confirm_planned_match(v_mid, 'reject', null);
  perform public.wb_process_transactions(array[s7]);
  checks := checks || jsonb_build_object(
    'rejected_not_again', (select count(*) = 1 and bool_and(status = 'rejected') from public.wb_planned_matches
                           where planned_item_id = pi3 and occurrence_on = date '2026-01-05'));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step4a();
