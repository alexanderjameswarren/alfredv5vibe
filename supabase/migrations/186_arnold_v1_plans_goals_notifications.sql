-- Purpose: Arnold V1 (written step 2, run step 3). arnold_plans (versioned, immutable, one active per user), arnold_goals
-- (the goals of one plan, immutable), claude_notifications (the shared log of every notification a Claude task sends,
-- any app), arnold_create_plan() and log_claude_notification(), with their validators, guard triggers, grants and
-- registration.
-- Kind: schema change (three new tables, seven functions, four triggers)
-- Applied: NO
--
-- Spec: docs/arnold_v1-technical-spec.md sections 3 and 4. Modelled on 054_sam_practice_plans.sql.
-- Run as one block in the SQL editor, then run supabase/tests/arnold_v1-k7m/1_verify.sql.
-- Safe to re-run: every create is if-not-exists or create-or-replace, and every trigger is dropped first.
-- supabase/migrations/186_arnold_v1_plans_goals_notifications.sql

begin;

-- ============================================================================
-- 1. Validators. Each returns null when the value is valid, else a plain message, so the check constraints and
--    arnold_create_plan() can never disagree about what is valid.
-- ============================================================================
create or replace function public.arnold_hhmm_valid(p text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p is not null and p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
$$;

comment on function public.arnold_hhmm_valid(text) is
  'Arnold: true when the text is a 24-hour HH:MM time, e.g. 05:00 or 19:30.';

create or replace function public.arnold_notification_settings_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_allowed text[] := array['window_start', 'window_end', 'max_nudges_per_day', 'max_encouragements_per_day',
                            'inbox_waiting_delay_minutes'];
  v_key     text;
  v_num     text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'notification_settings must be a JSON object.';
  end if;
  for v_key in select jsonb_object_keys(p) loop
    if not v_key = any (v_allowed) then
      return format('notification_settings has an unknown key "%s". Allowed: %s.', v_key, array_to_string(v_allowed, ', '));
    end if;
  end loop;
  foreach v_key in array v_allowed loop
    if not p ? v_key then
      return format('notification_settings.%s is required.', v_key);
    end if;
  end loop;
  if not (arnold_hhmm_valid(p->>'window_start') and arnold_hhmm_valid(p->>'window_end')) then
    return 'notification_settings.window_start and window_end must be HH:MM times, e.g. "05:00".';
  end if;
  if (p->>'window_start') >= (p->>'window_end') then
    return 'notification_settings.window_start must be before window_end.';
  end if;
  foreach v_num in array array['max_nudges_per_day', 'max_encouragements_per_day', 'inbox_waiting_delay_minutes'] loop
    if jsonb_typeof(p->v_num) <> 'number' or (p->>v_num) !~ '^[0-9]+$' then
      return format('notification_settings.%s must be a whole number, 0 or more.', v_num);
    end if;
  end loop;
  if (p->>'max_nudges_per_day')::int > 24 or (p->>'max_encouragements_per_day')::int > 24 then
    return 'notification_settings: max_nudges_per_day and max_encouragements_per_day must be 24 or less.';
  end if;
  if (p->>'inbox_waiting_delay_minutes')::int > 1440 then
    return 'notification_settings.inbox_waiting_delay_minutes must be 1440 (one day) or less.';
  end if;
  return null;
end;
$$;

comment on function public.arnold_notification_settings_problem(jsonb) is
  'Arnold: null when notification_settings is valid, else a plain message. Exactly the keys window_start, window_end '
  '(HH:MM, start before end), max_nudges_per_day, max_encouragements_per_day (0-24) and inbox_waiting_delay_minutes '
  '(0-1440). Unknown keys are refused so a typo is caught rather than silently ignored.';

create or replace function public.arnold_prompt_templates_problem(p jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_val jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 'prompt_templates must be a JSON object of name: prompt text.';
  end if;
  for v_key, v_val in select key, value from jsonb_each(p) loop
    if v_key !~ '^[a-z][a-z0-9_]*$' then
      return format('prompt_templates key "%s" must be lower-case letters, digits and underscores.', v_key);
    end if;
    if jsonb_typeof(v_val) <> 'string' or (v_val #>> '{}') !~ '^Arnold:' then
      return format('prompt_templates.%s must be text starting with "Arnold:".', v_key);
    end if;
  end loop;
  return null;
end;
$$;

comment on function public.arnold_prompt_templates_problem(jsonb) is
  'Arnold: null when prompt_templates is valid, else a plain message. An object whose keys are snake_case names and '
  'whose values are prompt texts that start with "Arnold:", so a pasted prompt opens an Arnold conversation.';

create or replace function public.arnold_pace_checkpoints_problem(p jsonb, p_target integer)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_cp         jsonb;
  v_prev_time  text := '';
  v_prev_count integer := 0;
begin
  if p is null or jsonb_typeof(p) <> 'array' then
    return 'pace_checkpoints must be an array (empty for none).';
  end if;
  for v_cp in select value from jsonb_array_elements(p) loop
    -- Separate ifs: SQL does not promise to short-circuit or, and the later tests fail on the wrong type.
    if jsonb_typeof(v_cp) <> 'object' then
      return 'each pace checkpoint must be exactly {"time": "HH:MM", "count": n}.';
    end if;
    if not (v_cp ? 'time' and v_cp ? 'count') or (select count(*) from jsonb_object_keys(v_cp)) <> 2 then
      return 'each pace checkpoint must be exactly {"time": "HH:MM", "count": n}.';
    end if;
    if not arnold_hhmm_valid(v_cp->>'time') then
      return format('pace checkpoint time "%s" must be HH:MM.', v_cp->>'time');
    end if;
    if jsonb_typeof(v_cp->'count') <> 'number' or (v_cp->>'count') !~ '^[0-9]+$' then
      return format('pace checkpoint at %s: count must be a whole number, 1 or more.', v_cp->>'time');
    end if;
    if (v_cp->>'count')::int < 1 then
      return format('pace checkpoint at %s: count must be a whole number, 1 or more.', v_cp->>'time');
    end if;
    if (v_cp->>'time') <= v_prev_time then
      return 'pace checkpoint times must be in increasing order.';
    end if;
    if (v_cp->>'count')::int < v_prev_count then
      return 'pace checkpoint counts must not go down.';
    end if;
    if p_target is not null and (v_cp->>'count')::int > p_target then
      return format('pace checkpoint at %s asks for %s, more than the target %s.', v_cp->>'time', v_cp->>'count', p_target);
    end if;
    v_prev_time  := v_cp->>'time';
    v_prev_count := (v_cp->>'count')::int;
  end loop;
  return null;
end;
$$;

comment on function public.arnold_pace_checkpoints_problem(jsonb, integer) is
  'Arnold: null when pace_checkpoints is valid for the target, else a plain message. An array of {time HH:MM, count}, '
  'times increasing, counts never decreasing and never above the target.';

-- Functions in check constraints run with the inserting user's rights.
revoke all on function public.arnold_hhmm_valid(text) from public, anon;
revoke all on function public.arnold_notification_settings_problem(jsonb) from public, anon;
revoke all on function public.arnold_prompt_templates_problem(jsonb) from public, anon;
revoke all on function public.arnold_pace_checkpoints_problem(jsonb, integer) from public, anon;
grant execute on function public.arnold_hhmm_valid(text) to authenticated, service_role;
grant execute on function public.arnold_notification_settings_problem(jsonb) to authenticated, service_role;
grant execute on function public.arnold_prompt_templates_problem(jsonb) to authenticated, service_role;
grant execute on function public.arnold_pace_checkpoints_problem(jsonb, integer) to authenticated, service_role;


-- ============================================================================
-- 2. arnold_plans
-- ============================================================================
create table if not exists public.arnold_plans (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null default auth.uid() references auth.users (id),
  status                text not null default 'active',
  starts_on             date not null default ((now() at time zone 'America/Los_Angeles')::date),
  ended_at              timestamptz,
  supersedes_plan_id    uuid references public.arnold_plans (id) on delete set null,
  focus                 text not null,
  change_summary        text,
  internal_notes        text,
  review_instructions   text not null,
  nudge_instructions    text not null,
  voice_notes           text,
  review_cadence_days   smallint not null default 7,
  notification_settings jsonb not null,
  prompt_templates      jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint arnold_plans_status_values check (status in ('active', 'superseded')),
  constraint arnold_plans_status_ended check ((status = 'active') = (ended_at is null)),
  constraint arnold_plans_focus_present check (length(btrim(focus)) between 1 and 200),
  constraint arnold_plans_review_instructions_present check (length(btrim(review_instructions)) > 0),
  constraint arnold_plans_nudge_instructions_present check (length(btrim(nudge_instructions)) > 0),
  constraint arnold_plans_change_summary_on_supersede
    check (supersedes_plan_id is null or length(btrim(coalesce(change_summary, ''))) > 0),
  constraint arnold_plans_review_cadence_range check (review_cadence_days between 1 and 90),
  constraint arnold_plans_notification_settings_valid
    check (public.arnold_notification_settings_problem(notification_settings) is null),
  constraint arnold_plans_prompt_templates_valid
    check (public.arnold_prompt_templates_problem(prompt_templates) is null)
);

create unique index if not exists arnold_plans_one_active on public.arnold_plans (user_id) where status = 'active';
create index if not exists arnold_plans_user_created on public.arnold_plans (user_id, created_at desc);

comment on table public.arnold_plans is
  'ARNOLD. A workout and wellbeing plan, proposed by Arnold (Claude) and approved by Alex in conversation. PLANS ARE '
  'NEVER EDITED: any change, including a travel or rehab week, is a new plan that supersedes this one (trigger-enforced). '
  'Only status, ended_at and updated_at may change after insert. At most one active plan per user. Every number, time, '
  'limit and instruction lives here or on arnold_goals; code holds no goal values. Create plans only through '
  'arnold_create_plan(). Spec: docs/arnold_v1-technical-spec.md.';
comment on column public.arnold_plans.id is 'Row id.';
comment on column public.arnold_plans.user_id is 'Owner. Owner RLS.';
comment on column public.arnold_plans.status is 'active | superseded. A superseded plan can never be reactivated.';
comment on column public.arnold_plans.starts_on is 'Pacific (America/Los_Angeles) date the plan began.';
comment on column public.arnold_plans.ended_at is 'When this plan was superseded. Null while active (constraint-enforced).';
comment on column public.arnold_plans.supersedes_plan_id is 'The plan this one replaced. Chains plan history.';
comment on column public.arnold_plans.focus is
  'VISIBLE. Short summary, e.g. "Three yoga classes a week and daily microworkouts".';
comment on column public.arnold_plans.change_summary is
  'What changed from the previous plan and why, in plain words. Required whenever the plan supersedes another.';
comment on column public.arnold_plans.internal_notes is 'CLAUDE ONLY. Reasoning behind the plan.';
comment on column public.arnold_plans.review_instructions is
  'CLAUDE ONLY. Plain-language rules the morning review follows: what to check, when to raise a conversation, which '
  'prompt template to use. Must not be empty.';
comment on column public.arnold_plans.nudge_instructions is
  'CLAUDE ONLY. Plain-language rules the hourly nudge task follows, e.g. "nudge if 3 hours pass with no microworkout '
  'tick". Applied within notification_settings. Must not be empty.';
comment on column public.arnold_plans.voice_notes is 'CLAUDE ONLY. Optional notes on Arnold''s tone for this plan.';
comment on column public.arnold_plans.review_cadence_days is
  'How often the morning review checks whether goals were met over the whole period. Default 7; 1 to 90.';
comment on column public.arnold_plans.notification_settings is
  'Values the hourly and morning tasks apply: window_start, window_end (HH:MM Pacific), max_nudges_per_day, '
  'max_encouragements_per_day, inbox_waiting_delay_minutes. Checked by arnold_notification_settings_problem().';
comment on column public.arnold_plans.prompt_templates is
  'Paste-ready prompts the morning review fills in and puts in inbox items, keyed by name (e.g. missed, goal_met, '
  'check_in). Each starts with "Arnold:". Checked by arnold_prompt_templates_problem().';
comment on column public.arnold_plans.created_at is 'Row creation.';
comment on column public.arnold_plans.updated_at is 'Last change (only on supersede). Stamped by the guard trigger.';

create or replace function public.arnold_plans_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.id, new.user_id, new.starts_on, new.supersedes_plan_id, new.focus, new.change_summary, new.internal_notes,
      new.review_instructions, new.nudge_instructions, new.voice_notes, new.review_cadence_days,
      new.notification_settings, new.prompt_templates, new.created_at)
     is distinct from
     (old.id, old.user_id, old.starts_on, old.supersedes_plan_id, old.focus, old.change_summary, old.internal_notes,
      old.review_instructions, old.nudge_instructions, old.voice_notes, old.review_cadence_days,
      old.notification_settings, old.prompt_templates, old.created_at) then
    raise exception 'arnold_plans: plan content is immutable. Create a new plan instead.' using errcode = '23514';
  end if;
  if old.status = 'superseded' and new.status = 'active' then
    raise exception 'arnold_plans: a superseded plan cannot be reactivated. Create a new plan instead.'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.arnold_plans_guard_update() is
  'Arnold: enforces plan immutability. Allows only status active->superseded and ended_at. Stamps updated_at.';
revoke all on function public.arnold_plans_guard_update() from public, anon;

drop trigger if exists arnold_plans_guard_update on public.arnold_plans;
create trigger arnold_plans_guard_update
  before update on public.arnold_plans
  for each row execute function public.arnold_plans_guard_update();


-- ============================================================================
-- 3. arnold_goals
-- ============================================================================
create table if not exists public.arnold_goals (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id),
  plan_id          uuid not null references public.arnold_plans (id) on delete cascade,
  position         smallint not null,
  goal_key         text not null,
  label            text not null,
  intent_id        text not null,
  measure          text not null,
  target           integer not null,
  period           text not null,
  usual_days       text[] not null default '{}',
  pace_checkpoints jsonb not null default '[]'::jsonb,
  notes            text,
  created_at       timestamptz not null default now(),

  constraint arnold_goals_plan_goal_key unique (plan_id, goal_key),
  constraint arnold_goals_position_positive check (position > 0),
  constraint arnold_goals_goal_key_slug check (goal_key ~ '^[a-z][a-z0-9_]*$'),
  constraint arnold_goals_label_present check (length(btrim(label)) between 1 and 100),
  constraint arnold_goals_measure_values check (measure in ('executions', 'elements')),
  constraint arnold_goals_target_range check (target between 1 and 1000),
  constraint arnold_goals_period_values check (period in ('day', 'week')),
  constraint arnold_goals_usual_days_values
    check (usual_days <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  constraint arnold_goals_pace_checkpoints_valid
    check (public.arnold_pace_checkpoints_problem(pace_checkpoints, target) is null)
);

create index if not exists arnold_goals_plan_position on public.arnold_goals (plan_id, position);
create index if not exists arnold_goals_intent on public.arnold_goals (intent_id);

comment on table public.arnold_goals is
  'ARNOLD. One goal of one plan: which Alfred intention counts, how it is counted, the target and the period. '
  'Immutable (trigger-enforced): a change is a new plan. Created only by arnold_create_plan().';
comment on column public.arnold_goals.id is 'Row id.';
comment on column public.arnold_goals.user_id is 'Owner. Owner RLS.';
comment on column public.arnold_goals.plan_id is 'The plan this goal belongs to.';
comment on column public.arnold_goals.position is 'Order within the plan, starting at 1.';
comment on column public.arnold_goals.goal_key is
  'Short stable name, e.g. yoga, microworkout, sleep_checkin. The same goal keeps its key across plan versions.';
comment on column public.arnold_goals.label is 'VISIBLE name, e.g. "Yoga classes".';
comment on column public.arnold_goals.intent_id is
  'The Alfred intention (intents.id) whose executions count. No foreign key on purpose: an intention can be deleted '
  'later without breaking plan history. arnold_create_plan() checks it exists, is yours and is not archived.';
comment on column public.arnold_goals.measure is
  'executions: closed executions with outcome done, dated by closed_at in Pacific time. elements: elements with '
  'display_type step and is_completed true, each dated by its own completed_at in Pacific time (never the execution''s '
  'closed_at or event_date).';
comment on column public.arnold_goals.target is 'How many per period, e.g. 3 or 5.';
comment on column public.arnold_goals.period is 'day or week. Weeks run Monday to Sunday, Pacific.';
comment on column public.arnold_goals.usual_days is
  'Optional weekdays (mon..sun), e.g. {tue,thu,sun} for yoga. Used to word nudges and reviews; never a hard rule.';
comment on column public.arnold_goals.pace_checkpoints is
  'Optional [{time HH:MM, count}], e.g. 1 by 10:00, 3 by 14:00. Behind pace = below count after time, Pacific.';
comment on column public.arnold_goals.notes is 'CLAUDE ONLY. Optional notes on this goal for the nudge and review tasks.';
comment on column public.arnold_goals.created_at is 'Row creation.';

create or replace function public.arnold_reject_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '%: rows are immutable. Create a new plan instead.', tg_table_name using errcode = '23514';
end;
$$;

comment on function public.arnold_reject_update() is 'Arnold: rejects all updates on immutable plan child tables.';
revoke all on function public.arnold_reject_update() from public, anon;

drop trigger if exists arnold_goals_reject_update on public.arnold_goals;
create trigger arnold_goals_reject_update
  before update on public.arnold_goals
  for each row execute function public.arnold_reject_update();


-- ============================================================================
-- 4. claude_notifications (shared by every app, not Arnold-only)
-- ============================================================================
create table if not exists public.claude_notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id),
  app             text not null references public.apps (id),
  job             text not null,
  kind            text not null,
  channel         text not null,
  title           text not null,
  body            text,
  link            text,
  local_date      date not null default ((now() at time zone 'America/Los_Angeles')::date),
  dedupe_key      text not null,
  delivery_status text not null default 'pending',
  delivery_detail jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint claude_notifications_job_present check (length(btrim(job)) between 1 and 100),
  constraint claude_notifications_kind_values check (kind in ('nudge', 'encouragement', 'flag', 'info')),
  constraint claude_notifications_channel_values check (channel in ('alfred_push', 'claude_push', 'inbox_item')),
  constraint claude_notifications_title_present check (length(btrim(title)) between 1 and 200),
  constraint claude_notifications_dedupe_key_present check (length(btrim(dedupe_key)) between 1 and 300),
  constraint claude_notifications_delivery_status_values
    check (delivery_status in ('pending', 'sent', 'failed', 'no_subscription')),
  constraint claude_notifications_delivery_detail_object check (jsonb_typeof(delivery_detail) = 'object')
);

