-- Purpose: Warren Buffet Phase 4 Step 3 tests, run after the interval rule migration (spec P4-D1): never_fires' interval is the most common rounded gap between a merchant's linked charges, ties to the longer, with too few charges falling back.
-- Kind: test (writes invented fixtures in one transaction that ends in ROLLBACK: nothing persists)
-- Applied: NO
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name below is invented ("ZZ P4" fixtures). No real financial data. The view reads today,
-- so every date here is counted back from today. Every check reads fixture rows only. Run the whole file.
--
-- HOW TO READ THE RESULT: each case raises a NOTICE, PASS or FAIL. Any failure stops the script with an
-- error listing the failed cases, and everything rolls back. If all pass, the result grid shows one row:
-- summary "ALL PASSED, rolled back" and rows_left_behind 0. The grid works where notices are not shown.
-- supabase/tests/warren_buffet_p4/1_interval_rule_tests.sql

begin;

create function pg_temp.zz_merchant(p_name text)
returns uuid
language sql
as $$
  insert into public.wb_merchants (user_id, context_id, name)
  select c.user_id, c.id, p_name || ' ' || gen_random_uuid() from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- A named cadence would refuse a weekly interval, so these are cadence other.
create function pg_temp.zz_sub(p_merchant uuid, p_count int, p_unit text)
returns uuid
language sql
as $$
  insert into public.wb_subscriptions (user_id, context_id, name, cadence, interval_count, interval_unit, expected_amount, status, merchant_id)
  select c.user_id, c.id, 'ZZ P4 sub ' || gen_random_uuid(), 'other', p_count, p_unit, 10, 'active', p_merchant
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- A rule last matched p_quiet days ago.
create function pg_temp.zz_rule(p_merchant uuid, p_quiet int)
returns uuid
language sql
as $$
  insert into public.wb_rules (user_id, context_id, name, match, add_tag_ids, created_by, created_at, hit_count, last_hit_at)
  select c.user_id, c.id, 'ZZ P4 rule ' || gen_random_uuid(), jsonb_build_object('merchant_id', p_merchant), '{}', 'claude',
         now() - interval '900 days', 1, now() - make_interval(days => p_quiet)
  from public.contexts c where c.id = 'muvitejhrgt3rgi8t6q'
  returning id;
$$;

-- Settled charges linked to the subscription, p_days ago.
create function pg_temp.zz_charges(p_acct uuid, p_merchant uuid, p_sub uuid, p_days int[], p_kind text default 'spend')
returns void
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee,
                                      raw, merchant_id, kind, subscription_id, subscription_source)
  select a.user_id, a.context_id, p_acct, 'ZZ-P4-' || gen_random_uuid(), now() - make_interval(days => d), -10,
         'ZZ CHARGE', 'ZZ CHARGE', '{}', p_merchant, p_kind, p_sub, 'manual'
  from public.wb_accounts a cross join unnest(p_days) d
  where a.id = p_acct;
$$;

create function pg_temp.zz_detail(p_rule uuid)
returns text
language sql
as $$ select detail from public.wb_rule_health_all where finding = 'never_fires' and rule_id = p_rule limit 1; $$;

-- One merchant, its subscription, its charges and its rule; returns the rule.
create function pg_temp.zz_case(p_acct uuid, p_sub_count int, p_sub_unit text, p_days int[], p_quiet int)
returns uuid
language plpgsql
as $$
declare
  m uuid := pg_temp.zz_merchant('ZZ P4 merchant');
begin
  perform pg_temp.zz_charges(p_acct, m, pg_temp.zz_sub(m, p_sub_count, p_sub_unit), p_days);
  return pg_temp.zz_rule(m, p_quiet);
end;
$$;

do $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  acct uuid;
  m uuid; s uuid;
  r_early_40 uuid; r_early_50 uuid; r_refund uuid;
  c record;
  failed text[] := '{}';
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ P4 card', 'credit_card') returning id into acct;

  -- One early charge and a stray weekly subscription: gaps 30, 31, 5, 25. min() read this as
  -- weekly and flagged it from 31 days quiet; monthly flags after 46.
  m := pg_temp.zz_merchant('ZZ P4 early quiet 40');
  s := pg_temp.zz_sub(m, 1, 'month');
  perform pg_temp.zz_sub(m, 1, 'week');
  perform pg_temp.zz_charges(acct, m, s, array[60, 90, 121, 126, 151]);
  r_early_40 := pg_temp.zz_rule(m, 40);

  m := pg_temp.zz_merchant('ZZ P4 early quiet 50');
  s := pg_temp.zz_sub(m, 1, 'month');
  perform pg_temp.zz_sub(m, 1, 'week');
  perform pg_temp.zz_charges(acct, m, s, array[60, 90, 121, 126, 151]);
  r_early_50 := pg_temp.zz_rule(m, 50);

  -- A linked refund is not a charge: two spend charges and a refund is still too few.
  m := pg_temp.zz_merchant('ZZ P4 refund');
  s := pg_temp.zz_sub(m, 1, 'week');
  perform pg_temp.zz_charges(acct, m, s, array[60, 90]);
  perform pg_temp.zz_charges(acct, m, s, array[120], 'refund');
  r_refund := pg_temp.zz_rule(m, 50);

  for c in
    select * from (values
      ('one early charge, not flagged at 40 days quiet', pg_temp.zz_detail(r_early_40) is null),
      ('one early charge, still monthly at 50 days quiet', pg_temp.zz_detail(r_early_50) like '%expected about every 30 days.'),
      -- Gaps 8, 8, 8, 30, 31, 30, 31. Unrounded, 8 would be the most common.
      ('30 and 31 days are the same month',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'week', array[60, 68, 76, 84, 114, 145, 175, 206], 50)) like '%expected about every 30 days.'),
      -- Gaps 14, 11, 17, under a monthly subscription.
      ('a two-week merchant',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'month', array[60, 74, 85, 102], 50)) like '%expected about every 14 days.'),
      -- Gaps 7, 10, 7, under a monthly subscription.
      ('gaps up to 10 days are a week',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'month', array[60, 67, 77, 84], 50)) like '%expected about every 7 days.'),
      -- Gaps 18, 30, 18, under a weekly subscription: 18 is past the two-week bucket.
      ('18 days is a month',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'week', array[60, 78, 108, 126], 50)) like '%expected about every 30 days.'),
      -- Gaps 7, 7, 30, 31.
      ('tie between a week and a month takes the month',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'week', array[60, 67, 74, 104, 135], 50)) like '%expected about every 30 days.'),
      -- Gaps 30, 30, 61, 61.
      ('tie between one month and two takes two',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'month', array[100, 130, 160, 221, 282], 100)) like '%expected about every 61 days.'),
      -- One gap of 30, so the subscription's weekly interval stands.
      ('fewer than 3 charges falls back',
       pg_temp.zz_detail(pg_temp.zz_case(acct, 1, 'week', array[60, 90], 50)) like '%expected about every 7 days.'),
      ('a linked refund is not a charge', pg_temp.zz_detail(r_refund) like '%expected about every 7 days.'),
      ('wb_rule_health columns unchanged',
       (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
        where table_schema = 'public' and table_name = 'wb_rule_health')
       = array['finding', 'rule_id', 'rule_name', 'merchant_id', 'merchant_name', 'n', 'of_n', 'detail'])
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
       + (select count(*) from public.wb_accounts where name = 'ZZ P4 card') as rows_left_behind;
