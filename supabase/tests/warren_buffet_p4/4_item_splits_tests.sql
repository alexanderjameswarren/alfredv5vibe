-- Purpose: Warren Buffet Phase 4 Step 8g tests, run after the item splits migration (spec P4-D10): item tags, splitting matched charges, reruns, every skip, processing leaving order splits alone, and rule hit counts.
-- Kind: test (writes invented fixtures in one transaction that ends in ROLLBACK: nothing persists)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ P4" fixtures), except one real project id, borrowed inside the
-- rolled-back transaction for the project skip. Fixtures are history_import rows so no planned match is suggested. Run the whole file.
--
-- HOW TO READ THE RESULT: each case raises a NOTICE, PASS or FAIL. Any failure stops the script with an
-- error listing the failed cases, and everything rolls back. If all pass, the result grid shows one row:
-- summary "ALL PASSED, rolled back" and rows_left_behind 0.
-- supabase/tests/warren_buffet_p4/4_item_splits_tests.sql

begin;

-- Raises the case's notice; returns its name when it failed.
create function pg_temp.zz_check(p_name text, p_ok boolean)
returns text[]
language plpgsql
as $$
begin
  raise notice '% %', case when p_ok is true then 'PASS' else 'FAIL' end, p_name;
  return case when p_ok is true then '{}'::text[] else array[p_name] end;
end;
$$;

create function pg_temp.zz_acct()
returns uuid
language sql
as $$
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  select c.user_id, c.id, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ P4 card', 'credit_card'
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

create function pg_temp.zz_tag(p_group text, p_name text)
returns uuid
language sql
as $$
  insert into public.wb_tags (user_id, context_id, group_id, name)
  select g.user_id, g.context_id, g.id, p_name from public.wb_tag_groups g where g.name = p_group
  returning id;
$$;

-- A shipment, its charge and their match. Returns the charge.
create function pg_temp.zz_charge(p_acct uuid, p_amount numeric)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
  v_txn   uuid;
begin
  insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
  select c.user_id, c.id, 'amazon', 'ZZ-P4-' || gen_random_uuid(), date '2025-01-02', date '2025-01-02', p_amount
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id into v_order;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw, source)
  select a.user_id, a.context_id, p_acct, 'ZZ-P4-' || gen_random_uuid(), (date '2025-01-02' + time '12:00') at time zone 'America/Los_Angeles',
         -p_amount, 'ZZ P4 CHARGE', '{}', 'history_import'
  from public.wb_accounts a where a.id = p_acct
  returning id into v_txn;
  insert into public.wb_order_matches (user_id, context_id, order_id, transaction_id, days_apart)
  select o.user_id, o.context_id, o.id, v_txn, 0 from public.wb_orders o where o.id = v_order;
  return v_txn;
end;
$$;

-- An item on a charge's shipment.
create function pg_temp.zz_line(p_txn uuid, p_line int, p_amount numeric, p_tag uuid default null, p_asin text default null)
returns uuid
language sql
as $$
  insert into public.wb_order_items (user_id, context_id, order_id, line_no, site, asin, product_name, quantity, unit_amount, line_amount, order_date, ship_date, tag_id, tag_source)
  select o.user_id, o.context_id, o.id, p_line, 'amazon', p_asin, 'ZZ P4 thing', 1, p_amount, p_amount, o.order_date, o.ship_date, p_tag,
         case when p_tag is null then null else 'claude' end
  from public.wb_order_matches m join public.wb_orders o on o.id = m.order_id
  where m.transaction_id = p_txn
  returning id;
$$;

-- A charge's splits in order, as "amount:tags" text, for Category tags or for the other groups.
create function pg_temp.zz_shape(p_txn uuid, p_category boolean default true)
returns text
language sql
as $$
  select string_agg(s.amount::text || ':' || coalesce((
           select string_agg(t.name, '+' order by t.name)
           from public.wb_split_tags st join public.wb_tags t on t.id = st.tag_id join public.wb_tag_groups g on g.id = t.group_id
           where st.split_id = s.id and (g.name = 'Category') = p_category), ''), ' ' order by s.position)
  from public.wb_splits s where s.transaction_id = p_txn;
