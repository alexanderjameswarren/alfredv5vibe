-- Purpose: notification routing step 4. The delivery section of Overwatch's plan (validator and check constraint),
-- dispatch_signals() (compute only: what the dispatcher would do with each queued signal now), and the delivery rules
-- seeded as a new Overwatch plan version from today's claude_notification_settings, so nothing changes for Arnold.
-- Kind: schema change (three functions, one check constraint) plus a data change (one new overwatch_plans row per user
-- with notification settings, superseding the active one, in a do block)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md sections 5 and 6. Needs 200_signals.sql first. Then run
-- supabase/tests/notification_routing-d7v/1_verify_signals.sql and 2_verify_dispatcher.sql with --test.
-- Safe to re-run: functions are create-or-replace, the constraint is dropped first, and the seed skips a user whose
-- active plan already has a delivery section.
-- supabase/migrations/201_dispatcher.sql

begin;

-- ============================================================================
-- 1. overwatch_delivery_problem — null when valid, else a plain message
-- ============================================================================
-- True when p is a whole JSON number from p_lo to p_hi, or JSON null when p_null_ok. A missing key is never valid.
create or replace function public.overwatch_delivery_whole(p jsonb, p_lo integer, p_hi integer, p_null_ok boolean)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p is null then false
    when jsonb_typeof(p) = 'null' then p_null_ok
    when jsonb_typeof(p) <> 'number' then false
    else (p::text)::numeric between p_lo and p_hi and (p::text)::numeric % 1 = 0
  end
$$;

comment on function public.overwatch_delivery_whole(jsonb, integer, integer, boolean) is
  'Overwatch: true when p is a whole JSON number from p_lo to p_hi, or JSON null when p_null_ok. Used by '
  'overwatch_delivery_problem.';
revoke all on function public.overwatch_delivery_whole(jsonb, integer, integer, boolean) from public, anon;
grant execute on function public.overwatch_delivery_whole(jsonb, integer, integer, boolean) to authenticated, service_role;

create or replace function public.overwatch_delivery_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c_sev  constant text[] := array['low', 'normal', 'high', 'urgent'];
  c_hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  v      jsonb;
  v_e    jsonb;
  v_key  text;
  v_problem text;
