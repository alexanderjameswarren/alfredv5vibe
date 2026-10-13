-- Purpose: Warren Buffet Phase 2 Step 10 tests for wb_rule_health: never_fires (with the 14-day, quarterly/annual-notes and long-interval skips), too_broad (3+ distinct normalized payees on a merchant with a rule; "AMAZON MKTPL*AB12" and "AMAZON MKTPL*CD34" are one payee), often_overridden (at least 2 and 25% of hits; tag swap and tag removal), duplicate_rules, rule_missing and merchant_no_category.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-13 by Alex after 127: 17/17 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/128_wb_phase2_step10_rule_health_tests.sql

create or replace function pg_temp.wb_test_step10_rule_health()
returns void
language plpgsql
as $$
declare
  v_ctx   text := 'muvitejhrgt3rgi8t6q';
  v_user  uuid;
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_acct  uuid;
  v_tag   text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  v_cat   uuid;
  t_a     uuid;
  t_b     uuid;
  m       uuid[] := '{}';
  r1      uuid;
  r2      uuid;
  r3      uuid;
  r4      uuid;
  r5      uuid;
  r6      uuid;
  v_ids   uuid[];
  v_split uuid;
  i       int;
  checks  jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  select id into v_cat from public.wb_tag_groups where context_id = v_ctx and name = 'Category';

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ A ' || v_tag) returning id into t_a;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ B ' || v_tag) returning id into t_b;

  -- Ten merchants, m[1]..m[10], each matching 'zzmN<tag>'.
  for i in 1 .. 10 loop
    insert into public.wb_merchants (user_id, context_id, name, match_patterns)
    values (v_user, v_ctx, format('ZZ m%s %s', i, v_tag), array[format('zzm%s%s', i, v_tag)]);
    m := m || (select id from public.wb_merchants where name = format('ZZ m%s %s', i, v_tag));
  end loop;

  -- Rules: r1 (m1, tag A, spend), r2 (m2, tag A), r3 (m3, never fires), r4 (m4, annual notes),
  -- r5 (m5, new), r6 (m6, long-interval subscription).
  insert into public.wb_rules (user_id, context_id, name, match, set_kind, add_tag_ids, created_by)
  values (v_user, v_ctx, 'ZZ r1', jsonb_build_object('merchant_id', m[1]), 'spend', array[t_a], 'claude') returning id into r1;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by)
  values (v_user, v_ctx, 'ZZ r2', jsonb_build_object('merchant_id', m[2]), array[t_a], 'claude') returning id into r2;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by, created_at)
  values (v_user, v_ctx, 'ZZ r3', jsonb_build_object('merchant_id', m[3]), array[t_a], 'claude', now() - interval '30 days') returning id into r3;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by, created_at, notes)
  values (v_user, v_ctx, 'ZZ r4', jsonb_build_object('merchant_id', m[4]), array[t_a], 'claude', now() - interval '30 days', 'Annual renewal') returning id into r4;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by)
  values (v_user, v_ctx, 'ZZ r5', jsonb_build_object('merchant_id', m[5]), array[t_a], 'claude') returning id into r5;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by, created_at)
  values (v_user, v_ctx, 'ZZ r6', jsonb_build_object('merchant_id', m[6]), array[t_a], 'claude', now() - interval '30 days') returning id into r6;
  insert into public.wb_subscriptions (user_id, context_id, name, merchant_id, cadence, status)
  values (v_user, v_ctx, 'ZZ yearly ' || v_tag, m[6], 'annual', 'active');
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by)
  values (v_user, v_ctx, 'ZZ r10', jsonb_build_object('merchant_id', m[10]), array[t_a], 'claude');

  -- Transactions: m1 x4 with 3 distinct payees; m2 x4 with one payee; m7 x3 and m8 x2 (no rule); m9 x2 (no rule, no tags).
  with f(mi, k, payee) as (values
    (1, 1, 'ZZ PAYEE ONE'), (1, 2, 'ZZ PAYEE TWO'), (1, 3, 'ZZ PAYEE THREE'), (1, 4, 'zz payee one'),
    (2, 1, 'ZZ SAME'), (2, 2, 'ZZ SAME'), (2, 3, 'ZZ SAME'), (2, 4, 'ZZ SAME'),
    (7, 1, null), (7, 2, null), (7, 3, null), (8, 1, null), (8, 2, null), (9, 1, null), (9, 2, null),
    (10, 1, 'AMAZON MKTPL*AB12'), (10, 2, 'AMAZON MKTPL*CD34'), (10, 3, 'Amazon  Mktpl 0042*X')),
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
    select v_user, v_ctx, v_acct, format('ZZ-S10-%s-%s', f.mi, f.k), ((v_today - f.k * 3) + time '12:00') at time zone 'America/Los_Angeles',
           -10.00, upper(format('zzm%s%s', f.mi, v_tag)) || ' ' || f.k, f.payee, '{}'
    from f
    returning id)
  select array_agg(id) into v_ids from ins;
  perform public.wb_process_transactions(v_ids);

  -- r1: two of four hits overridden (one tag swapped to B by hand, one rule tag removed).
  select s.id into v_split from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where x.external_id = 'ZZ-S10-1-1' and x.account_id = v_acct;
  delete from public.wb_split_tags where split_id = v_split and source = 'rule';
  insert into public.wb_split_tags (split_id, tag_id, source) values (v_split, t_b, 'manual');
  insert into public.wb_tag_exclusions (transaction_id, tag_id, rule_id, source)
  select x.id, t_a, r1, 'manual' from public.wb_transactions x where x.external_id = 'ZZ-S10-1-2' and x.account_id = v_acct;
  -- r2: one of four overridden (below the threshold of 2).
  select s.id into v_split from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where x.external_id = 'ZZ-S10-2-1' and x.account_id = v_acct;
  delete from public.wb_split_tags where split_id = v_split and source = 'rule';
  insert into public.wb_split_tags (split_id, tag_id, source) values (v_split, t_b, 'manual');
  -- m7: three hand-tagged, no rule; m8: two.
  insert into public.wb_split_tags (split_id, tag_id, source)
  select s.id, t_b, 'claude' from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where x.account_id = v_acct and x.merchant_id in (m[7], m[8]);

  checks := checks || jsonb_build_object(
    'never_fires_old_rule', exists (select 1 from public.wb_rule_health where finding = 'never_fires' and rule_id = r3),
    'never_fires_skips_annual_notes', not exists (select 1 from public.wb_rule_health where finding = 'never_fires' and rule_id = r4),
    'never_fires_skips_new_rule', not exists (select 1 from public.wb_rule_health where finding = 'never_fires' and rule_id = r5),
    'never_fires_skips_long_interval', not exists (select 1 from public.wb_rule_health where finding = 'never_fires' and rule_id = r6),
    'never_fires_not_for_firing_rule', not exists (select 1 from public.wb_rule_health where finding = 'never_fires' and rule_id = r1),
    'too_broad_three_payees', (select n = 3 and of_n = 4 and detail like 'Payees: zz payee one; zz payee three; zz payee two'
                               from public.wb_rule_health where finding = 'too_broad' and merchant_id = m[1]),
    'too_broad_not_one_payee', not exists (select 1 from public.wb_rule_health where finding = 'too_broad' and merchant_id = m[2]),
    'too_broad_normalizes_payees', not exists (select 1 from public.wb_rule_health where finding = 'too_broad' and merchant_id = m[10]),
    'too_broad_needs_a_rule', not exists (select 1 from public.wb_rule_health where finding = 'too_broad' and merchant_id = m[7]),
    'overridden_two_of_four', (select n = 2 and of_n = 4 and detail = '1 tag swapped, 1 tag removed'
                               from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1),
    'overridden_needs_two', not exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r2),
    'rule_missing_three', (select n = 3 from public.wb_rule_health where finding = 'rule_missing' and merchant_id = m[7]),
    'rule_missing_needs_three', not exists (select 1 from public.wb_rule_health where finding = 'rule_missing' and merchant_id = m[8]),
    'no_category_flagged', (select n = 2 from public.wb_rule_health where finding = 'merchant_no_category' and merchant_id = m[9]),
    'no_category_not_when_tagged', not exists (select 1 from public.wb_rule_health where finding = 'merchant_no_category' and merchant_id in (m[1], m[2])),
    'no_duplicates_yet', not exists (select 1 from public.wb_rule_health where finding = 'duplicate_rules' and merchant_id = m[1]));

  -- A second active rule on m1.
  insert into public.wb_rules (user_id, context_id, name, match, set_kind, created_by)
  values (v_user, v_ctx, 'ZZ r1 again', jsonb_build_object('merchant_id', m[1]), 'spend', 'manual');
  checks := checks || jsonb_build_object(
    'duplicate_rules', (select n = 2 and detail like 'Rules: ZZ r1%ZZ r1 again'
                        from public.wb_rule_health where finding = 'duplicate_rules' and merchant_id = m[1]));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step10_rule_health();
