-- Purpose: Warren Buffet Phase 3 Step 2 tests, run after 133_wb_phase3_step2_tables.sql: the four new tables' checks and triggers (including is_draft, A14), wb_splits.project_id, and wb_replace_splits keeping project links and planned matches through a re-split.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Applied: YES — run 2026-10-14 by Alex after 133: 41/41 checks passed, rolled back by design. Safe to re-run any time.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/migrations/134_wb_phase3_step2_tests.sql

create or replace function pg_temp.wb_test_p3_step2()
returns void
language plpgsql
as $$
declare
  v_ctx   text := 'muvitejhrgt3rgi8t6q';
  v_user  uuid;
  v_today date := (now() at time zone 'America/Los_Angeles')::date;
  v_key   text := 'zz' || substr(md5(random()::text), 1, 8);
  v_acct  uuid;
  v_cat   uuid;
  t_a     uuid;
  t_b     uuid;
  p1      uuid;
  p2      uuid;
  pi_one  uuid;
  pi_rec  uuid;
  pi_in   uuid;
  x1      uuid;
  x2      uuid;
  x_pend  uuid;
  s1      uuid;
  s2      uuid;
  s_new   uuid;
  m1      uuid;
  m2      uuid;
  v_res   jsonb;
  v_err   text;
  checks  jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  select id into v_cat from public.wb_tag_groups where context_id = v_ctx and name = 'Category';

  -- Structure: RLS on, one policy each, the same shape as wb_subscriptions'.
  checks := checks || jsonb_build_object(
    'rls_on', (select bool_and(c.relrowsecurity) from pg_class c
               where c.oid in ('public.wb_projects'::regclass, 'public.wb_planned_items'::regclass,
                               'public.wb_planned_matches'::regclass, 'public.wb_settings'::regclass)),
    'policies_shape', (select count(*) = 4 from pg_policies p
                       cross join (select qual, with_check from pg_policies
                                   where tablename = 'wb_subscriptions' and policyname = 'wb_subscriptions_access') s
                       where p.schemaname = 'public'
                         and p.tablename in ('wb_projects', 'wb_planned_items', 'wb_planned_matches', 'wb_settings')
                         and p.cmd = 'ALL' and p.qual = s.qual and p.with_check = s.with_check),
    'horizon_default_12', (select column_default = '12' from information_schema.columns
                           where table_schema = 'public' and table_name = 'wb_settings' and column_name = 'horizon_months'));

  -- Fixtures.
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card', 'credit_card')
  returning id into v_acct;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ A ' || v_key) returning id into t_a;
  insert into public.wb_tags (user_id, context_id, group_id, name) values (v_user, v_ctx, v_cat, 'ZZ B ' || v_key) returning id into t_b;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-P3-1', now(), -100.00, 'ZZ CONTRACTOR', '{}') returning id into x1;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-P3-2', now(), -30.00, 'ZZ PREMIUM', '{}') returning id into x2;
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, transacted_at, amount, description, pending, raw)
  values (v_user, v_ctx, v_acct, 'ZZ-P3-3', now(), -100.00, 'ZZ PENDING', true, '{}') returning id into x_pend;
  select id into s1 from public.wb_splits where transaction_id = x1;
  select id into s2 from public.wb_splits where transaction_id = x2;

  -- Projects.
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ Project ' || v_key) returning id into p1;
  insert into public.wb_projects (user_id, context_id, name, status) values (v_user, v_ctx, 'ZZ Other ' || v_key, 'on_hold') returning id into p2;
  begin
    insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, upper('ZZ Project ' || v_key));
    v_err := null;
  exception when unique_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('project_name_unique_ignoring_case', v_err = 'refused',
    'project_default_active', (select status = 'active' from public.wb_projects where id = p1));
  begin
    insert into public.wb_projects (user_id, context_id, name, status) values (v_user, v_ctx, 'ZZ bad ' || v_key, 'open');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('project_bad_status_refused', v_err = 'refused');

  -- Planned items.
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage, tax_year)
  values (v_user, v_ctx, p1, 'ZZ invoice', -150.00, v_today, 'invoiced', 2026) returning id into pi_one;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ premium', -30.00, v_today, 1, 'month') returning id into pi_rec;
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit)
  values (v_user, v_ctx, 'ZZ royalty', 20.00, v_today, 3, 'month') returning id into pi_in;

  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on) values (v_user, v_ctx, 'ZZ x', -1, v_today);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('one_off_needs_stage', v_err = 'refused');
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, interval_unit, stage)
    values (v_user, v_ctx, 'ZZ x', -1, v_today, 1, 'month', 'estimate');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('recurring_has_no_stage', v_err = 'refused');
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, interval_count, stage)
    values (v_user, v_ctx, 'ZZ x', -1, v_today, 1, null);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('half_interval_refused', v_err = 'refused');
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage) values (v_user, v_ctx, 'ZZ x', 0, v_today, 'draft');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('zero_amount_refused', v_err = 'refused');
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, ends_on)
    values (v_user, v_ctx, 'ZZ x', -1, v_today, 'draft', v_today + 30);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('ends_on_recurring_only', v_err = 'refused');
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, tax_year)
    values (v_user, v_ctx, 'ZZ x', -1, v_today, 'draft', 1999);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('tax_year_range', v_err = 'refused');

  -- is_draft (A14): recurring only, default false.
  checks := checks || jsonb_build_object(
    'is_draft_default_false', (select not is_draft from public.wb_planned_items where id = pi_rec));
  update public.wb_planned_items set is_draft = true where id = pi_in;
  checks := checks || jsonb_build_object(
    'recurring_draft_allowed', (select is_draft from public.wb_planned_items where id = pi_in));
  begin
    insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage, is_draft)
    values (v_user, v_ctx, 'ZZ x', -1, v_today, 'estimate', true);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('one_off_is_draft_refused', v_err = 'refused');

  -- Matches: filled by trigger, and the parent-dependent checks.
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source)
  values (pi_one, s1, -60.00, 'confirmed', 'manual') returning id into m1;
  insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied)
  values (pi_rec, s2, v_today, -30.00) returning id into m2;
  checks := checks || jsonb_build_object(
    'match_filled', (select user_id = v_user and context_id = v_ctx and transaction_id = x1 from public.wb_planned_matches where id = m1),
    'match_default_suggested', (select status = 'suggested' and source = 'default' from public.wb_planned_matches where id = m2));

  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied)
    values (pi_one, (select id from public.wb_splits where transaction_id = x_pend), -10);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('pending_refused', v_err = 'refused');
  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied) values (pi_rec, s1, -10);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('recurring_needs_occurrence', v_err = 'refused');
  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied) values (pi_one, s2, v_today, -10);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('one_off_no_occurrence', v_err = 'refused');
  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied) values (pi_one, s2, 10);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('wrong_sign_refused', v_err = 'refused');
  -- 60 already confirmed on s1; another 50 would pass its 100.
  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, occurrence_on, amount_applied, status)
    values (pi_rec, s1, v_today, -50.00, 'confirmed');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('confirmed_over_split_refused', v_err = 'refused');
  begin
    insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied) values (pi_one, s1, -5);
    v_err := null;
  exception when unique_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('duplicate_one_off_refused', v_err = 'refused');
  begin
    delete from public.wb_splits where id = s1;
    v_err := null;
  exception when foreign_key_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('split_delete_restricted', v_err = 'refused');
  begin
    delete from public.wb_planned_items where id = pi_one;
    v_err := null;
  exception when foreign_key_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('planned_item_delete_restricted', v_err = 'refused');

  -- Project link on a split; deleting the project clears it.
  update public.wb_splits set project_id = p2 where id = s2;
  delete from public.wb_projects where id = p2;
  checks := checks || jsonb_build_object(
    'project_delete_sets_null', (select project_id is null from public.wb_splits where id = s2));
  update public.wb_splits set project_id = p1 where id = s1;

  -- Re-split 1 -> 2 without project_id keys: the first split keeps its id, project and match.
  v_res := public.wb_replace_splits(x1, jsonb_build_array(
    jsonb_build_object('amount', -70.00, 'tag_ids', jsonb_build_array(t_a)),
    jsonb_build_object('amount', -30.00, 'tag_ids', jsonb_build_array(t_b))), 'manual');
  select id into s_new from public.wb_splits where transaction_id = x1 and position = 1;
  checks := checks || jsonb_build_object(
    'resplit_keeps_first_id', (select id = s1 from public.wb_splits where transaction_id = x1 and position = 0),
    'resplit_keeps_project', (select project_id = p1 from public.wb_splits where id = s1),
    'resplit_new_split_no_project', (select project_id is null from public.wb_splits where id = s_new),
    'resplit_keeps_match', (select split_id = s1 from public.wb_planned_matches where id = m1),
    'resplit_tags_replaced', (select array_agg(tag_id) = array[t_a] from public.wb_split_tags where split_id = s1),
    'resplit_output_has_project', (v_res -> 'splits' -> 0 ->> 'project_id')::uuid = p1);

  -- Give the second split a project and a match, then shrink back to one: its match moves to the first split.
  update public.wb_planned_matches set split_id = s_new, amount_applied = -20.00 where id = m1;
  v_res := public.wb_replace_splits(x1, jsonb_build_array(
    jsonb_build_object('amount', -100.00, 'project_id', null)), 'manual');
  checks := checks || jsonb_build_object(
    'shrink_one_split', (select count(*) = 1 from public.wb_splits where transaction_id = x1),
    'shrink_match_moved', (select split_id = s1 and status = 'confirmed' from public.wb_planned_matches where id = m1),
    'explicit_null_clears_project', (select project_id is null from public.wb_splits where id = s1));

  -- A split smaller than its confirmed matches is refused.
  begin
    perform public.wb_replace_splits(x1, jsonb_build_array(
      jsonb_build_object('amount', -10.00), jsonb_build_object('amount', -90.00)), 'manual');
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('resplit_below_confirmed_refused', v_err = 'refused');

  -- Explicit project on a new split.
  v_res := public.wb_replace_splits(x1, jsonb_build_array(
    jsonb_build_object('amount', -50.00),
    jsonb_build_object('amount', -50.00, 'project_id', p1)), 'manual');
  checks := checks || jsonb_build_object(
    'explicit_project_on_new_split', (select project_id = p1 from public.wb_splits where transaction_id = x1 and position = 1));

  -- Settings: one row per context, ranges.
  begin
    insert into public.wb_settings (user_id, context_id, horizon_months) values (v_user, v_ctx, 25);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('horizon_range', v_err = 'refused');
  begin
    insert into public.wb_settings (user_id, context_id, safety_floor) values (v_user, v_ctx, -1);
    v_err := null;
  exception when check_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('negative_floor_refused', v_err = 'refused');
  if not exists (select 1 from public.wb_settings where context_id = v_ctx) then
    insert into public.wb_settings (user_id, context_id) values (v_user, v_ctx);
  end if;
  begin
    insert into public.wb_settings (user_id, context_id) values (v_user, v_ctx);
    v_err := null;
  exception when unique_violation then v_err := 'refused';
  end;
  checks := checks || jsonb_build_object('one_settings_row', v_err = 'refused');

  -- Existing reads still work with the new column.
  checks := checks || jsonb_build_object(
    'transaction_list_reads', (select split_count = 2 from public.wb_transaction_list where id = x1));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks)::text;
end;
$$;

select pg_temp.wb_test_p3_step2();
