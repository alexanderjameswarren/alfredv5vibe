-- Purpose: Warren Buffet Phase 2 Step 2 tests and verification, run after 103_wb_phase2_tables.sql. Pure-function cases (cleaning, kinds, transfer matching, pair decision, rule matching) on invented values, plus structural checks on the live database.
-- Kind: read-only diagnostic (never "applied"; writes nothing)
-- Applied: YES — run 2026-10-09 by Alex after 103: 69 tests, 0 failed; every check true. Read-only, safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md sections 4 and 5.
-- Every description, amount and id below is invented. No real financial data.
-- Expect: tests.failed = 0 and every check in "checks" true.
-- supabase/migrations/104_wb_phase2_tests.sql

with
clean_cases(name, raw, strip, expected) as (values
  ('named entity',            'CAFE &amp; BAKERY',                         false, 'CAFE & BAKERY'),
  ('numeric entity',          'TEA&#39;S SHOP',                            false, 'TEA''S SHOP'),
  ('hex entity',              'TEA&#x27;S SHOP',                           false, 'TEA''S SHOP'),
  ('amp decodes once',        'A &amp;lt; B',                              false, 'A &lt; B'),
  ('whitespace',              '  GROCER   MART   ',                        false, 'GROCER MART'),
  ('store number',            'PET WORLD #1234',                           false, 'PET WORLD'),
  ('digit run',               'FUEL STOP 00451234',                        false, 'FUEL STOP'),
  ('short number kept',       'ROUTE 66 DINER',                            false, 'ROUTE 66 DINER'),
  ('phone dashes',            'GYM CLUB 555-123-4567',                     false, 'GYM CLUB'),
  ('phone parens',            'GYM CLUB (555) 123-4567',                   false, 'GYM CLUB'),
  ('ref number',              'UTILITY CO REF #AB12345',                   false, 'UTILITY CO'),
  ('conf lower case',         'water co conf: 99812',                      false, 'water co'),
  ('masked card X',           'ONLINE TRANSFER TO CARD XXXXXX1111',        false, 'ONLINE TRANSFER TO CARD'),
  ('masked card star',        'CARD PAYMENT ****9876',                     false, 'CARD PAYMENT'),
  ('asterisk code',           'BOOKSHOP MKTP US*2K4HJ1',                   false, 'BOOKSHOP MKTP US'),
  ('asterisk before name',    'SQ *CORNER COFFEE',                         false, 'SQ CORNER COFFEE'),
  ('city state stripped',     'CORNER COFFEE SPRINGFIELD OR',              true,  'CORNER COFFEE'),
  ('city state kept',         'CORNER COFFEE SPRINGFIELD OR',              false, 'CORNER COFFEE SPRINGFIELD OR'),
  ('city state alone kept',   'SPRINGFIELD OR',                            true,  'SPRINGFIELD OR'),
  ('store then city',         'NEIGHBORHOOD GROCER #0042 SPRINGFIELD OR',  true,  'NEIGHBORHOOD GROCER'),
  ('blank is null',           '   ',                                       false, null),
  ('null is null',            null,                                        false, null)
),
clean as (
  select 'clean' as fn, name, wb_clean_description(raw, strip) as got, expected
  from clean_cases
),
phrase_cases(name, fn, input, expected) as (values
  ('card payment',        'transfer', 'ONLINE PAYMENT THANK YOU',            true),
  ('payment dash',        'transfer', 'PAYMENT - THANK YOU',                 true),
  ('online transfer',     'transfer', 'ONLINE TRANSFER TO SAVINGS',          true),
  ('transfer from',       'transfer', 'RECURRING TRANSFER FROM CHECKING',    true),
  ('autopay',             'transfer', 'AUTOPAY PAYMENT',                     true),
  ('not transfer',        'transfer', 'TRANSFORMER TOYS',                    false),
  ('null transfer',       'transfer', null,                                  false),
  ('interest',            'interest', 'INTEREST PAYMENT',                    true),
  ('not interest',        'interest', 'INTERESTING BOOKS',                   false),
  ('fee',                 'fee',      'MONTHLY SERVICE FEE',                 true),
  ('interest charge fee', 'fee',      'INTEREST CHARGE ON PURCHASES',        true),
  ('not fee',             'fee',      'COFFEE HOUSE',                        false)
),
phrases as (
  select 'phrase_' || fn as fn, name,
         (case fn when 'transfer' then wb_is_transfer_phrase(input)
                  when 'interest' then wb_is_interest_phrase(input)
                  else wb_is_fee_phrase(input) end)::text as got,
         expected::text as expected
  from phrase_cases
),
kind_cases(name, role, amount, description, payee, merchant_kind, expected) as (values
  ('retirement',              'retirement',         -100.00, 'FUND PURCHASE',              null,             null,     'investment'),
  ('investment beats merchant','taxable_investment',  50.00, 'DIVIDEND',                   null,             'income', 'investment'),
  ('merchant beats sign',     'credit_card',          25.00, 'BOOKSHOP',                   null,             'spend',  'spend'),
  ('card payment',            'credit_card',         500.00, 'ONLINE PAYMENT THANK YOU',   null,             null,     'transfer'),
  ('bank side of payment',    'spending_cash',      -500.00, 'ONLINE TRANSFER TO CARD',    null,             null,     'transfer'),
  ('interest',                'reserve_cash',          1.23, 'INTEREST PAYMENT',           null,             null,     'interest'),
  ('interest charge',         'credit_card',         -15.00, 'INTEREST CHARGE ON PURCHASES', null,           null,     'fee'),
  ('fee on payee',            'credit_card',         -15.00, 'ACCOUNT ACTIVITY',           'INTEREST CHARGE', null,    'fee'),
  ('bank fee',                'spending_cash',       -10.00, 'MONTHLY SERVICE FEE',        null,             null,     'fee'),
  ('card refund',             'credit_card',          30.00, 'BOOKSHOP RETURN',            null,             null,     'refund'),
  ('income',                  'spending_cash',      1000.00, 'PAYROLL DEPOSIT',            null,             null,     'income'),
  ('spend',                   'spending_cash',       -42.50, 'NEIGHBORHOOD GROCER',        null,             null,     'spend')
),
kinds as (
  select 'default_kind' as fn, name,
         wb_default_kind(role, amount, description, payee, merchant_kind) as got, expected
  from kind_cases
),
match_cases(name, a_acc, a_amt, a_day, b_acc, b_amt, b_day, expected) as (values
  ('opposite, 2 days',    1, -500.00, 0, 2,  500.00, 2, true),
  ('5 days is in',        1, -500.00, 0, 2,  500.00, 5, true),
  ('6 days is out',       1, -500.00, 0, 2,  500.00, 6, false),
  ('same account',        1, -500.00, 0, 1,  500.00, 1, false),
  ('not opposite',        1, -500.00, 0, 2,  499.99, 1, false),
  ('same sign',           1, -500.00, 0, 2, -500.00, 1, false),
  ('zero amounts',        1,    0.00, 0, 2,    0.00, 1, false),
  ('date before',         1,  250.00, 4, 2, -250.00, 0, true)
),
matches as (
  select 'transfer_match' as fn, name,
         wb_transfer_match(('00000000-0000-0000-0000-00000000000' || a_acc)::uuid, a_amt, date '2026-01-10' + a_day,
                           ('00000000-0000-0000-0000-00000000000' || b_acc)::uuid, b_amt, date '2026-01-10' + b_day)::text as got,
         expected::text as expected
  from match_cases
),
decision_cases(name, fwd, rev, expected) as (values
  ('one each way',     1, 1, 'pair'),
  ('no match',         0, 0, 'none'),
  ('two forward',      2, 1, 'ambiguous'),
  ('two back',         1, 2, 'ambiguous')
),
decisions as (
  select 'pair_decision' as fn, name, wb_pair_decision(fwd, rev) as got, expected
  from decision_cases
),
rule_cases(name, match, amount, payee, description, clean, merchant, kind, expected) as (values
  ('payee case-insensitive', '{"payee_contains": "corner"}'::jsonb,            -4.50, 'Corner Coffee', 'SQ *CORNER COFFEE', 'SQ CORNER COFFEE', null, 'spend', true),
  ('payee miss',             '{"payee_contains": "grocer"}'::jsonb,            -4.50, 'Corner Coffee', 'SQ *CORNER COFFEE', 'SQ CORNER COFFEE', null, 'spend', false),
  ('description via clean',  '{"description_contains": "sq corner"}'::jsonb,   -4.50, null,            'SQ *CORNER COFFEE', 'SQ CORNER COFFEE', null, 'spend', true),
  ('amount_min absolute',    '{"amount_min": 10}'::jsonb,                     -12.00, null,            'X',                 'X',                null, 'spend', true),
  ('amount_min below',       '{"amount_min": 10}'::jsonb,                      -5.00, null,            'X',                 'X',                null, 'spend', false),
  ('amount_max inclusive',   '{"amount_max": 12}'::jsonb,                     -12.00, null,            'X',                 'X',                null, 'spend', true),
  ('kind mismatch',          '{"kind": "income"}'::jsonb,                     -12.00, null,            'X',                 'X',                null, 'spend', false),
  ('account listed',         '{"account_ids": ["00000000-0000-0000-0000-000000000001"]}'::jsonb, -1.00, null, 'X', 'X', null, 'spend', true),
  ('account not listed',     '{"account_ids": ["00000000-0000-0000-0000-000000000002"]}'::jsonb, -1.00, null, 'X', 'X', null, 'spend', false),
  ('merchant needed, none',  '{"merchant_id": "00000000-0000-0000-0000-00000000000m"}'::jsonb, -1.00, null, 'X', 'X', null, 'spend', false),
  ('all keys must match',    '{"payee_contains": "corner", "kind": "income"}'::jsonb, -4.50, 'Corner Coffee', 'X', 'X', null, 'spend', false)
),
rules as (
  select 'rule_matches' as fn, name,
         wb_rule_matches(match, '00000000-0000-0000-0000-000000000001'::uuid, amount, payee, description, clean, merchant::uuid, kind)::text as got,
         expected::text as expected
  from rule_cases
),
all_cases as (
  select fn, name, got, expected from clean
  union all select fn, name, got, expected from phrases
  union all select fn, name, got, expected from kinds
  union all select fn, name, got, expected from matches
  union all select fn, name, got, expected from decisions
  union all select fn, name, got, expected from rules
)
select json_build_object(
  'tests', json_build_object(
    'total',  (select count(*) from all_cases),
    'failed', (select count(*) from all_cases where got is distinct from expected),
    'failures', (select coalesce(json_agg(t), '[]'::json) from (
      select fn, name, got, expected from all_cases where got is distinct from expected) t)
  ),
  'checks', json_build_object(
    'every_transaction_one_split_equal_to_amount', (
      select bool_and(n = 1 and total = x.amount)
      from public.wb_transactions x
      join lateral (select count(*) as n, sum(s.amount) as total from public.wb_splits s where s.transaction_id = x.id) s on true),
    'transactions', (select count(*) from public.wb_transactions),
    'splits', (select count(*) from public.wb_splits),
    'no_transaction_processed_yet', (select count(*) = 0 from public.wb_transactions where processed_at is not null or kind is not null),
    'split_tags_empty', (select count(*) = 0 from public.wb_split_tags),
    'tag_groups_seeded', (
      select json_agg(t order by sort_order) from (
        select name, exclusive, required_for_kinds, sort_order, context_id = 'muvitejhrgt3rgi8t6q' as money_context
        from public.wb_tag_groups) t),
    'policies_match_intents', (
      select bool_and(p.qual = i.qual and p.with_check = i.with_check)
      from pg_policies p
      cross join (select qual, with_check from pg_policies where tablename = 'intents' and policyname = 'intents_access') i
      where p.schemaname = 'public'
        and p.tablename in ('wb_merchants', 'wb_tag_groups', 'wb_tags', 'wb_rules', 'wb_splits', 'wb_split_tags')),
    'policy_count', (
      select count(*) from pg_policies
      where schemaname = 'public'
        and tablename in ('wb_merchants', 'wb_tag_groups', 'wb_tags', 'wb_rules', 'wb_splits', 'wb_split_tags')),
    'rls_on', (
      select bool_and(c.relrowsecurity) from pg_class c
      where c.oid in ('public.wb_merchants'::regclass, 'public.wb_tag_groups'::regclass, 'public.wb_tags'::regclass,
                      'public.wb_rules'::regclass, 'public.wb_splits'::regclass, 'public.wb_split_tags'::regclass)),
    'views_security_invoker', (
      select bool_and(coalesce(c.reloptions, '{}') @> array['security_invoker=true']) from pg_class c
      where c.oid in ('public.wb_review_queue'::regclass, 'public.wb_spending_by_tag'::regclass,
                      'public.wb_cash_flow_monthly'::regclass)),
    'process_fn_is_invoker', (
      select not p.prosecdef from pg_proc p where p.oid = 'public.wb_process_transactions(uuid[])'::regprocedure),
    'no_wb_security_definer', (
      select count(*) = 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'wb\_%' and p.prosecdef),
    'anon_blocked', (
      select not has_table_privilege('anon', 'public.wb_splits', 'select')
         and not has_table_privilege('anon', 'public.wb_split_tags', 'select')
         and not has_table_privilege('anon', 'public.wb_rules', 'select')
         and not has_table_privilege('anon', 'public.wb_review_queue', 'select')
         and not has_function_privilege('anon', 'public.wb_process_transactions(uuid[])', 'execute')),
    'triggers', (
      select json_agg(t order by t) from (
        select distinct event_object_table || '.' || trigger_name as t
        from information_schema.triggers
        where event_object_schema = 'public' and event_object_table like 'wb\_%') x),
    'review_queue_reasons', (
      select json_object_agg(reason, n) from (
        select reason, count(*) as n from public.wb_review_queue group by reason) q)
  )
) as result;
