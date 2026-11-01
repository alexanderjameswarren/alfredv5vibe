-- Purpose: Warren Buffet Phase 4 Step 4 tests, run after 191_history_source.sql (spec P4-D2, P4-D4): each place imported history is kept out, with one imported row and one synced row, and synced rows behaving as before.
-- Kind: test (writes invented fixtures in one transaction that ends in ROLLBACK: nothing persists)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ P4" fixtures). No real financial data. The views read today,
-- so every date here is counted back from today. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: each case raises a NOTICE, PASS or FAIL. Any failure stops the script with an
-- error listing the failed cases, and everything rolls back. If all pass, the result grid shows one row:
-- summary "ALL PASSED, rolled back" and rows_left_behind 0. The grid works where notices are not shown.
-- supabase/tests/warren_buffet_p4/2_history_source_tests.sql

begin;

create function pg_temp.zz_acct(p_role text)
returns uuid
language sql
as $$
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  select c.user_id, c.id, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ P4 acct ' || gen_random_uuid(), p_role
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create function pg_temp.zz_merchant(p_pattern text default null)
returns uuid
language sql
as $$
  insert into public.wb_merchants (user_id, context_id, name, match_patterns)
  select c.user_id, c.id, 'ZZ P4 merchant ' || gen_random_uuid(),
         case when p_pattern is null then '{}'::text[] else array[p_pattern] end
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- A settled row p_days ago. The insert trigger gives it its default split.
create function pg_temp.zz_txn(p_acct uuid, p_days int, p_amount numeric, p_desc text, p_source text,
                               p_merchant uuid default null, p_kind text default null, p_kind_source text default null)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee,
                                       raw, merchant_id, kind, kind_source, source)
  select a.user_id, a.context_id, p_acct, 'ZZ-P4-' || gen_random_uuid(),
         (((now() at time zone 'America/Los_Angeles')::date - p_days) + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, p_desc, p_desc, '{}', p_merchant, p_kind, p_kind_source, p_source
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

-- Several rows, each matched by a rule or linked to a subscription.
create function pg_temp.zz_txns(p_acct uuid, p_days int[], p_source text, p_merchant uuid, p_kind text, p_kind_source text,
                                p_rule uuid default null, p_sub uuid default null)
returns void
language plpgsql
as $$
declare
  d int;
  v_id uuid;
begin
  foreach d in array p_days loop
    v_id := pg_temp.zz_txn(p_acct, d, -9, 'ZZ MANY', p_source, p_merchant, p_kind, p_kind_source);
    update public.wb_transactions
    set matched_rule_ids = case when p_rule is null then matched_rule_ids else array[p_rule] end,
        subscription_id = p_sub,
        subscription_source = case when p_sub is null then null else 'manual' end
    where id = v_id;
  end loop;
end;
$$;

create function pg_temp.zz_rule(p_merchant uuid, p_set_kind text default null, p_quiet int default 1)
returns uuid
language sql
as $$
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, set_kind, created_by, created_at, hit_count, last_hit_at)
  select c.user_id, c.id, 'ZZ P4 rule ' || gen_random_uuid(), jsonb_build_object('merchant_id', p_merchant), '{}', p_set_kind, 'claude',
         now() - interval '900 days', 1, now() - make_interval(days => p_quiet)
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create function pg_temp.zz_item(p_amount numeric, p_merchant uuid default null)
returns uuid
language sql
as $$
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, match_window_days, merchant_id)
  select c.user_id, c.id, 'ZZ P4 item ' || gen_random_uuid(), p_amount, (now() at time zone 'America/Los_Angeles')::date - 2, 'invoiced', 10, p_merchant
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create function pg_temp.zz_queued(p_txn uuid, p_reason text)
returns boolean
language sql
as $$ select exists (select 1 from public.wb_review_queue q where q.transaction_id = p_txn and q.reason = p_reason); $$;

