-- Purpose: Warren Buffet Phase 4 Step 8b tests, run after migrations 193 and 194 (spec P4-D7): the three order tables, refunds on items, the match rule, access and registration.
-- Kind: test (writes invented fixtures in one transaction that ends in ROLLBACK: nothing persists)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ P4" fixtures). No real order data. Run the whole file.
--
-- HOW TO READ THE RESULT: each case raises a NOTICE, PASS or FAIL. Any failure stops the script with an
-- error listing the failed cases, and everything rolls back. If all pass, the result grid shows one row:
-- summary "ALL PASSED, rolled back" and rows_left_behind 0.
-- supabase/tests/warren_buffet_p4/3_orders_tests.sql

begin;

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

create function pg_temp.zz_txn(p_acct uuid, p_amount numeric, p_posted timestamptz)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw, source)
  select a.user_id, a.context_id, p_acct, 'ZZ-P4-' || gen_random_uuid(), p_posted, p_amount, 'ZZ P4 charge', '{}', 'sync'
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create function pg_temp.zz_order(p_site text, p_number text, p_ship date, p_amount numeric)
returns uuid
language sql
as $$
  insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
  select c.user_id, c.id, p_site, p_number, p_ship, p_ship, p_amount
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- Noon Pacific, so the Pacific date is plain to read.
create function pg_temp.zz_at(p_date date)
returns timestamptz
language sql
as $$ select (p_date + time '12:00') at time zone 'America/Los_Angeles'; $$;

-- A match insert, as text for zz_state.
create function pg_temp.zz_match(p_order uuid, p_txn uuid, p_days int)
returns text
language sql
as $$
  select format(
    'insert into public.wb_order_matches (user_id, context_id, order_id, transaction_id, days_apart)
     select user_id, context_id, %L::uuid, %L::uuid, %s from public.wb_orders where id = %L',
    p_order, p_txn, p_days, p_order);
$$;

-- An item insert with the given refund, as text for zz_state.
create function pg_temp.zz_item(p_order uuid, p_line int, p_site text, p_line_amount numeric, p_refund numeric, p_refund_date date)
returns text
language sql
as $$
  select format(
    'insert into public.wb_order_items (user_id, context_id, order_id, line_no, site, product_name, quantity, unit_amount, line_amount, refunded_amount, refund_date, order_date, ship_date)
     select user_id, context_id, %L::uuid, %s, %L, ''ZZ P4 thing'', 1, 1, %s, %s, %s::date, order_date, ship_date from public.wb_orders where id = %L',
    p_order, p_line, p_site, p_line_amount,
    coalesce(p_refund::text, 'null'), coalesce(quote_literal(p_refund_date), 'null'), p_order);
$$;

do $$
declare
  v_user     uuid;
  v_acct     uuid;
  v_amazon   uuid;  -- 1.23, shipped 2025-01-02
  v_zero     uuid;  -- amazon, total zero
  v_wf       uuid;  -- whole foods, 4.56
  v_late     uuid;  -- amazon, 7.89, shipped 2025-02-01
  v_claimed  uuid;  -- amazon, 2.50, shipped 2025-03-01
  v_twin     uuid;  -- amazon, the same amount and day as v_claimed
  v_txn      uuid;
  v_txn_zero uuid;
  v_txn_wf   uuid;
  v_txn_3d   uuid;
  v_txn_4d   uuid;
  v_txn_off  uuid;
  v_claim_a  uuid;
  v_claim_b  uuid;
  v_item_id  uuid;
  c          record;
  failed     text[] := '{}';
