-- notification_routing-d7v step 10e: verify delivery overrides, their guardrails, and inbox at any hour. Runs after
-- the dispatch overrides migration, with --test. It undoes itself: the inner block ends in its own error, the checks
-- survive in a variable, and the result row says { ok, failed, check_count, checks }. The clock is pinned 40 days
-- ahead; fixtures are job nrd_ov with subjects nrd-ov-*, and each scenario drops its queued fixtures before the next.
-- Test plans supersede the active plan, all rolled back.
-- supabase/tests/notification_routing-d7v/6_dispatch_overrides_verify.sql

do $$
declare
  c_tz    constant text := 'America/Los_Angeles';
  c_done  constant text := 'NRD_UNDO';
  c_alex  constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  v_day   date := (now() at time zone c_tz)::date + 40;
  v_at    timestamptz := (v_day + time '10:00') at time zone c_tz;
  v_early timestamptz := (v_day + time '04:30') at time zone c_tz;
  v_dow   text := (array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[extract(isodow from v_day)::int];
  v_other text := (array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[extract(isodow from v_day + 1)::int];
  v_base  jsonb := '{
    "window": {"start": "05:00", "end": "19:00"},
    "pace": {"max_pops_per_hour": 5, "max_pops_per_day": null, "min_gap_minutes": 0},
    "priority": {"severity_order": ["urgent", "high", "normal", "low"], "app_order": []},
    "defaults": {"low": "hold", "normal": "inbox", "high": "pop", "urgent": "pop"},
    "bundling": {"digest_severities": ["low"], "min_signals": 3},
    "escalation": [],
    "merge": {"into_open_inbox": true, "pop_merge_hours": 12},
    "watchers": []}';
  v_made  jsonb;   -- created_at and ends_at that pass the 14-day guardrail
  v_hold  jsonb;
  v_plan  jsonb;
  v_dec   jsonb;
  v_ids   uuid[];
  v_inbox text;
  v_sig   uuid;
  c       jsonb := '{}';
  v_result jsonb;
begin
  begin
    v_made := jsonb_build_object('created_at', to_jsonb(v_at - interval '1 day'));
    v_hold := v_made || jsonb_build_object('label', 'Mute DJ', 'match', '{"app": "dj"}'::jsonb,
      'when', jsonb_build_object('ends_at', to_jsonb(v_at + interval '1 day')), 'effect', '{"decision": "hold"}'::jsonb);

    -- Catalog.
    c := c || (select jsonb_object_agg('fn_ok:' || f,
                 to_regprocedure(f) is not null
                 and has_function_privilege('authenticated', f, 'execute')
                 and has_function_privilege('service_role', f, 'execute')
                 and not has_function_privilege('anon', f, 'execute'))
                 from unnest(array[
                   'public.overwatch_override_problem(jsonb,integer)',
                   'public.overwatch_override_applies(jsonb,timestamptz,text,text,text,text,text,text)',
                   'public.overwatch_delivery_problem(jsonb)',
                   'public.dispatch_signals(timestamptz)'
                 ]) f);

    -- Validator and guardrails.
    c := c || jsonb_build_object(
      'no_overrides_valid', public.overwatch_delivery_problem(v_base) is null,
      'empty_list_valid', public.overwatch_delivery_problem(v_base || '{"overrides": []}') is null,
      'hold_with_end_valid', public.overwatch_delivery_problem(v_base || jsonb_build_object('overrides', jsonb_build_array(v_hold))) is null,
      'day_all_valid', public.overwatch_delivery_problem(v_base || '{"pace": {"max_pops_per_hour": 5, "max_pops_per_day": null, "min_gap_minutes": 0, "max_per_day_all": 10}}') is null,
      'day_all_bad_refused', public.overwatch_delivery_problem(v_base || '{"pace": {"max_pops_per_hour": 5, "max_pops_per_day": null, "min_gap_minutes": 0, "max_per_day_all": "ten"}}') is not null,
      'not_a_list_refused', public.overwatch_delivery_problem(v_base || '{"overrides": {}}') is not null,
      'hold_without_end_refused', public.overwatch_override_problem(v_hold #- '{when,ends_at}', 1) like '%must end%',
      'hold_over_14_days_refused', public.overwatch_override_problem(jsonb_set(v_hold, '{when,ends_at}',
                                     to_jsonb(v_at + interval '14 days')), 1) like '%more than 14 days%',
      'hold_without_created_refused', public.overwatch_override_problem(v_hold - 'created_at', 1) like '%needs created_at%',
      'drop_everything_refused', public.overwatch_override_problem(jsonb_set(v_hold - 'match', '{effect,decision}', '"drop"'), 1)
                                   like '%confirm_broad%',
      'confirm_broad_accepted', public.overwatch_override_problem(jsonb_set(v_hold - 'match', '{effect,decision}', '"drop"')
                                   || '{"confirm_broad": true}', 1) is null,
      'broad_inbox_needs_no_confirm', public.overwatch_override_problem('{"label": "All inbox", "effect": {"decision": "inbox"}}', 1) is null,
      'unknown_key_refused', public.overwatch_override_problem(v_hold || '{"colour": 1}', 1) like '%unknown key "colour"%',
      'unknown_effect_refused', public.overwatch_override_problem('{"label": "x", "effect": {"shout": true}}', 1) like '%unknown key "shout"%',
      'unknown_match_refused', public.overwatch_override_problem('{"label": "x", "match": {"colour": "red"}, "effect": {"decision": "inbox"}}', 1) is not null,
      'no_label_refused', public.overwatch_override_problem('{"effect": {"decision": "inbox"}}', 1) like '%needs a label%',
      'no_effect_refused', public.overwatch_override_problem('{"label": "x"}', 1) like '%needs an effect%',
      'time_from_alone_refused', public.overwatch_override_problem('{"label": "x", "when": {"time_from": "09:00"}, "effect": {"decision": "inbox"}}', 1) like '%go together%',
      'bad_time_refused', public.overwatch_override_problem('{"label": "x", "when": {"time_from": "9am", "time_to": "10:00"}, "effect": {"decision": "inbox"}}', 1) is not null,
      'bad_day_refused', public.overwatch_override_problem('{"label": "x", "when": {"days_of_week": ["monday"]}, "effect": {"decision": "inbox"}}', 1) is not null,
      'bad_severity_refused', public.overwatch_override_problem('{"label": "x", "match": {"severity": ["loud"]}, "effect": {"decision": "inbox"}}', 1) is not null,
      'bad_kind_refused', public.overwatch_override_problem('{"label": "x", "match": {"kind": ["alarm"]}, "effect": {"decision": "inbox"}}', 1) is not null,
      'bad_decision_refused', public.overwatch_override_problem('{"label": "x", "effect": {"decision": "pop"}}', 1) is not null,
      'bad_shift_refused', public.overwatch_override_problem('{"label": "x", "effect": {"severity": 2}}', 1) is not null,
      'bad_prefix_refused', public.overwatch_override_problem('{"label": "x", "match": {"subject_key": "DJ*"}, "effect": {"decision": "inbox"}}', 1) is not null,
      'bad_timestamp_refused', public.overwatch_override_problem('{"label": "x", "when": {"ends_at": "tomorrow"}, "effect": {"decision": "inbox"}}', 1) is not null,
      'window_both_refused', public.overwatch_override_problem('{"label": "x", "effect": {"window": {"ignore": true, "start": "05:00", "end": "06:00"}}}', 1) is not null,
      'bad_pace_refused', public.overwatch_override_problem('{"label": "x", "effect": {"pace": {"max_per_hour": 30}}}', 1) is not null,
      'same_label_refused', public.overwatch_delivery_problem(v_base || jsonb_build_object('overrides',
                              jsonb_build_array(v_hold, v_hold))) like '%same label%',
      'message_is_plain', public.overwatch_override_problem(v_hold #- '{when,ends_at}', 1)
                            = 'Override 1 (''Mute DJ'') holds signals, so it must end: give when.ends_at, at most 14 days after created_at.');

    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    begin
      perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base
        || jsonb_build_object('overrides', jsonb_build_array(v_hold #- '{when,ends_at}'))), 'Test only.');
      c := c || '{"plan_with_bad_override_refused": false}';
    exception when others then c := c || jsonb_build_object('plan_with_bad_override_refused', sqlstate = '23514'); end;

    -- A. No overrides: the defaults, word for word.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base), 'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_ov', 'low', 'nrd-ov-a:1', 'A1', 'chat', v_early - interval '30 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-a:2', 'A2', 'chat', v_early - interval '20 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-a:3', 'A3', 'chat', v_early - interval '10 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'none_low_holds', v_dec -> v_ids[1]::text ->> 'reason' = 'low signals default to hold'
                        and v_dec -> v_ids[1]::text ->> 'decision' = 'hold',
      'none_normal_inbox', v_dec -> v_ids[2]::text ->> 'reason' = 'normal signals default to inbox',
      'none_high_pops', v_dec -> v_ids[3]::text ->> 'decision' = 'pop'
                        and v_dec -> v_ids[3]::text ->> 'reason' = 'high signals default to pop',
      'none_no_labels', v_dec -> v_ids[3]::text -> 'overrides' = '[]'::jsonb);

    -- B. Outside the window: inbox and hold are decided now; only the notification waits.
    v_plan := public.dispatch_signals(v_early);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'early_low_holds', v_dec -> v_ids[1]::text ->> 'decision' = 'hold',
      'early_normal_inbox', v_dec -> v_ids[2]::text ->> 'decision' = 'inbox',
      'early_high_waits', v_dec -> v_ids[3]::text ->> 'decision' = 'wait'
                          and v_dec -> v_ids[3]::text ->> 'reason' = 'outside the window 05:00-19:00');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- C. Decision by app, a severity shift and set, later wins, drop, kind failure.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base || jsonb_build_object('overrides',
      jsonb_build_array(
        '{"label": "DJ is too chatty", "match": {"app": "dj"}, "effect": {"decision": "inbox"}}'::jsonb,
        '{"label": "Ken up", "match": {"app": "ken", "subject_key": "nrd-ov-c:up"}, "effect": {"severity": 1}}'::jsonb,
        '{"label": "Ken low", "match": {"app": "ken", "subject_key": "nrd-ov-c:set"}, "effect": {"severity": "low"}}'::jsonb,
        '{"label": "Arnold notify", "match": {"app": "arnold"}, "effect": {"decision": "notify"}}'::jsonb,
        '{"label": "Arnold inbox", "match": {"app": "arnold", "severity": ["normal"]}, "effect": {"decision": "inbox"}}'::jsonb,
        v_made || jsonb_build_object('label', 'Drop SAM', 'match', '{"app": "sam"}'::jsonb,
          'when', jsonb_build_object('ends_at', to_jsonb(v_at + interval '1 day')), 'effect', '{"decision": "drop"}'::jsonb),
        '{"label": "Failures to inbox", "match": {"kind": ["failure"]}, "effect": {"decision": "inbox"}}'::jsonb))),
      'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, details, created_at)
      values ('dj', 'nrd_ov', 'high', 'nrd-ov-c:dj', 'C1', 'chat', '{}', v_at - interval '9 minutes'),
             ('ken', 'nrd_ov', 'normal', 'nrd-ov-c:up', 'C2', 'chat', '{}', v_at - interval '8 minutes'),
             ('ken', 'nrd_ov', 'normal', 'nrd-ov-c:set', 'C3', 'chat', '{}', v_at - interval '7 minutes'),
             ('arnold', 'nrd_ov', 'normal', 'nrd-ov-c:arn', 'C4', 'chat', '{}', v_at - interval '6 minutes'),
             ('sam', 'nrd_ov', 'high', 'nrd-ov-c:sam', 'C5', 'chat', '{}', v_at - interval '5 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-c:fail', 'C6', 'chat', '{"kind": "failure"}', v_at - interval '4 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-c:plain', 'C7', 'chat', '{}', v_at - interval '3 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'app_override_inbox', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox',
      'reason_names_override', v_dec -> v_ids[1]::text ->> 'reason' like '%override ''DJ is too chatty'': high to inbox%',
      'labels_listed', v_dec -> v_ids[1]::text -> 'overrides' = '["DJ is too chatty"]'::jsonb,
      'shift_up_pops', v_dec -> v_ids[2]::text ->> 'decision' = 'pop'
                       and v_dec -> v_ids[2]::text ->> 'severity' = 'high'
                       and v_dec -> v_ids[2]::text ->> 'reason' like '%override ''Ken up'': severity normal to high%',
      'set_low_holds', v_dec -> v_ids[3]::text ->> 'decision' = 'hold',
      'later_override_wins', v_dec -> v_ids[4]::text ->> 'decision' = 'inbox'
                             and v_dec -> v_ids[4]::text ->> 'reason' not like '%Arnold notify%',
      'drop_decided', v_dec -> v_ids[5]::text ->> 'decision' = 'drop',
      'failure_kind_matched', v_dec -> v_ids[6]::text ->> 'decision' = 'inbox'
                              and v_dec -> v_ids[6]::text ->> 'kind' = 'failure',
      'other_app_untouched', v_dec -> v_ids[7]::text ->> 'decision' = 'pop');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- D. When: expired, days of the week, time of day.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base || jsonb_build_object('overrides',
      jsonb_build_array(
        jsonb_build_object('label', 'Expired', 'created_at', to_jsonb(v_at - interval '3 days'),
          'match', '{"subject_key": "nrd-ov-d:exp"}'::jsonb,
          'when', jsonb_build_object('ends_at', to_jsonb(v_at - interval '1 hour')), 'effect', '{"decision": "hold"}'::jsonb),
        jsonb_build_object('label', 'Other day', 'match', '{"subject_key": "nrd-ov-d:day"}'::jsonb,
          'when', jsonb_build_object('days_of_week', jsonb_build_array(v_other)), 'effect', '{"decision": "notify"}'::jsonb),
        jsonb_build_object('label', 'Today', 'match', '{"subject_key": "nrd-ov-d:today"}'::jsonb,
          'when', jsonb_build_object('days_of_week', jsonb_build_array(v_dow)), 'effect', '{"decision": "notify"}'::jsonb),
        '{"label": "Afternoon", "match": {"subject_key": "nrd-ov-d:pm"}, "when": {"time_from": "13:00", "time_to": "17:00"}, "effect": {"decision": "notify"}}'::jsonb,
        '{"label": "Morning", "match": {"subject_key": "nrd-ov-d:am"}, "when": {"time_from": "09:00", "time_to": "11:00"}, "effect": {"decision": "notify"}}'::jsonb,
        '{"label": "Night", "match": {"subject_key": "nrd-ov-d:night"}, "when": {"time_from": "22:00", "time_to": "10:30"}, "effect": {"decision": "notify"}}'::jsonb))),
      'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:exp', 'D1', 'chat', v_at - interval '9 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:day', 'D2', 'chat', v_at - interval '8 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:today', 'D3', 'chat', v_at - interval '7 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:pm', 'D4', 'chat', v_at - interval '6 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:am', 'D5', 'chat', v_at - interval '5 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-d:night', 'D6', 'chat', v_at - interval '4 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'expired_ignored', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox'
                         and v_dec -> v_ids[1]::text -> 'overrides' = '[]'::jsonb,
      'other_day_ignored', v_dec -> v_ids[2]::text ->> 'decision' = 'inbox',
      'today_applies', v_dec -> v_ids[3]::text ->> 'decision' = 'pop',
      'outside_hours_ignored', v_dec -> v_ids[4]::text ->> 'decision' = 'inbox',
      'inside_hours_applies', v_dec -> v_ids[5]::text ->> 'decision' = 'pop',
      'overnight_hours_apply', v_dec -> v_ids[6]::text ->> 'decision' = 'pop');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- E. Pace: exempt from the plan's cap; an override's own hourly cap, past notifications counted.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base
      || '{"pace": {"max_pops_per_hour": 1, "max_pops_per_day": null, "min_gap_minutes": 0}}'::jsonb
      || jsonb_build_object('overrides', jsonb_build_array(
        '{"label": "Exempt", "match": {"subject_key": "nrd-ov-e:ex"}, "effect": {"pace": {"exempt": true}}}'::jsonb,
        '{"label": "One an hour", "match": {"subject_key": "nrd-ov-e:cap*"}, "effect": {"pace": {"exempt": true, "max_per_hour": 1}}}'::jsonb,
        '{"label": "Counted", "match": {"subject_key": "nrd-ov-e:hist"}, "effect": {"pace": {"exempt": true, "max_per_hour": 1}}}'::jsonb))),
      'Test only; rolled back.');
    insert into public.claude_notifications (app, job, kind, channel, title, dedupe_key, local_date, delivery_status, created_at)
    values ('alfred', 'nrd_ov', 'flag', 'alfred_push', 'T', 'nrd-ov:pop', v_day, 'sent', v_at);
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, outcome, decided_at, created_at)
    values ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:hist', 'Past', 'chat', 'delivered', 'pop', v_at, v_at - interval '1 hour')
    returning id into v_sig;
    insert into public.claude_notifications (app, job, kind, channel, title, dedupe_key, local_date, delivery_status,
                                             signal_id, created_at)
    values ('alfred', 'nrd_ov', 'flag', 'alfred_push', 'T', 'nrd-ov:hist', v_day, 'sent', v_sig, v_at);
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:plain', 'E1', 'chat', v_at - interval '9 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:ex', 'E2', 'chat', v_at - interval '8 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:cap1', 'E3', 'chat', v_at - interval '7 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:cap2', 'E4', 'chat', v_at - interval '6 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:hist', 'E5', 'chat', v_at - interval '5 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'plan_cap_still_applies', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox',
      'exempt_pops', v_dec -> v_ids[2]::text ->> 'decision' = 'pop',
      'own_cap_first_pops', v_dec -> v_ids[3]::text ->> 'decision' = 'pop',
      'own_cap_second_inbox', v_dec -> v_ids[4]::text ->> 'decision' = 'inbox'
                              and v_dec -> v_ids[4]::text ->> 'reason' like '%override ''One an hour'': its hourly cap%',
      'recent_pop_still_merges', v_dec -> v_ids[5]::text ->> 'decision' = 'merge');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- The past pop above merges a repeat of its subject within pop_merge_hours. With pop_merge_hours 0 and the clock
    -- at 10:30, it does not, and its notification at 10:00 still counts against the override's hourly cap.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base
      || '{"merge": {"into_open_inbox": true, "pop_merge_hours": 0}}'::jsonb
      || jsonb_build_object('overrides', jsonb_build_array(
        '{"label": "Counted", "match": {"subject_key": "nrd-ov-e:hist"}, "effect": {"pace": {"max_per_hour": 1}}}'::jsonb))),
      'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_ov', 'high', 'nrd-ov-e:hist', 'E6', 'chat', v_at - interval '2 minutes') returning id)
    select array_agg(id) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at + interval '30 minutes');
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('own_cap_counts_history', v_dec -> v_ids[1]::text ->> 'decision' = 'inbox'
                                   and v_dec -> v_ids[1]::text ->> 'reason' like '%override ''Counted'': its hourly cap%');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- F. Window: ignore it, or its own.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base || jsonb_build_object('overrides',
      jsonb_build_array(
        '{"label": "Any hour", "match": {"subject_key": "nrd-ov-f:any"}, "effect": {"window": {"ignore": true}}}'::jsonb,
        '{"label": "Early bird", "match": {"subject_key": "nrd-ov-f:own"}, "effect": {"window": {"start": "04:00", "end": "06:00"}}}'::jsonb))),
      'Test only; rolled back.');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, created_at)
      values ('alfred', 'nrd_ov', 'high', 'nrd-ov-f:any', 'F1', 'chat', v_early - interval '9 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-f:own', 'F2', 'chat', v_early - interval '8 minutes'),
             ('alfred', 'nrd_ov', 'high', 'nrd-ov-f:none', 'F3', 'chat', v_early - interval '7 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_early);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'window_ignore_pops', v_dec -> v_ids[1]::text ->> 'decision' = 'pop'
                            and v_dec -> v_ids[1]::text ->> 'reason' like '%override ''Any hour'': ignores the window%',
      'own_window_pops', v_dec -> v_ids[2]::text ->> 'decision' = 'pop',
      'plan_window_waits', v_dec -> v_ids[3]::text ->> 'decision' = 'wait');
    v_plan := public.dispatch_signals((v_day + time '07:00') at time zone c_tz);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('own_window_closes', v_dec -> v_ids[2]::text ->> 'decision' = 'wait'
                                   and v_dec -> v_ids[2]::text ->> 'reason' like 'outside the window 04:00-06:00%');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    -- G. Merge: into an open item as usual, failure kind included; merge false keeps one out.
    perform public.create_overwatch_plan('TEST plan', jsonb_build_object('delivery', v_base || jsonb_build_object('overrides',
      jsonb_build_array('{"label": "Separate", "match": {"subject_key": "nrd-ov-g:apart"}, "effect": {"merge": false}}'::jsonb))),
      'Test only; rolled back.');
    v_inbox := gen_random_uuid()::text;
    insert into public.inbox (id, user_id, archived, triaged_at, captured_text, source_type, source_metadata, ai_status,
                              suggest_item, suggest_intent, suggest_event, suggested_tags, suggested_status)
    values (v_inbox, c_alex, false, null, 'TEST open', 'task', '{}'::jsonb, 'not_started', false, false, false, '{}', 'active');
    insert into public.signals (app, job, severity, subject_key, title, started_by, state, outcome, inbox_id, decided_at, created_at)
    values ('alfred', 'nrd_ov', 'normal', 'nrd-ov-g:fail', 'T', 'chat', 'delivered', 'inbox', v_inbox, v_at - interval '1 day', v_at - interval '1 day'),
           ('alfred', 'nrd_ov', 'normal', 'nrd-ov-g:apart', 'T', 'chat', 'delivered', 'inbox', v_inbox, v_at - interval '1 day', v_at - interval '1 day');
    with ins as (
      insert into public.signals (app, job, severity, subject_key, title, started_by, details, created_at)
      values ('alfred', 'nrd_ov', 'normal', 'nrd-ov-g:fail', 'G1', 'chat', '{"kind": "failure"}', v_early - interval '9 minutes'),
             ('alfred', 'nrd_ov', 'normal', 'nrd-ov-g:apart', 'G2', 'chat', '{}', v_early - interval '8 minutes')
      returning id, title)
    select array_agg(id order by title) into v_ids from ins;
    v_plan := public.dispatch_signals(v_at);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object(
      'failure_merged_like_any', v_dec -> v_ids[1]::text ->> 'decision' = 'merge'
                                 and v_dec -> v_ids[1]::text ->> 'inbox_id' = v_inbox,
      'merge_false_new_item', v_dec -> v_ids[2]::text ->> 'decision' = 'inbox'
                              and v_dec -> v_ids[2]::text ->> 'inbox_id' is null);
    -- Merging is decided outside the window too.
    v_plan := public.dispatch_signals(v_early);
    v_dec := (select jsonb_object_agg(d ->> 'signal_id', d) from jsonb_array_elements(v_plan -> 'decisions') d);
    c := c || jsonb_build_object('merge_decided_early', v_dec -> v_ids[1]::text ->> 'decision' = 'merge');
    update public.signals set state = 'dropped' where job = 'nrd_ov' and state = 'queued';

    c := c || jsonb_build_object('writes_nothing', not exists (
      select 1 from public.signals where job = 'nrd_ov' and state not in ('dropped', 'delivered')));

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
