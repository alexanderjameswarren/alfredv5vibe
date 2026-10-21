-- Purpose: Warren Buffet Phase 3 Step 8d-1 tests, run after 146_wb_phase3_step8d_delete_planned_item.sql: an item with matches of every status and a skip is fully removed with the right counts; the matched transactions and the project stay; the project's amounts still due drop by the item; a missing id is refused with nothing changed; an item RLS hides from another user is refused with nothing changed.
-- Kind: test (writes invented fixtures, then rolls everything back: nothing persists, not even audit rows)
-- Run: 2026-10-21 by Alex after 146: 12/12 checks passed, rolled back by design. Safe to re-run any time.
--
-- A script run by hand, so it lives in supabase/tests/, not supabase/migrations/ (see .claude/CLAUDE.md).
-- Every name and amount below is invented ("ZZ test" fixtures). No real financial data.
-- Every check reads fixture rows only, so real data does not matter. Run the whole file.
--
-- HOW TO READ THE RESULT: the script ends by raising an error on purpose, so the
-- whole run rolls back. The error text is the result:
--   WB TEST RESULT (rolled back): {"all_passed": true, "checks": {...}}
-- Expect all_passed true.
-- supabase/tests/warren_buffet_p3/1_delete_planned_item_tests.sql

create or replace function pg_temp.zz_txn(p_acct uuid, p_on date, p_amount numeric)
returns uuid
language sql
as $$
  insert into public.wb_transactions (user_id, context_id, account_id, external_id, posted_at, amount, description, payee, raw)
  select a.user_id, a.context_id, p_acct, 'ZZ-P8D-' || gen_random_uuid(), (p_on + time '12:00') at time zone 'America/Los_Angeles',
         p_amount, 'ZZ P8D test', 'ZZ P8D test', '{}'
  from public.wb_accounts a where a.id = p_acct
  returning id;
$$;

create or replace function pg_temp.zz_split(p_txn uuid)
returns uuid
language sql
as $$ select id from public.wb_splits where transaction_id = p_txn order by position limit 1; $$;

create or replace function pg_temp.wb_test_p3_step8d_delete()
returns void
language plpgsql
as $$
declare
  v_ctx  text := 'muvitejhrgt3rgi8t6q';
  v_user uuid;
  d      date := (now() at time zone 'America/Los_Angeles')::date;
  k      text := 'zz' || substr(md5(random()::text), 1, 8);
  v_acct uuid;
  pP     uuid;
  pi_del uuid; pi_keep uuid; pi_hidden uuid;
  t1 uuid; t2 uuid; t3 uuid;
  v_res  jsonb;
  v_err  text;
  v_n    int;
  due0   numeric; due1 numeric;
  checks jsonb := '{}'::jsonb;
begin
  select user_id into v_user from public.contexts where id = v_ctx;
  insert into public.wb_accounts (user_id, context_id, source, external_id, name, role)
  values (v_user, v_ctx, 'simplefin', 'ZZ-TEST-' || gen_random_uuid(), 'ZZ test card ' || k, 'credit_card')
  returning id into v_acct;
  insert into public.wb_projects (user_id, context_id, name) values (v_user, v_ctx, 'ZZ D project ' || k) returning id into pP;

  -- An overdue one-off on the project with a confirmed part, a suggestion, a turned-down match and a skip.
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage)
  values (v_user, v_ctx, pP, 'ZZ D delete me', -300, d - 5, 'invoiced') returning id into pi_del;
  insert into public.wb_planned_items (user_id, context_id, project_id, name, amount, due_on, stage)
  values (v_user, v_ctx, pP, 'ZZ D keep me', -50, d + 5, 'quoted') returning id into pi_keep;
  t1 := pg_temp.zz_txn(v_acct, d - 5, -100);
  t2 := pg_temp.zz_txn(v_acct, d - 4, -300);
  t3 := pg_temp.zz_txn(v_acct, d - 3, -300);
  insert into public.wb_planned_matches (planned_item_id, split_id, amount_applied, status, source) values
    (pi_del, pg_temp.zz_split(t1), -100, 'confirmed', 'manual'),
    (pi_del, pg_temp.zz_split(t2), -300, 'suggested', 'manual'),
    (pi_del, pg_temp.zz_split(t3), -300, 'rejected', 'manual');
  insert into public.wb_planned_skips (planned_item_id, reason) values (pi_del, 'ZZ test');
  select planned_out_due into due0 from public.wb_project_summary where project_id = pP;

  v_res := public.wb_delete_planned_item(pi_del);
  select planned_out_due into due1 from public.wb_project_summary where project_id = pP;
  checks := checks || jsonb_build_object(
    'del_counts', (v_res ->> 'confirmed')::int = 1 and (v_res ->> 'suggested')::int = 1
                  and (v_res ->> 'rejected')::int = 1 and (v_res ->> 'skips')::int = 1
                  and v_res ->> 'name' = 'ZZ D delete me',
    'del_item_gone', not exists (select 1 from public.wb_planned_items where id = pi_del),
    'del_matches_gone', not exists (select 1 from public.wb_planned_matches where planned_item_id = pi_del),
    'del_skips_gone', not exists (select 1 from public.wb_planned_skips where planned_item_id = pi_del),
    'del_transactions_stay', (select count(*) from public.wb_transactions where id in (t1, t2, t3)) = 3
                             and (select count(*) from public.wb_splits where transaction_id in (t1, t2, t3)) = 3,
    'del_project_stays', exists (select 1 from public.wb_projects where id = pP),
    'del_other_item_stays', exists (select 1 from public.wb_planned_items where id = pi_keep),
    'del_project_due_drops', due0 = -250 and due1 = -50);

  -- A missing id: refused, nothing changed.
  select count(*) into v_n from public.wb_planned_items;
  begin
    perform public.wb_delete_planned_item(gen_random_uuid());
    v_err := 'none';
  exception when others then v_err := sqlerrm;
  end;
  checks := checks || jsonb_build_object(
    'missing_refused', v_err like '%no planned item%that you can see%',
    'missing_nothing_changed', (select count(*) from public.wb_planned_items) = v_n);

  -- Another user: an item in a private context of this user is hidden by RLS from anyone else.
  insert into public.contexts (id, name, user_id, shared) values ('zz-' || k, 'ZZ D private ' || k, v_user, false);
  insert into public.wb_planned_items (user_id, context_id, name, amount, due_on, stage)
  values (v_user, 'zz-' || k, 'ZZ D hidden', -10, d + 5, 'quoted') returning id into pi_hidden;
  begin
    perform set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
    execute 'set local role authenticated';
    perform public.wb_delete_planned_item(pi_hidden);
    v_err := 'none';
  exception when others then v_err := sqlerrm;
  end;
  execute 'reset role';
  checks := checks || jsonb_build_object(
    'other_user_refused', v_err <> 'none',
    'other_user_nothing_changed', exists (select 1 from public.wb_planned_items where id = pi_hidden));

  raise exception 'WB TEST RESULT (rolled back): %',
    jsonb_build_object('all_passed', not exists (select 1 from jsonb_each(checks) c where c.value <> 'true'::jsonb),
                       'checks', checks, 'other_user_error', v_err)::text;
end;
$$;

select pg_temp.wb_test_p3_step8d_delete();
