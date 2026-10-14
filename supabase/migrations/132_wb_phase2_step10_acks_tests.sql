-- Purpose: Warren Buffet Phase 2 Step 10 follow-up tests: an acknowledged finding is hidden from wb_rule_health and kept in wb_rule_health_all; it reappears when its n grows past the acknowledged n; re-acknowledging hides it again; un-acknowledging (deleting the row) shows it; a merchant-level finding is acknowledged by merchant; the table refuses a blank reason or an unknown finding; and wb_bulk_create reports a null id for an item it did not really create.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-14 by Alex after 131: 19/19 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/132_wb_phase2_step10_acks_tests.sql

create or replace function pg_temp.wb_test_step10_acks()
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
  m1      uuid;
  r1      uuid;
  v_ids   uuid[];
  v_split uuid;
  v_res   jsonb;
  v_err   text;
  checks  jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  select id into v_cat from public.wb_tag_groups where context_id = v_ctx and name = 'Category';

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ A ' || v_tag) returning id into t_a;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ B ' || v_tag) returning id into t_b;
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  values (v_user, v_ctx, 'ZZ m1 ' || v_tag, array['zzm1' || v_tag]) returning id into m1;
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by)
  values (v_user, v_ctx, 'ZZ r1', jsonb_build_object('merchant_id', m1), array[t_a], 'claude') returning id into r1;

  -- Six charges with three payees; the rule tags all six.
  with f(k, payee) as (values (1, 'ZZ ONE'), (2, 'ZZ TWO'), (3, 'ZZ THREE'), (4, 'ZZ ONE'), (5, 'ZZ ONE'), (6, 'ZZ ONE')),
  ins as (
    insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
    select v_user, v_ctx, v_acct, 'ZZ-ACK-' || f.k, ((v_today - f.k * 3) + time '12:00') at time zone 'America/Los_Angeles',
           -10.00, upper('zzm1' || v_tag) || ' ' || f.k, f.payee, '{}'
    from f
    returning id)
  select array_agg(id) into v_ids from ins;
  perform public.wb_process_transactions(v_ids);

  -- Two of six swapped to B by hand: often_overridden, n = 2.
  for v_split in
    select s.id from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
    where x.account_id = v_acct and x.external_id in ('ZZ-ACK-1', 'ZZ-ACK-2')
  loop
    delete from public.wb_split_tags where split_id = v_split and source = 'rule';
    insert into public.wb_split_tags (split_id, tag_id, source) values (v_split, t_b, 'manual');
  end loop;
  checks := checks || jsonb_build_object(
    'finding_shown', exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1 and n = 2));

  -- Acknowledge it at n = 2.
  insert into public.wb_rule_health_acks (user_id, context_id, finding, subject_id, acked_n, reason)
  values (v_user, v_ctx, 'often_overridden', r1, 2, 'ZZ deliberate re-split');
  checks := checks || jsonb_build_object(
    'ack_hides', not exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1),
    'ack_kept_in_all', (select acknowledged and acked_n = 2 and ack_reason = 'ZZ deliberate re-split' and subject_id = r1
                        from public.wb_rule_health_all where finding = 'often_overridden' and rule_id = r1));

  -- A third override: n = 3 > 2, so it shows again.
  select s.id into v_split from public.wb_splits s join public.wb_transactions x on x.id = s.transaction_id
  where x.account_id = v_acct and x.external_id = 'ZZ-ACK-3';
  delete from public.wb_split_tags where split_id = v_split and source = 'rule';
  insert into public.wb_split_tags (split_id, tag_id, source) values (v_split, t_b, 'manual');
  checks := checks || jsonb_build_object(
    'reappears_when_n_grows', exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1 and n = 3),
    'all_says_not_acknowledged', (select not acknowledged and acked_n = 2 from public.wb_rule_health_all
                                  where finding = 'often_overridden' and rule_id = r1));

  -- Re-acknowledge at the new n, then un-acknowledge.
  update public.wb_rule_health_acks set acked_n = 3 where finding = 'often_overridden' and subject_id = r1;
  checks := checks || jsonb_build_object(
    'reack_hides', not exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1));
  delete from public.wb_rule_health_acks where finding = 'often_overridden' and subject_id = r1;
  checks := checks || jsonb_build_object(
    'unack_shows', exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1),
    'unack_all_clean', (select not acknowledged and acked_n is null from public.wb_rule_health_all
                        where finding = 'often_overridden' and rule_id = r1));

  -- A merchant-level finding is acknowledged by merchant.
  checks := checks || jsonb_build_object(
    'too_broad_shown', exists (select 1 from public.wb_rule_health where finding = 'too_broad' and merchant_id = m1));
  insert into public.wb_rule_health_acks (user_id, context_id, finding, subject_id, acked_n, reason)
  values (v_user, v_ctx, 'too_broad', m1, 3, 'ZZ one-off payees');
  checks := checks || jsonb_build_object(
    'merchant_ack_hides', not exists (select 1 from public.wb_rule_health where finding = 'too_broad' and merchant_id = m1),
    'merchant_ack_only_that_finding', exists (select 1 from public.wb_rule_health where finding = 'often_overridden' and rule_id = r1));

  -- The table's checks.
  begin
    insert into public.wb_rule_health_acks (user_id, context_id, finding, subject_id, acked_n, reason)
    values (v_user, v_ctx, 'never_fires', r1, 0, '  ');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('blank_reason_refused', v_err = 'refused');
  begin
    insert into public.wb_rule_health_acks (user_id, context_id, finding, subject_id, acked_n, reason)
    values (v_user, v_ctx, 'made_up', r1, 0, 'ZZ');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('unknown_finding_refused', v_err = 'refused');
  begin
    insert into public.wb_rule_health_acks (user_id, context_id, finding, subject_id, acked_n, reason)
    values (v_user, v_ctx, 'too_broad', m1, 4, 'ZZ again');
    v_err := null;
  exception when unique_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('one_ack_per_finding_and_subject', v_err = 'refused');

  -- wb_bulk_create: a dry run's created items have no id; an existing item keeps its real id.
  v_res := public.wb_bulk_create(jsonb_build_object('tags', jsonb_build_array(
             jsonb_build_object('group', 'Category', 'name', 'ZZ New ' || v_tag),
             jsonb_build_object('group', 'Category', 'name', 'ZZ A ' || v_tag))), v_ctx, true, 'claude');
  checks := checks || jsonb_build_object(
    'dry_run_created_id_null', (select r -> 'id' = 'null'::jsonb from jsonb_array_elements(v_res -> 'results') r where r ->> 'status' = 'created'),
    'dry_run_exists_keeps_id', (select (r ->> 'id')::uuid = t_a from jsonb_array_elements(v_res -> 'results') r where r ->> 'status' = 'exists'),
    'dry_run_order_kept', (select array_agg(r ->> 'status' order by ord) from jsonb_array_elements(v_res -> 'results') with ordinality e(r, ord))
                          = array['created', 'exists']);
  -- A run with an error writes nothing, so its created item has no id either.
  v_res := public.wb_bulk_create(jsonb_build_object(
             'tags', jsonb_build_array(jsonb_build_object('group', 'Category', 'name', 'ZZ New ' || v_tag)),
             'rules', jsonb_build_array(jsonb_build_object('name', 'ZZ x', 'merchant', 'ZZ Nowhere ' || v_tag, 'set_kind', 'spend'))),
           v_ctx, false, 'claude');
  checks := checks || jsonb_build_object(
    'failed_run_created_id_null', (v_res ->> 'applied')::boolean = false
      and (select r -> 'id' = 'null'::jsonb from jsonb_array_elements(v_res -> 'results') r where r ->> 'status' = 'created'));
  -- A real run keeps real ids.
  v_res := public.wb_bulk_create(jsonb_build_object('tags', jsonb_build_array(
             jsonb_build_object('group', 'Category', 'name', 'ZZ New ' || v_tag))), v_ctx, false, 'claude');
  checks := checks || jsonb_build_object(
    'real_run_keeps_id', (select (r ->> 'id')::uuid = (select id from public.wb_tags where name = 'ZZ New ' || v_tag)
                          from jsonb_array_elements(v_res -> 'results') r));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step10_acks();