create unique index if not exists claude_notifications_user_dedupe on public.claude_notifications (user_id, dedupe_key);
create index if not exists claude_notifications_user_day on public.claude_notifications (user_id, local_date, app);
create index if not exists claude_notifications_user_created on public.claude_notifications (user_id, created_at desc);

comment on table public.claude_notifications is
  'SHARED. One row per notification a Claude task or tool decided to send Alex, for any app, so there is one place to '
  'see whether notifications have become too many. Not a replacement for notification_steps, reminders or '
  'push_subscriptions. A repeated (user_id, dedupe_key) is refused, which is how "at most once" is enforced. Only '
  'delivery_status, delivery_detail and updated_at may change after insert. Write through log_claude_notification() '
  'or the send_alfred_push tool.';
comment on column public.claude_notifications.id is 'Row id.';
comment on column public.claude_notifications.user_id is 'Owner. Owner RLS.';
comment on column public.claude_notifications.app is 'The app it was for (apps.id), e.g. arnold.';
comment on column public.claude_notifications.job is 'What sent it, e.g. arnold_hourly, arnold_morning_review.';
comment on column public.claude_notifications.kind is 'nudge, encouragement, flag or info.';
comment on column public.claude_notifications.channel is
  'alfred_push (Alfred Web Push, sent by send_alfred_push), claude_push (a Claude app push notification) or '
  'inbox_item (an Alfred inbox item).';
