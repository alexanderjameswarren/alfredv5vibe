-- notification_routing-d7v step 4: verify the dispatcher migration. Runs after the signals and dispatcher migrations,
-- with --test. It undoes itself: the inner block ends in its own error, the checks survive in a variable, and the
-- result row says { ok, failed, check_count, checks }. The clock is pinned 40 days ahead; fixtures are job nrd_test
-- with subjects nrd-*, and each scenario drops its queued fixtures before the next. Test plans supersede the active
-- plan, all rolled back.
-- supabase/tests/notification_routing-d7v/2_verify_dispatcher.sql

do $$
declare
  c_tz    constant text := 'America/Los_Angeles';
  c_done  constant text := 'NRD_UNDO';
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_day   date := (now() at time zone c_tz)::date + 40;
  v_at    timestamptz;
  v_p1    jsonb := '{
    "window": {"start": "05:00", "end": "19:00"},
    "pace": {"max_pops_per_hour": 2, "max_pops_per_day": 5, "min_gap_minutes": 0},
    "priority": {"severity_order": ["urgent", "high", "normal", "low"], "app_order": []},
    "defaults": {"low": "hold", "normal": "inbox", "high": "pop", "urgent": "pop"},
    "bundling": {"digest_severities": ["low"], "min_signals": 3},
    "escalation": [{"subject_key": "nrd-esc", "hold_repeats": 1, "inbox_repeats": 2}],
    "merge": {"into_open_inbox": true, "pop_merge_hours": 12},
    "watchers": []}';
  v_plan  jsonb;
  v_dec   jsonb;
  v_ids   uuid[];
  v_inbox text;
  v_inbox2 text;
  v_open  uuid;
  c       jsonb := '{}';
  v_result jsonb;
