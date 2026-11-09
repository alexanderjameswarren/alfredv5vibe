-- notification_routing-d7v step 13b: verify started_by is required on claude_notifications and by
-- log_claude_notification(). Runs after 221_claude_notifications_started_by_required.sql, with --test. It undoes itself: the inner
-- block ends in its own error, the checks survive in a variable, and the result row says
-- { ok, failed, check_count, checks }. Fixtures are dedupe keys nrsr-test:*.
-- supabase/tests/notification_routing-d7v/9_started_by_required_verify.sql

do $$
declare
  c_done   constant text := 'NRSR_UNDO';
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c        jsonb := '{}';
  v_out    jsonb;
  v_result jsonb;
begin
  begin
    c := c || jsonb_build_object(
      'column_not_null', exists (select 1 from information_schema.columns where table_schema = 'public'
                                    and table_name = 'claude_notifications' and column_name = 'started_by'
                                    and is_nullable = 'NO'),
      'no_null_rows', not exists (select 1 from public.claude_notifications where started_by is null),
      'constraint_present', exists (select 1 from pg_constraint where conrelid = 'public.claude_notifications'::regclass
                                       and conname = 'claude_notifications_started_by_valid'),
      'fn_not_anon', not has_function_privilege('anon',
        'public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)',
        'execute'),
      'fn_authenticated', has_function_privilege('authenticated',
        'public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb, text, uuid)',
        'execute'),
      'conformance', public.platform_check_conformance() like 'CONFORMANT%');

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    -- A missing or blank started_by is refused with the function's own message.
    begin
      perform public.log_claude_notification('alfred', 'nrsr_test', 'info', 'inbox_item', 'TEST nrsr', 'nrsr-test:none');
      c := c || '{"fn_refuses_missing": false}';
    exception when others then
      c := c || jsonb_build_object('fn_refuses_missing', sqlerrm like '%started_by is required%');
    end;
    begin
      perform public.log_claude_notification('alfred', 'nrsr_test', 'info', 'inbox_item', 'TEST nrsr', 'nrsr-test:blank',
        p_started_by => '  ');
      c := c || '{"fn_refuses_blank": false}';
    exception when others then
      c := c || jsonb_build_object('fn_refuses_blank', sqlerrm like '%started_by is required%');
    end;

    -- A good one is logged; a bad one is still refused by the check constraint.
    v_out := public.log_claude_notification('alfred', 'nrsr_test', 'info', 'inbox_item', 'TEST nrsr', 'nrsr-test:ok',
      p_started_by => 'chat');
    c := c || jsonb_build_object('fn_logs_with_started_by', (v_out->>'created')::boolean
      and exists (select 1 from public.claude_notifications where id = (v_out->>'id')::uuid and started_by = 'chat'));
    begin
      perform public.log_claude_notification('alfred', 'nrsr_test', 'info', 'inbox_item', 'TEST nrsr', 'nrsr-test:bad',
        p_started_by => 'cron');
      c := c || '{"fn_refuses_bad_value": false}';
    exception when others then c := c || jsonb_build_object('fn_refuses_bad_value', sqlstate = '23514'); end;

    -- A direct insert with no started_by (as notify-dispatch would, under the service role) is refused.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    perform set_config('role', 'service_role', true);
    begin
      insert into public.claude_notifications (user_id, app, job, kind, channel, title, dedupe_key, delivery_status)
      values (c_alex, 'alfred', 'nrsr_test', 'info', 'alfred_push', 'TEST nrsr', 'nrsr-test:direct', 'sent');
      c := c || '{"direct_null_refused": false}';
    exception when others then c := c || jsonb_build_object('direct_null_refused', sqlstate = '23502'); end;

    v_result := jsonb_build_object(
      'ok', not exists (select 1 from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c)
                  where value is distinct from 'true'::jsonb),
      'check_count', (select count(*) from jsonb_object_keys(c)),
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('ok', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('notification_routing.result', v_result::text, false);
end;
$$;

select current_setting('notification_routing.result')::jsonb as result;
