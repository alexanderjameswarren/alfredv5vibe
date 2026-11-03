-- Warren Buffet money chat, Step 15: subscription reviews. Run after the migration, through the queue with --test.
-- It works on invented "ZZ" rows and undoes itself. Result: one row, with all_passed, failed and checks.
-- The real subscriptions sit in a shared context, so the other-household check uses its own private context.
-- supabase/tests/warren_buffet_p4-r6d/1_subscription_reviews_tests.sql

do $$
declare
  c_money constant text := 'muvitejhrgt3rgi8t6q';
  c_ctx   constant text := 'zzsubreviewtest1';
  c_fn    constant text := 'public.wb_record_subscription_review(uuid, text, date, date, date, date, integer, numeric, numeric, text, text)';
  v_owner uuid := (select user_id from public.contexts where id = c_money);
  v_checks jsonb := '{}'::jsonb;
  v_sub uuid; v_cancel uuid; v_private uuid;
  v_row public.wb_subscription_reviews;
  v_sub_row public.wb_subscriptions;
  v_ok boolean;
  n int;
  v_result jsonb;
begin
  begin
    insert into public.contexts (id, name, shared, user_id) values (c_ctx, 'ZZ private', false, v_owner);
    insert into public.wb_subscriptions (user_id, context_id, name, status, review_date, notes, usage_clues)
      values (v_owner, c_money, 'ZZ keep', 'active', date '2030-01-01', 'ZZ note', 'ZZ clue') returning id into v_sub;
    insert into public.wb_subscriptions (user_id, context_id, name, status, review_date)
      values (v_owner, c_money, 'ZZ cancel', 'active', date '2030-01-01') returning id into v_cancel;
    insert into public.wb_subscriptions (user_id, context_id, name, status, review_date)
      values (v_owner, c_ctx, 'ZZ private', 'active', date '2030-01-01') returning id into v_private;

    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    -- a. A review saves and moves review_date, and nothing else.
    v_row := public.wb_record_subscription_review(v_sub, 'keep', date '2031-02-01',
      p_reviewed_on => date '2030-06-01', p_period_from => date '2029-06-01', p_period_to => date '2030-05-31',
      p_uses => 10, p_amount_paid => 100, p_cost_per_use => 10, p_market_check => '2030-06-01 ZZ source: about the same');
    select * into v_sub_row from public.wb_subscriptions where id = v_sub;
    v_checks := v_checks
      || jsonb_build_object('a_row_saved', v_row.verdict = 'keep' and v_row.uses = 10 and v_row.cost_per_use = 10
           and v_row.next_review_on = date '2031-02-01' and v_row.reviewed_on = date '2030-06-01')
      || jsonb_build_object('a_owner_copied', v_row.user_id = v_owner and v_row.context_id = c_money)
      || jsonb_build_object('a_review_date_moved', v_sub_row.review_date = date '2031-02-01')
      || jsonb_build_object('a_nothing_else_changed', v_sub_row.status = 'active' and v_sub_row.notes = 'ZZ note'
           and v_sub_row.usage_clues = 'ZZ clue' and v_sub_row.name = 'ZZ keep');

    -- b. No next date and a non-cancel verdict is refused, and changes nothing.
    begin perform public.wb_record_subscription_review(v_cancel, 'keep'); v_ok := false;
    exception when others then v_ok := sqlerrm like '%next review date is required%'; end;
    v_checks := v_checks
      || jsonb_build_object('b_no_next_date_refused', v_ok)
      || jsonb_build_object('b_no_row', not exists (select 1 from public.wb_subscription_reviews where subscription_id = v_cancel))
      || jsonb_build_object('b_date_unchanged', (select review_date from public.wb_subscriptions where id = v_cancel) = date '2030-01-01');

    -- c. Cancel needs no next date and leaves the subscription alone.
    v_row := public.wb_record_subscription_review(v_cancel, 'cancel', p_reviewed_on => date '2030-06-01');
    select * into v_sub_row from public.wb_subscriptions where id = v_cancel;
    v_checks := v_checks
      || jsonb_build_object('c_cancel_saved', v_row.verdict = 'cancel' and v_row.next_review_on is null)
      || jsonb_build_object('c_status_alone', v_sub_row.status = 'active')
      || jsonb_build_object('c_date_alone', v_sub_row.review_date = date '2030-01-01');

    -- d. The overview shows the last review and verdict, and adds its columns at the end.
    perform public.wb_record_subscription_review(v_sub, 'shop_around', date '2031-03-01', p_reviewed_on => date '2030-07-01');
    v_checks := v_checks
      || jsonb_build_object('d_last_review', exists (select 1 from public.wb_subscription_overview
           where id = v_sub and last_reviewed_on = date '2030-07-01' and last_verdict = 'shop_around' and usage_clues = 'ZZ clue'))
      || jsonb_build_object('d_never_reviewed_is_null', exists (select 1 from public.wb_subscription_overview
           where id = v_private and last_reviewed_on is null and last_verdict is null))
      || jsonb_build_object('d_columns_at_end', (select array_agg(column_name::text order by ordinal_position desc)
           from (select column_name, ordinal_position from information_schema.columns
                  where table_schema = 'public' and table_name = 'wb_subscription_overview'
                  order by ordinal_position desc limit 4) t)
           = array['last_verdict', 'last_reviewed_on', 'usage_clues', 'interval_unit']);

    -- e. The table refuses bad rows of its own.
    begin perform public.wb_record_subscription_review(v_cancel, 'maybe', date '2031-01-01'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('e_bad_verdict_refused', v_ok);
    begin perform public.wb_record_subscription_review(v_cancel, 'keep', date '2030-05-01', p_reviewed_on => date '2030-06-01'); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('e_next_before_review_refused', v_ok);
    begin perform public.wb_record_subscription_review(v_cancel, 'keep', date '2031-01-01', p_uses => 0, p_cost_per_use => 1); v_ok := false;
    exception when check_violation then v_ok := true; end;
    v_checks := v_checks || jsonb_build_object('e_cost_with_no_uses_refused', v_ok);

    -- f. Another household sees none of a private context's rows, and can't review them.
    perform public.wb_record_subscription_review(v_private, 'keep', date '2031-01-01', p_reviewed_on => date '2030-06-01');
    v_checks := v_checks || jsonb_build_object('f_owner_sees_private_review',
      exists (select 1 from public.wb_subscription_reviews where subscription_id = v_private));

    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    select count(*) into n from public.wb_subscription_reviews where subscription_id = v_private;
    v_checks := v_checks
      || jsonb_build_object('f_stranger_no_review', n = 0)
      || jsonb_build_object('f_stranger_no_overview', not exists (select 1 from public.wb_subscription_overview where id = v_private));
    begin perform public.wb_record_subscription_review(v_private, 'keep', date '2031-06-01'); v_ok := false;
    exception when others then v_ok := sqlerrm like '%no subscription%'; end;
    v_checks := v_checks || jsonb_build_object('f_stranger_cannot_review', v_ok);

    perform set_config('role', 'none', true);
    v_checks := v_checks
      || jsonb_build_object('f_date_unmoved_by_stranger', (select review_date from public.wb_subscriptions where id = v_private) = date '2031-01-01');

    -- g. Grants: anon gets nothing, and the platform has no complaint.
    v_checks := v_checks
      || jsonb_build_object('g_anon_no_table', not has_table_privilege('anon', 'public.wb_subscription_reviews', 'select'))
      || jsonb_build_object('g_anon_no_view', not has_table_privilege('anon', 'public.wb_subscription_overview', 'select'))
      || jsonb_build_object('g_anon_no_function', not has_function_privilege('anon', c_fn, 'execute'))
      || jsonb_build_object('g_authenticated_function', has_function_privilege('authenticated', c_fn, 'execute'))
      || jsonb_build_object('g_authenticated_view', has_table_privilege('authenticated', 'public.wb_subscription_overview', 'select'))
      || jsonb_build_object('g_view_security_invoker', exists (select 1 from pg_class c
           where c.oid = 'public.wb_subscription_overview'::regclass and 'security_invoker=true' = any (c.reloptions)))
      || jsonb_build_object('g_conformant', not exists (select 1 from platform.conformance_failures f where f.table_name like '%wb_subscription%'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'wb_subscription_reviews_undo';
  exception when others then
    if sqlerrm <> 'wb_subscription_reviews_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'checks', v_checks);
    end if;
  end;
  perform set_config('wb.subscription_reviews_result', v_result::text, true);
end;
$$;

select current_setting('wb.subscription_reviews_result')::jsonb as result;
