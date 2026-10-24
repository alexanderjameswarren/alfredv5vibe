-- Purpose: Overwatch Step 12 (Phase 2). Overwatch's own tables: overwatch_plans (the rulebook: one active row, seeded
-- with the starting plan, superseded only through create_overwatch_plan; checks_next_run replaced only through
-- update_overwatch_checks), overwatch_watch (dated adjustments), overwatch_notes (the nightly and weekly notes),
-- overwatch_seen_releases (release-note entries already seen) and process_friction (snags in how the work runs).
-- Kind: schema change (five new tables, two RPCs, one trigger function) plus one seeded row
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md sections 4.6 to 4.8, 4.10 and 4.11. Run as one block in the SQL editor.
-- Then run supabase/tests/overwatch-q4n/11_overwatch_plans_test.sql.
-- Safe to re-run: every create is idempotent, and the starting plan is seeded only when the user has no plan at all.
-- supabase/migrations/172_overwatch_plans.sql

begin;

-- ============================================================================
-- 1. overwatch_plans
-- ============================================================================
create table if not exists public.overwatch_plans (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null default auth.uid() references auth.users (id),
  active          boolean     not null default true,
  instructions    text        not null,
  settings        jsonb       not null default '{}'::jsonb,
  checks_next_run jsonb       not null default '[]'::jsonb,
  written_by      text        not null default 'alex',
  reason          text,
  supersedes_id   uuid        references public.overwatch_plans (id),
  created_at      timestamptz not null default now(),

  constraint overwatch_plans_settings_object check (jsonb_typeof(settings) = 'object'),
  constraint overwatch_plans_checks_array check (jsonb_typeof(checks_next_run) = 'array'),
  constraint overwatch_plans_written_by_values check (written_by in ('alex', 'overwatch'))
);

-- Exactly one active plan per user.
create unique index if not exists overwatch_plans_one_active on public.overwatch_plans (user_id) where active;

comment on table public.overwatch_plans is
  'OVERWATCH. The rulebook: instructions (focus, what to watch, tone), settings (limits and times) and the checks for '
  'the next run. Rows are only inserted; exactly one is active (overwatch_plans_one_active). A change supersedes the '
  'active row through create_overwatch_plan; checks_next_run is the one field changed in place, through '
  'update_overwatch_checks. overwatch_plans_guard enforces both. Spec: docs/technical-spec-overwatch-q4n.md 4.6.';
comment on column public.overwatch_plans.id is 'Row id.';
comment on column public.overwatch_plans.user_id is 'Owner. Owner RLS.';
comment on column public.overwatch_plans.active is
  'True on the one plan in force. Goes false only when create_overwatch_plan supersedes it; never back to true.';
comment on column public.overwatch_plans.instructions is 'Plain text: what to focus on, what to watch, and the tone.';
comment on column public.overwatch_plans.settings is
  'A JSON object of limits and times: active_project_limit, limit_mode, pushes_per_day, push_time, stall_days, '
  'waiting_on_alex_days, fading_days, overrun_factor, inbox_backlog_threshold, weekly_day, audit_every_weeks.';
comment on column public.overwatch_plans.checks_next_run is
  'A JSON array of { text, check_on (date), about (app id or group id) }: what the next run should look at. The '
  'nightly job replaces it through update_overwatch_checks.';
comment on column public.overwatch_plans.written_by is 'alex, or overwatch when the nightly job''s proposal was accepted.';
comment on column public.overwatch_plans.reason is 'Why this plan replaced the one before.';
comment on column public.overwatch_plans.supersedes_id is 'The plan this one replaced, or null for the first.';
comment on column public.overwatch_plans.created_at is 'When this plan was written.';

create or replace function public.overwatch_plans_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.id is distinct from old.id or new.user_id is distinct from old.user_id
     or new.instructions is distinct from old.instructions or new.settings is distinct from old.settings
     or new.written_by is distinct from old.written_by or new.reason is distinct from old.reason
     or new.supersedes_id is distinct from old.supersedes_id or new.created_at is distinct from old.created_at then
    raise exception 'overwatch_plans rows are not edited: write a new plan with create_overwatch_plan.'
      using errcode = '23514';
  end if;
  if new.active and not old.active then
    raise exception 'overwatch_plans: a superseded plan cannot become active again; write a new plan instead.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.overwatch_plans_guard() is
  'Overwatch: on overwatch_plans only active (true to false) and checks_next_run may change.';
revoke all on function public.overwatch_plans_guard() from public, anon;

drop trigger if exists overwatch_plans_guard on public.overwatch_plans;
create trigger overwatch_plans_guard
  before update on public.overwatch_plans
  for each row execute function public.overwatch_plans_guard();