begin
  begin
    -- Catalog.
    c := c || (select jsonb_object_agg('fn_ok:' || f,
                 to_regprocedure(f) is not null
                 and has_function_privilege('authenticated', f, 'execute')
                 and has_function_privilege('service_role', f, 'execute')
                 and not has_function_privilege('anon', f, 'execute'))
                 from unnest(array[
                   'public.overwatch_delivery_whole(jsonb,integer,integer,boolean)',
                   'public.overwatch_delivery_problem(jsonb)',
                   'public.dispatch_signals(timestamptz)'
                 ]) f);
    c := c || jsonb_build_object('plan_constraint', exists (select 1 from pg_constraint
      where conrelid = 'public.overwatch_plans'::regclass and conname = 'overwatch_plans_delivery_valid'));

    -- The seed: the active plan's delivery copies the notification settings.
    c := c || jsonb_build_object('seed_copies_settings', exists (
      select 1 from public.overwatch_plans p join public.claude_notification_settings s on s.user_id = p.user_id
       where p.user_id = c_alex and p.active
         and p.settings -> 'delivery' -> 'window' ->> 'start' = s.window_start
         and p.settings -> 'delivery' -> 'window' ->> 'end' = s.window_end
         and (p.settings -> 'delivery' -> 'pace' ->> 'max_pops_per_hour')::int = s.max_per_hour
         and (p.settings -> 'delivery' -> 'pace' -> 'max_pops_per_day') = coalesce(to_jsonb(s.max_per_day), 'null'::jsonb)
         and p.settings -> 'delivery' -> 'watchers' = s.apps
         and public.overwatch_delivery_problem(p.settings -> 'delivery') is null));

    -- Validator.
    c := c || jsonb_build_object(
      'valid_passes', public.overwatch_delivery_problem(v_p1) is null,
      'no_section_passes', public.overwatch_delivery_problem(null) is null,
      'unknown_key_refused', public.overwatch_delivery_problem(v_p1 || '{"colour": 1}') is not null,
      'reversed_window_refused', public.overwatch_delivery_problem(v_p1 || '{"window": {"start": "19:00", "end": "05:00"}}') is not null,
      'bad_time_refused', public.overwatch_delivery_problem(v_p1 || '{"window": {"start": "5am", "end": "19:00"}}') is not null,
      'hour_cap_refused', public.overwatch_delivery_problem(v_p1 || '{"pace": {"max_pops_per_hour": 25, "max_pops_per_day": null, "min_gap_minutes": 0}}') is not null,
      'text_cap_refused', public.overwatch_delivery_problem(v_p1 || '{"pace": {"max_pops_per_hour": "3", "max_pops_per_day": null, "min_gap_minutes": 0}}') is not null,
      'missing_gap_refused', public.overwatch_delivery_problem(v_p1 || '{"pace": {"max_pops_per_hour": 3, "max_pops_per_day": null}}') is not null,
      'fraction_refused', public.overwatch_delivery_problem(v_p1 || '{"pace": {"max_pops_per_hour": 1.5, "max_pops_per_day": null, "min_gap_minutes": 0}}') is not null,
      'severity_order_refused', public.overwatch_delivery_problem(v_p1 || '{"priority": {"severity_order": ["high", "low"], "app_order": []}}') is not null,
      'bad_default_refused', public.overwatch_delivery_problem(v_p1 || '{"defaults": {"low": "hold", "normal": "inbox", "high": "pop", "urgent": "shout"}}') is not null,
      'missing_default_refused', public.overwatch_delivery_problem(v_p1 || '{"defaults": {"low": "hold", "normal": "inbox", "high": "pop"}}') is not null,
      'bad_bundle_refused', public.overwatch_delivery_problem(v_p1 || '{"bundling": {"digest_severities": ["meh"], "min_signals": 3}}') is not null,
      'bad_escalation_refused', public.overwatch_delivery_problem(v_p1 || '{"escalation": [{"subject_key": "Bad Key", "hold_repeats": 1, "inbox_repeats": null}]}') is not null,
      'bad_repeats_refused', public.overwatch_delivery_problem(v_p1 || '{"escalation": [{"subject_key": "*", "hold_repeats": -1, "inbox_repeats": null}]}') is not null,
      'bad_merge_refused', public.overwatch_delivery_problem(v_p1 || '{"merge": {"into_open_inbox": "yes", "pop_merge_hours": 12}}') is not null,
      'bad_watchers_refused', public.overwatch_delivery_problem(v_p1 || '{"watchers": [{"app": "arnold"}]}') is not null,
      'wrong_shapes_message_not_error', public.overwatch_delivery_problem(v_p1 || '{"priority": 1, "defaults": []}') is not null);

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    begin
      perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1 || '{"defaults": 1}'), 'Test only.');
      c := c || '{"plan_with_bad_delivery_refused": false}';
    exception when others then c := c || jsonb_build_object('plan_with_bad_delivery_refused', sqlstate = '23514'); end;

    -- No delivery section: the dispatcher stops.
    perform public.create_overwatch_plan('TEST plan', '{}'::jsonb, 'Test only; rolled back.');
    v_plan := public.dispatch_signals((v_day + time '10:00') at time zone c_tz);
    c := c || jsonb_build_object('no_rules_stops', v_plan ? 'stopped' and jsonb_array_length(v_plan -> 'decisions') = 0);

    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1), 'Test only; rolled back.');

    -- A. Quiet hours.
    v_at := (v_day + time '04:30') at time zone c_tz;
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'high', 'nrd-quiet', 'T', 'chat', v_at - interval '10 minutes') returning id)
    select array_agg(id) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('quiet_hours_wait', v_dec -> v_ids[1]::text ->> 'decision' = 'wait'
                                                     and not (v_plan ->> 'in_window')::boolean);
    v_plan := public.dispatch_signals((v_day + time '19:00') at time zone c_tz);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('window_end_is_quiet', v_dec -> v_ids[1]::text ->> 'decision' = 'wait');
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- B. Defaults by severity.
    v_at := (v_day + time '10:00') at time zone c_tz;
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'low', 'nrd-def-low', 'T', 'chat', v_at - interval '30 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-def-normal', 'T', 'chat', v_at - interval '20 minutes'),
             ('alfred', 'nrd_test', 'high', 'nrd-def-high', 'T', 'chat', v_at - interval '10 minutes')
      returning id, severity)
    select array_agg(id order by array_position(array['low', 'normal', 'high'], severity)) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'low_holds', v_dec -> v_ids[1]::text ->> 'decision' = 'hold',
      'normal_inbox', v_dec -> v_ids[2]::text ->> 'decision' = 'inbox',
      'high_pops', v_dec -> v_ids[3]::text ->> 'decision' = 'pop',
      'priority_order_high_first', v_plan -> 'decisions' -> 0 ->> 'signal_id' = v_ids[3]::text,
      'writes_nothing', not exists (select 1 from public.signals where id = any (v_ids) and state <> 'queued'));
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- C. Escalation, by prefix rule nrd-esc, counting since the last resolved.
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, created_at) values
      ('alfred', 'nrd_test', 'low', 'nrd-esc:x', 'T', 'chat', 'held', v_at - interval '2 days'),
      ('alfred', 'nrd_test', 'low', 'nrd-esc:y', 'T', 'chat', 'held', v_at - interval '2 days'),
      ('alfred', 'nrd_test', 'low', 'nrd-esc:y', 'T', 'chat', 'resolved', v_at - interval '1 day'),
      ('alfred', 'nrd_test', 'low', 'nrd-esc:z', 'T', 'chat', 'held', v_at - interval '3 days'),
      ('alfred', 'nrd_test', 'low', 'nrd-esc:z', 'T', 'chat', 'held', v_at - interval '2 days');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'low', 'nrd-esc:x', 'T', 'chat', v_at - interval '5 minutes'),
             ('alfred', 'nrd_test', 'low', 'nrd-esc:y', 'T', 'chat', v_at - interval '5 minutes'),
             ('alfred', 'nrd_test', 'low', 'nrd-esc:z', 'T', 'chat', v_at - interval '5 minutes')
      returning id, subject_key)
    select array_agg(id order by subject_key) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'second_in_a_row_becomes_inbox', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox'
                                       and (v_dec -> v_ids[1]::text ->> 'repeats')::int = 1,
      'resolved_resets_count', v_dec -> v_ids[2]::text ->> 'decision' = 'hold'
                               and (v_dec -> v_ids[2]::text ->> 'repeats')::int = 0,
      'inbox_escalates_to_pop', v_dec -> v_ids[3]::text ->> 'decision' = 'pop');
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- D. Merge: into an open inbox item, not an archived one; into a recent pop; within one run.
    v_inbox := gen_random_uuid()::text;
    v_inbox2 := gen_random_uuid()::text;
    insert into public.inbox (id, user_id, archived, triaged_at, captured_text, source_type, source_metadata, ai_status,
                              suggest_item, suggest_intent, suggest_event, suggested_tags, suggested_status)
    values (v_inbox, c_alex, false, null, 'TEST open', 'task', '{}'::jsonb, 'not_started', false, false, false,
            '{}', 'active'),
           (v_inbox2, c_alex, true, null, 'TEST archived', 'task', '{}'::jsonb, 'not_started', false, false, false,
            '{}', 'active');
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, outcome, inbox_id,
                                decided_at, created_at)
    values ('alfred', 'nrd_test', 'normal', 'nrd-merge:a', 'T', 'chat', 'delivered', 'inbox', v_inbox,
            v_at - interval '1 day', v_at - interval '1 day')
    returning id into v_open;
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, outcome, inbox_id,
                                decided_at, created_at) values
      ('alfred', 'nrd_test', 'normal', 'nrd-merge:b', 'T', 'chat', 'delivered', 'inbox', v_inbox2,
       v_at - interval '1 day', v_at - interval '1 day'),
      ('alfred', 'nrd_test', 'high', 'nrd-merge:c', 'T', 'chat', 'delivered', 'pop', null,
       v_at - interval '2 hours', v_at - interval '2 hours');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'normal', 'nrd-merge:a', 'T1', 'chat', v_at - interval '9 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-merge:b', 'T2', 'chat', v_at - interval '8 minutes'),
             ('alfred', 'nrd_test', 'high', 'nrd-merge:c', 'T3', 'chat', v_at - interval '7 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-merge:d', 'T4', 'chat', v_at - interval '6 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-merge:d', 'T5', 'chat', v_at - interval '5 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'merges_into_open_inbox', v_dec -> v_ids[1]::text ->> 'decision' = 'merge'
                                and v_dec -> v_ids[1]::text ->> 'inbox_id' = v_inbox
                                and v_dec -> v_ids[1]::text ->> 'merge_target_signal_id' = v_open::text,
      'archived_item_not_merged', v_dec -> v_ids[2]::text ->> 'decision' = 'inbox',
      'merges_into_recent_pop', v_dec -> v_ids[3]::text ->> 'decision' = 'merge',
      'first_of_run_delivered', v_dec -> v_ids[4]::text ->> 'decision' = 'inbox',
      'same_run_repeat_merged', v_dec -> v_ids[5]::text ->> 'decision' = 'merge'
                                and v_dec -> v_ids[5]::text ->> 'merge_target_signal_id' = v_ids[4]::text);
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- A pop older than pop_merge_hours is not merged into.
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, outcome, decided_at, created_at)
    values ('alfred', 'nrd_test', 'high', 'nrd-merge:e', 'T', 'chat', 'delivered', 'pop',
            v_at - interval '13 hours', v_at - interval '13 hours');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'high', 'nrd-merge:e', 'T', 'chat', v_at - interval '5 minutes') returning id)
    select array_agg(id) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('old_pop_not_merged', v_dec -> v_ids[1]::text ->> 'decision' = 'pop');
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- E. Bundling: three normal pops become one digest; two do not.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1
      || '{"defaults": {"low": "hold", "normal": "pop", "high": "pop", "urgent": "pop"},
           "bundling": {"digest_severities": ["normal"], "min_signals": 3},
           "pace": {"max_pops_per_hour": 5, "max_pops_per_day": null, "min_gap_minutes": 0}}'), 'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'normal', 'nrd-bun:1', 'T', 'chat', v_at - interval '9 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-bun:2', 'T', 'chat', v_at - interval '8 minutes'),
             ('alfred', 'nrd_test', 'normal', 'nrd-bun:3', 'T', 'chat', v_at - interval '7 minutes'),
             ('alfred', 'nrd_test', 'high', 'nrd-bun:h', 'T', 'chat', v_at - interval '6 minutes')
      returning id, subject_key)
    select array_agg(id order by subject_key) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'three_become_digest', (select bool_and(v_dec -> x::text ->> 'decision' = 'digest'
                                              and (v_dec -> x::text ->> 'bundle')::boolean) from unnest(v_ids[1:3]) x),
      'high_not_bundled', v_dec -> v_ids[4]::text ->> 'decision' = 'pop',
      'digest_counts_once', (v_plan -> 'pops' ->> 'hour_left_after')::int = 3);
    update public.signals set state = 'dropped' where id = v_ids[3];
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('two_are_not_bundled', v_dec -> v_ids[1]::text ->> 'decision' = 'pop');
    update public.signals set state = 'dropped' where job = 'nrd_test' and state = 'queued';

    -- F. Pace: the hourly cap, reminders not counted, the minimum gap.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1
      || '{"pace": {"max_pops_per_hour": 1, "max_pops_per_day": 5, "min_gap_minutes": 0}}'), 'Test only; rolled back.');
    insert into public.claude_notifications (app, job, kind, channel, title, dedupe_key, local_date, delivery_status,
                                             created_at)
    values ('alfred', 'reminder', 'info', 'alfred_push', 'T', 'nrd-test:reminder', v_day, 'sent',
            v_at - interval '20 minutes');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'high', 'nrd-cap:1', 'T', 'chat', v_at - interval '5 minutes') returning id)
    select array_agg(id) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('reminders_not_counted', v_dec -> v_ids[1]::text ->> 'decision' = 'pop');

    insert into public.claude_notifications (app, job, kind, channel, title, dedupe_key, local_date, delivery_status,
                                             created_at)
    -- At v_at itself: v_at is 10:00, so anything earlier falls in the previous clock hour.
    values ('alfred', 'nrd_test', 'flag', 'alfred_push', 'T', 'nrd-test:pop', v_day, 'sent', v_at);
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_test', 'urgent', 'nrd-cap:2', 'T', 'chat', v_at - interval '4 minutes') returning id)
    select v_ids || array_agg(id) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'hour_cap_high_becomes_inbox', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox',
      'hour_cap_urgent_waits', v_dec -> v_ids[2]::text ->> 'decision' = 'wait',
      'counts_pops_sent', (v_plan -> 'pops' ->> 'this_hour')::int = 1);
    v_plan := public.dispatch_signals(v_at + interval '1 hour');
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('next_hour_pops_again', v_dec -> v_ids[2]::text ->> 'decision' = 'pop');

    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1
      || '{"pace": {"max_pops_per_hour": 5, "max_pops_per_day": null, "min_gap_minutes": 30}}'), 'Test only; rolled back.');
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'min_gap_stops_pop', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox'
                           and v_dec -> v_ids[1]::text ->> 'reason' like '%minimum gap%');

    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_p1
      || '{"pace": {"max_pops_per_hour": 5, "max_pops_per_day": 1, "min_gap_minutes": 0}}'), 'Test only; rolled back.');
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('day_cap_stops_pop', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox'
                                                      and v_dec -> v_ids[1]::text ->> 'reason' like '%daily cap%');

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
