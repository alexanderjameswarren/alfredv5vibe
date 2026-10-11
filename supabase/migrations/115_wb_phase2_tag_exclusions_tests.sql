-- Purpose: Warren Buffet Phase 2, Step 5 follow-up tests for tag exclusions: a tag removed by hand survives a full reprocess, a single-transaction reprocess and a re-split; adding it back clears the exclusion; the rule's other tags still apply.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-11 by Alex after 114: 13/13 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/115_wb_phase2_tag_exclusions_tests.sql

create or replace function pg_temp.wb_test_tag_exclusions()
returns void
language plpgsql
as $$
declare
  v_ctx    text := 'muvitejhrgt3rgi8t6q';
  v_user   uuid;
  v_acct   uuid;
  v_m      uuid;
  v_cat    uuid;
  v_lbl    uuid;
  v_rule   uuid;
  v_t1     uuid;
  v_t2     uuid;
  checks   jsonb := '{}'::jsonb;
  ex       record;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  -- Fixtures: an account, a merchant, a Category tag and a Label tag, one rule
  -- adding both, and two transactions at that merchant.
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ Test Shop ' || gen_random_uuid(), array['zz test shop'])
  returning id into v_m;
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select v_user, v_ctx, g.id, 'ZZ test category ' || gen_random_uuid() from public.wb_tag_groups g where g.name = 'Category'
  returning id into v_cat;
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select v_user, v_ctx, g.id, 'ZZ test label ' || gen_random_uuid() from public.wb_tag_groups g where g.name = 'Label'
  returning id into v_lbl;
  insert into public.wb_rules (user_id, context_id, name, priority, match, add_tag_ids, created_by)
  -- Priority below any real rule, so it runs first and owns the Category group.
  values (v_user, v_ctx, 'ZZ test rule', -1000, jsonb_build_object('merchant_id', v_m), array[v_cat, v_lbl], 'claude')
  returning id into v_rule;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-T1', '2026-01-05 18:00Z', -20.00, 'ZZ TEST SHOP 0001', '{}')
  returning id into v_t1;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-T2', '2026-01-06 18:00Z', -30.00, 'ZZ TEST SHOP 0002', '{}')
  returning id into v_t2;

  perform public.wb_process_transactions(array[v_t1, v_t2]);
  checks := checks || jsonb_build_object('rule_applies_both_tags',
    (select count(*) = 2 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
     where s.transaction_id = v_t1 and st.tag_id in (v_cat, v_lbl) and st.source = 'rule'));

  -- Remove the Label by hand.
  perform public.wb_apply_tags(array[v_t1], '{}'::uuid[], 'manual', array[v_lbl]);
  select * into ex from public.wb_tag_exclusions where transaction_id = v_t1 and tag_id = v_lbl;
  checks := checks || jsonb_build_object('removal_writes_exclusion',
    ex.id is not null and ex.source = 'manual' and ex.rule_id = v_rule);

  -- Survives a full reprocess (every transaction, as the sync or a range reprocess would).
  perform public.wb_process_transactions(array(select id from public.wb_transactions));
  checks := checks || jsonb_build_object(
    'survives_full_reprocess', not exists (
      select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t1 and st.tag_id = v_lbl),
    'other_rule_tag_still_applied', exists (
      select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t1 and st.tag_id = v_cat and st.rule_id = v_rule),
    'other_transaction_unaffected', (
      select count(*) = 2 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t2 and st.tag_id in (v_cat, v_lbl)));

  -- Survives a single-transaction reprocess.
  perform public.wb_process_transactions(array[v_t1]);
  checks := checks || jsonb_build_object('survives_single_reprocess', not exists (
    select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
    where s.transaction_id = v_t1 and st.tag_id = v_lbl));

  -- Survives a re-split: two parts, back to one, then a reprocess.
  perform public.wb_replace_splits(v_t1, '[{"amount": -12.00}, {"amount": -8.00}]'::jsonb, 'manual');
  perform public.wb_replace_splits(v_t1, '[{"amount": -20.00}]'::jsonb, 'manual');
  perform public.wb_process_transactions(array[v_t1]);
  checks := checks || jsonb_build_object(
    'survives_resplit', not exists (
      select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t1 and st.tag_id = v_lbl),
    'exclusion_kept_after_resplit', exists (
      select 1 from public.wb_tag_exclusions where transaction_id = v_t1 and tag_id = v_lbl),
    'category_back_after_resplit', exists (
      select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t1 and st.tag_id = v_cat));

  -- Adding it back by hand clears the exclusion, and it stays through a reprocess.
  perform public.wb_apply_tags(array[v_t1], array[v_lbl], 'manual');
  perform public.wb_process_transactions(array[v_t1]);
  checks := checks || jsonb_build_object(
    'readd_clears_exclusion', not exists (
      select 1 from public.wb_tag_exclusions where transaction_id = v_t1 and tag_id = v_lbl),
    'readded_tag_stays', exists (
      select 1 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
      where s.transaction_id = v_t1 and st.tag_id = v_lbl and st.source = 'manual'));

  -- Adding it back through a split also clears it.
  perform public.wb_apply_tags(array[v_t1], '{}'::uuid[], 'manual', array[v_lbl]);
  perform public.wb_replace_splits(v_t1, jsonb_build_array(jsonb_build_object('amount', -20.00, 'tag_ids', jsonb_build_array(v_lbl))), 'manual');
  checks := checks || jsonb_build_object('split_readd_clears_exclusion', not exists (
    select 1 from public.wb_tag_exclusions where transaction_id = v_t1 and tag_id = v_lbl));

  -- The list view shows an exclusion.
  perform public.wb_apply_tags(array[v_t2], '{}'::uuid[], 'claude', array[v_lbl]);
  checks := checks || jsonb_build_object('list_view_shows_exclusion', (
    select l.excluded_tags -> 0 ->> 'tag_id' = v_lbl::text and l.excluded_tags -> 0 ->> 'source' = 'claude'
    from public.wb_transaction_list l where l.id = v_t2));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_tag_exclusions();