comment on column public.claude_notifications.title is 'What Alex saw as the title.';
comment on column public.claude_notifications.body is 'What Alex saw as the text.';
comment on column public.claude_notifications.link is
  'Where it leads: an Alfred path (e.g. /inbox/<id>) for alfred_push and inbox_item; null when there is none.';
comment on column public.claude_notifications.local_date is 'Pacific date it was sent. Daily limits count by this.';
comment on column public.claude_notifications.dedupe_key is
  'Unique per user, e.g. arnold:2026-10-29:microworkout:behind_pace:10:00. A repeat insert is refused.';
comment on column public.claude_notifications.delivery_status is
  'pending (logged, not yet sent), sent, failed or no_subscription. sent means the push service or Claude accepted '
  'it, not that it arrived: Android can hold a push.';
comment on column public.claude_notifications.delivery_detail is
  'Result detail, e.g. per-endpoint push status codes, or the inbox item id. An object.';
comment on column public.claude_notifications.created_at is 'Row creation.';
comment on column public.claude_notifications.updated_at is 'Last delivery update. Stamped by the guard trigger.';

create or replace function public.claude_notifications_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (new.id, new.user_id, new.app, new.job, new.kind, new.channel, new.title, new.body, new.link, new.local_date,
      new.dedupe_key, new.created_at)
     is distinct from
     (old.id, old.user_id, old.app, old.job, old.kind, old.channel, old.title, old.body, old.link, old.local_date,
      old.dedupe_key, old.created_at) then
    raise exception 'claude_notifications: only delivery_status and delivery_detail may change. Log a new notification instead.'
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.claude_notifications_guard_update() is
  'Shared: claude_notifications rows keep what Alex saw; only delivery_status and delivery_detail may change. '
  'Stamps updated_at.';
