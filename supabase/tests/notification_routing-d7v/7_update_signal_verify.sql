-- notification_routing-d7v step 11: verify signals.decided_by, and that Alex can make update_signal's state changes
-- himself: hold a queued signal, drop a held one, deliver a held one, never move a final one. Runs after
-- 214_signals_decided_by.sql (ran on 2026-11-06 as 212, run 30c77dc4), with --test. It undoes itself: the inner block ends in its own error, the checks survive
-- in a variable, and the result row says { ok, failed, check_count, checks }.
-- supabase/tests/notification_routing-d7v/7_update_signal_verify.sql

do $$
declare
  c_done   constant text := 'NRU_UNDO';
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c        jsonb := '{}';
  v_a      uuid;
  v_b      uuid;
  v_n      int;
  v_result jsonb;
begin
  begin
    c := c || jsonb_build_object(
      'column_exists', exists (select 1 from information_schema.columns
                               where table_schema = 'public' and table_name = 'signals' and column_name = 'decided_by'),
      'authenticated_can_update_it', has_column_privilege('authenticated', 'public.signals', 'decided_by', 'update'),
      'anon_cannot_read_it', not has_column_privilege('anon', 'public.signals', 'decided_by', 'select'));

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    v_a := (public.raise_signal('alfred', 'nru_test', 'normal', 'alfred:nru_test:a', 'TEST nru a', 'alex') ->> 'id')::uuid;
    v_b := (public.raise_signal('alfred', 'nru_test', 'high', 'alfred:nru_test:b', 'TEST nru b', 'alex') ->> 'id')::uuid;

    -- Hold: queued to held, with who and when.
    update public.signals set state = 'held', reason = 'held by Alex', decided_at = now(), decided_by = 'chat'
     where id = v_a and state = 'queued';
    get diagnostics v_n = row_count;
    c := c || jsonb_build_object('owner_can_hold', v_n = 1 and exists (select 1 from public.signals
      where id = v_a and state = 'held' and decided_by = 'chat' and decided_at is not null));

    -- Drop: held to dropped.
    update public.signals set state = 'dropped', reason = 'dropped by Alex', decided_at = now(), decided_by = 'alex'
     where id = v_a and state in ('queued', 'held');
    get diagnostics v_n = row_count;
    c := c || jsonb_build_object('owner_can_drop_held', v_n = 1);

    -- Dropped is final.
    begin
      update public.signals set state = 'held' where id = v_a;
      c := c || '{"dropped_is_final": false}';
    exception when others then c := c || jsonb_build_object('dropped_is_final', sqlstate = '23514'); end;

    -- Deliver now: queued to delivered, as a notification.
    update public.signals set state = 'delivered', outcome = 'pop', reason = 'delivered now by Alex',
           decided_at = now(), decided_by = 'alex'
     where id = v_b and state in ('queued', 'held');
    get diagnostics v_n = row_count;
    c := c || jsonb_build_object('owner_can_deliver', v_n = 1);

    -- What the sender wrote still cannot change, decided_by or not.
    begin
      update public.signals set title = 'changed', decided_by = 'alex' where id = v_b;
      c := c || '{"sender_columns_still_fixed": false}';
    exception when others then c := c || jsonb_build_object('sender_columns_still_fixed', sqlstate = '23514'); end;

    -- Only alex, chat or task:<job>.
    begin
      update public.signals set decided_by = 'Alex!' where id = v_b;
      c := c || '{"bad_decided_by_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_decided_by_refused', sqlstate = '23514'); end;

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
