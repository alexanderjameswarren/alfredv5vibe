-- notification_routing-d7v step 3: verify the signals migration. Runs after it, with --test.
-- It undoes itself: the inner block ends in its own error, the checks survive in a variable, and the result row says
-- { ok, failed, check_count, checks }. Catalog checks run first as the runner's role; the behaviour checks run as Alex
-- (authenticated) and, for the server path, as service_role.
-- supabase/tests/notification_routing-d7v/1_verify_signals.sql

do $$
declare
  c_done  constant text := 'NRS_UNDO';
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c       jsonb := '{}';
  v_out   jsonb;
  v_id    uuid;
  v_nid   uuid;
  v_result jsonb;
begin
  begin
    -- Catalog: table, comments, grants, registry, functions.
    c := c || jsonb_build_object(
      'rls_enabled', (select relrowsecurity from pg_class where oid = 'public.signals'::regclass),
      'every_column_commented', not exists (
        select 1 from pg_attribute a where a.attrelid = 'public.signals'::regclass and a.attnum > 0
           and not a.attisdropped and col_description(a.attrelid, a.attnum) is null),
      'new_notification_columns_commented', not exists (
        select 1 from pg_attribute a where a.attrelid = 'public.claude_notifications'::regclass
           and a.attname in ('started_by', 'signal_id') and col_description(a.attrelid, a.attnum) is null),
      'authenticated_crud', (select bool_and(has_table_privilege('authenticated', 'public.signals', p))
                               from unnest(array['select', 'insert', 'update', 'delete']) p),
      'service_role_crud', (select bool_and(has_table_privilege('service_role', 'public.signals', p))
                              from unnest(array['select', 'insert', 'update', 'delete']) p),
      'anon_has_nothing', not (select bool_or(has_table_privilege('anon', 'public.signals', p))
                                 from unnest(array['select', 'insert', 'update', 'delete']) p),
      'registered', exists (select 1 from platform.registry where table_name = 'public.signals'),
      'guard_trigger', exists (select 1 from pg_trigger where tgrelid = 'public.signals'::regclass
                                  and tgname = 'signals_guard_update'),
      'old_log_signature_gone', to_regprocedure(
        'public.log_claude_notification(text,text,text,text,text,text,text,text,date,text,jsonb)') is null,
      'backfill_left_no_nulls', not exists (select 1 from public.claude_notifications where started_by is null));

    c := c || (select jsonb_object_agg('fn_ok:' || f,
                 to_regprocedure(f) is not null
                 and has_function_privilege('authenticated', f, 'execute')
                 and has_function_privilege('service_role', f, 'execute')
                 and not has_function_privilege('anon', f, 'execute'))
                 from unnest(array[
                   'public.started_by_valid(text)',
                   'public.raise_signal(text,text,text,text,text,text,text,text,text,jsonb,uuid)',
                   'public.log_claude_notification(text,text,text,text,text,text,text,text,date,text,jsonb,text,uuid)'
                 ]) f);

    c := c || jsonb_build_object(
      'started_by_accepts', public.started_by_valid('alex') and public.started_by_valid('chat')
                            and public.started_by_valid('task:wb-sync') and public.started_by_valid('task:overwatch_nightly'),
      'started_by_refuses', not coalesce(public.started_by_valid('Alex'), false)
                            and not coalesce(public.started_by_valid('task:'), false)
                            and not coalesce(public.started_by_valid('cron'), false));

    -- As Alex.
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    v_out := public.raise_signal('alfred', 'nrs_test', 'normal', 'nrs-test:failure', 'TEST signal', 'chat',
                                 p_link => '/abc', p_source_ref => 'nrs-test:1');
    v_id := (v_out ->> 'id')::uuid;
    c := c || jsonb_build_object(
      'raise_creates', (v_out ->> 'created')::boolean,
      'raise_defaults', exists (select 1 from public.signals where id = v_id and state = 'queued'
                                   and user_id = c_alex and details = '{}'::jsonb));

    v_out := public.raise_signal('alfred', 'nrs_test', 'normal', 'nrs-test:failure', 'TEST again', 'chat',
                                 p_source_ref => 'nrs-test:1');
    c := c || jsonb_build_object(
      'repeat_source_ref_not_created', not (v_out ->> 'created')::boolean and (v_out ->> 'id')::uuid = v_id);

    v_out := public.raise_signal('alfred', 'nrs_test', 'low', 'nrs-test:failure', 'TEST no ref', 'task:nrs_test');
    c := c || jsonb_build_object('no_source_ref_always_creates', (v_out ->> 'created')::boolean);

    begin
      perform public.raise_signal('nope', 'nrs_test', 'normal', 'nrs-test:x', 'T', 'chat');
      c := c || '{"unknown_app_refused": false}';
    exception when others then c := c || jsonb_build_object('unknown_app_refused', sqlstate = '22023'); end;
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'loud', 'nrs-test:x', 'T', 'chat');
      c := c || '{"bad_severity_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_severity_refused', sqlstate = '23514'); end;
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'normal', 'Has Spaces', 'T', 'chat');
      c := c || '{"bad_subject_key_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_subject_key_refused', sqlstate = '23514'); end;
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'normal', 'nrs-test:x', 'T', 'someone');
      c := c || '{"bad_started_by_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_started_by_refused', sqlstate = '23514'); end;
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'normal', 'nrs-test:x', 'T', 'chat', p_link => 'https://x.example');
      c := c || '{"bad_link_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_link_refused', sqlstate = '23514'); end;
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'normal', 'nrs-test:x', 'T', 'chat',
                                  p_user_id => gen_random_uuid());
      c := c || '{"other_user_id_refused": false}';
    exception when others then c := c || jsonb_build_object('other_user_id_refused', sqlstate = '22023'); end;

    -- Guard: the sender's columns are fixed; state moves; final states stay final.
    begin
      update public.signals set title = 'changed' where id = v_id;
      c := c || '{"sender_columns_fixed": false}';
    exception when others then c := c || jsonb_build_object('sender_columns_fixed', sqlstate = '23514'); end;
    update public.signals set state = 'held', reason = 'test' where id = v_id;
    update public.signals set state = 'delivered', outcome = 'inbox' where id = v_id;
    c := c || jsonb_build_object('state_moves',
      exists (select 1 from public.signals where id = v_id and state = 'delivered' and outcome = 'inbox'));
    begin
      update public.signals set state = 'queued', outcome = null where id = v_id;
      c := c || '{"final_state_stays": false}';
    exception when others then c := c || jsonb_build_object('final_state_stays', sqlstate = '23514'); end;
    begin
      update public.signals set state = 'delivered' where state = 'queued' and job = 'nrs_test';
      c := c || '{"delivered_needs_outcome": false}';
    exception when others then c := c || jsonb_build_object('delivered_needs_outcome', sqlstate = '23514'); end;

    -- log_claude_notification: started_by and signal_id stored, fixed after insert; old named calls still resolve.
    v_out := public.log_claude_notification(p_app => 'alfred', p_job => 'nrs_test', p_kind => 'info',
      p_channel => 'inbox_item', p_title => 'TEST log', p_dedupe_key => 'nrs-test:log:1',
      p_started_by => 'task:nrs_test', p_signal_id => v_id);
    v_nid := (v_out ->> 'id')::uuid;
    c := c || jsonb_build_object('log_stores_started_by_and_signal',
      exists (select 1 from public.claude_notifications where id = v_nid and started_by = 'task:nrs_test'
                 and signal_id = v_id));
    v_out := public.log_claude_notification(p_app => 'alfred', p_job => 'nrs_test', p_kind => 'info',
      p_channel => 'inbox_item', p_title => 'TEST old call', p_dedupe_key => 'nrs-test:log:2');
    c := c || jsonb_build_object('log_old_named_call_works', (v_out ->> 'created')::boolean
      and exists (select 1 from public.claude_notifications where id = (v_out ->> 'id')::uuid and started_by is null));
    begin
      perform public.log_claude_notification(p_app => 'alfred', p_job => 'nrs_test', p_kind => 'info',
        p_channel => 'inbox_item', p_title => 'T', p_dedupe_key => 'nrs-test:log:3', p_started_by => 'bot');
      c := c || '{"log_bad_started_by_refused": false}';
    exception when others then c := c || jsonb_build_object('log_bad_started_by_refused', sqlstate = '23514'); end;
    begin
      update public.claude_notifications set started_by = 'alex' where id = v_nid;
      c := c || '{"log_started_by_fixed": false}';
    exception when others then c := c || jsonb_build_object('log_started_by_fixed', sqlstate = '23514'); end;
    update public.claude_notifications set delivery_status = 'sent' where id = v_nid;
    c := c || jsonb_build_object('log_delivery_still_updatable',
      exists (select 1 from public.claude_notifications where id = v_nid and delivery_status = 'sent'));

    -- As the service role: the user must be named.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    perform set_config('role', 'service_role', true);
    begin
      perform public.raise_signal('alfred', 'nrs_test', 'high', 'nrs-test:server', 'T', 'task:nrs_test');
      c := c || '{"service_role_needs_user": false}';
    exception when others then c := c || jsonb_build_object('service_role_needs_user', sqlstate = '22023'); end;
    v_out := public.raise_signal('alfred', 'nrs_test', 'high', 'nrs-test:server', 'TEST server', 'task:nrs_test',
                                 p_user_id => c_alex);
    c := c || jsonb_build_object('service_role_raises_for_user',
      exists (select 1 from public.signals where id = (v_out ->> 'id')::uuid and user_id = c_alex));

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