$$;

create function pg_temp.zz_sum(p_txn uuid)
returns numeric
language sql
as $$ select sum(amount) from public.wb_splits where transaction_id = p_txn; $$;

create function pg_temp.zz_marked(p_txn uuid)
returns bigint
language sql
as $$ select count(*) from public.wb_splits where transaction_id = p_txn and from_order; $$;

create function pg_temp.zz_rules()
returns jsonb
language sql
as $$ select jsonb_agg(jsonb_build_array(id, hit_count, last_hit_at) order by id) from public.wb_rules; $$;

-- 'ran', or the error code the statement raised. Either way the statement is undone.
create function pg_temp.zz_state(p_sql text)
returns text
language plpgsql
as $$
begin
  execute p_sql;
  raise exception 'zz_ran';
exception when others then
  return case when sqlerrm = 'zz_ran' then 'ran' else sqlstate end;
end;
$$;

do $$
declare
  v_acct uuid := pg_temp.zz_acct();
  v_a    uuid := pg_temp.zz_tag('Category', 'ZZ P4 A');
  v_b    uuid := pg_temp.zz_tag('Category', 'ZZ P4 B');
  v_c    uuid := pg_temp.zz_tag('Category', 'ZZ P4 C');
  v_lbl  uuid := pg_temp.zz_tag('Label', 'ZZ P4 label');
  v_rule uuid;
  t_round uuid; t_rem uuid; t_all uuid; t_hand uuid; t_before uuid; t_project uuid; t_cat uuid; t_rule uuid; t_plain uuid; t_changed uuid;
  i_rem  uuid;
  i_x    uuid;
  v_res  jsonb;
  v_state jsonb;
  v_rules jsonb;
  v_project uuid;
  failed text[] := '{}';
