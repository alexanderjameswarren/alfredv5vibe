-- Purpose: Warren Buffet Phase 2 Step 10 tests for wb_bulk_create: a dry run writes nothing, a real run creates tags (with a parent from the same call), merchants and merchant rules by name, a re-run reuses them (new patterns are added), an existing merchant rule is never duplicated, and any item error writes nothing.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-13 by Alex after 129: 17/17 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/130_wb_phase2_step10_bulk_create_tests.sql

create or replace function pg_temp.wb_test_step10_bulk_create()
returns void
language plpgsql
as $$
declare
  v_ctx     text := 'muvitejhrgt3rgi8t6q';
  v_tag     text := 'zz' || translate(substr(md5(random()::text), 1, 8), '0123456789', 'ghijklmnop');
  v_payload jsonb;
  v_res     jsonb;
  v_rule    record;
  v_err     text;
  checks    jsonb := '{}'::jsonb;
begin
  v_payload := jsonb_build_object(
    'tags', jsonb_build_array(
      jsonb_build_object('group', 'Category', 'name', 'ZZ Home ' || v_tag),
      jsonb_build_object('group', 'category', 'name', 'ZZ Pets ' || v_tag, 'parent', 'ZZ Home ' || v_tag)),
    'merchants', jsonb_build_array(
      jsonb_build_object('name', 'ZZ Shop ' || v_tag, 'match_patterns', jsonb_build_array('ZZShop' || v_tag), 'default_kind', 'spend')),
    'rules', jsonb_build_array(
      jsonb_build_object('name', 'ZZ Shop rule', 'merchant', 'zz shop ' || v_tag, 'set_kind', 'spend',
                         'tags', jsonb_build_array('Category/ZZ Pets ' || v_tag))));

  -- Dry run: every item would be created, nothing is written.
  v_res := public.wb_bulk_create(v_payload, v_ctx, true, 'claude');
  checks := checks || jsonb_build_object(
    'dry_run_plans_all', (v_res #>> '{counts,created}')::int = 4 and (v_res ->> 'applied')::boolean = false,
    'dry_run_writes_nothing', not exists (select 1 from public.wb_tags where name like 'ZZ % ' || v_tag)
                              and not exists (select 1 from public.wb_merchants where name = 'ZZ Shop ' || v_tag));

  -- Real run.
  v_res := public.wb_bulk_create(v_payload, v_ctx, false, 'claude');
  select r.* into v_rule from public.wb_rules r
  join public.wb_merchants m on m.id = (r.match ->> 'merchant_id')::uuid
  where m.name = 'ZZ Shop ' || v_tag;
  checks := checks || jsonb_build_object(
    'real_run_applied', (v_res ->> 'applied')::boolean and (v_res #>> '{counts,created}')::int = 4,
    'parent_from_same_call', (select p.name = 'ZZ Home ' || v_tag from public.wb_tags t join public.wb_tags p on p.id = t.parent_id
                              where t.name = 'ZZ Pets ' || v_tag),
    'merchant_patterns_lowercase', (select match_patterns = array['zzshop' || v_tag] and default_kind = 'spend'
                                    from public.wb_merchants where name = 'ZZ Shop ' || v_tag),
    'rule_on_merchant_with_tag', v_rule.set_kind = 'spend' and v_rule.created_by = 'claude'
      and v_rule.add_tag_ids = array[(select id from public.wb_tags where name = 'ZZ Pets ' || v_tag)]);

  -- Again, with one new pattern: tags and rule reused, merchant updated, nothing duplicated.
  v_payload := jsonb_set(v_payload, '{merchants,0,match_patterns}', jsonb_build_array('zzshop' || v_tag, 'zzshoptwo' || v_tag));
  v_res := public.wb_bulk_create(v_payload, v_ctx, false, 'manual');
  checks := checks || jsonb_build_object(
    'rerun_reuses', (v_res #>> '{counts,exists}')::int = 3 and (v_res #>> '{counts,updated}')::int = 1,
    'rerun_adds_pattern', (select cardinality(match_patterns) = 2 from public.wb_merchants where name = 'ZZ Shop ' || v_tag),
    'rule_not_duplicated', (select count(*) = 1 from public.wb_rules where match ->> 'merchant_id' = (v_rule.match ->> 'merchant_id')),
    'rule_result_is_existing', (select (r ->> 'id')::uuid = v_rule.id from jsonb_array_elements(v_res -> 'results') r where r ->> 'kind' = 'rule'));

  -- An error anywhere writes nothing: a good new tag plus a rule on a missing merchant and a bad tag reference.
  v_res := public.wb_bulk_create(jsonb_build_object(
    'tags', jsonb_build_array(jsonb_build_object('group', 'Category', 'name', 'ZZ Garden ' || v_tag)),
    'rules', jsonb_build_array(
      jsonb_build_object('name', 'ZZ missing', 'merchant', 'ZZ Nowhere ' || v_tag, 'set_kind', 'spend'),
      jsonb_build_object('name', 'ZZ bad tag', 'merchant', 'ZZ Shop ' || v_tag, 'tags', jsonb_build_array('Category/ZZ Nope')))),
    v_ctx, false, 'claude');
  checks := checks || jsonb_build_object(
    'error_not_applied', (v_res ->> 'applied')::boolean = false and (v_res #>> '{counts,error}')::int = 2,
    'error_rolls_back_good_items', not exists (select 1 from public.wb_tags where name = 'ZZ Garden ' || v_tag),
    'error_names_the_problem', exists (select 1 from jsonb_array_elements(v_res -> 'results') r
                                       where r ->> 'error' like 'no merchant "ZZ Nowhere%'),
    'error_names_bad_tag', exists (select 1 from jsonb_array_elements(v_res -> 'results') r
                                   where r ->> 'error' = 'no tag "Category/ZZ Nope" (write Group/Tag)'));

  -- Item checks: unknown group, short pattern, rule with no action.
  v_res := public.wb_bulk_create(jsonb_build_object(
    'tags', jsonb_build_array(jsonb_build_object('group', 'Nope', 'name', 'ZZ x')),
    'merchants', jsonb_build_array(jsonb_build_object('name', 'ZZ Short ' || v_tag, 'match_patterns', jsonb_build_array('ab'))),
    'rules', jsonb_build_array(jsonb_build_object('name', 'ZZ idle', 'merchant', 'ZZ Shop ' || v_tag))),
    v_ctx, true, 'claude');
  checks := checks || jsonb_build_object(
    'item_errors_listed', (select array_agg(r ->> 'error' order by r ->> 'kind') from jsonb_array_elements(v_res -> 'results') r)
                          = array['a match pattern needs at least 3 characters', 'say what the rule does: set_kind and/or tags', 'no tag group "Nope"']);

  -- Whole-call refusals.
  begin
    perform public.wb_bulk_create(jsonb_build_object('tags', (select jsonb_agg(jsonb_build_object('group', 'Category', 'name', 'ZZ ' || g))
                                                              from generate_series(1, 51) g)), v_ctx, true, 'claude');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('cap_of_50', v_err like '%at most 50%');
  begin
    perform public.wb_bulk_create('{}'::jsonb, v_ctx, true, 'rule');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object('created_by_checked', v_err like '%created_by must be claude or manual%');

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_step10_bulk_create();