revoke all on function public.claude_notifications_guard_update() from public, anon;

drop trigger if exists claude_notifications_guard_update on public.claude_notifications;
create trigger claude_notifications_guard_update
  before update on public.claude_notifications
  for each row execute function public.claude_notifications_guard_update();


-- ============================================================================
-- 5. arnold_create_plan — the only way to create a plan
-- ============================================================================
create or replace function public.arnold_create_plan(p_plan jsonb, p_goals jsonb)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid          uuid := auth.uid();
  v_plan_keys    text[] := array['focus', 'change_summary', 'internal_notes', 'review_instructions',
                                 'nudge_instructions', 'voice_notes', 'review_cadence_days',
                                 'notification_settings', 'prompt_templates', 'starts_on'];
  v_goal_keys    text[] := array['goal_key', 'label', 'intent_id', 'measure', 'target', 'period', 'usual_days',
                                 'pace_checkpoints', 'notes'];
  v_key          text;
  v_problem      text;
  v_prev_plan_id uuid;
  v_plan_id      uuid;
  v_goal         jsonb;
  v_pos          integer := 0;
  v_target       integer;
  v_days         text[];
  v_checkpoints  jsonb;
  v_intent       record;
begin
  if v_uid is null then
    raise exception 'arnold_create_plan: not authenticated.';
  end if;

  -- The plan
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'arnold_create_plan: the plan must be a JSON object.';
  end if;
  for v_key in select jsonb_object_keys(p_plan) loop
    if not v_key = any (v_plan_keys) then
      raise exception 'arnold_create_plan: unknown plan field "%". Allowed: %.', v_key, array_to_string(v_plan_keys, ', ');
    end if;
  end loop;
  if nullif(btrim(p_plan->>'focus'), '') is null then
    raise exception 'arnold_create_plan: focus is required.';
  end if;
  if nullif(btrim(p_plan->>'review_instructions'), '') is null then
    raise exception 'arnold_create_plan: review_instructions is required.';
  end if;
  if nullif(btrim(p_plan->>'nudge_instructions'), '') is null then
    raise exception 'arnold_create_plan: nudge_instructions is required.';
  end if;
  -- The CASE is in parentheses: PL/pgSQL ends an IF condition at the first THEN outside parentheses.
  if p_plan ? 'review_cadence_days'
     and (case when jsonb_typeof(p_plan->'review_cadence_days') = 'number' and (p_plan->>'review_cadence_days') ~ '^[0-9]+$'
               then (p_plan->>'review_cadence_days')::int not between 1 and 90
               else true end) then
    raise exception 'arnold_create_plan: review_cadence_days must be a whole number from 1 to 90.';
  end if;
  if p_plan ? 'starts_on' and (p_plan->>'starts_on') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'arnold_create_plan: starts_on must be a YYYY-MM-DD date.';
  end if;
  v_problem := arnold_notification_settings_problem(p_plan->'notification_settings');
  if v_problem is not null then
    raise exception 'arnold_create_plan: %', v_problem;
  end if;
  v_problem := arnold_prompt_templates_problem(coalesce(p_plan->'prompt_templates', '{}'::jsonb));
  if v_problem is not null then
    raise exception 'arnold_create_plan: %', v_problem;
  end if;

  -- The goals: shape only here; each is checked in full as it is inserted below.
  if p_goals is null or jsonb_typeof(p_goals) <> 'array' or jsonb_array_length(p_goals) = 0 then
    raise exception 'arnold_create_plan: goals must be a non-empty array.';
  end if;
  if jsonb_array_length(p_goals) > 20 then
    raise exception 'arnold_create_plan: a plan may have at most 20 goals (got %).', jsonb_array_length(p_goals);
  end if;

  -- Supersede the active plan. Everything below is one transaction, so any failure rolls this back too.
  select id into v_prev_plan_id
    from arnold_plans
   where user_id = v_uid and status = 'active'
   for update;

  if v_prev_plan_id is not null and nullif(btrim(p_plan->>'change_summary'), '') is null then
    raise exception 'arnold_create_plan: change_summary is required when replacing the active plan: say what changed and why.';
  end if;

  if v_prev_plan_id is not null then
    update arnold_plans set status = 'superseded', ended_at = now() where id = v_prev_plan_id;
  end if;

  insert into arnold_plans (
    starts_on, supersedes_plan_id, focus, change_summary, internal_notes, review_instructions, nudge_instructions,
    voice_notes, review_cadence_days, notification_settings, prompt_templates
  )
  values (
    coalesce((p_plan->>'starts_on')::date, (now() at time zone 'America/Los_Angeles')::date),
    v_prev_plan_id,
    btrim(p_plan->>'focus'),
    nullif(btrim(p_plan->>'change_summary'), ''),
    nullif(btrim(p_plan->>'internal_notes'), ''),
    btrim(p_plan->>'review_instructions'),
    btrim(p_plan->>'nudge_instructions'),
    nullif(btrim(p_plan->>'voice_notes'), ''),
    coalesce((p_plan->>'review_cadence_days')::smallint, 7),
    p_plan->'notification_settings',
    coalesce(p_plan->'prompt_templates', '{}'::jsonb)
  )
  returning id into v_plan_id;

  for v_goal in select value from jsonb_array_elements(p_goals) loop
    v_pos := v_pos + 1;
    if jsonb_typeof(v_goal) <> 'object' then
      raise exception 'arnold_create_plan: goal % must be a JSON object.', v_pos;
    end if;
    for v_key in select jsonb_object_keys(v_goal) loop
      if not v_key = any (v_goal_keys) then
        raise exception 'arnold_create_plan: goal %: unknown field "%". Allowed: %.',
          v_pos, v_key, array_to_string(v_goal_keys, ', ');
      end if;
    end loop;
    if coalesce(v_goal->>'goal_key', '') !~ '^[a-z][a-z0-9_]*$' then
      raise exception 'arnold_create_plan: goal %: goal_key is required, lower-case letters, digits and underscores.', v_pos;
    end if;
    if exists (select 1 from arnold_goals where plan_id = v_plan_id and goal_key = v_goal->>'goal_key') then
      raise exception 'arnold_create_plan: goal_key "%" is listed more than once.', v_goal->>'goal_key';
    end if;
    if nullif(btrim(v_goal->>'label'), '') is null then
      raise exception 'arnold_create_plan: goal "%": label is required.', v_goal->>'goal_key';
    end if;
    if coalesce(v_goal->>'measure', '') not in ('executions', 'elements') then
      raise exception 'arnold_create_plan: goal "%": measure must be executions or elements.', v_goal->>'goal_key';
    end if;
    if coalesce(v_goal->>'period', '') not in ('day', 'week') then
      raise exception 'arnold_create_plan: goal "%": period must be day or week.', v_goal->>'goal_key';
    end if;
    if (case when jsonb_typeof(v_goal->'target') = 'number' and (v_goal->>'target') ~ '^[0-9]+$'
             then (v_goal->>'target')::int not between 1 and 1000
             else true end) then
      raise exception 'arnold_create_plan: goal "%": target must be a whole number from 1 to 1000.', v_goal->>'goal_key';
    end if;
    v_target := (v_goal->>'target')::int;

    if v_goal ? 'usual_days' then
      if jsonb_typeof(v_goal->'usual_days') <> 'array' then
        raise exception 'arnold_create_plan: goal "%": usual_days must be an array like ["tue","thu"].', v_goal->>'goal_key';
      end if;
      select coalesce(array_agg(lower(d)), '{}') into v_days from jsonb_array_elements_text(v_goal->'usual_days') d;
      if not v_days <@ array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] then
        raise exception 'arnold_create_plan: goal "%": usual_days may contain only mon, tue, wed, thu, fri, sat, sun.',
          v_goal->>'goal_key';
      end if;
    else
      v_days := '{}';
    end if;

    v_checkpoints := coalesce(v_goal->'pace_checkpoints', '[]'::jsonb);
    v_problem := arnold_pace_checkpoints_problem(v_checkpoints, v_target);
    if v_problem is not null then
      raise exception 'arnold_create_plan: goal "%": %', v_goal->>'goal_key', v_problem;
    end if;

    -- RLS confines this to the caller's own intentions, so "not found" covers "not yours".
    select id, text, archived into v_intent from intents where id = v_goal->>'intent_id';
    if not found then
      raise exception 'arnold_create_plan: goal "%": intention % not found.', v_goal->>'goal_key', v_goal->>'intent_id';
    end if;
    if v_intent.archived then
      raise exception 'arnold_create_plan: goal "%": intention "%" is archived.', v_goal->>'goal_key', v_intent.text;
    end if;

    insert into arnold_goals (plan_id, position, goal_key, label, intent_id, measure, target, period, usual_days,
                              pace_checkpoints, notes)
    values (v_plan_id, v_pos, v_goal->>'goal_key', btrim(v_goal->>'label'), v_intent.id, v_goal->>'measure',
            v_target, v_goal->>'period', v_days, v_checkpoints, nullif(btrim(v_goal->>'notes'), ''));
  end loop;

  return v_plan_id;
