-- notification_routing-d7v step 7: verify resolve_signal, and the wb-sync escalation it resets. Runs after the
-- resolve_signal migration, with --test. It undoes itself: the inner block ends in its own error, the checks survive
-- in a variable, and the result row says { ok, failed, check_count, checks }.
-- Uses the live delivery rules (escalation wb-sync:failure: hold_repeats 1; low defaults to hold) and a fixture
-- subject wb-sync:failure:nrrtest01. dispatch_signals is pinned 40 days ahead at 10:00 Pacific, inside the window.
-- supabase/tests/notification_routing-d7v/4_resolve_signal_verify.sql

do $$
declare
  c_tz     constant text := 'America/Los_Angeles';
  c_done   constant text := 'NRR_UNDO';
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_subj   constant text := 'wb-sync:failure:nrrtest01';
  v_at     timestamptz := ((now() at time zone c_tz)::date + 40 + time '10:00') at time zone c_tz;
  c        jsonb := '{}';
  v_out    jsonb;
  v_first  uuid;
  v_second uuid;
  v_third  uuid;
  v_dec    jsonb;
  v_result jsonb;
begin
  begin
    c := c || jsonb_build_object('fn_ok',
      to_regprocedure('public.resolve_signal(text,text,text,uuid)') is not null
      and has_function_privilege('authenticated', 'public.resolve_signal(text,text,text,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.resolve_signal(text,text,text,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_signal(text,text,text,uuid)', 'execute'));

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    -- First failure: held.
    v_first := (public.raise_signal('warren_buffet', 'wb-sync', 'low', c_subj, 'TEST nrr 1', 'task:wb-sync') ->> 'id')::uuid;
    v_dec := (select d from jsonb_array_elements(public.dispatch_signals(v_at) -> 'decisions') d
               where d ->> 'signal_id' = v_first::text);
    c := c || jsonb_build_object('first_failure_held', v_dec ->> 'decision' = 'hold');
    update public.signals set state = 'held', reason = 'test' where id = v_first;

    -- Second in a row: escalated to an inbox item.
    v_second := (public.raise_signal('warren_buffet', 'wb-sync', 'low', c_subj, 'TEST nrr 2', 'task:wb-sync') ->> 'id')::uuid;
    v_dec := (select d from jsonb_array_elements(public.dispatch_signals(v_at) -> 'decisions') d
               where d ->> 'signal_id' = v_second::text);
    c := c || jsonb_build_object('second_failure_inbox', v_dec ->> 'decision' = 'inbox'
                                                       and (v_dec ->> 'repeats')::int = 1);

    -- A successful sync resolves every failure subject; the queued second is dropped.
    v_out := public.resolve_signal('warren_buffet', 'wb-sync:failure', 'task:wb-sync');
    c := c || jsonb_build_object(
      'resolve_names_subject', v_out -> 'resolved' ? c_subj,
      'resolve_drops_queued', (v_out ->> 'dropped')::int >= 1
                              and exists (select 1 from public.signals where id = v_second and state = 'dropped'),
      'resolved_row_written', exists (select 1 from public.signals where subject_key = c_subj and state = 'resolved'
                                         and started_by = 'task:wb-sync'),
      'held_one_left_as_is', exists (select 1 from public.signals where id = v_first and state = 'held'));

    v_out := public.resolve_signal('warren_buffet', 'wb-sync:failure', 'task:wb-sync');
    c := c || jsonb_build_object('resolve_again_is_empty', not (v_out -> 'resolved' ? c_subj));

    -- The next failure after a resolve starts the count over: held again.
    insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
    values ('warren_buffet', 'wb-sync', 'low', c_subj, 'TEST nrr 3', 'task:wb-sync', now() + interval '30 seconds')
    returning id into v_third;
    v_dec := (select d from jsonb_array_elements(public.dispatch_signals(v_at) -> 'decisions') d
               where d ->> 'signal_id' = v_third::text);
    c := c || jsonb_build_object('after_resolve_held_again', v_dec ->> 'decision' = 'hold'
                                                           and (v_dec ->> 'repeats')::int = 0);

    -- Refusals.
    begin
      perform public.resolve_signal('warren_buffet', 'Bad Key', 'task:wb-sync');
      c := c || '{"bad_subject_refused": false}';
    exception when others then c := c || jsonb_build_object('bad_subject_refused', sqlstate = '22023'); end;
    begin
      perform public.resolve_signal('warren_buffet', 'wb-sync:failure', 'task:wb-sync', gen_random_uuid());
      c := c || '{"other_user_refused": false}';
    exception when others then c := c || jsonb_build_object('other_user_refused', sqlstate = '22023'); end;

    -- The service role (wb-sync) must name the user.
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    perform set_config('role', 'service_role', true);
    begin
      perform public.resolve_signal('warren_buffet', 'wb-sync:failure', 'task:wb-sync');
      c := c || '{"service_role_needs_user": false}';
    exception when others then c := c || jsonb_build_object('service_role_needs_user', sqlstate = '22023'); end;
    v_out := public.resolve_signal('warren_buffet', 'wb-sync:failure', 'task:wb-sync', c_alex);
    c := c || jsonb_build_object('service_role_resolves_for_user', v_out -> 'resolved' ? c_subj);

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
