-- notification_routing-d7v step 6: verify the started_by migration on reminders, and the claude_notifications row
-- notify-dispatch now writes. Runs after it, with --test. It undoes itself: the inner block ends in its own error, the
-- checks survive in a variable, and the result row says { ok, failed, check_count, checks }. Fixtures are text TEST nrs*.
-- supabase/tests/notification_routing-d7v/3_started_by_verify.sql

do $$
declare
  c_done  constant text := 'NRSB_UNDO';
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c       jsonb := '{}';
  v_due   timestamptz := now() + interval '40 days';
  v_row   public.reminders%rowtype;
  v_id    uuid;
  v_n     int;
  v_result jsonb;
begin
  begin
    -- Catalog and backfill.
    c := c || jsonb_build_object(
      'column_not_null', exists (select 1 from information_schema.columns where table_schema = 'public'
                                    and table_name = 'reminders' and column_name = 'started_by' and is_nullable = 'NO'),
      'column_commented', col_description('public.reminders'::regclass,
        (select attnum from pg_attribute where attrelid = 'public.reminders'::regclass and attname = 'started_by')) is not null,
      'constraint_present', exists (select 1 from pg_constraint where conrelid = 'public.reminders'::regclass
                                       and conname = 'reminders_started_by_valid'),
      'trigger_present', exists (select 1 from pg_trigger where tgrelid = 'public.reminders'::regclass
                                    and tgname = 'reminders_default_started_by'),
      'trigger_fn_not_anon', not has_function_privilege('anon', 'public.reminders_default_started_by()', 'execute'),
      'backfill_app_is_alex', not exists (select 1 from public.reminders where created_by = 'app'
                                             and started_by <> 'alex' and created_at < now() - interval '1 minute'),
      'backfill_claude_is_chat_or_task', not exists (select 1 from public.reminders where created_by = 'claude'
                                                        and started_by = 'alex'),
      'conformance', public.platform_check_conformance() like 'CONFORMANT%');

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    -- The insert trigger fills it from created_by; a given value is kept.
    insert into public.reminders (text, due_at, created_by) values ('TEST nrsb app', v_due, 'app') returning * into v_row;
    c := c || jsonb_build_object('app_insert_is_alex', v_row.started_by = 'alex');
    insert into public.reminders (text, due_at, created_by) values ('TEST nrsb claude', v_due, 'claude') returning * into v_row;
    c := c || jsonb_build_object('claude_insert_is_chat', v_row.started_by = 'chat');
    insert into public.reminders (text, due_at, created_by, started_by)
    values ('TEST nrsb task', v_due, 'claude', 'task:overwatch_nightly') returning * into v_row;
    c := c || jsonb_build_object('given_value_kept', v_row.started_by = 'task:overwatch_nightly');

    -- What create_reminder (the tool) does when a task passes one: create as claude, then set it.
    v_row := public.create_reminder('TEST nrsb rpc', v_due, null, null, 'claude');
    c := c || jsonb_build_object('rpc_defaults_to_chat', v_row.started_by = 'chat');
    update public.reminders set started_by = 'task:overwatch_weekly' where id = v_row.id;
    c := c || jsonb_build_object('rpc_row_can_be_set',
      exists (select 1 from public.reminders where id = v_row.id and started_by = 'task:overwatch_weekly'));

    begin
      insert into public.reminders (text, due_at, created_by, started_by) values ('TEST nrsb bad', v_due, 'app', 'cron');
      c := c || '{"bad_value_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_value_refused', sqlstate = '23514'); end;
    begin
      update public.reminders set started_by = null where id = v_row.id;
      c := c || '{"null_refused": false}';
    exception when others then c := c || jsonb_build_object('null_refused', sqlstate = '23502'); end;

    -- The row notify-dispatch logs, under the service role with an explicit user; a repeat is skipped.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    perform set_config('role', 'service_role', true);
    insert into public.claude_notifications (user_id, app, job, kind, channel, title, body, link, dedupe_key,
                                             delivery_status, delivery_detail, started_by)
    values (c_alex, 'alfred', 'reminder', 'info', 'alfred_push', 'Alfred reminder', 'TEST nrsb', '/x',
            'reminder:nrsb-test:' || v_due::text, 'sent', jsonb_build_object('reminder_id', v_row.id), 'chat')
    on conflict (user_id, dedupe_key) do nothing
    returning id into v_id;
    c := c || jsonb_build_object('dispatch_log_row_written', v_id is not null);
    insert into public.claude_notifications (user_id, app, job, kind, channel, title, dedupe_key, delivery_status,
                                             started_by)
    values (c_alex, 'alfred', 'reminder', 'info', 'alfred_push', 'Alfred reminder', 'reminder:nrsb-test:' || v_due::text,
            'sent', 'chat')
    on conflict (user_id, dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    c := c || jsonb_build_object('dispatch_log_repeat_skipped', v_n = 0);

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