create function pg_temp.zz_in_queue(p_txn uuid)
returns boolean
language sql
as $$ select exists (select 1 from public.wb_review_queue q where q.transaction_id = p_txn); $$;

create function pg_temp.zz_needs_review(p_txn uuid)
returns boolean
language sql
as $$ select l.needs_review from public.wb_transaction_list l where l.id = p_txn; $$;

create function pg_temp.zz_flag(p_items jsonb, p_txn uuid)
returns text
language sql
as $$ select e ->> 'severity' from jsonb_array_elements(p_items -> 'flags') e where e ->> 'link_id' = p_txn::text limit 1; $$;

create function pg_temp.zz_matches(p_item uuid)
returns bigint
language sql
as $$ select count(*) from public.wb_planned_matches m where m.planned_item_id = p_item and m.status = 'suggested'; $$;

create function pg_temp.zz_finding(p_finding text, p_merchant uuid)
returns boolean
language sql
as $$ select exists (select 1 from public.wb_rule_health_all h where h.finding = p_finding and h.merchant_id = p_merchant); $$;

do $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  k      text := 'zzp4' || substr(md5(random()::text), 1, 10);
  cash uuid; cardA uuid; cardB uuid;
  x_imp uuid; x_syn uuid; x_old uuid; x_new uuid; x_matched uuid; v_split uuid; v_item uuid;
  m_watch uuid; s_watch uuid;
  fee_imp uuid; fee_syn uuid; fee_ref uuid;
  items jsonb;
  m1 uuid; m2 uuid; i1 uuid; i2 uuid; i3 uuid; i4 uuid; i5 uuid; i6 uuid; x1 uuid; x2 uuid; x3 uuid; x4 uuid; x5 uuid; x6 uuid;
  p1 jsonb; p2 jsonb;
  m_start uuid; m_start_imp uuid;
  m_cat_imp uuid; m_cat_syn uuid; m_broad_imp uuid; m_broad_syn uuid; m_over_imp uuid; m_over_syn uuid; m_int uuid; s_int uuid;
  r_over_imp uuid; r_over_syn uuid; r_int uuid;
  bad_source boolean := false;
  c record;
  failed text[] := '{}';
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  cash := pg_temp.zz_acct('spending_cash');
  cardA := pg_temp.zz_acct('credit_card');
  cardB := pg_temp.zz_acct('credit_card');

  -- ---------------------------------------------------------------- review queue and needs_review
  -- Fresh rows have no kind, so a synced one is queued as no_kind.
  x_imp := pg_temp.zz_txn(cash, 3, -21.17, 'ZZ IMPORTED', 'history_import');
  x_syn := pg_temp.zz_txn(cash, 3, -21.17, 'ZZ SYNCED', 'sync');

  -- planned_match ignores reviewed, so reviewed alone would not keep an imported row out.
  x_matched := pg_temp.zz_txn(cash, 3, -22.19, 'ZZ IMPORTED MATCHED', 'history_import', null, 'spend', 'manual');
  update public.wb_transactions set reviewed = true where id = x_matched;
  select s.id into v_split from public.wb_splits s where s.transaction_id = x_matched;
  v_item := pg_temp.zz_item(-22.19);
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (v_item, v_split, -22.19, 'suggested', 'default');

  -- A watching subscription: the imported charge is newer, and the synced one still shows.
  m_watch := pg_temp.zz_merchant();
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, expected_amount, status, merchant_id)
  values (v_user, v_ctx, 'ZZ P4 watching ' || k, 'monthly', 5, 'watching', m_watch) returning id into s_watch;
  x_old := pg_temp.zz_txn(cash, 40, -5, 'ZZ WATCH SYNCED', 'sync', m_watch, 'spend', 'manual');
  x_new := pg_temp.zz_txn(cash, 10, -5, 'ZZ WATCH IMPORTED', 'history_import', m_watch, 'spend', 'manual');
  update public.wb_transactions set subscription_id = s_watch, subscription_source = 'manual' where id in (x_old, x_new);

  -- ---------------------------------------------------------------- card fee and interest flags
  fee_imp := pg_temp.zz_txn(cardA, 20, -12.41, 'INTEREST CHARGE ZZ', 'history_import');
  fee_syn := pg_temp.zz_txn(cardA, 10, -12.41, 'INTEREST CHARGE ZZ', 'sync');
  perform pg_temp.zz_txn(cardA, 5, 12.41, 'ZZ CREDIT', 'history_import', null, 'refund', 'manual');
  fee_ref := pg_temp.zz_txn(cardB, 10, -13.43, 'LATE FEE ZZ', 'sync');
  perform pg_temp.zz_txn(cardB, 5, 13.43, 'ZZ CREDIT', 'sync', null, 'refund', 'manual');
  items := public.wb_action_items();

  -- ---------------------------------------------------------------- planned-match suggestions
  m1 := pg_temp.zz_merchant();
  m2 := pg_temp.zz_merchant();
  i1 := pg_temp.zz_item(-31.23, m1);
  i2 := pg_temp.zz_item(-31.29, m2);
  x1 := pg_temp.zz_txn(cash, 2, -31.23, 'ZZ AT MERCHANT', 'history_import', m1);
  x2 := pg_temp.zz_txn(cash, 2, -31.29, 'ZZ AT MERCHANT', 'sync', m2);
  perform public.wb_suggest_planned_matches(array[x1, x2], null);

  -- An item with no merchant takes any payment, so this one is the wider door.
  i3 := pg_temp.zz_item(-37.31);
  i4 := pg_temp.zz_item(-37.37);
  x3 := pg_temp.zz_txn(cash, 2, -37.31, 'ZZ NO MERCHANT', 'history_import');
  x4 := pg_temp.zz_txn(cash, 2, -37.37, 'ZZ NO MERCHANT', 'sync');
  perform public.wb_suggest_planned_matches(null, array[i3, i4]);

  -- Through processing, which is how the import reaches it. Each merchant is found by its pattern.
  i5 := pg_temp.zz_item(-41.41, pg_temp.zz_merchant(k || 'a'));
  i6 := pg_temp.zz_item(-41.47, pg_temp.zz_merchant(k || 'b'));
  x5 := pg_temp.zz_txn(cash, 2, -41.41, k || 'a', 'history_import');
  x6 := pg_temp.zz_txn(cash, 2, -41.47, k || 'b', 'sync');
  p1 := public.wb_process_transactions(array[x5]);
  p2 := public.wb_process_transactions(array[x6]);

  -- ---------------------------------------------------------------- planned item backdating
  m_start := pg_temp.zz_merchant();
  m_start_imp := pg_temp.zz_merchant();
  perform pg_temp.zz_txn(cash, 3, -43.43, 'ZZ START', 'history_import', m_start);
  perform pg_temp.zz_txn(cash, 2, -43.43, 'ZZ START', 'sync', m_start);
  perform pg_temp.zz_txn(cash, 3, -43.43, 'ZZ START', 'history_import', m_start_imp);

  -- ---------------------------------------------------------------- rule health
  m_cat_imp := pg_temp.zz_merchant();
  m_cat_syn := pg_temp.zz_merchant();
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ CAT', 'history_import', m_cat_imp, 'spend', 'manual');
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ CAT', 'sync', m_cat_syn, 'spend', 'manual');
  perform pg_temp.zz_txn(cash, 5, -9, 'ZZ CAT', 'history_import', m_cat_syn, 'spend', 'manual');

  -- Two payees synced and two more imported is not too broad; three synced is.
  m_broad_imp := pg_temp.zz_merchant();
  m_broad_syn := pg_temp.zz_merchant();
  perform pg_temp.zz_rule(m_broad_imp);
  perform pg_temp.zz_rule(m_broad_syn);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE ONE', 'sync', m_broad_imp);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE TWO', 'sync', m_broad_imp);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE THREE', 'history_import', m_broad_imp);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE FOUR', 'history_import', m_broad_imp);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE ONE', 'sync', m_broad_syn);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE TWO', 'sync', m_broad_syn);
  perform pg_temp.zz_txn(cash, 4, -9, 'ZZ PAYEE THREE', 'sync', m_broad_syn);

  -- A kind changed by hand beats a rule that sets one. Imported corrections do not count; imported
  -- matches do not dilute of_n either: 2 synced corrections read as 2 of 2, not 2 of 12.
  m_over_imp := pg_temp.zz_merchant();
  m_over_syn := pg_temp.zz_merchant();
  r_over_imp := pg_temp.zz_rule(m_over_imp, 'spend');
  r_over_syn := pg_temp.zz_rule(m_over_syn, 'spend');
  perform pg_temp.zz_txns(cash, array[5, 6, 7, 8], 'history_import', m_over_imp, 'income', 'manual', r_over_imp);
  perform pg_temp.zz_txns(cash, array[5, 6], 'sync', m_over_syn, 'income', 'manual', r_over_syn);
  perform pg_temp.zz_txns(cash, array[11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 'history_import', m_over_syn, 'spend', 'rule', r_over_syn);

  -- Imported charges are still interval data: gaps of 14 days under a monthly subscription.
  m_int := pg_temp.zz_merchant();
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, interval_count, interval_unit, expected_amount, status, merchant_id)
  values (v_user, v_ctx, 'ZZ P4 interval ' || k, 'other', 1, 'month', 10, 'active', m_int) returning id into s_int;
  r_int := pg_temp.zz_rule(m_int, null, 50);
  perform pg_temp.zz_txns(cash, array[60, 74, 88, 102], 'history_import', m_int, 'spend', 'manual', null, s_int);

  -- ---------------------------------------------------------------- the column itself
  begin
    perform pg_temp.zz_txn(cash, 1, -1, 'ZZ BAD', 'other');
  exception when check_violation then
    bad_source := true;
  end;

  for c in
    select * from (values
      ('source defaults to sync',
       (select column_default like '''sync''%' and is_nullable = 'NO' from information_schema.columns
        where table_schema = 'public' and table_name = 'wb_transactions' and column_name = 'source')),
      ('source refuses any other value', bad_source),
      ('history_from is a date',
       (select data_type = 'date' from information_schema.columns
        where table_schema = 'public' and table_name = 'wb_accounts' and column_name = 'history_from')),
      ('list exposes source',
       (select source = 'history_import' from public.wb_transaction_list where id = x_imp)
       and (select source = 'sync' from public.wb_transaction_list where id = x_syn)),
      ('queue: imported row left out', not pg_temp.zz_in_queue(x_imp)),
      ('queue: synced row still in', pg_temp.zz_queued(x_syn, 'no_kind')),
      ('needs_review: imported false', pg_temp.zz_needs_review(x_imp) = false),
      ('needs_review: synced true', pg_temp.zz_needs_review(x_syn) = true),
      ('queue: imported suggested match left out', not pg_temp.zz_in_queue(x_matched)),
      ('needs_review: imported suggested match false', pg_temp.zz_needs_review(x_matched) = false),
      ('queue: new_recurring takes the newest synced charge', pg_temp.zz_queued(x_old, 'new_recurring') and not pg_temp.zz_in_queue(x_new)),
      ('needs_review: new_recurring follows the queue', pg_temp.zz_needs_review(x_old) = true and pg_temp.zz_needs_review(x_new) = false),
      ('flags: imported fee left out', pg_temp.zz_flag(items, fee_imp) is null),
      ('flags: synced fee red, an imported refund does not count', pg_temp.zz_flag(items, fee_syn) = 'red'),
      ('flags: synced fee with a synced refund is info', pg_temp.zz_flag(items, fee_ref) = 'info'),
      ('suggest: imported at merchant none', pg_temp.zz_matches(i1) = 0),
      ('suggest: synced at merchant one', pg_temp.zz_matches(i2) = 1),
      ('suggest: imported with no merchant none', pg_temp.zz_matches(i3) = 0),
      ('suggest: synced with no merchant one', pg_temp.zz_matches(i4) = 1),
      ('process: imported row is processed, nothing suggested',
       (p1 ->> 'processed')::int = 1 and (p1 ->> 'matches_suggested')::int = 0 and pg_temp.zz_matches(i5) = 0),
      ('process: imported row gets its merchant and kind',
       (select merchant_id is not null and kind is not null from public.wb_transactions where id = x5)),
      ('process: synced row suggested', (p2 ->> 'matches_suggested')::int = 1 and pg_temp.zz_matches(i6) = 1),
      ('backdate: skips the earlier imported payment',
       public.wb_planned_start_from_history(m_start, -43.43) = (now() at time zone 'America/Los_Angeles')::date - 2),
      ('backdate: imported only gives null', public.wb_planned_start_from_history(m_start_imp, -43.43) is null),
      ('merchant_no_category: imported only left out', not pg_temp.zz_finding('merchant_no_category', m_cat_imp)),
      ('merchant_no_category: synced found, counting synced only',
       (select n = 1 from public.wb_rule_health_all where finding = 'merchant_no_category' and merchant_id = m_cat_syn)),
      ('too_broad: imported payees left out', not pg_temp.zz_finding('too_broad', m_broad_imp)),
      ('too_broad: synced payees found', pg_temp.zz_finding('too_broad', m_broad_syn)),
      ('often_overridden: imported left out', not pg_temp.zz_finding('often_overridden', m_over_imp)),
      ('often_overridden: synced found, imported hits not diluting',
       (select n = 2 and of_n = 2 from public.wb_rule_health_all where finding = 'often_overridden' and rule_id = r_over_syn)),
      ('interval: imported charges still count',
       (select detail like '%expected about every 14 days.' from public.wb_rule_health_all where finding = 'never_fires' and rule_id = r_int)),
      ('anon has nothing on the views',
       not has_table_privilege('anon', 'public.wb_review_queue', 'select')
       and not has_table_privilege('anon', 'public.wb_transaction_list', 'select')
       and not has_table_privilege('anon', 'public.wb_rule_health_all', 'select')
       and not has_table_privilege('anon', 'public.wb_rule_health', 'select')),
      ('anon has nothing on the functions',
       not has_function_privilege('anon', 'public.wb_suggest_planned_matches(uuid[], uuid[])', 'execute')
       and not has_function_privilege('anon', 'public.wb_planned_start_from_history(uuid, numeric, numeric, date)', 'execute')
       and not has_function_privilege('anon', 'public.wb_action_items(int, numeric, int, date)', 'execute'))
    ) as t(name, ok)
  loop
    raise notice '% %', case when c.ok is true then 'PASS' else 'FAIL' end, c.name;
    if c.ok is not true then failed := failed || c.name; end if;
  end loop;

  if cardinality(failed) > 0 then
    raise exception 'WB TEST FAILED (rolled back), % case(s): %', cardinality(failed), array_to_string(failed, '; ');
  end if;
  raise notice 'SUMMARY all cases passed';
end;
$$;

rollback;

select 'ALL PASSED, rolled back' as summary,
       (select count(*) from public.wb_merchants where name like 'ZZ P4 %')
       + (select count(*) from public.wb_rules where name like 'ZZ P4 %')
       + (select count(*) from public.wb_accounts where name like 'ZZ P4 %')
       + (select count(*) from public.wb_planned_items where name like 'ZZ P4 %')
       + (select count(*) from public.wb_subscriptions where name like 'ZZ P4 %')
       + (select count(*) from public.wb_transactions where external_id like 'ZZ-P4-%') as rows_left_behind;