end;
$$;

comment on function public.arnold_create_plan(jsonb, jsonb) is
'Arnold: the ONLY way to create a plan. Atomically supersedes the active plan and inserts the plan and its goals,
returning the new plan id. All-or-nothing, with plain messages: authenticated; no unknown fields on the plan or a goal;
focus, review_instructions and nudge_instructions present; change_summary present when an active plan is replaced;
notification_settings, prompt_templates and pace_checkpoints valid (the same validators as the check constraints);
goal_key unique per plan; every intention exists, is yours and is not archived. At most 20 goals.

Input shape:
p_plan:  { focus, change_summary?, internal_notes?, review_instructions, nudge_instructions, voice_notes?,
           review_cadence_days?, starts_on?, prompt_templates?,
           notification_settings: { window_start, window_end, max_nudges_per_day, max_encouragements_per_day,
                                    inbox_waiting_delay_minutes } }
p_goals: [ { goal_key, label, intent_id, measure (executions|elements), target, period (day|week),
             usual_days?, pace_checkpoints?: [ { time, count } ], notes? } ]';

revoke all on function public.arnold_create_plan(jsonb, jsonb) from public, anon;
grant execute on function public.arnold_create_plan(jsonb, jsonb) to authenticated, service_role;


-- ============================================================================
-- 6. log_claude_notification — insert once per dedupe key
-- ============================================================================
create or replace function public.log_claude_notification(
  p_app             text,
  p_job             text,
  p_kind            text,
  p_channel         text,
  p_title           text,
  p_dedupe_key      text,
  p_body            text  default null,
  p_link            text  default null,
  p_local_date      date  default null,
  p_delivery_status text  default 'pending',
  p_delivery_detail jsonb default null)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_id       uuid;
  v_existing public.claude_notifications%rowtype;