begin
  if p is null then return null; end if;   -- a plan without a delivery section is valid
  if jsonb_typeof(p) <> 'object' then return 'delivery must be an object.'; end if;
  for v_key in select jsonb_object_keys(p) loop
    if v_key <> all (array['window', 'pace', 'priority', 'defaults', 'bundling', 'escalation', 'merge', 'watchers']) then
      return format('delivery has an unknown key "%s".', v_key);
    end if;
  end loop;

  v := p -> 'window';
  if jsonb_typeof(v) is distinct from 'object' or coalesce(v ->> 'start', '') !~ c_hhmm
     or coalesce(v ->> 'end', '') !~ c_hhmm then
    return 'delivery.window must be {"start": "HH:MM", "end": "HH:MM"}, Pacific.';
  end if;
  if v ->> 'start' >= v ->> 'end' then return 'delivery.window.start must be before end.'; end if;

  v := p -> 'pace';
  if jsonb_typeof(v) is distinct from 'object' then
    return 'delivery.pace must be {"max_pops_per_hour", "max_pops_per_day", "min_gap_minutes"}.';
  end if;
  if not public.overwatch_delivery_whole(v -> 'max_pops_per_hour', 0, 24, false) then
    return 'delivery.pace.max_pops_per_hour must be a whole number from 0 to 24.';
  end if;
  if not public.overwatch_delivery_whole(v -> 'max_pops_per_day', 0, 200, true) then
    return 'delivery.pace.max_pops_per_day must be null (no daily cap) or a whole number from 0 to 200.';
  end if;
  if not public.overwatch_delivery_whole(v -> 'min_gap_minutes', 0, 240, false) then
    return 'delivery.pace.min_gap_minutes must be a whole number from 0 to 240.';
  end if;

  -- Each shape is checked before anything that would fail on the wrong one.
  v := p -> 'priority';
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'severity_order') is distinct from 'array'
     or jsonb_typeof(v -> 'app_order') is distinct from 'array' then
    return 'delivery.priority must be {"severity_order": [...], "app_order": [...]}.';
  end if;
  if (select array_agg(e #>> '{}' order by e #>> '{}') from jsonb_array_elements(v -> 'severity_order') e)
     is distinct from array['high', 'low', 'normal', 'urgent'] then
    return 'delivery.priority.severity_order must list low, normal, high and urgent once each.';
  end if;
  if exists (select 1 from jsonb_array_elements(v -> 'app_order') e where jsonb_typeof(e) <> 'string') then
    return 'delivery.priority.app_order must be a list of app ids.';
  end if;

  v := p -> 'defaults';
  if jsonb_typeof(v) is distinct from 'object' then
    return 'delivery.defaults must give low, normal, high and urgent each one of hold, inbox or pop.';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v) k) is distinct from array['high', 'low', 'normal', 'urgent']
     or exists (select 1 from jsonb_each(v) e where e.value not in ('"hold"', '"inbox"', '"pop"')) then
    return 'delivery.defaults must give low, normal, high and urgent each one of hold, inbox or pop.';
  end if;

  v := p -> 'bundling';
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'digest_severities') is distinct from 'array'
     or not public.overwatch_delivery_whole(v -> 'min_signals', 2, 20, false) then
    return 'delivery.bundling must be {"digest_severities": [severities], "min_signals": 2 to 20}.';
  end if;
  if exists (select 1 from jsonb_array_elements(v -> 'digest_severities') e
              where jsonb_typeof(e) <> 'string' or e #>> '{}' <> all (c_sev)) then
    return 'delivery.bundling.digest_severities must list only low, normal, high or urgent.';
  end if;

  v := p -> 'escalation';
  if jsonb_typeof(v) is distinct from 'array' then return 'delivery.escalation must be a list.'; end if;
  for v_e in select value from jsonb_array_elements(v) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e -> 'subject_key') is distinct from 'string'
       or (v_e ->> 'subject_key' <> '*' and v_e ->> 'subject_key' !~ '^[a-z0-9][a-z0-9:_.-]{0,199}$') then
      return 'each delivery.escalation entry needs a subject_key: a subject key, a prefix of one, or "*".';
    end if;
    for v_key in select unnest(array['hold_repeats', 'inbox_repeats']) loop
      if not public.overwatch_delivery_whole(v_e -> v_key, 0, 100, true) then
        return format('delivery.escalation %s: %s must be null (never) or a whole number from 0 to 100.',
                      v_e ->> 'subject_key', v_key);
      end if;
    end loop;
  end loop;

  v := p -> 'merge';
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'into_open_inbox') is distinct from 'boolean'
     or not public.overwatch_delivery_whole(v -> 'pop_merge_hours', 0, 168, false) then
    return 'delivery.merge must be {"into_open_inbox": true or false, "pop_merge_hours": a whole number 0 to 168}.';
  end if;

  -- Same shape as claude_notification_settings.apps, which watchers replaces.
  v_problem := public.claude_notification_settings_problem('05:00', '20:00', 0, null, p -> 'watchers');
  if v_problem is not null then return 'delivery.watchers: ' || v_problem; end if;

  return null;
end;
$$;

comment on function public.overwatch_delivery_problem(jsonb) is
  'Overwatch: null when p is a valid delivery section of an Overwatch plan (or null: no section), else a plain message. '
  'Keys: window, pace, priority, defaults, bundling, escalation, merge, watchers. Used by the overwatch_plans check '
  'constraint, so create_overwatch_plan refuses an invalid one.';