begin
  -- Proportional rounding: three equal lines over 10.00 cannot divide evenly.
  t_round := pg_temp.zz_charge(v_acct, 10.00);
  perform pg_temp.zz_line(t_round, 1, 1.00, v_a);
  perform pg_temp.zz_line(t_round, 2, 1.00, v_b);
  perform pg_temp.zz_line(t_round, 3, 1.00, v_c);
  v_res := public.wb_split_order_charges(array[t_round]);
  failed := failed || pg_temp.zz_check('rounding: reports one split', (v_res ->> 'split')::int = 1);
  failed := failed || pg_temp.zz_check('rounding: sums exactly to the charge', pg_temp.zz_sum(t_round) = -10.00);
  failed := failed || pg_temp.zz_check('rounding: three parts, one cent apart at most',
    (select count(*) = 3 and max(amount) - min(amount) = 0.01 from public.wb_splits where transaction_id = t_round));
  failed := failed || pg_temp.zz_check('rounding: every part is marked', pg_temp.zz_marked(t_round) = 3);

  -- Untagged remainder, then a tag change and rerun.
  t_rem := pg_temp.zz_charge(v_acct, 10.00);
  perform pg_temp.zz_line(t_rem, 1, 6.00, v_a, 'ZZASIN1');
  i_rem := pg_temp.zz_line(t_rem, 2, 4.00);
  perform public.wb_split_order_charges(array[t_rem]);
  failed := failed || pg_temp.zz_check('remainder: untagged lines sit on Amazon (unsorted)',
    pg_temp.zz_shape(t_rem) = '-6.00:ZZ P4 A -4.00:Amazon (unsorted)');

  v_res := public.wb_split_order_charges(array[t_rem]);
  failed := failed || pg_temp.zz_check('rerun: nothing changed is reported unchanged',
    (v_res ->> 'unchanged')::int = 1 and (v_res ->> 'split')::int = 0);

  v_res := public.wb_set_order_item_tags(v_b, array[i_rem]);
  failed := failed || pg_temp.zz_check('tags: by ids', (v_res ->> 'updated')::int = 1);
  v_res := public.wb_split_order_charges(array[t_rem]);
  failed := failed || pg_temp.zz_check('rerun: a tag change rebuilds the parts',
    (v_res ->> 'split')::int = 1 and pg_temp.zz_shape(t_rem) = '-6.00:ZZ P4 A -4.00:ZZ P4 B');

  update public.wb_order_items set asin = 'ZZASIN1' where id = i_rem;
  v_res := public.wb_set_order_item_tags(v_a, null, 'ZZASIN1');
  failed := failed || pg_temp.zz_check('tags: every row of an ASIN', (v_res ->> 'updated')::int = 2);
  perform public.wb_split_order_charges(array[t_rem]);
  failed := failed || pg_temp.zz_check('rerun: fewer categories leave fewer parts',
    pg_temp.zz_shape(t_rem) = '-10.00:ZZ P4 A' and pg_temp.zz_marked(t_rem) = 1);

  -- Item tag rules.
  t_all := pg_temp.zz_charge(v_acct, 3.00);
  i_x := pg_temp.zz_line(t_all, 1, 3.00);
  failed := failed || pg_temp.zz_check('tags: a tag outside Category is refused',
    pg_temp.zz_state(format('select public.wb_set_order_item_tags(%L, array[%L]::uuid[])', v_lbl, i_x)) = '23514');
  failed := failed || pg_temp.zz_check('tags: two ways at once are refused',
    pg_temp.zz_state(format('select public.wb_set_order_item_tags(%L, array[%L]::uuid[], ''ZZ'')', v_a, i_x)) = '22023');
  failed := failed || pg_temp.zz_check('tags: a source of rule is refused',
    pg_temp.zz_state(format('select public.wb_set_order_item_tags(%L, array[%L]::uuid[], null, null, ''rule'')', v_a, i_x)) = '22023');
  failed := failed || pg_temp.zz_check('tags: a source with no tag is refused by the table',
    pg_temp.zz_state(format('update public.wb_order_items set tag_source = ''claude'' where id = %L', i_x)) = '23514');
  perform public.wb_set_order_item_tags(v_b, array[i_x], null, null, 'manual');
  i_rem := pg_temp.zz_line(t_all, 2, 0.00);
  v_res := public.wb_set_order_item_tags(v_a, null, null, 'amazon');
  failed := failed || pg_temp.zz_check('tags: the site option fills untagged items',
    (select tag_id = v_a and tag_source = 'claude' from public.wb_order_items where id = i_rem));
  failed := failed || pg_temp.zz_check('tags: the site option leaves tagged items alone',
    (select tag_id = v_b and tag_source = 'manual' from public.wb_order_items where id = i_x));

  -- A hand edit of an order split: left alone, and no longer counted as ours.
  t_hand := pg_temp.zz_charge(v_acct, 8.00);
  perform pg_temp.zz_line(t_hand, 1, 4.00, v_a);
  perform pg_temp.zz_line(t_hand, 2, 4.00, v_b);
  perform public.wb_split_order_charges(array[t_hand]);
  perform public.wb_replace_splits(t_hand, jsonb_build_array(
    jsonb_build_object('amount', -5.00, 'tag_ids', jsonb_build_array(v_a)),
    jsonb_build_object('amount', -3.00, 'tag_ids', jsonb_build_array(v_b))), 'manual');
  v_res := public.wb_split_order_charges(array[t_hand]);
  failed := failed || pg_temp.zz_check('hand edit: reported', v_res -> 'skipped_hand_split' ? t_hand::text);
  failed := failed || pg_temp.zz_check('hand edit: amounts stay', pg_temp.zz_shape(t_hand) = '-5.00:ZZ P4 A -3.00:ZZ P4 B');
  failed := failed || pg_temp.zz_check('hand edit: no longer marked', pg_temp.zz_marked(t_hand) = 0);
  v_res := public.wb_split_order_charges(array[t_hand]);
  failed := failed || pg_temp.zz_check('hand edit: stays skipped on the next run',
    v_res -> 'skipped_hand_split' ? t_hand::text and pg_temp.zz_shape(t_hand) = '-5.00:ZZ P4 A -3.00:ZZ P4 B');

  -- Split by hand before any order split.
  t_before := pg_temp.zz_charge(v_acct, 8.00);
  perform pg_temp.zz_line(t_before, 1, 8.00, v_a);
  perform public.wb_replace_splits(t_before, jsonb_build_array(
    jsonb_build_object('amount', -6.00, 'tag_ids', jsonb_build_array(v_b)),
    jsonb_build_object('amount', -2.00, 'tag_ids', jsonb_build_array(v_c))), 'claude');
  v_res := public.wb_split_order_charges(array[t_before]);
  failed := failed || pg_temp.zz_check('split by hand first: left alone and reported',
    v_res -> 'skipped_hand_split' ? t_before::text and pg_temp.zz_shape(t_before) = '-6.00:ZZ P4 B -2.00:ZZ P4 C');

  -- A project causes a skip. A planned match is read by the same condition.
  select id into v_project from public.wb_projects limit 1;
  t_project := pg_temp.zz_charge(v_acct, 7.00);
  perform pg_temp.zz_line(t_project, 1, 3.00, v_a);
  perform pg_temp.zz_line(t_project, 2, 4.00, v_b);
  update public.wb_splits set project_id = v_project where transaction_id = t_project;
  v_res := public.wb_split_order_charges(array[t_project]);
  failed := failed || pg_temp.zz_check('project: a real project exists to test with', v_project is not null);
  failed := failed || pg_temp.zz_check('project: charge skipped and reported', v_res -> 'skipped_project_or_planned_match' ? t_project::text);
  failed := failed || pg_temp.zz_check('project: still one part, project kept',
    (select count(*) = 1 and bool_and(project_id = v_project) from public.wb_splits where transaction_id = t_project));

  -- A hand category causes a skip.
  t_cat := pg_temp.zz_charge(v_acct, 6.00);
  perform pg_temp.zz_line(t_cat, 1, 6.00, v_b);
  perform public.wb_apply_tags(array[t_cat], array[v_a], 'manual');
  v_res := public.wb_split_order_charges(array[t_cat]);
  failed := failed || pg_temp.zz_check('hand category: skipped and reported', v_res -> 'skipped_hand_tagged' ? t_cat::text);
  failed := failed || pg_temp.zz_check('hand category: the tag stays', pg_temp.zz_shape(t_cat) = '-6.00:ZZ P4 A');

  -- An amount changed at the bank.
  t_changed := pg_temp.zz_charge(v_acct, 6.00);
  perform pg_temp.zz_line(t_changed, 1, 6.00, v_a);
  update public.wb_transactions set amount = -6.50 where id = t_changed;
  v_res := public.wb_split_order_charges(array[t_changed]);
  failed := failed || pg_temp.zz_check('amount changed: skipped and reported', v_res -> 'skipped_amount_changed' ? t_changed::text);

  -- Processing and rules. A fixture rule adds a Label and sets nothing else.
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by)
  select c2.user_id, c2.id, 'ZZ P4 rule', jsonb_build_object('description_contains', 'ZZ P4 CHARGE'), array[v_lbl], 'claude'
  from public.contexts c2 where c2.id = 'muvitejhrgt3rgi8t6q'
  returning id into v_rule;

  t_rule := pg_temp.zz_charge(v_acct, 9.00);
  perform pg_temp.zz_line(t_rule, 1, 5.00, v_a);
  perform pg_temp.zz_line(t_rule, 2, 4.00, v_b);
  t_plain := pg_temp.zz_charge(v_acct, 9.50);
  perform public.wb_process_transactions(array[t_rule, t_plain]);
  failed := failed || pg_temp.zz_check('process: an unsplit charge still gets its rule tag',
    pg_temp.zz_shape(t_plain, false) = '-9.50:ZZ P4 label');

  v_res := public.wb_split_order_charges(array[t_rule]);
  failed := failed || pg_temp.zz_check('labels: on every part',
    (v_res ->> 'split')::int = 1 and pg_temp.zz_shape(t_rule, false) = '-5.00:ZZ P4 label -4.00:ZZ P4 label');

  v_state := public.wb_order_split_state(t_rule);
  v_rules := pg_temp.zz_rules();
  perform public.wb_process_transactions(array[t_rule, t_plain]);
  failed := failed || pg_temp.zz_check('process: order splits unchanged', public.wb_order_split_state(t_rule) = v_state);
  failed := failed || pg_temp.zz_check('process: still marked', pg_temp.zz_marked(t_rule) = 2);
  failed := failed || pg_temp.zz_check('process: categories unchanged', pg_temp.zz_shape(t_rule) = '-5.00:ZZ P4 A -4.00:ZZ P4 B');
  failed := failed || pg_temp.zz_check('process: the rule still counts as matched',
    (select v_rule = any (matched_rule_ids) from public.wb_transactions where id = t_rule));
  failed := failed || pg_temp.zz_check('hit counts: unchanged by processing again', pg_temp.zz_rules() = v_rules);
  failed := failed || pg_temp.zz_check('hit counts: the rule counts both charges', (select hit_count = 2 from public.wb_rules where id = v_rule));

  -- Processing a one-part order split does not add tags or undo it.
  update public.wb_order_items set tag_id = v_a, tag_source = 'claude'
  where order_id = (select order_id from public.wb_order_matches where transaction_id = t_rule);
  perform public.wb_split_order_charges(array[t_rule]);
  v_state := public.wb_order_split_state(t_rule);
  perform public.wb_process_transactions(array[t_rule]);
  failed := failed || pg_temp.zz_check('process: a one-part order split is left alone',
    public.wb_order_split_state(t_rule) = v_state and pg_temp.zz_shape(t_rule) = '-9.00:ZZ P4 A' and pg_temp.zz_marked(t_rule) = 1);
  v_res := public.wb_split_order_charges(array[t_rule]);
  failed := failed || pg_temp.zz_check('process: the next split run sees no hand edit',
    (v_res ->> 'unchanged')::int = 1 and jsonb_array_length(v_res -> 'skipped_hand_split') = 0);

  -- Access.
  failed := failed || pg_temp.zz_check('platform: anon cannot run the new functions',
    not has_function_privilege('anon', 'public.wb_set_order_item_tags(uuid, uuid[], text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.wb_split_order_charges(uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.wb_order_split_state(uuid)', 'execute'));
  failed := failed || pg_temp.zz_check('platform: authenticated and service_role can',
    has_function_privilege('authenticated', 'public.wb_split_order_charges(uuid[])', 'execute')
    and has_function_privilege('service_role', 'public.wb_set_order_item_tags(uuid, uuid[], text, text, text)', 'execute'));
  failed := failed || pg_temp.zz_check('platform: no conformance failure',
    (select count(*) = 0 from platform.conformance_failures f where f.table_name like '%wb_%'));

  -- The deferred check that splits sum to their charge, run now rather than at a commit that never comes.
  set constraints all immediate;
  raise notice 'checked every split sums to its charge';

  if cardinality(failed) > 0 then
    raise exception 'WB TEST FAILED (rolled back), % case(s): %', cardinality(failed), array_to_string(failed, '; ');
  end if;
  raise notice 'SUMMARY all cases passed';
end;
$$;

rollback;

select 'ALL PASSED, rolled back' as summary,
       (select count(*) from public.wb_orders where order_number like 'ZZ-P4-%')
       + (select count(*) from public.wb_order_items where product_name like 'ZZ P4 %')
       + (select count(*) from public.wb_accounts where name like 'ZZ P4 %')
       + (select count(*) from public.wb_tags where name like 'ZZ P4 %')
       + (select count(*) from public.wb_rules where name like 'ZZ P4 %')
       + (select count(*) from public.wb_transactions where external_id like 'ZZ-P4-%') as rows_left_behind;
