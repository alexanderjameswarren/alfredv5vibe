-- Purpose: Warren Buffet Phase 2 Step 6a tests for "Always do this": wb_suggest_pattern, wb_fix_plan and wb_apply_fix (new merchant and rule, existing rule refused without a choice, update merges tags, exclusive tag replaced, add-new allowed, pattern added to an existing merchant), and wb_transactions.notes in the list view.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-11 by Alex after 117: 24/24 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/118_wb_phase2_step6_tests.sql

create or replace function pg_temp.wb_test_step6_fix()
returns void
language plpgsql
as $$
declare
  v_ctx    text := 'muvitejhrgt3rgi8t6q';
  v_user   uuid;
  v_acct   uuid;
  v_food   uuid;
  v_pets   uuid;
  v_who    uuid;
  v_t1     uuid;
  v_t2     uuid;
  v_t3     uuid;
  v_plan   jsonb;
  v_res    jsonb;
  v_rule   record;
  v_mid    uuid;
  -- A unique letters-only word, so no real row matches and it can be a pattern.
  v_tag    text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  checks   jsonb := '{}'::jsonb;
  v_err    text;
begin
  select user_id into v_user from public.contexts where id = v_ctx;

  -- Pure: the suggested pattern.
  checks := checks || jsonb_build_object(
    'suggest_payee_first', public.wb_suggest_pattern('Corner Coffee Roasters', null) = 'corner',
    'suggest_from_clean', public.wb_suggest_pattern(null, 'SQ CORNER COFFEE') = 'corner',
    'suggest_none_for_stop_words', public.wb_suggest_pattern('Online Payment', 'CARD PAYMENT') is null,
    'suggest_one_word', public.wb_suggest_pattern('PetStore', 'PET STORE AZ') = 'petstore');

  -- Fixtures: an account, three tags (two Category, one Who), three transactions,
  -- two at an unknown shop and one whose payee only names it differently.
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select v_user, v_ctx, g.id, 'ZZ food ' || v_tag from public.wb_tag_groups g where g.name = 'Category' returning id into v_food;
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select v_user, v_ctx, g.id, 'ZZ pets ' || v_tag from public.wb_tag_groups g where g.name = 'Category' returning id into v_pets;
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select v_user, v_ctx, g.id, 'ZZ who ' || v_tag from public.wb_tag_groups g where g.name = 'Who' returning id into v_who;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-T1', '2026-01-05 18:00Z', -20.00, upper(v_tag) || ' SHOP 0001', initcap(v_tag) || ' Shop', '{}')
  returning id into v_t1;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-T2', '2026-01-06 18:00Z', -30.00, upper(v_tag) || ' SHOP 0002', initcap(v_tag) || ' Shop', '{}')
  returning id into v_t2;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-T3', '2026-01-07 18:00Z', -40.00, 'OTHERNAME' || v_tag || ' 0003', null, '{}')
  returning id into v_t3;
  perform public.wb_process_transactions(array[v_t1, v_t2, v_t3]);

  -- Plan for a transaction with no merchant.
  v_plan := public.wb_fix_plan(v_t1);
  checks := checks || jsonb_build_object(
    'plan_suggests_pattern', v_plan ->> 'pattern' = v_tag,
    'plan_new_merchant', (v_plan #>> '{merchant,exists}')::boolean = false and v_plan #>> '{merchant,name}' = initcap(v_tag),
    'plan_counts_all_three', (v_plan #>> '{dry_run,count}')::int = 3,
    'plan_not_too_narrow', (v_plan #>> '{dry_run,too_narrow}')::boolean = false,
    'plan_no_rules', jsonb_array_length(v_plan -> 'existing_rules') = 0);

  -- A too-short pattern is refused.
  begin
    perform public.wb_fix_plan(v_t1, 'ab');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('plan_refuses_short_pattern', v_err like '%at least 3 characters%');

  -- Apply: merchant and rule are created, both tagged and kinded.
  v_res := public.wb_apply_fix(v_t1, 'spend', array[v_food], null, null, null, false, null, 'manual');
  v_mid := (v_res ->> 'merchant_id')::uuid;
  select * into v_rule from public.wb_rules where id = (v_res ->> 'rule_id')::uuid;
  checks := checks || jsonb_build_object(
    'apply_creates_merchant', (v_res ->> 'merchant_created')::boolean
      and exists (select 1 from public.wb_merchants where id = v_mid and v_tag = any (match_patterns)),
    'apply_rule_matches_merchant', v_rule.match = jsonb_build_object('merchant_id', v_mid),
    'apply_records_source_transaction', v_rule.created_from_transaction_id = v_t1 and v_rule.created_by = 'manual',
    'apply_matches_three', (v_res ->> 'matched_now')::int = 3,
    'apply_tags_all_three', (select count(*) = 3 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
                             where s.transaction_id in (v_t1, v_t2, v_t3) and st.tag_id = v_food and st.rule_id = v_rule.id));

  -- Plan again: the merchant has a rule now.
  v_plan := public.wb_fix_plan(v_t2);
  checks := checks || jsonb_build_object(
    'plan_sees_existing_rule', jsonb_array_length(v_plan -> 'existing_rules') = 1
      and v_plan -> 'warnings' ->> 0 like 'A rule already exists%');

  -- A second rule without a choice is refused.
  begin
    perform public.wb_apply_fix(v_t2, null, array[v_who]);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('apply_refuses_duplicate_rule', v_err like '%rule already exists%');

  -- Update the rule: a Who tag is added and Food stays.
  perform public.wb_apply_fix(v_t2, null, array[v_who], null, null, v_rule.id);
  checks := checks || jsonb_build_object(
    'update_merges_tags', (select add_tag_ids @> array[v_food, v_who] and cardinality(add_tag_ids) = 2 from public.wb_rules where id = v_rule.id),
    'update_keeps_one_rule', (select count(*) = 1 from public.wb_rules where match ->> 'merchant_id' = v_mid::text));

  -- Update with another Category tag: it replaces Food (exclusive group), Who stays.
  perform public.wb_apply_fix(v_t2, null, array[v_pets], null, null, v_rule.id);
  checks := checks || jsonb_build_object(
    'update_replaces_exclusive_tag', (select add_tag_ids @> array[v_pets, v_who] and not (v_food = any (add_tag_ids))
                                      from public.wb_rules where id = v_rule.id),
    'update_retags_rows', (select count(*) = 3 from public.wb_splits s join public.wb_split_tags st on st.split_id = s.id
                           where s.transaction_id in (v_t1, v_t2, v_t3) and st.tag_id = v_pets));

  -- add_new_rule makes a second rule.
  perform public.wb_apply_fix(v_t2, 'spend', array[v_who], null, null, null, true);
  checks := checks || jsonb_build_object(
    'add_new_rule_allowed', (select count(*) = 2 from public.wb_rules where match ->> 'merchant_id' = v_mid::text));

  -- A pattern for an existing merchant (by name) is added to it, not a new merchant.
  v_plan := public.wb_fix_plan(v_t3, 'othername' || v_tag, initcap(v_tag));
  checks := checks || jsonb_build_object(
    'plan_finds_merchant_by_name', (v_plan #>> '{merchant,id}')::uuid = v_mid
      and v_plan #>> '{merchant,add_pattern}' = 'othername' || v_tag);

  -- Notes: written on the transaction, shown in the list view.
  update public.wb_transactions set notes = 'ZZ test note' where id = v_t1;
  checks := checks || jsonb_build_object(
    'notes_in_list_view', (select notes = 'ZZ test note' from public.wb_transaction_list where id = v_t1));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step6_fix();