-- Functions in check constraints run with the inserting user's rights.
revoke all on function public.overwatch_delivery_problem(jsonb) from public, anon;
grant execute on function public.overwatch_delivery_problem(jsonb) to authenticated, service_role;

alter table public.overwatch_plans drop constraint if exists overwatch_plans_delivery_valid;
alter table public.overwatch_plans add constraint overwatch_plans_delivery_valid
  check (public.overwatch_delivery_problem(settings -> 'delivery') is null);


-- ============================================================================
-- 2. dispatch_signals — compute only. What the dispatcher would do now with each queued signal.
-- ============================================================================
-- Rules, in order: (1) quiet hours, (2) the severity's default, (3) escalation by repeats since the subject's last
-- resolved, (4) merge into an open inbox item or a recent pop, (5) bundling of low-priority pops into one digest,
-- (6) pace: pops past the caps or the gap wait (urgent) or become inbox items.
create or replace function public.dispatch_signals(p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  v_user    uuid := auth.uid();
  v_plan    uuid;
  v_d       jsonb;
  v_local   time;
  v_today   date;
  v_sev_order text[];
  v_app_order text[];
  v_hour_pops int;
  v_day_pops  int;
  v_last_pop  timestamptz;
  v_hour_left int;
  v_day_left  int;
  v_gap_ok    boolean;
  r           record;
  v_rule      jsonb;
  v_out       text;
  v_why       text;
  v_rep       int;
  v_resolved  timestamptz;
  v_open_sig  uuid;
  v_open_inbox text;
  v_pop_sig   uuid;
  v_first     int;
  v_n         int := 0;
  v_digest    int[] := '{}';
  v_unit      boolean;
  i           int;
  -- One slot per queued signal, in priority order.
  a_id     uuid[] := '{}';
  a_app    text[] := '{}';
  a_sev    text[] := '{}';
  a_subj   text[] := '{}';
  a_dec    text[] := '{}';
  a_why    text[] := '{}';
  a_rep    int[] := '{}';
  a_target uuid[] := '{}';
  a_inbox  text[] := '{}';
  a_bundle boolean[] := '{}';
  v_decisions jsonb := '[]';
begin
  if v_user is null then
    raise exception 'dispatch_signals: not authenticated.';
  end if;

  select id, settings -> 'delivery' into v_plan, v_d from overwatch_plans where user_id = v_user and active;
  if v_d is null then
    return jsonb_build_object('at', p_now, 'stopped', 'no delivery rules in the active Overwatch plan',
                              'plan_id', v_plan, 'decisions', '[]'::jsonb);
  end if;

  v_local := (p_now at time zone c_tz)::time;
  v_today := (p_now at time zone c_tz)::date;
  v_sev_order := array(select jsonb_array_elements_text(v_d -> 'priority' -> 'severity_order'));
  v_app_order := array(select jsonb_array_elements_text(v_d -> 'priority' -> 'app_order'));

  -- Pops already sent. Alex's own reminders and step timers always fire and are not counted.
  select count(*) filter (where created_at >= date_trunc('hour', p_now)),
         count(*) filter (where local_date = v_today),
         max(created_at)
    into v_hour_pops, v_day_pops, v_last_pop
    from claude_notifications
   where user_id = v_user and channel = 'alfred_push' and delivery_status in ('pending', 'sent')
     and job not in ('reminder', 'step_timer') and created_at <= p_now;
  v_hour_left := (v_d -> 'pace' ->> 'max_pops_per_hour')::int - v_hour_pops;
  v_day_left := coalesce((v_d -> 'pace' ->> 'max_pops_per_day')::int - v_day_pops, 1000000);
  v_gap_ok := v_last_pop is null
              or p_now >= v_last_pop + make_interval(mins => (v_d -> 'pace' ->> 'min_gap_minutes')::int);

  for r in
    select s.id, s.app, s.severity, s.subject_key, s.created_at
      from signals s
     where s.user_id = v_user and s.state = 'queued' and s.created_at <= p_now
     order by coalesce(array_position(v_sev_order, s.severity), 99),
              coalesce(array_position(v_app_order, s.app), 999),
              s.created_at, s.id
  loop
    v_n := v_n + 1;
    a_id := a_id || r.id; a_app := a_app || r.app; a_sev := a_sev || r.severity; a_subj := a_subj || r.subject_key;
    a_target := a_target || null::uuid; a_inbox := a_inbox || null::text; a_bundle := a_bundle || false;

    -- (1) Quiet hours.
    if not (v_local >= (v_d -> 'window' ->> 'start')::time and v_local < (v_d -> 'window' ->> 'end')::time) then
      a_dec := a_dec || 'wait'::text; a_rep := a_rep || 0;
      a_why := a_why || format('outside the window %s-%s', v_d -> 'window' ->> 'start', v_d -> 'window' ->> 'end');
      continue;
    end if;

    -- An earlier signal for the same subject in this run that will be delivered takes this one with it.
    v_first := null;
    for i in 1 .. v_n - 1 loop
      if a_subj[i] = r.subject_key and a_dec[i] in ('inbox', 'pop') then v_first := i; exit; end if;
    end loop;
    if v_first is not null then
      a_dec := a_dec || 'merge'::text; a_rep := a_rep || 0;
      a_target[v_n] := a_id[v_first]; a_inbox[v_n] := a_inbox[v_first];
      a_why := a_why || 'same subject as another signal delivered in this run';
      continue;
    end if;

    -- (2) The severity's default.
    v_out := v_d -> 'defaults' ->> r.severity;
    v_why := format('%s signals default to %s', r.severity, v_out);

    -- (3) Escalation: earlier held or delivered signals for the subject since it was last resolved, this run's
    -- held ones included. The first rule whose subject_key matches (exact, a prefix before ":", or "*") applies.
    select max(created_at) into v_resolved from signals
     where user_id = v_user and subject_key = r.subject_key and state = 'resolved' and created_at <= p_now;
    select count(*) into v_rep from signals
     where user_id = v_user and subject_key = r.subject_key and id <> r.id
       and state in ('held', 'delivered', 'merged') and created_at <= p_now
       and created_at > coalesce(v_resolved, '-infinity'::timestamptz);
    for i in 1 .. v_n - 1 loop
      if a_subj[i] = r.subject_key and a_dec[i] = 'hold' then v_rep := v_rep + 1; end if;
    end loop;
    v_rule := null;
    select e.value into v_rule from jsonb_array_elements(v_d -> 'escalation') with ordinality e(value, ord)
     where e.value ->> 'subject_key' = '*' or e.value ->> 'subject_key' = r.subject_key
        or starts_with(r.subject_key, (e.value ->> 'subject_key') || ':')
     order by e.ord limit 1;
    if v_out = 'hold' and v_rule ->> 'hold_repeats' is not null and v_rep >= (v_rule ->> 'hold_repeats')::int then
      v_out := 'inbox';
      v_why := format('escalated to inbox: %s earlier since last resolved (rule %s)', v_rep, v_rule ->> 'subject_key');
    end if;
    if v_out = 'inbox' and v_rule ->> 'inbox_repeats' is not null and v_rep >= (v_rule ->> 'inbox_repeats')::int then
      v_out := 'pop';
      v_why := format('escalated to pop: %s earlier since last resolved (rule %s)', v_rep, v_rule ->> 'subject_key');
    end if;

    -- (4) Merge into an open inbox item for the subject, or a recent pop of it.
    if v_out in ('inbox', 'pop') then
      v_open_sig := null; v_open_inbox := null; v_pop_sig := null;
      select s.id, s.inbox_id into v_open_sig, v_open_inbox
        from signals s join inbox i on i.id = s.inbox_id
       where s.user_id = v_user and s.subject_key = r.subject_key and s.state = 'delivered'
         and coalesce(i.archived, false) = false
       order by s.decided_at desc nulls last limit 1;
      if v_open_inbox is not null and (v_d -> 'merge' ->> 'into_open_inbox')::boolean then
        a_target[v_n] := v_open_sig; a_inbox[v_n] := v_open_inbox;
        if v_out = 'inbox' then
          v_out := 'merge';
          v_why := v_why || '; merged into the open inbox item';
        else
          v_why := v_why || '; the pop points at the open inbox item';
        end if;
      elsif v_out = 'pop' then
        select s.id into v_pop_sig from signals s
         where s.user_id = v_user and s.subject_key = r.subject_key and s.state = 'delivered' and s.outcome = 'pop'
           and s.decided_at >= p_now - make_interval(hours => (v_d -> 'merge' ->> 'pop_merge_hours')::int)
         order by s.decided_at desc limit 1;
        if v_pop_sig is not null then
          v_out := 'merge'; a_target[v_n] := v_pop_sig;
          v_why := v_why || format('; popped within %s hours, merged', v_d -> 'merge' ->> 'pop_merge_hours');
        end if;
      end if;
    end if;

    a_dec := a_dec || v_out; a_why := a_why || v_why; a_rep := a_rep || v_rep;
  end loop;

  -- (5) Bundling: enough low-priority pops in one run become one digest pop.
  select array_agg(i order by i) into v_digest from generate_subscripts(a_id, 1) i
   where a_dec[i] = 'pop' and a_inbox[i] is null
     and a_sev[i] in (select jsonb_array_elements_text(v_d -> 'bundling' -> 'digest_severities'));
  if coalesce(array_length(v_digest, 1), 0) >= (v_d -> 'bundling' ->> 'min_signals')::int then
    foreach i in array v_digest loop
      a_dec[i] := 'digest'; a_bundle[i] := true;
      a_why[i] := a_why[i] || format('; bundled with %s others into one digest', array_length(v_digest, 1) - 1);
    end loop;
  else
    v_digest := '{}';
  end if;

  -- (6) Pace. Each pop, and the digest as a whole, is one unit, in priority order.
  v_unit := false;   -- whether the digest has been paced yet
  for i in 1 .. v_n loop
    if a_dec[i] = 'pop' or (a_dec[i] = 'digest' and not v_unit) then
      if v_gap_ok and v_hour_left > 0 and v_day_left > 0 then
        v_hour_left := v_hour_left - 1; v_day_left := v_day_left - 1;
        if a_dec[i] = 'digest' then v_unit := true; end if;
      elsif a_dec[i] = 'digest' then
        foreach v_first in array v_digest loop
          a_dec[v_first] := 'inbox'; a_bundle[v_first] := false;
          a_why[v_first] := a_why[v_first] || '; the digest is held back by pace, so each becomes an inbox item';
        end loop;
        v_unit := true;
      else
        v_why := case when not v_gap_ok then 'the minimum gap since the last pop'
                      when v_hour_left <= 0 then 'the hourly cap' else 'the daily cap' end;
        if a_sev[i] = 'urgent' then
          a_dec[i] := 'wait'; a_why[i] := a_why[i] || '; waits for ' || v_why;
        elsif a_inbox[i] is not null then
          a_dec[i] := 'merge'; a_why[i] := a_why[i] || '; ' || v_why || ' stops the pop, merged into the open item';
        else
          a_dec[i] := 'inbox'; a_why[i] := a_why[i] || '; ' || v_why || ' stops the pop, an inbox item instead';
        end if;
      end if;
    end if;
  end loop;

  for i in 1 .. v_n loop
    v_decisions := v_decisions || jsonb_build_object(
      'signal_id', a_id[i], 'app', a_app[i], 'severity', a_sev[i], 'subject_key', a_subj[i],
      'decision', a_dec[i], 'reason', a_why[i], 'repeats', a_rep[i],
      'merge_target_signal_id', a_target[i], 'inbox_id', a_inbox[i], 'bundle', a_bundle[i]);
  end loop;

  return jsonb_build_object(
    'at', p_now, 'local_time', to_char(v_local, 'HH24:MI'), 'local_date', v_today, 'plan_id', v_plan,
    'in_window', v_local >= (v_d -> 'window' ->> 'start')::time and v_local < (v_d -> 'window' ->> 'end')::time,
    'pops', jsonb_build_object('this_hour', v_hour_pops, 'today', v_day_pops, 'last_at', v_last_pop,
                               'hour_left_after', greatest(v_hour_left, 0),
                               'day_left_after', case when v_d -> 'pace' ->> 'max_pops_per_day' is null then null
                                                      else greatest(v_day_left, 0) end),
    'decisions', v_decisions);
end;
$$;

comment on function public.dispatch_signals(timestamptz) is
  'Shared: compute only, writes nothing. For each of the caller''s queued signals, what the dispatcher would do at '
  'p_now under the delivery rules in the active Overwatch plan: wait, hold, inbox, pop, merge or digest, with the '
  'reason, the repeat count, and the signal or inbox item it merges into. Pops counted against the caps exclude '
  'Alex''s own reminders and step timers. Called by the get_dispatch_plan and deliver_signals tools.';
revoke all on function public.dispatch_signals(timestamptz) from public, anon;
grant execute on function public.dispatch_signals(timestamptz) to authenticated, service_role;


-- ============================================================================
-- 3. Seed: the delivery rules as a new Overwatch plan version, from today's claude_notification_settings
-- ============================================================================
-- Window, caps and watched apps are copied unchanged, and there is no minimum gap, so Arnold's pushes behave as now.
do $$
declare
  s     record;
  v_old public.overwatch_plans%rowtype;
begin
  for s in select * from public.claude_notification_settings loop
    select * into v_old from public.overwatch_plans where user_id = s.user_id and active for update;
    if v_old.id is null or v_old.settings ? 'delivery' then continue; end if;
    update public.overwatch_plans set active = false where id = v_old.id;
    insert into public.overwatch_plans (user_id, active, instructions, settings, checks_next_run, written_by, reason,
                                        supersedes_id)
    values (s.user_id, true, v_old.instructions,
      v_old.settings || jsonb_build_object('delivery', jsonb_build_object(
        'window', jsonb_build_object('start', s.window_start, 'end', s.window_end),
        'pace', jsonb_build_object('max_pops_per_hour', s.max_per_hour, 'max_pops_per_day', s.max_per_day,
                                   'min_gap_minutes', 0),
        'priority', jsonb_build_object('severity_order', '["urgent", "high", "normal", "low"]'::jsonb,
                                       'app_order', '["alfred", "arnold", "warren_buffet", "overwatch"]'::jsonb),
        'defaults', '{"low": "hold", "normal": "inbox", "high": "pop", "urgent": "pop"}'::jsonb,
        'bundling', '{"digest_severities": ["low", "normal"], "min_signals": 3}'::jsonb,
        'escalation', '[{"subject_key": "wb-sync:failure", "hold_repeats": 1, "inbox_repeats": 3},
                        {"subject_key": "*", "hold_repeats": 2, "inbox_repeats": null}]'::jsonb,
        'merge', '{"into_open_inbox": true, "pop_merge_hours": 12}'::jsonb,
        'watchers', s.apps)),
      v_old.checks_next_run, 'overwatch',
      'Notification routing step 4: add the delivery rules, copied from the Claude notification settings.', v_old.id);
  end loop;
end
$$;

commit;

-- ============================================================================
-- 4. Result: must say CONFORMANT. Then run supabase/tests/notification_routing-d7v/1_verify_signals.sql and
--    2_verify_dispatcher.sql with --test.
-- ============================================================================
select public.platform_check_conformance() as conformance;
