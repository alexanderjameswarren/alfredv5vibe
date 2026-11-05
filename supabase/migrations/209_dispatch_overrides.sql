-- Purpose: notification routing step 10e. Delivery overrides and the inbox-at-any-hour rule.
--   1. overwatch_override_problem(): validates one entry of delivery.overrides, with the guardrails: a hold or drop
--      must end within 14 days of created_at, and one that matches everything needs confirm_broad.
--   2. overwatch_override_applies(): whether an override matches a signal, and (given a time) is in force then.
--   3. overwatch_delivery_problem(): replaced to accept delivery.overrides and delivery.pace.max_per_day_all.
--   4. dispatch_signals(): replaced. Overrides apply in list order, a later one winning per setting. The window now
--      holds back only notifications (pop, digest): inbox, hold, merge and drop are decided at any hour.
--      With no overrides every existing decision is the same, except that outside the window a signal that is not
--      a notification is now decided instead of waiting.
-- Kind: schema change (two new functions, two replaced)
-- Applied: NO
--
-- Spec: docs/technical-spec-notification_routing-d7v.md sections 5 and 6. Then run
-- supabase/tests/notification_routing-d7v/6_dispatch_overrides_verify.sql and 2_verify_dispatcher.sql with --test.
-- Safe to re-run: create or replace.
-- supabase/migrations/209_dispatch_overrides.sql

begin;

-- ============================================================================
-- 1. overwatch_override_problem — null when one override is valid, else a plain message
-- ============================================================================
create or replace function public.overwatch_override_problem(o jsonb, n integer)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  c_sev    constant text[] := array['low', 'normal', 'high', 'urgent'];
  c_kinds  constant text[] := array['nudge', 'flag', 'info', 'encouragement', 'failure'];
  c_days   constant text[] := array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  c_hhmm   constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  c_ts     constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  c_key    constant text := '^[a-z0-9][a-z0-9:_.-]{0,199}$';
  c_prefix constant text := '^[a-z0-9][a-z0-9:_.-]{0,198}\*$';
  v_name    text;
  m         jsonb;
  w         jsonb;
  e         jsonb;
  v         jsonb;
  k         text;
  v_created timestamptz;
  v_starts  timestamptz;
  v_ends    timestamptz;
