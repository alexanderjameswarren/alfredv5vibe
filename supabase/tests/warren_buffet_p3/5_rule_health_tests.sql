-- Purpose: Warren Buffet Phase 3 Step 10a tests, run after 155_wb_phase3_step10a_rule_health.sql and its floor fix (spec A16, A54, A55): never_fires at 1.5 times the expected interval and more than 30 days quiet (a subscription's interval, else the median gap between matches, else annual or quarterly notes, else 30 days), for rules that matched and rules that never did; and often_overridden counting a project the rule set that was changed or removed by hand.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name below is invented ("ZZ test" fixtures). No real financial data. The view reads today,
-- so every date here is counted back from today. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/5_rule_health_tests.sql

create or replace function pg_temp.zz_merchant(p_name text)
returns uuid
language sql
as $$
  insert into public.wb_merchants (user_id, context_id, name)
  select c.user_id, c.id, p_name from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create or replace function pg_temp.zz_rule(p_name text, p_merchant uuid, p_created_days int, p_last_hit_days int default null,
                                           p_notes text default null, p_project uuid default null)
returns uuid
language sql
as $$
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by, created_at, notes,
                               set_project_id, hit_count, last_hit_at)
  select c.user_id, c.id, p_name, jsonb_build_object('merchant_id', p_merchant), '{}', 'claude',
         now() - make_interval(days => p_created_days), p_notes, p_project,
         case when p_last_hit_days is null then 0 else 1 end,
         case when p_last_hit_days is not null then now() - make_interval(days => p_last_hit_days) end
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- A settled transaction the rule matched, p_days ago.
create or replace function pg_temp.zz_hit(p_acct uuid, p_rule uuid, p_merchant uuid, p_days int)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee,
                                      raw, merchant_id, kind, matched_rule_ids)
  select a.user_id, a.context_id, p_acct, 'ZZ-P10-' || gen_random_uuid(), now() - make_interval(days => p_days), -10,
         'ZZ HIT', 'ZZ HIT', '{}', p_merchant, 'spend', array[p_rule]
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_finding(p_finding text, p_rule uuid)
returns public.wb_rule_health_all
language sql
as $$ select * from public.wb_rule_health_all where finding = p_finding and rule_id = p_rule limit 1; $$;