begin
  if auth.uid() is null then
    raise exception 'log_claude_notification: not authenticated.';
  end if;
  if not exists (select 1 from apps where id = p_app) then
    raise exception 'log_claude_notification: unknown app "%". Use an id from get_apps.', p_app using errcode = '22023';
  end if;

  insert into claude_notifications (app, job, kind, channel, title, body, link, local_date, dedupe_key,
                                    delivery_status, delivery_detail)
  values (p_app, btrim(p_job), p_kind, p_channel, btrim(p_title), nullif(btrim(p_body), ''), nullif(btrim(p_link), ''),
          coalesce(p_local_date, (now() at time zone 'America/Los_Angeles')::date), btrim(p_dedupe_key),
          coalesce(p_delivery_status, 'pending'), coalesce(p_delivery_detail, '{}'::jsonb))
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('created', true, 'id', v_id);
  end if;

  select * into v_existing from claude_notifications where user_id = auth.uid() and dedupe_key = btrim(p_dedupe_key);
  return jsonb_build_object('created', false, 'id', v_existing.id, 'duplicate_of', jsonb_build_object(
    'created_at', v_existing.created_at, 'channel', v_existing.channel, 'title', v_existing.title,
    'delivery_status', v_existing.delivery_status));
end;
$$;

comment on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb) is
  'Shared: log one notification in claude_notifications. Returns {created: true, id} for a new row, or {created: false, '
  'id, duplicate_of} when the caller already has a row with this dedupe_key, in which case nothing is written and the '
  'notification must not be sent. local_date defaults to today in Pacific time. Called by the log_claude_notification '
  'and send_alfred_push tools.';