begin
  if jsonb_typeof(o) is distinct from 'object' then
    return format('delivery.overrides entry %s must be an object.', n);
  end if;
  if jsonb_typeof(o -> 'label') is distinct from 'string' or length(btrim(o ->> 'label')) not between 1 and 100 then
    return format('delivery.overrides entry %s needs a label: plain words, at most 100 characters.', n);
  end if;
  v_name := format('Override %s (''%s'')', n, o ->> 'label');
  for k in select jsonb_object_keys(o) loop
    if k <> all (array['label', 'reason', 'created_at', 'created_by', 'match', 'when', 'effect', 'confirm_broad']) then
      return format('%s has an unknown key "%s".', v_name, k);
    end if;
  end loop;
  if o ? 'reason' and (jsonb_typeof(o -> 'reason') <> 'string' or length(o ->> 'reason') > 500) then
    return format('%s: reason must be text, at most 500 characters.', v_name);
  end if;
  if o ? 'created_by' and (jsonb_typeof(o -> 'created_by') <> 'string' or length(btrim(o ->> 'created_by')) not between 1 and 100) then
    return format('%s: created_by must be text, at most 100 characters.', v_name);
  end if;
  if o ? 'confirm_broad' and jsonb_typeof(o -> 'confirm_broad') <> 'boolean' then
    return format('%s: confirm_broad must be true or false.', v_name);
  end if;
  if o ? 'created_at' then
    if jsonb_typeof(o -> 'created_at') <> 'string' or o ->> 'created_at' !~ c_ts then
      return format('%s: created_at must be a timestamp with its time zone, e.g. "2026-11-05T09:00:00-08:00".', v_name);
    end if;
    begin
      v_created := (o ->> 'created_at')::timestamptz;
    exception when others then
      return format('%s: created_at is not a real date and time.', v_name);
    end;
  end if;

  -- match: every field given must match; a missing one matches everything.
  m := coalesce(o -> 'match', '{}'::jsonb);
  if jsonb_typeof(m) <> 'object' then return format('%s: match must be an object.', v_name); end if;
  for k in select jsonb_object_keys(m) loop
    if k <> all (array['app', 'job', 'subject_key', 'severity', 'kind', 'started_by']) then
      return format('%s: match has an unknown key "%s". Use app, job, subject_key, severity, kind or started_by.', v_name, k);
    end if;
  end loop;
  for k in select unnest(array['app', 'job']) loop
    if m ? k and (jsonb_typeof(m -> k) <> 'string' or length(btrim(m ->> k)) not between 1 and 100) then
      return format('%s: match.%s must be text, at most 100 characters.', v_name, k);
    end if;
  end loop;
  if m ? 'started_by' and (jsonb_typeof(m -> 'started_by') <> 'string' or not public.started_by_valid(m ->> 'started_by')) then
    return format('%s: match.started_by must be alex, chat or task:<job>.', v_name);
  end if;
  if m ? 'subject_key' and (jsonb_typeof(m -> 'subject_key') <> 'string'
     or (m ->> 'subject_key' !~ c_key and m ->> 'subject_key' !~ c_prefix)) then
    return format('%s: match.subject_key must be a subject key, or the start of one ending in "*", e.g. "dj:*".', v_name);
  end if;
  if m ? 'severity' and (jsonb_typeof(m -> 'severity') <> 'array' or jsonb_array_length(m -> 'severity') = 0
     or exists (select 1 from jsonb_array_elements(m -> 'severity') x
                 where jsonb_typeof(x) <> 'string' or x #>> '{}' <> all (c_sev))) then
    return format('%s: match.severity must list one or more of low, normal, high, urgent.', v_name);
  end if;
  if m ? 'kind' and (jsonb_typeof(m -> 'kind') <> 'array' or jsonb_array_length(m -> 'kind') = 0
     or exists (select 1 from jsonb_array_elements(m -> 'kind') x
                 where jsonb_typeof(x) <> 'string' or x #>> '{}' <> all (c_kinds))) then
    return format('%s: match.kind must list one or more of nudge, flag, info, encouragement, failure.', v_name);
  end if;

  -- when: starts_at, ends_at, days_of_week, time_from and time_to (Pacific).
  w := coalesce(o -> 'when', '{}'::jsonb);
  if jsonb_typeof(w) <> 'object' then return format('%s: when must be an object.', v_name); end if;
  for k in select jsonb_object_keys(w) loop
    if k <> all (array['starts_at', 'ends_at', 'days_of_week', 'time_from', 'time_to']) then
      return format('%s: when has an unknown key "%s". Use starts_at, ends_at, days_of_week, time_from or time_to.', v_name, k);
    end if;
  end loop;
  for k in select unnest(array['starts_at', 'ends_at']) loop
    if w ? k then
      if jsonb_typeof(w -> k) <> 'string' or w ->> k !~ c_ts then
        return format('%s: when.%s must be a timestamp with its time zone, e.g. "2026-11-05T09:00:00-08:00".', v_name, k);
      end if;
      begin
        if k = 'starts_at' then v_starts := (w ->> k)::timestamptz; else v_ends := (w ->> k)::timestamptz; end if;
      exception when others then
        return format('%s: when.%s is not a real date and time.', v_name, k);
      end;
    end if;
  end loop;
  if v_starts is not null and v_ends is not null and v_starts >= v_ends then
    return format('%s: when.starts_at must be before ends_at.', v_name);
  end if;
  if w ? 'days_of_week' and (jsonb_typeof(w -> 'days_of_week') <> 'array' or jsonb_array_length(w -> 'days_of_week') = 0
     or exists (select 1 from jsonb_array_elements(w -> 'days_of_week') x
                 where jsonb_typeof(x) <> 'string' or x #>> '{}' <> all (c_days))) then
    return format('%s: when.days_of_week must list one or more of mon, tue, wed, thu, fri, sat, sun.', v_name);
  end if;
  if (w ? 'time_from') <> (w ? 'time_to') then
    return format('%s: when.time_from and when.time_to go together; give both or neither.', v_name);
  end if;
  if w ? 'time_from' then
    if coalesce(w ->> 'time_from', '') !~ c_hhmm or coalesce(w ->> 'time_to', '') !~ c_hhmm
       or jsonb_typeof(w -> 'time_from') <> 'string' or jsonb_typeof(w -> 'time_to') <> 'string' then
      return format('%s: when.time_from and when.time_to must be "HH:MM", Pacific.', v_name);
    end if;
    if w ->> 'time_from' = w ->> 'time_to' then
      return format('%s: when.time_from and when.time_to must differ.', v_name);
    end if;
  end if;

  -- effect: what changes for the signals it matches.
  e := o -> 'effect';
  if jsonb_typeof(e) is distinct from 'object' or e = '{}'::jsonb then
    return format('%s needs an effect: severity, decision, pace, window, bundle, merge or priority.', v_name);
  end if;
  for k in select jsonb_object_keys(e) loop
    if k <> all (array['severity', 'decision', 'pace', 'window', 'bundle', 'merge', 'priority']) then
      return format('%s: effect has an unknown key "%s". Use severity, decision, pace, window, bundle, merge or priority.', v_name, k);
    end if;
  end loop;
  if e ? 'severity' and not (
       (jsonb_typeof(e -> 'severity') = 'string' and e ->> 'severity' = any (c_sev))
       or (jsonb_typeof(e -> 'severity') = 'number' and e -> 'severity' in ('1'::jsonb, '-1'::jsonb))) then
    return format('%s: effect.severity must be low, normal, high or urgent, or 1 or -1 to move it one step.', v_name);
  end if;
  if e ? 'decision' and (jsonb_typeof(e -> 'decision') <> 'string' or e ->> 'decision' not in ('notify', 'inbox', 'hold', 'drop')) then
    return format('%s: effect.decision must be notify, inbox, hold or drop.', v_name);
  end if;
  if e ? 'pace' then
    v := e -> 'pace';
    if jsonb_typeof(v) <> 'object' or v = '{}'::jsonb then
      return format('%s: effect.pace must give exempt, max_per_hour, max_per_day or min_gap_minutes.', v_name);
    end if;
    for k in select jsonb_object_keys(v) loop
      if k <> all (array['exempt', 'max_per_hour', 'max_per_day', 'min_gap_minutes']) then
        return format('%s: effect.pace has an unknown key "%s".', v_name, k);
      end if;
    end loop;
    if v ? 'exempt' and jsonb_typeof(v -> 'exempt') <> 'boolean' then
      return format('%s: effect.pace.exempt must be true or false.', v_name);
    end if;
    if v ? 'max_per_hour' and not public.overwatch_delivery_whole(v -> 'max_per_hour', 0, 24, false) then
      return format('%s: effect.pace.max_per_hour must be a whole number from 0 to 24.', v_name);
    end if;
    if v ? 'max_per_day' and not public.overwatch_delivery_whole(v -> 'max_per_day', 0, 200, false) then
      return format('%s: effect.pace.max_per_day must be a whole number from 0 to 200.', v_name);
    end if;
    if v ? 'min_gap_minutes' and not public.overwatch_delivery_whole(v -> 'min_gap_minutes', 0, 240, false) then
      return format('%s: effect.pace.min_gap_minutes must be a whole number from 0 to 240.', v_name);
    end if;
  end if;
  if e ? 'window' then
    v := e -> 'window';
    if jsonb_typeof(v) <> 'object' then
      return format('%s: effect.window must be {"ignore": true} or {"start": "HH:MM", "end": "HH:MM"}.', v_name);
    end if;
    if v ? 'ignore' then
      if jsonb_typeof(v -> 'ignore') <> 'boolean' or (select count(*) from jsonb_object_keys(v)) <> 1 then
        return format('%s: effect.window must be {"ignore": true} or {"start": "HH:MM", "end": "HH:MM"}, not both.', v_name);
      end if;
    elsif (select array_agg(x order by x) from jsonb_object_keys(v) x) is distinct from array['end', 'start']
          or jsonb_typeof(v -> 'start') <> 'string' or jsonb_typeof(v -> 'end') <> 'string'
          or v ->> 'start' !~ c_hhmm or v ->> 'end' !~ c_hhmm then
      return format('%s: effect.window must be {"ignore": true} or {"start": "HH:MM", "end": "HH:MM"}.', v_name);
    elsif v ->> 'start' >= v ->> 'end' then
      return format('%s: effect.window.start must be before end.', v_name);
    end if;
  end if;
  if e ? 'bundle' and (jsonb_typeof(e -> 'bundle') <> 'string' or e ->> 'bundle' not in ('never', 'always')) then
    return format('%s: effect.bundle must be never or always.', v_name);
  end if;
  if e ? 'merge' and jsonb_typeof(e -> 'merge') <> 'boolean' then
    return format('%s: effect.merge must be true or false.', v_name);
  end if;
  if e ? 'priority' and (jsonb_typeof(e -> 'priority') <> 'string' or e ->> 'priority' not in ('before', 'after')) then
    return format('%s: effect.priority must be before or after.', v_name);
  end if;

  -- Guardrails: a hold or drop always ends, within 14 days, and one that matches everything must say so.
  if e ->> 'decision' in ('hold', 'drop') then
    if v_ends is null then
      return format('%s %ss signals, so it must end: give when.ends_at, at most 14 days after created_at.',
                    v_name, e ->> 'decision');
    end if;
    if v_created is null then
      return format('%s %ss signals, so it needs created_at, to check that it ends within 14 days.',
                    v_name, e ->> 'decision');
    end if;
    if v_ends > v_created + interval '14 days' then
      return format('%s %ss signals for more than 14 days: when.ends_at must be at most 14 days after created_at.',
                    v_name, e ->> 'decision');
    end if;
    if m = '{}'::jsonb and coalesce((o ->> 'confirm_broad')::boolean, false) is false then
      return format('%s would %s every signal: it matches nothing in particular. Set confirm_broad to true if that is meant.',
                    v_name, e ->> 'decision');
    end if;
  end if;
  return null;
end;
$$;

comment on function public.overwatch_override_problem(jsonb, integer) is
  'Overwatch: null when o is a valid entry n of delivery.overrides, else a plain message. A hold or drop override '
  'must have when.ends_at at most 14 days after created_at, and one with no match fields needs confirm_broad. Used by '
  'overwatch_delivery_problem.';
revoke all on function public.overwatch_override_problem(jsonb, integer) from public, anon;
grant execute on function public.overwatch_override_problem(jsonb, integer) to authenticated, service_role;


-- ============================================================================
-- 2. overwatch_override_applies — does an override match a signal, and is it in force at p_at
-- ============================================================================
-- p_at null checks the match only: the dispatcher uses that to count past notifications against an override's caps.
create or replace function public.overwatch_override_applies(
  o jsonb, p_at timestamptz, p_app text, p_job text, p_subject_key text, p_severity text, p_kind text, p_started_by text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  m       jsonb := coalesce(o -> 'match', '{}'::jsonb);
  w       jsonb := coalesce(o -> 'when', '{}'::jsonb);
  v_local timestamp;
  v_t     time;
  v_from  time;
  v_to    time;
begin
  if m ? 'app' and m ->> 'app' is distinct from p_app then return false; end if;
  if m ? 'job' and m ->> 'job' is distinct from p_job then return false; end if;
  if m ? 'started_by' and m ->> 'started_by' is distinct from p_started_by then return false; end if;
  if m ? 'subject_key' then
    if right(m ->> 'subject_key', 1) = '*' then
      if not starts_with(coalesce(p_subject_key, ''), left(m ->> 'subject_key', -1)) then return false; end if;
    elsif m ->> 'subject_key' is distinct from p_subject_key then
      return false;
    end if;
  end if;
  if m ? 'severity' and not coalesce(m -> 'severity' ? p_severity, false) then return false; end if;
  if m ? 'kind' and not coalesce(m -> 'kind' ? p_kind, false) then return false; end if;
  if p_at is null then return true; end if;

  if w ? 'starts_at' and p_at < (w ->> 'starts_at')::timestamptz then return false; end if;
  if w ? 'ends_at' and p_at >= (w ->> 'ends_at')::timestamptz then return false; end if;
  v_local := p_at at time zone 'America/Los_Angeles';
  if w ? 'days_of_week' and not (w -> 'days_of_week'
       ? (array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])[extract(isodow from v_local)::int]) then
    return false;
  end if;
  if w ? 'time_from' then
    v_t := v_local::time; v_from := (w ->> 'time_from')::time; v_to := (w ->> 'time_to')::time;
    -- time_from after time_to runs past midnight.
    if v_from < v_to then
      if not (v_t >= v_from and v_t < v_to) then return false; end if;
    elsif not (v_t >= v_from or v_t < v_to) then
      return false;
    end if;
  end if;
  return true;
end;
$$;

comment on function public.overwatch_override_applies(jsonb, timestamptz, text, text, text, text, text, text) is
  'Overwatch: true when the delivery override o matches a signal (app, job, subject_key exact or "prefix*", severity, '
  'kind, started_by: every field given must match) and, when p_at is given, is in force then (starts_at, ends_at, '
  'days_of_week, time_from to time_to, Pacific). Used by dispatch_signals.';
revoke all on function public.overwatch_override_applies(jsonb, timestamptz, text, text, text, text, text, text) from public, anon;
grant execute on function public.overwatch_override_applies(jsonb, timestamptz, text, text, text, text, text, text)
  to authenticated, service_role;


-- ============================================================================
-- 3. overwatch_delivery_problem — as 201, plus overrides and pace.max_per_day_all
-- ============================================================================
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
  v_n    bigint;
  v_problem text;
begin
  if p is null then return null; end if;   -- a plan without a delivery section is valid
  if jsonb_typeof(p) <> 'object' then return 'delivery must be an object.'; end if;
  for v_key in select jsonb_object_keys(p) loop
    if v_key <> all (array['window', 'pace', 'priority', 'defaults', 'bundling', 'escalation', 'merge', 'watchers',
                           'overrides']) then
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
  if v ? 'max_per_day_all' and not public.overwatch_delivery_whole(v -> 'max_per_day_all', 0, 200, true) then
    return 'delivery.pace.max_per_day_all must be null (no daily cap) or a whole number from 0 to 200.';
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

  -- Overrides: optional, an ordered list, one label each.
  if p ? 'overrides' then
    v := p -> 'overrides';
    if jsonb_typeof(v) <> 'array' then return 'delivery.overrides must be a list.'; end if;
    for v_e, v_n in select value, ord from jsonb_array_elements(v) with ordinality x(value, ord) loop
      v_problem := public.overwatch_override_problem(v_e, v_n::int);
      if v_problem is not null then return v_problem; end if;
    end loop;
    if (select count(distinct lower(btrim(x ->> 'label'))) from jsonb_array_elements(v) x) < jsonb_array_length(v) then
      return 'delivery.overrides: two overrides have the same label; each needs its own.';
    end if;
  end if;

  return null;
end;
$$;

comment on function public.overwatch_delivery_problem(jsonb) is
  'Overwatch: null when p is a valid delivery section of an Overwatch plan (or null: no section), else a plain message. '
  'Keys: window, pace (max_per_day_all optional), priority, defaults, bundling, escalation, merge, watchers, and the '
  'optional overrides list (each checked by overwatch_override_problem). Used by the overwatch_plans check constraint, '
  'so create_overwatch_plan refuses an invalid one.';
revoke all on function public.overwatch_delivery_problem(jsonb) from public, anon;
grant execute on function public.overwatch_delivery_problem(jsonb) to authenticated, service_role;


-- ============================================================================
-- 4. dispatch_signals — compute only. What the dispatcher would do now with each queued signal.
-- ============================================================================
-- Rules, in order: (1) overrides: every matching, in-force one, in list order, a later one winning per setting;
-- (2) the severity's default, after any severity override, then any decision override; (3) escalation by repeats
-- since the subject's last resolved, unless an override set the decision; (4) merge into an open inbox item or a
-- recent pop, unless an override says merge false; (5) the window: a notification outside it waits, everything else
-- is decided at any hour; (6) bundling of low-priority notifications into one digest; (7) pace, with override caps,
-- exemptions and priority. With no overrides, (1) does nothing.
-- No query alias may share a name with a variable below, and every literal appended to an array is cast to its
-- element type: an untyped literal is read as an array.
create or replace function public.dispatch_signals(p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  c_sevs    constant text[] := array['low', 'normal', 'high', 'urgent'];
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
  v_day_cap   int;
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
  v_ok        boolean;
  i           int;
  g           int;
  k           int;
  -- Overrides: the list, and per override the notifications it has counted this hour, today, and its last.
  v_ovs       jsonb;
  v_nov       int;
  o           jsonb;
  e           jsonb;
  ov_hour     int[] := '{}';
  ov_day      int[] := '{}';
  ov_last     timestamptz[] := '{}';
  v_cnt_h     int;
  v_cnt_d     int;
  v_cnt_last  timestamptz;
  v_matched   int[];
  v_notes     text[];
  v_sev       text;
  e_sev       jsonb;
  e_sev_l     text;
  e_dec       text;
  e_dec_l     text;
  e_exempt    boolean;
  e_exempt_l  text;
  e_hk        int;
  e_dk        int;
  e_gk        int;
  e_win       jsonb;
  e_win_l     text;
  e_bundle    text;
  e_bundle_l  text;
  e_merge     boolean;
  e_merge_l   text;
  e_prio      text;
  e_prio_l    text;
  v_ws        text;
  v_we        text;
  v_inwin     boolean;
  -- One slot per queued signal, in priority order.
  a_id     uuid[] := '{}';
  a_app    text[] := '{}';
  a_sev    text[] := '{}';
  a_raised text[] := '{}';
  a_subj   text[] := '{}';
  a_kind   text[] := '{}';
  a_dec    text[] := '{}';
  a_why    text[] := '{}';
  a_rep    int[] := '{}';
  a_target uuid[] := '{}';
  a_inbox  text[] := '{}';
  a_bundle boolean[] := '{}';
  a_exempt boolean[] := '{}';
  a_hk     int[] := '{}';
  a_dk     int[] := '{}';
  a_gk     int[] := '{}';
  a_bset   text[] := '{}';
  a_prio   int[] := '{}';
  a_own    boolean[] := '{}';
  a_match  jsonb[] := '{}';
  a_labels jsonb[] := '{}';
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
  v_ovs := coalesce(v_d -> 'overrides', '[]'::jsonb);
  v_nov := jsonb_array_length(v_ovs);

  -- Pops already sent. Alex's own reminders and step timers always fire and are not counted.
  select count(*) filter (where created_at >= date_trunc('hour', p_now)),
         count(*) filter (where local_date = v_today),
         max(created_at)
    into v_hour_pops, v_day_pops, v_last_pop
    from claude_notifications
   where user_id = v_user and channel = 'alfred_push' and delivery_status in ('pending', 'sent')
     and job not in ('reminder', 'step_timer') and created_at <= p_now;
  v_day_cap := coalesce(v_d -> 'pace' ->> 'max_per_day_all', v_d -> 'pace' ->> 'max_pops_per_day')::int;
  v_hour_left := (v_d -> 'pace' ->> 'max_pops_per_hour')::int - v_hour_pops;
  v_day_left := coalesce(v_day_cap - v_day_pops, 1000000);
  v_gap_ok := v_last_pop is null
              or p_now >= v_last_pop + make_interval(mins => (v_d -> 'pace' ->> 'min_gap_minutes')::int);

  -- Per override with its own caps: the notifications of the signals it matches, this hour, today, and the last.
  for k in 1 .. v_nov loop
    o := v_ovs -> (k - 1);
    v_cnt_h := 0; v_cnt_d := 0; v_cnt_last := null;
    if coalesce(o -> 'effect' -> 'pace' ?| array['max_per_hour', 'max_per_day', 'min_gap_minutes'], false) then
      select count(*) filter (where n.created_at >= date_trunc('hour', p_now)),
             count(*) filter (where n.local_date = v_today),
             max(n.created_at)
        into v_cnt_h, v_cnt_d, v_cnt_last
        from claude_notifications n join signals s on s.id = n.signal_id
       where n.user_id = v_user and n.channel = 'alfred_push' and n.delivery_status in ('pending', 'sent')
         and n.created_at <= p_now
         and public.overwatch_override_applies(o, null, s.app, s.job, s.subject_key, s.severity,
               coalesce(nullif(s.details ->> 'kind', ''), case when s.severity in ('high', 'urgent') then 'flag' else 'info' end),
               s.started_by);
    end if;
    ov_hour := ov_hour || v_cnt_h; ov_day := ov_day || v_cnt_d; ov_last := ov_last || v_cnt_last;
  end loop;

  for r in
    select s.id, s.app, s.job, s.severity, s.subject_key, s.started_by, s.created_at,
           coalesce(nullif(s.details ->> 'kind', ''),
                    case when s.severity in ('high', 'urgent') then 'flag' else 'info' end) as sig_kind
      from signals s
     where s.user_id = v_user and s.state = 'queued' and s.created_at <= p_now
     order by coalesce(array_position(v_sev_order, s.severity), 99),
              coalesce(array_position(v_app_order, s.app), 999),
              s.created_at, s.id
  loop
    v_n := v_n + 1;

    -- (1) Overrides: each setting from the last matching, in-force override that gives it.
    e_sev := null; e_sev_l := null; e_dec := null; e_dec_l := null; e_exempt := false; e_exempt_l := null;
    e_hk := 0; e_dk := 0; e_gk := 0; e_win := null; e_win_l := null; e_bundle := null; e_bundle_l := null;
    e_merge := null; e_merge_l := null; e_prio := null; e_prio_l := null;
    v_matched := '{}'; v_notes := '{}';
    for k in 1 .. v_nov loop
      o := v_ovs -> (k - 1);
      continue when not public.overwatch_override_applies(o, p_now, r.app, r.job, r.subject_key, r.severity,
                                                           r.sig_kind, r.started_by);
      v_matched := v_matched || k;
      e := o -> 'effect';
      if e ? 'severity' then e_sev := e -> 'severity'; e_sev_l := o ->> 'label'; end if;
      if e ? 'decision' then e_dec := e ->> 'decision'; e_dec_l := o ->> 'label'; end if;
      if e -> 'pace' ? 'exempt' then e_exempt := (e -> 'pace' ->> 'exempt')::boolean; e_exempt_l := o ->> 'label'; end if;
      if e -> 'pace' ? 'max_per_hour' then e_hk := k; end if;
      if e -> 'pace' ? 'max_per_day' then e_dk := k; end if;
      if e -> 'pace' ? 'min_gap_minutes' then e_gk := k; end if;
      if e ? 'window' then e_win := e -> 'window'; e_win_l := o ->> 'label'; end if;
      if e ? 'bundle' then e_bundle := e ->> 'bundle'; e_bundle_l := o ->> 'label'; end if;
      if e ? 'merge' then e_merge := (e ->> 'merge')::boolean; e_merge_l := o ->> 'label'; end if;
      if e ? 'priority' then e_prio := e ->> 'priority'; e_prio_l := o ->> 'label'; end if;
    end loop;

    v_sev := r.severity;
    if jsonb_typeof(e_sev) = 'string' then
      v_sev := e_sev #>> '{}';
    elsif jsonb_typeof(e_sev) = 'number' then
      v_sev := c_sevs[least(4, greatest(1, array_position(c_sevs, r.severity) + (e_sev::text)::int))];
    end if;
    if v_sev <> r.severity then
      v_notes := v_notes || format('override ''%s'': severity %s to %s', e_sev_l, r.severity, v_sev);
    end if;

    a_id := a_id || r.id; a_app := a_app || r.app; a_sev := a_sev || v_sev; a_raised := a_raised || r.severity;
    a_subj := a_subj || r.subject_key; a_kind := a_kind || r.sig_kind;
    a_target := a_target || null::uuid; a_inbox := a_inbox || null::text; a_bundle := a_bundle || false;
    a_exempt := a_exempt || coalesce(e_exempt, false); a_hk := a_hk || e_hk; a_dk := a_dk || e_dk; a_gk := a_gk || e_gk;
    a_bset := a_bset || e_bundle;
    a_prio := a_prio || (case e_prio when 'before' then 0 when 'after' then 2 else 1 end);
    a_own := a_own || (coalesce(e_exempt, false) or e_hk > 0 or e_dk > 0 or e_gk > 0 or e_prio is not null);
    a_match := a_match || to_jsonb(v_matched);
    a_labels := a_labels || (select coalesce(jsonb_agg(v_ovs -> (x - 1) -> 'label' order by x), '[]'::jsonb)
                               from unnest(v_matched) x);

    -- This signal's window: its override's own, none (ignore), or the plan's.
    if e_win ? 'ignore' and (e_win ->> 'ignore')::boolean then
      v_inwin := true; v_ws := null; v_we := null;
    else
      v_ws := coalesce(e_win ->> 'start', v_d -> 'window' ->> 'start');
      v_we := coalesce(e_win ->> 'end', v_d -> 'window' ->> 'end');
      v_inwin := v_local >= v_ws::time and v_local < v_we::time;
    end if;

    -- An earlier signal for the same subject in this run that will be delivered takes this one with it.
    v_first := null;
    if e_merge is distinct from false then
      for i in 1 .. v_n - 1 loop
        if a_subj[i] = r.subject_key and a_dec[i] in ('inbox', 'pop') then v_first := i; exit; end if;
      end loop;
    end if;
    if v_first is not null then
      a_dec := a_dec || 'merge'::text; a_rep := a_rep || 0;
      a_target[v_n] := a_id[v_first]; a_inbox[v_n] := a_inbox[v_first];
      a_why := a_why || 'same subject as another signal delivered in this run'::text;
      continue;
    end if;

    -- (2) The severity's default, then a decision override.
    v_out := v_d -> 'defaults' ->> v_sev;
    v_why := format('%s signals default to %s', v_sev, v_out);
    if e_dec is not null then
      if (case e_dec when 'notify' then 'pop' else e_dec end) <> v_out then
        v_notes := v_notes || format('override ''%s'': %s to %s', e_dec_l, v_sev, e_dec);
      end if;
      v_out := case e_dec when 'notify' then 'pop' else e_dec end;
    end if;

    -- (3) Escalation: earlier held or delivered signals for the subject since it was last resolved, this run's
    -- held ones included. The first rule whose subject_key matches (exact, a prefix before ":", or "*") applies.
    -- An override's decision is final, so it does not escalate.
    select max(created_at) into v_resolved from signals
     where user_id = v_user and subject_key = r.subject_key and state = 'resolved' and created_at <= p_now;
    select count(*) into v_rep from signals
     where user_id = v_user and subject_key = r.subject_key and id <> r.id
       and state in ('held', 'delivered', 'merged') and created_at <= p_now
       and created_at > coalesce(v_resolved, '-infinity'::timestamptz);
    for i in 1 .. v_n - 1 loop
      if a_subj[i] = r.subject_key and a_dec[i] = 'hold' then v_rep := v_rep + 1; end if;
    end loop;
    if e_dec is null then
      v_rule := null;
      select x.value into v_rule from jsonb_array_elements(v_d -> 'escalation') with ordinality x(value, ord)
       where x.value ->> 'subject_key' = '*' or x.value ->> 'subject_key' = r.subject_key
          or starts_with(r.subject_key, (x.value ->> 'subject_key') || ':')
       order by x.ord limit 1;
      if v_out = 'hold' and v_rule ->> 'hold_repeats' is not null and v_rep >= (v_rule ->> 'hold_repeats')::int then
        v_out := 'inbox';
        v_why := format('escalated to inbox: %s earlier since last resolved (rule %s)', v_rep, v_rule ->> 'subject_key');
      end if;
      if v_out = 'inbox' and v_rule ->> 'inbox_repeats' is not null and v_rep >= (v_rule ->> 'inbox_repeats')::int then
        v_out := 'pop';
        v_why := format('escalated to pop: %s earlier since last resolved (rule %s)', v_rep, v_rule ->> 'subject_key');
      end if;
    end if;

    -- (4) Merge into an open inbox item for the subject, or a recent pop of it.
    if v_out in ('inbox', 'pop') and e_merge is false then
      v_notes := v_notes || format('override ''%s'': not merged', e_merge_l);
    elsif v_out in ('inbox', 'pop') then
      v_open_sig := null; v_open_inbox := null; v_pop_sig := null;
      select s.id, s.inbox_id into v_open_sig, v_open_inbox
        from signals s join inbox ib on ib.id = s.inbox_id
       where s.user_id = v_user and s.subject_key = r.subject_key and s.state = 'delivered'
         and coalesce(ib.archived, false) = false
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

    -- (5) The window holds back only notifications.
    if v_out = 'pop' then
      if e_win is not null then
        v_notes := v_notes || case when v_ws is null then format('override ''%s'': ignores the window', e_win_l)
                                   else format('override ''%s'': its own window %s-%s', e_win_l, v_ws, v_we) end;
      end if;
      if not v_inwin then
        v_out := 'wait';
        v_why := format('outside the window %s-%s', v_ws, v_we);
      end if;
    end if;
    if v_out = 'pop' and e_exempt then
      v_notes := v_notes || format('override ''%s'': not held back by the plan''s pace', e_exempt_l);
    end if;
    if v_out = 'pop' and e_bundle is not null then
      v_notes := v_notes || format('override ''%s'': bundle %s', e_bundle_l, e_bundle);
    end if;
    if v_out = 'pop' and e_prio is not null then
      v_notes := v_notes || format('override ''%s'': paced %s other apps', e_prio_l, e_prio);
    end if;

    if array_length(v_notes, 1) > 0 then v_why := v_why || '; ' || array_to_string(v_notes, '; '); end if;
    a_dec := a_dec || v_out; a_why := a_why || v_why; a_rep := a_rep || v_rep;
  end loop;

  -- (6) Bundling: enough low-priority pops in one run become one digest pop. A signal an override paces on its own
  -- is never bundled; bundle never keeps one out, bundle always lets one in whatever its severity.
  select array_agg(gs.n order by gs.n) into v_digest from generate_subscripts(a_id, 1) gs(n)
   where a_dec[gs.n] = 'pop' and a_inbox[gs.n] is null and not a_own[gs.n]
     and a_bset[gs.n] is distinct from 'never'
     and (a_bset[gs.n] = 'always'
          or a_sev[gs.n] in (select jsonb_array_elements_text(v_d -> 'bundling' -> 'digest_severities')));
  if coalesce(array_length(v_digest, 1), 0) >= (v_d -> 'bundling' ->> 'min_signals')::int then
    foreach i in array v_digest loop
      a_dec[i] := 'digest'; a_bundle[i] := true;
      a_why[i] := a_why[i] || format('; bundled with %s others into one digest', array_length(v_digest, 1) - 1);
    end loop;
  else
    v_digest := '{}';
  end if;

  -- (7) Pace. Each pop, and the digest as a whole, is one unit: priority before first, then the rest, then after,
  -- each in priority order. An exempt pop skips the plan's caps and gap; an override's own caps always count.
  v_unit := false;   -- whether the digest has been paced yet
  for g in 0 .. 2 loop
    for i in 1 .. v_n loop
      continue when a_prio[i] <> g;
      if a_dec[i] = 'pop' or (a_dec[i] = 'digest' and not v_unit) then
        v_why := null;
        if not a_exempt[i] and not v_gap_ok then v_why := 'the minimum gap since the last pop';
        elsif not a_exempt[i] and v_hour_left <= 0 then v_why := 'the hourly cap';
        elsif not a_exempt[i] and v_day_left <= 0 then v_why := 'the daily cap';
        elsif a_gk[i] > 0 and ov_last[a_gk[i]] is not null and p_now < ov_last[a_gk[i]]
              + make_interval(mins => (v_ovs -> (a_gk[i] - 1) -> 'effect' -> 'pace' ->> 'min_gap_minutes')::int) then
          v_why := format('override ''%s'': its minimum gap', v_ovs -> (a_gk[i] - 1) ->> 'label');
        elsif a_hk[i] > 0 and ov_hour[a_hk[i]] >= (v_ovs -> (a_hk[i] - 1) -> 'effect' -> 'pace' ->> 'max_per_hour')::int then
          v_why := format('override ''%s'': its hourly cap', v_ovs -> (a_hk[i] - 1) ->> 'label');
        elsif a_dk[i] > 0 and ov_day[a_dk[i]] >= (v_ovs -> (a_dk[i] - 1) -> 'effect' -> 'pace' ->> 'max_per_day')::int then
          v_why := format('override ''%s'': its daily cap', v_ovs -> (a_dk[i] - 1) ->> 'label');
        end if;
        v_ok := v_why is null;
        if v_ok then
          v_hour_left := v_hour_left - 1; v_day_left := v_day_left - 1;
          for k in select jsonb_array_elements_text(a_match[i])::int loop
            ov_hour[k] := ov_hour[k] + 1; ov_day[k] := ov_day[k] + 1; ov_last[k] := p_now;
          end loop;
          if a_dec[i] = 'digest' then v_unit := true; end if;
        elsif a_dec[i] = 'digest' then
          foreach v_first in array v_digest loop
            a_dec[v_first] := 'inbox'; a_bundle[v_first] := false;
            a_why[v_first] := a_why[v_first] || '; the digest is held back by pace, so each becomes an inbox item';
          end loop;
          v_unit := true;
        elsif a_sev[i] = 'urgent' then
          a_dec[i] := 'wait'; a_why[i] := a_why[i] || '; waits for ' || v_why;
        elsif a_inbox[i] is not null then
          a_dec[i] := 'merge'; a_why[i] := a_why[i] || '; ' || v_why || ' stops the pop, merged into the open item';
        else
          a_dec[i] := 'inbox'; a_why[i] := a_why[i] || '; ' || v_why || ' stops the pop, an inbox item instead';
        end if;
      end if;
    end loop;
  end loop;

  for i in 1 .. v_n loop
    v_decisions := v_decisions || jsonb_build_object(
      'signal_id', a_id[i], 'app', a_app[i], 'severity', a_sev[i], 'raised_severity', a_raised[i],
      'kind', a_kind[i], 'subject_key', a_subj[i],
      'decision', a_dec[i], 'reason', a_why[i], 'repeats', a_rep[i],
      'merge_target_signal_id', a_target[i], 'inbox_id', a_inbox[i], 'bundle', a_bundle[i],
      'overrides', a_labels[i]);
  end loop;

  return jsonb_build_object(
    'at', p_now, 'local_time', to_char(v_local, 'HH24:MI'), 'local_date', v_today, 'plan_id', v_plan,
    'in_window', v_local >= (v_d -> 'window' ->> 'start')::time and v_local < (v_d -> 'window' ->> 'end')::time,
    'overrides', v_nov,
    'pops', jsonb_build_object('this_hour', v_hour_pops, 'today', v_day_pops, 'last_at', v_last_pop,
                               'hour_left_after', greatest(v_hour_left, 0),
                               'day_left_after', case when v_day_cap is null then null
                                                      else greatest(v_day_left, 0) end),
    'decisions', v_decisions);
end;
$$;

comment on function public.dispatch_signals(timestamptz) is
  'Shared: compute only, writes nothing. For each of the caller''s queued signals, what the dispatcher would do at '
  'p_now under the delivery rules in the active Overwatch plan, overrides included: wait, hold, inbox, pop, merge, '
  'drop or digest, with the reason (naming each override that changed it), the repeat count, and the signal or inbox '
  'item it merges into. Only pops and digests wait for the window. Pops counted against the caps exclude Alex''s own '
  'reminders and step timers. Called by the get_dispatch_plan and deliver_signals tools.';
revoke all on function public.dispatch_signals(timestamptz) from public, anon;
grant execute on function public.dispatch_signals(timestamptz) to authenticated, service_role;

commit;

-- Result: must say CONFORMANT. Then run supabase/tests/notification_routing-d7v/6_dispatch_overrides_verify.sql and
-- 2_verify_dispatcher.sql with --test.
select public.platform_check_conformance() as conformance;