-- ============================================================================
-- 2. The two RPCs (caller's own rows, under RLS)
-- ============================================================================
create or replace function public.create_overwatch_plan(
  p_instructions text,
  p_settings     jsonb,
  p_reason       text,
  p_written_by   text  default 'alex',
  p_checks       jsonb default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_old public.overwatch_plans%rowtype;
  v_new public.overwatch_plans%rowtype;
begin
  if coalesce(trim(p_instructions), '') = '' then
    raise exception 'create_overwatch_plan: instructions are required.' using errcode = '22023';
  end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'create_overwatch_plan: settings must be a JSON object.' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'create_overwatch_plan: a reason is required.' using errcode = '22023';
  end if;

  -- Lock the active plan so two writers cannot both supersede it.
  select * into v_old from public.overwatch_plans where user_id = auth.uid() and active for update;
  if v_old.id is not null then
    update public.overwatch_plans set active = false where id = v_old.id;
  end if;

  insert into public.overwatch_plans (instructions, settings, checks_next_run, written_by, reason, supersedes_id)
  values (p_instructions, p_settings, coalesce(p_checks, v_old.checks_next_run, '[]'::jsonb),
          coalesce(p_written_by, 'alex'), p_reason, v_old.id)
  returning * into v_new;
  return to_jsonb(v_new);
end;
$$;

comment on function public.create_overwatch_plan(text, jsonb, text, text, jsonb) is
  'Overwatch: supersede the caller''s active plan in one transaction: the old row goes inactive, the new one is inserted '
  'with supersedes_id, carrying the old checks_next_run unless p_checks is given. Returns the new row. Called by the '
  'tier-3 create_overwatch_plan tool.';
revoke all on function public.create_overwatch_plan(text, jsonb, text, text, jsonb) from public, anon;
grant execute on function public.create_overwatch_plan(text, jsonb, text, text, jsonb) to authenticated, service_role;

create or replace function public.update_overwatch_checks(p_checks jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_row public.overwatch_plans%rowtype;
  v_bad int;
begin
  if p_checks is null or jsonb_typeof(p_checks) <> 'array' then
    raise exception 'update_overwatch_checks: checks must be a JSON array.' using errcode = '22023';
  end if;
  select count(*) into v_bad
    from jsonb_array_elements(p_checks) c
   where jsonb_typeof(c) <> 'object'
      or coalesce(trim(c ->> 'text'), '') = ''
      or coalesce(c ->> 'check_on', '') !~ '^\d{4}-\d{2}-\d{2}$';
  if v_bad > 0 then
    raise exception 'update_overwatch_checks: % check(s) lack text or a check_on date (YYYY-MM-DD).', v_bad
      using errcode = '22023';
  end if;

  update public.overwatch_plans set checks_next_run = p_checks
   where user_id = auth.uid() and active
  returning * into v_row;
  if v_row.id is null then
    raise exception 'update_overwatch_checks: there is no active plan.' using errcode = 'P0002';
  end if;
  return to_jsonb(v_row);
end;
$$;

comment on function public.update_overwatch_checks(jsonb) is
  'Overwatch: replace checks_next_run on the caller''s active plan. Each check needs text and a check_on date. Returns '
  'the plan. Called by the tier-2 update_overwatch_checks tool.';
revoke all on function public.update_overwatch_checks(jsonb) from public, anon;
grant execute on function public.update_overwatch_checks(jsonb) to authenticated, service_role;

-- ============================================================================
-- 3. overwatch_watch
-- ============================================================================
create table if not exists public.overwatch_watch (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null default auth.uid() references auth.users (id),
  kind            text        not null,
  text            text        not null,
  app_id          text        references public.apps (id),
  group_id        text        references public.item_groups (id) on delete cascade,
  starts_on       date        not null default current_date,
  ends_on         date        not null,
  created_by      text        not null default 'alex',
  expiry_noted_at timestamptz,
  created_at      timestamptz not null default now(),

  constraint overwatch_watch_kind_values check (kind in ('focus', 'ease_off', 'keep_an_eye_on')),
  constraint overwatch_watch_dates check (ends_on >= starts_on),
  constraint overwatch_watch_created_by_values check (created_by in ('alex', 'overwatch'))
);

comment on table public.overwatch_watch is
  'OVERWATCH. Short-term adjustments with dates: focus on something, ease off something (an app''s quiet days stop '
  'counting), or keep an eye on something. Spec: docs/technical-spec-overwatch-q4n.md 4.7.';
comment on column public.overwatch_watch.id is 'Row id.';
comment on column public.overwatch_watch.user_id is 'Owner. Owner RLS.';
comment on column public.overwatch_watch.kind is 'focus, ease_off or keep_an_eye_on.';
comment on column public.overwatch_watch.text is 'What it is about, in plain words.';
comment on column public.overwatch_watch.app_id is 'The app it is about, or null.';
comment on column public.overwatch_watch.group_id is 'The Project group it is about, or null. Deleting the group deletes it.';
comment on column public.overwatch_watch.starts_on is 'First day it applies.';
comment on column public.overwatch_watch.ends_on is 'Last day it applies; never before starts_on.';
comment on column public.overwatch_watch.created_by is 'alex or overwatch.';
comment on column public.overwatch_watch.expiry_noted_at is 'Set once a note has mentioned that it expired, so it is said once.';
comment on column public.overwatch_watch.created_at is 'Row creation.';

create index if not exists overwatch_watch_user_ends_idx on public.overwatch_watch (user_id, ends_on);

-- ============================================================================
-- 4. overwatch_notes
-- ============================================================================
create table if not exists public.overwatch_notes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users (id),
  period     text        not null,
  for_date   date        not null,
  body       text        not null,
  flags      jsonb       not null default '{}'::jsonb,
  plan_id    uuid        references public.overwatch_plans (id),
  created_at timestamptz not null default now(),

  constraint overwatch_notes_period_values check (period in ('nightly', 'weekly')),
  constraint overwatch_notes_flags_object check (jsonb_typeof(flags) = 'object'),
  constraint overwatch_notes_once unique (user_id, period, for_date)
);

comment on table public.overwatch_notes is
  'OVERWATCH. The notes the tab shows, kept as history: one nightly and at most one weekly note per day. A re-run '
  'replaces the day''s note (create_overwatch_note upserts). Spec: docs/technical-spec-overwatch-q4n.md 4.8.';
comment on column public.overwatch_notes.id is 'Row id.';
comment on column public.overwatch_notes.user_id is 'Owner. Owner RLS.';
comment on column public.overwatch_notes.period is 'nightly or weekly.';
comment on column public.overwatch_notes.for_date is 'The day the note is for.';
comment on column public.overwatch_notes.body is 'The note, in markdown.';
comment on column public.overwatch_notes.flags is
  'A JSON object of structured findings (quiet apps, stalls, backlogs, over-limit, stopped schedules, friction) so the '
  'tab can render them without parsing prose.';
comment on column public.overwatch_notes.plan_id is 'The plan that was active when the note was written.';
comment on column public.overwatch_notes.created_at is 'When the note was written.';

-- ============================================================================
-- 5. overwatch_seen_releases
-- ============================================================================
create table if not exists public.overwatch_seen_releases (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  source        text        not null,
  entry_key     text        not null,
  title         text        not null,
  summary       text,
  first_seen_at timestamptz not null default now(),

  constraint overwatch_seen_releases_source_values
    check (source in ('claude_release_notes', 'claude_code_changelog', 'api_release_notes')),
  constraint overwatch_seen_releases_once unique (user_id, source, entry_key)
);

comment on table public.overwatch_seen_releases is
  'OVERWATCH. Release-note entries the weekly feature watch has already seen, so each is reported once. '
  'Spec: docs/technical-spec-overwatch-q4n.md 4.10.';
comment on column public.overwatch_seen_releases.id is 'Row id.';
comment on column public.overwatch_seen_releases.user_id is 'Owner. Owner RLS.';
comment on column public.overwatch_seen_releases.source is 'claude_release_notes, claude_code_changelog or api_release_notes.';
comment on column public.overwatch_seen_releases.entry_key is
  'The entry''s identity within its source (a version, date or heading). Not a credential: cleared for conformance.';
comment on column public.overwatch_seen_releases.title is 'The entry''s heading.';
comment on column public.overwatch_seen_releases.summary is 'A line on what it changes, or null.';
comment on column public.overwatch_seen_releases.first_seen_at is 'When the weekly job first recorded it.';

-- ============================================================================
-- 6. process_friction
-- ============================================================================
create table if not exists public.process_friction (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  occurred_at   timestamptz not null default now(),
  what_happened text        not null,
  process       text        not null,
  project_code  text,
  suggested_fix text,
  pattern_id    uuid,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),

  constraint process_friction_process_values
    check (process in ('cli_testing_steps', 'cli_prompt', 'todos', 'closeout', 'inbox', 'other')
           or process ~ '^skill:[a-z0-9_-]{1,60}$'),
  constraint process_friction_code_format check (project_code is null or project_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint process_friction_resolved_pair check ((resolved_by is null) = (resolved_at is null))
);

comment on table public.process_friction is
  'OVERWATCH. Snags in how the work runs: a missed instruction, a testing format that confused Alex, a prompt he had '
  'to correct, a step that caused a redo. Any thread logs one with log_friction, without asking. Fixes wait for a '
  'pattern: the weekly job groups open entries by process and proposes a fix once a process has three or more in 30 '
  'days. Spec: docs/technical-spec-overwatch-q4n.md 4.11.';
comment on column public.process_friction.id is 'Row id.';
comment on column public.process_friction.user_id is 'Owner. Owner RLS.';
comment on column public.process_friction.occurred_at is 'When the snag happened.';
comment on column public.process_friction.what_happened is 'What happened, in plain words.';
comment on column public.process_friction.process is
  'Which process: cli_testing_steps, cli_prompt, todos, closeout, inbox, other, or skill:<name>.';
comment on column public.process_friction.project_code is 'The CLI project code it happened in, or null.';
comment on column public.process_friction.suggested_fix is 'A fix suggested at the time, or null.';
comment on column public.process_friction.pattern_id is
  'Set when the weekly job groups entries into one pattern; entries sharing it are fixed together.';
comment on column public.process_friction.resolved_by is
  'What fixed it (a skill change, a prompt change), set with resolved_at when the pattern is resolved.';
comment on column public.process_friction.resolved_at is 'When it was resolved; null while open.';
comment on column public.process_friction.created_at is 'When the entry was written.';

create index if not exists process_friction_open_idx
  on public.process_friction (user_id, process, occurred_at desc) where resolved_at is null;

-- ============================================================================
-- 7. Register all five: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table('public.overwatch_plans', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. The rulebook; one active row. Superseded via create_overwatch_plan (tier 3), checks via update_overwatch_checks (tier 2).');
select platform.register_table('public.overwatch_watch', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. Dated focus, ease_off and keep_an_eye_on adjustments.');
select platform.register_table('public.overwatch_notes', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. The nightly and weekly notes, one per period per day.');
select platform.register_table('public.overwatch_seen_releases', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. Release-note entries already seen by the weekly feature watch.',
  p_cleared_columns => array['entry_key']);
select platform.register_table('public.process_friction', p_policy_mode => 'owner', p_audited => true, p_exempt => false,
  p_notes => 'App: Overwatch. Snags in how the work runs, logged by any thread with log_friction.');

-- ============================================================================
-- 8. The starting plan (the 091 pattern: the user from the Money context)
-- ============================================================================
insert into public.overwatch_plans (user_id, active, instructions, settings, written_by, reason)
select c.user_id, true,
  'Keep Alex aware of what he did, what he is doing and what he wants to do, across every app. Each night, write one '
  || 'short note: what got done, what is moving, what has stalled or gone quiet, and what needs him. Watch active '
  || 'projects against the limit, stalls, waits on Alex, overruns, inbox backlogs per app, fading items, stopped '
  || 'schedules, repeated claim blocks and process friction. Send at most pushes_per_day nudges, most important first. '
  || 'Tone: plain, direct and friendly; pushy within these limits, never about the same thing twice in a day. Changes '
  || 'to these instructions or settings come to Alex as a task inbox item with a paste-ready prompt.',
  '{"active_project_limit": 3, "limit_mode": "soft", "pushes_per_day": 1, "push_time": "07:30", "stall_days": 5,
    "waiting_on_alex_days": 3, "fading_days": 30, "overrun_factor": 1.5, "inbox_backlog_threshold": 5,
    "weekly_day": "monday", "audit_every_weeks": 2}'::jsonb,
  'alex', 'Starting plan (Overwatch Step 12, spec 4.6).'
from public.contexts c
where c.id = 'muvitejhrgt3rgi8t6q'
  and not exists (select 1 from public.overwatch_plans p where p.user_id = c.user_id);

commit;

-- ============================================================================
-- 9. Result: the five tables, the active plan, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'tables', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attrelid::regclass::text as table_name, count(*) as columns,
             count(*) filter (where col_description(a.attrelid, a.attnum) is null) as without_comment
        from pg_attribute a
       where a.attrelid in ('public.overwatch_plans'::regclass, 'public.overwatch_watch'::regclass,
                            'public.overwatch_notes'::regclass, 'public.overwatch_seen_releases'::regclass,
                            'public.process_friction'::regclass)
         and a.attnum > 0 and not a.attisdropped
       group by 1 order by 1
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, mcp_read, cleared_columns from platform.registry
       where table_name in ('public.overwatch_plans', 'public.overwatch_watch', 'public.overwatch_notes',
                            'public.overwatch_seen_releases', 'public.process_friction') order by 1
    ) t),
  'active_plan', (select coalesce(json_agg(t), '[]'::json) from (
      select id, written_by, reason, settings ->> 'push_time' as push_time, jsonb_array_length(checks_next_run) as checks
        from public.overwatch_plans where active
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