begin
  select c2.user_id into v_user from public.contexts c2 where c2.id = 'muvitejhrgt3rgi8t6q';

  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, 'muvitejhrgt3rgi8t6q', 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ P4 card', 'credit_card')
  returning id into v_acct;

  v_amazon  := pg_temp.zz_order('amazon', 'ZZ-P4-1', date '2025-01-02', 1.23);
  v_zero    := pg_temp.zz_order('amazon', 'ZZ-P4-2', date '2025-01-02', 0);
  v_wf      := pg_temp.zz_order('wholefoods', 'ZZ-P4-3', date '2025-01-02', 4.56);
  v_late    := pg_temp.zz_order('amazon', 'ZZ-P4-4', date '2025-02-01', 7.89);
  v_claimed := pg_temp.zz_order('amazon', 'ZZ-P4-5', date '2025-03-01', 2.50);
  v_twin    := pg_temp.zz_order('amazon', 'ZZ-P4-6', date '2025-03-01', 2.50);

  v_txn      := pg_temp.zz_txn(v_acct, -1.23, pg_temp.zz_at(date '2025-01-03'));
  v_txn_zero := pg_temp.zz_txn(v_acct, -1.00, pg_temp.zz_at(date '2025-01-03'));
  v_txn_wf   := pg_temp.zz_txn(v_acct, -4.56, pg_temp.zz_at(date '2025-01-03'));
  v_txn_3d   := pg_temp.zz_txn(v_acct, -7.89, pg_temp.zz_at(date '2025-02-04'));
  v_txn_4d   := pg_temp.zz_txn(v_acct, -7.89, pg_temp.zz_at(date '2025-02-05'));
  v_txn_off  := pg_temp.zz_txn(v_acct, -7.88, pg_temp.zz_at(date '2025-02-02'));
  v_claim_a  := pg_temp.zz_txn(v_acct, -2.50, pg_temp.zz_at(date '2025-03-01'));
  v_claim_b  := pg_temp.zz_txn(v_acct, -2.50, pg_temp.zz_at(date '2025-03-02'));

  insert into public.wb_order_items (user_id, context_id, order_id, line_no, site, product_name, quantity, unit_amount, line_amount, order_date, ship_date)
  values (v_user, 'muvitejhrgt3rgi8t6q', v_amazon, 1, 'amazon', 'ZZ P4 thing', 1, 1.00, 1.23, '2025-01-02', '2025-01-02')
  returning id into v_item_id;

  insert into public.wb_order_matches (user_id, context_id, order_id, transaction_id, days_apart)
  values (v_user, 'muvitejhrgt3rgi8t6q', v_amazon, v_txn, 1);
  insert into public.wb_order_matches (user_id, context_id, order_id, transaction_id, days_apart)
  values (v_user, 'muvitejhrgt3rgi8t6q', v_claimed, v_claim_a, 0);

  for c in
    select * from (values
      -- wb_orders
      ('orders: the same order on another ship date is allowed',
        pg_temp.zz_state($q$insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
          select user_id, context_id, 'amazon', 'ZZ-P4-1', order_date, date '2025-01-09', 1 from public.wb_orders where order_number = 'ZZ-P4-1'$q$) = 'ran'),
      ('orders: a repeated shipment is refused',
        pg_temp.zz_state($q$insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
          select user_id, context_id, 'amazon', 'ZZ-P4-1', order_date, date '2025-01-02', 1 from public.wb_orders where order_number = 'ZZ-P4-1'$q$) = '23505'),
      ('orders: an unknown site is refused',
        pg_temp.zz_state($q$insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
          select user_id, context_id, 'zz', 'ZZ-P4-9', order_date, ship_date, 1 from public.wb_orders where order_number = 'ZZ-P4-1'$q$) = '23514'),
      ('orders: a negative amount is refused',
        pg_temp.zz_state($q$insert into public.wb_orders (user_id, context_id, site, order_number, order_date, ship_date, amount)
          select user_id, context_id, 'amazon', 'ZZ-P4-9', order_date, ship_date, -1 from public.wb_orders where order_number = 'ZZ-P4-1'$q$) = '23514'),
      -- wb_order_items
      ('items: a whole foods line with no asin or tag is allowed', pg_temp.zz_state(pg_temp.zz_item(v_wf, 1, 'wholefoods', 4.56, null, null)) = 'ran'),
      ('items: a repeated line is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 1, 'amazon', 1, null, null)) = '23505'),
      ('items: an unknown site is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'zz', 1, null, null)) = '23514'),
      ('items: a negative line amount is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'amazon', -1, null, null)) = '23514'),
      -- refunds on items
      ('refunds: an amount and a date are allowed', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'amazon', 1, 1, date '2025-02-01')) = 'ran'),
      ('refunds: an amount with no date is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'amazon', 1, 1, null)) = '23514'),
      ('refunds: a date with no amount is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'amazon', 1, null, date '2025-02-01')) = '23514'),
      ('refunds: a zero amount is refused', pg_temp.zz_state(pg_temp.zz_item(v_amazon, 2, 'amazon', 1, 0, date '2025-02-01')) = '23514'),
      ('refunds: a new line starts with none', (select refunded_amount is null and refund_date is null from public.wb_order_items where id = v_item_id)),
      -- the match rule
      ('matches: exact, three days apart, is allowed', pg_temp.zz_state(pg_temp.zz_match(v_late, v_txn_3d, 3)) = 'ran'),
      ('matches: four days apart is refused', pg_temp.zz_state(pg_temp.zz_match(v_late, v_txn_4d, 4)) = '23514'),
      ('matches: a days_apart that is not the real gap is refused', pg_temp.zz_state(pg_temp.zz_match(v_late, v_txn_4d, 1)) = '23514'),
      ('matches: an amount one cent off is refused', pg_temp.zz_state(pg_temp.zz_match(v_late, v_txn_off, 1)) = '23514'),
      ('matches: a zero-total shipment is never matched', pg_temp.zz_state(pg_temp.zz_match(v_zero, v_txn_zero, 1)) = '23514'),
      ('matches: a whole foods shipment is never matched', pg_temp.zz_state(pg_temp.zz_match(v_wf, v_txn_wf, 1)) = '23514'),
      -- Which of two claiming charges to leave out is the writer's rule: amazon_import.test.mjs proves it writes neither.
      ('matches: a shipment refuses a second charge', pg_temp.zz_state(pg_temp.zz_match(v_claimed, v_claim_b, 1)) = '23505'),
      ('matches: a charge refuses a second shipment', pg_temp.zz_state(pg_temp.zz_match(v_twin, v_claim_a, 0)) = '23505'),
      -- platform
      ('platform: the three tables are registered',
        (select count(*) = 3 from platform.registry r where r.table_name in ('public.wb_orders', 'public.wb_order_items', 'public.wb_order_matches'))),
      ('platform: row level security is on',
        (select count(*) = 3 from pg_class k where k.oid in ('public.wb_orders'::regclass, 'public.wb_order_items'::regclass, 'public.wb_order_matches'::regclass) and k.relrowsecurity)),
      ('platform: authenticated and service_role can read and write',
        has_table_privilege('authenticated', 'public.wb_order_items', 'select,insert,update,delete')
        and has_table_privilege('authenticated', 'public.wb_orders', 'select,insert,update,delete')
        and has_table_privilege('authenticated', 'public.wb_order_matches', 'select,insert,update,delete')
        and has_table_privilege('service_role', 'public.wb_order_items', 'select,insert,update,delete')
        and has_table_privilege('service_role', 'public.wb_orders', 'select,insert,update,delete')
        and has_table_privilege('service_role', 'public.wb_order_matches', 'select,insert,update,delete')),
      ('platform: anon has nothing',
        not has_table_privilege('anon', 'public.wb_orders', 'select,insert,update,delete')
        and not has_table_privilege('anon', 'public.wb_order_items', 'select,insert,update,delete')
        and not has_table_privilege('anon', 'public.wb_order_matches', 'select,insert,update,delete')
        and not has_function_privilege('anon', 'public.wb_order_matches_check()', 'execute')),
      ('platform: no conformance failure on these tables',
        (select count(*) = 0 from platform.conformance_failures f where f.table_name like '%wb_order%'))
    ) as t(name, ok)
  loop
    raise notice '% %', case when c.ok is true then 'PASS' else 'FAIL' end, c.name;
    if c.ok is not true then failed := failed || c.name; end if;
  end loop;

  -- Cascades, last because they remove fixtures.
  delete from public.wb_transactions where id = v_txn;
  if exists (select 1 from public.wb_order_matches where transaction_id = v_txn) then
    failed := failed || 'cascade: deleting a charge removes its match'::text;
  end if;
  delete from public.wb_orders where id = v_amazon;
  if exists (select 1 from public.wb_order_items where order_id = v_amazon) then
    failed := failed || 'cascade: deleting a shipment removes its items'::text;
  end if;
  raise notice 'checked cascades';

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
       + (select count(*) from public.wb_transactions where external_id like 'ZZ-P4-%') as rows_left_behind;