revoke all on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb)
  from public, anon;
grant execute on function public.log_claude_notification(text, text, text, text, text, text, text, text, date, text, jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 7. Register: owner RLS, explicit grants (no anon), audited. goal_key and dedupe_key are not credentials.
-- ============================================================================
select platform.register_table(
  'public.arnold_plans',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Arnold. Versioned workout and wellbeing plans; immutable, one active. Written by arnold_create_plan (tier 3 tool).'
);

select platform.register_table(
  'public.arnold_goals',
  p_policy_mode     => 'owner',
  p_audited         => true,
  p_exempt          => false,
  p_notes           => 'App: Arnold. The goals of one plan; immutable. Written by arnold_create_plan.',
  p_cleared_columns => array['goal_key']
);

select platform.register_table(
  'public.claude_notifications',
  p_policy_mode     => 'owner',
  p_audited         => true,
  p_exempt          => false,
  p_notes           => 'Shared. Every notification a Claude task sends, any app; one per dedupe_key. Written by log_claude_notification and send_alfred_push (tier 1).',
  p_cleared_columns => array['dedupe_key']
);

commit;

-- ============================================================================
-- 8. Result: must say CONFORMANT. Then run supabase/tests/arnold_v1-k7m/1_verify.sql.
-- ============================================================================
select public.platform_check_conformance() as conformance;