create or replace function pg_temp.wb_test_p3_step10a()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  acct uuid;
  m_sub uuid; m_sub2 uuid; m_qtr uuid; m_gap uuid; m_gap2 uuid; m_none uuid; m_none2 uuid; m_ann uuid; m_new uuid;
  m_proj uuid; m_proj2 uuid; m_g4a uuid; m_g4b uuid; m_g1a uuid; m_g1b uuid;
  r_g4_q10 uuid; r_g4_q40 uuid; r_g1_q3 uuid; r_g1_q40 uuid;
  r_sub_ok uuid; r_sub_late uuid; r_qtr uuid; r_gap_late uuid; r_gap_ok uuid; r_new_default uuid; r_old_default uuid;
  r_annual uuid; r_brand_new uuid; r_proj uuid; r_proj_one uuid;
  p1 uuid; p2 uuid;
  x uuid;
  i int;
  f public.wb_rule_health_all;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ card ' || k, 'credit_card') returning id into acct;

  -- ---------------------------------------------------------------- never_fires
  m_sub := pg_temp.zz_merchant('ZZ S10 monthly ' || k);
  m_sub2 := pg_temp.zz_merchant('ZZ S10 monthly two ' || k);
  m_qtr := pg_temp.zz_merchant('ZZ S10 quarterly ' || k);
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, merchant_id) values
    (v_user, v_ctx, 'ZZ S10 sub ' || k, 'monthly', 10, 'active', m_sub),
    (v_user, v_ctx, 'ZZ S10 sub two ' || k, 'monthly', 10, 'active', m_sub2),
    (v_user, v_ctx, 'ZZ S10 sub qtr ' || k, 'quarterly', 10, 'active', m_qtr);
  r_sub_ok := pg_temp.zz_rule('ZZ S10 sub ok ' || k, m_sub, 400, 40);       -- monthly: flagged after 46 days
  r_sub_late := pg_temp.zz_rule('ZZ S10 sub late ' || k, m_sub2, 400, 50);
  r_qtr := pg_temp.zz_rule('ZZ S10 quarterly ' || k, m_qtr, 400, 100);     -- quarterly: after about 137 days

  -- No subscription: the median gap between matches (14 days), so flagged after 21.
  m_gap := pg_temp.zz_merchant('ZZ S10 gap ' || k);
  r_gap_late := pg_temp.zz_rule('ZZ S10 gap late ' || k, m_gap, 400, 42);
  perform pg_temp.zz_hit(acct, r_gap_late, m_gap, d) from unnest(array[70, 56, 42]) d;
  m_gap2 := pg_temp.zz_merchant('ZZ S10 gap two ' || k);
  r_gap_ok := pg_temp.zz_rule('ZZ S10 gap ok ' || k, m_gap2, 400, 10);
  perform pg_temp.zz_hit(acct, r_gap_ok, m_gap2, d) from unnest(array[38, 24, 10]) d;

  -- Nothing known: 30 days, so a rule with no match is flagged once it is more than 45 days old.
  m_none := pg_temp.zz_merchant('ZZ S10 none ' || k);
  r_new_default := pg_temp.zz_rule('ZZ S10 40 days ' || k, m_none, 40);
  m_none2 := pg_temp.zz_merchant('ZZ S10 none two ' || k);
  r_old_default := pg_temp.zz_rule('ZZ S10 50 days ' || k, m_none2, 50);
  m_ann := pg_temp.zz_merchant('ZZ S10 annual ' || k);
  r_annual := pg_temp.zz_rule('ZZ S10 annual ' || k, m_ann, 200, null, 'Annual renewal');
  m_new := pg_temp.zz_merchant('ZZ S10 new ' || k);
  r_brand_new := pg_temp.zz_rule('ZZ S10 new ' || k, m_new, 0);

  -- The 30-day floor (A55): short gaps are not flagged until the rule has been quiet more than 30 days.
  m_g4a := pg_temp.zz_merchant('ZZ S10 gap4 quiet10 ' || k);
  r_g4_q10 := pg_temp.zz_rule('ZZ S10 gap4 quiet10 ' || k, m_g4a, 400, 10);
  perform pg_temp.zz_hit(acct, r_g4_q10, m_g4a, d) from unnest(array[22, 18, 14, 10]) d;
  m_g4b := pg_temp.zz_merchant('ZZ S10 gap4 quiet40 ' || k);
  r_g4_q40 := pg_temp.zz_rule('ZZ S10 gap4 quiet40 ' || k, m_g4b, 400, 40);
  perform pg_temp.zz_hit(acct, r_g4_q40, m_g4b, d) from unnest(array[52, 48, 44, 40]) d;
  m_g1a := pg_temp.zz_merchant('ZZ S10 gap1 quiet3 ' || k);
  r_g1_q3 := pg_temp.zz_rule('ZZ S10 gap1 quiet3 ' || k, m_g1a, 400, 3);
  perform pg_temp.zz_hit(acct, r_g1_q3, m_g1a, d) from unnest(array[6, 5, 4, 3]) d;
  m_g1b := pg_temp.zz_merchant('ZZ S10 gap1 quiet40 ' || k);
  r_g1_q40 := pg_temp.zz_rule('ZZ S10 gap1 quiet40 ' || k, m_g1b, 400, 40);
  perform pg_temp.zz_hit(acct, r_g1_q40, m_g1b, d) from unnest(array[43, 42, 41, 40]) d;
  checks := checks || jsonb_build_object(
    'floor_gap4_quiet10_not_flagged', pg_temp.zz_finding('never_fires', r_g4_q10) is null,
    'floor_gap4_quiet40_flagged', (pg_temp.zz_finding('never_fires', r_g4_q40)).detail like 'Last match on %; expected about every 4 days.',
    'floor_gap1_quiet3_not_flagged', pg_temp.zz_finding('never_fires', r_g1_q3) is null,
    'interval_1_reads_every_day', (pg_temp.zz_finding('never_fires', r_g1_q40)).detail like 'Last match on %; expected about every day.');

  f := pg_temp.zz_finding('never_fires', r_sub_late);
  checks := checks || jsonb_build_object(
    'subscription_interval_not_yet', pg_temp.zz_finding('never_fires', r_sub_ok) is null,
    'subscription_interval_late', f.rule_id = r_sub_late and f.detail like 'Last match on %; expected about every 30 days.',
    'quarterly_subscription_not_yet', pg_temp.zz_finding('never_fires', r_qtr) is null,
    'median_gap_late', (pg_temp.zz_finding('never_fires', r_gap_late)).detail like '%expected about every 14 days.',
    'median_gap_not_yet', pg_temp.zz_finding('never_fires', r_gap_ok) is null,
    'no_match_default_not_yet', pg_temp.zz_finding('never_fires', r_new_default) is null,
    'no_match_default_late', (pg_temp.zz_finding('never_fires', r_old_default)).detail like 'No match since it was created on %; expected about every 30 days.',
    'annual_notes_not_yet', pg_temp.zz_finding('never_fires', r_annual) is null,
    'brand_new_rule_not_flagged', pg_temp.zz_finding('never_fires', r_brand_new) is null,
    'never_fires_n_stays_0', f.n = 0);

  -- ---------------------------------------------------------------- often_overridden: a project changed by hand
  insert into public.wb_projects (user_id, context_id, name, status) values (v_user, v_ctx, 'ZZ S10 roof ' || k, 'active') returning id into p1;
  insert into public.wb_projects (user_id, context_id, name, status) values (v_user, v_ctx, 'ZZ S10 other ' || k, 'active') returning id into p2;
  m_proj := pg_temp.zz_merchant('ZZ S10 roofer ' || k);
  r_proj := pg_temp.zz_rule('ZZ S10 roofer rule ' || k, m_proj, 30, 1, null, p1);
  for i in 1..4 loop
    x := pg_temp.zz_hit(acct, r_proj, m_proj, i);
    update public.wb_splits set project_id = case i when 1 then p2 when 2 then null else p1 end,
                                project_source = case when i <= 2 then 'manual' else 'rule' end
    where transaction_id = x;
  end loop;
  m_proj2 := pg_temp.zz_merchant('ZZ S10 roofer two ' || k);
  r_proj_one := pg_temp.zz_rule('ZZ S10 roofer two rule ' || k, m_proj2, 30, 1, null, p1);
  for i in 1..4 loop
    x := pg_temp.zz_hit(acct, r_proj_one, m_proj2, i);
    update public.wb_splits set project_id = case i when 1 then p2 else p1 end,
                                project_source = case when i = 1 then 'manual' else 'rule' end
    where transaction_id = x;
  end loop;

  f := pg_temp.zz_finding('often_overridden', r_proj);
  checks := checks || jsonb_build_object(
    'project_changed_and_removed_count', f.n = 2 and f.of_n = 4 and f.detail = 'project changed on 2 (of 4)',
    'one_project_change_not_enough', pg_temp.zz_finding('often_overridden', r_proj_one) is null,
    'shown_in_wb_rule_health', exists (select 1 from public.wb_rule_health h where h.rule_id = r_proj and h.finding = 'often_overridden'));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step10a();
