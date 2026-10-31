-- Purpose: Arnold V1 (written step 8b, run step 8c). claude_notification_settings: the shared
-- window and caps the Claude hourly notifications task applies on top of each app's own limits, and which apps take
-- part. Also gives the arnold app its description.
-- Kind: schema change (one new table, two functions, one trigger) plus one apps row update
-- Applied: NO
--
-- Spec: docs/arnold_v1-technical-spec.md section 3.6. Run as one block in the SQL editor, then run
-- supabase/tests/arnold_v1-k7m/3_notification_settings_verify.sql.
-- Safe to re-run: every create is if-not-exists or create-or-replace, and the trigger is dropped first.
-- supabase/migrations/188_arnold_v1_claude_notification_settings.sql

begin;

-- ============================================================================
-- 1. Validator. Null when valid, else a plain message; the check constraint and the guard trigger both use it.
-- ============================================================================
create or replace function public.claude_notification_settings_problem(
  p_window_start text, p_window_end text, p_max_per_hour integer, p_max_per_day integer, p_apps jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_entry jsonb;
  v_seen  text[] := array[]::text[];
  v_key   text;
begin
  if p_window_start is null or p_window_end is null
     or p_window_start !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or p_window_end !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    return 'window_start and window_end must be HH:MM times, e.g. "05:00".';
  end if;
  if p_window_start >= p_window_end then
    return 'window_start must be before window_end.';
  end if;
  if p_max_per_hour is null or p_max_per_hour not between 0 and 24 then
    return 'max_per_hour must be a whole number from 0 to 24.';
  end if;
  if p_max_per_day is not null and p_max_per_day not between 0 and 200 then
    return 'max_per_day must be empty (no daily cap) or a whole number from 0 to 200.';
  end if;
  if p_apps is null or jsonb_typeof(p_apps) <> 'array' then
    return 'apps must be an array (empty for none).';
  end if;
  if jsonb_array_length(p_apps) > 50 then
    return 'apps may list at most 50 apps.';
  end if;
  for v_entry in select value from jsonb_array_elements(p_apps) loop
    -- Separate ifs: SQL does not promise to short-circuit, and the later tests fail on the wrong type.
    if jsonb_typeof(v_entry) <> 'object' then
      return 'each apps entry must be exactly {"app", "enabled", "plan_tool", "progress_tool"}.';
    end if;
    if (select count(*) from jsonb_object_keys(v_entry)) <> 4
       or not (v_entry ? 'app' and v_entry ? 'enabled' and v_entry ? 'plan_tool' and v_entry ? 'progress_tool') then
      return 'each apps entry must be exactly {"app", "enabled", "plan_tool", "progress_tool"}.';
    end if;
    if jsonb_typeof(v_entry->'app') <> 'string' or (v_entry->>'app') !~ '^[a-z][a-z0-9_]*$' then
      return format('apps entry app "%s" must be an app id: lower-case letters, digits and underscores.', v_entry->>'app');
    end if;
    if (v_entry->>'app') = any (v_seen) then
      return format('apps lists "%s" twice.', v_entry->>'app');
    end if;
    v_seen := v_seen || (v_entry->>'app');
    if jsonb_typeof(v_entry->'enabled') <> 'boolean' then
      return format('apps entry %s: enabled must be true or false.', v_entry->>'app');
    end if;
    foreach v_key in array array['plan_tool', 'progress_tool'] loop
      if jsonb_typeof(v_entry->v_key) <> 'string' or (v_entry->>v_key) !~ '^[a-z][a-z0-9_]*$' then
        return format('apps entry %s: %s must be a tool name in snake_case, e.g. get_arnold_plan.', v_entry->>'app', v_key);
      end if;
    end loop;
  end loop;
  return null;
end;
$$;

comment on function public.claude_notification_settings_problem(text, text, integer, integer, jsonb) is
  'Shared: null when a claude_notification_settings row is valid, else a plain message. Window HH:MM with start before '
  'end; max_per_hour 0-24; max_per_day null or 0-200; apps an array of at most 50 {app, enabled, plan_tool, '
  'progress_tool}, each app once, tool names snake_case.';
-- Functions in check constraints run with the inserting user's rights.
revoke all on function public.claude_notification_settings_problem(text, text, integer, integer, jsonb) from public, anon;
grant execute on function public.claude_notification_settings_problem(text, text, integer, integer, jsonb)
  to authenticated, service_role;


-- ============================================================================
-- 2. claude_notification_settings: one row per user.
-- ============================================================================
create table if not exists public.claude_notification_settings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id),
  window_start text not null default '05:00',
  window_end   text not null default '20:00',
  max_per_hour integer not null default 3,
  max_per_day  integer,
  apps         jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint claude_notification_settings_one_per_user unique (user_id),
  constraint claude_notification_settings_valid
    check (public.claude_notification_settings_problem(window_start, window_end, max_per_hour, max_per_day, apps) is null)
);

comment on table public.claude_notification_settings is
  'SHARED. The window and caps the Claude hourly notifications task applies across every app, on top of each app''s '
  'own limits, and which apps take part. One row per user. Caps count push notifications (alfred_push, claude_push) '
  'with status pending or sent in claude_notifications. Notifications are sent separately, never combined. Read and '
  'written by get_ and update_claude_notification_settings. Spec: docs/arnold_v1-technical-spec.md 3.6.';
comment on column public.claude_notification_settings.id is 'Row id.';
comment on column public.claude_notification_settings.user_id is 'Owner. Owner RLS; one row per user.';
comment on column public.claude_notification_settings.window_start is
  'HH:MM Pacific. No push is sent before this time, whatever an app''s own window says.';
comment on column public.claude_notification_settings.window_end is
  'HH:MM Pacific, after window_start. No push is sent after this time.';
comment on column public.claude_notification_settings.max_per_hour is
  'Most pushes in one clock hour across all apps, 0 to 24. 0 stops them all.';
comment on column public.claude_notification_settings.max_per_day is
  'Most pushes in one Pacific day across all apps, 0 to 200. Empty: no shared daily cap (each app''s own limits apply).';
comment on column public.claude_notification_settings.apps is
  'Apps the hourly task serves: [{app, enabled, plan_tool, progress_tool}]. app is an apps.id; plan_tool and '
  'progress_tool are the MCP tools it reads for that app, e.g. get_arnold_plan and get_arnold_progress.';
comment on column public.claude_notification_settings.created_at is 'Row creation.';
comment on column public.claude_notification_settings.updated_at is 'Last change. Stamped by the guard trigger.';

create or replace function public.claude_notification_settings_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_problem text;
  v_app     text;
begin
  v_problem := claude_notification_settings_problem(new.window_start, new.window_end, new.max_per_hour,
                                                    new.max_per_day, new.apps);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '23514';
  end if;
  select e->>'app' into v_app
    from jsonb_array_elements(new.apps) e
   where not exists (select 1 from apps a where a.id = e->>'app')
   limit 1;
  if v_app is not null then
    raise exception 'unknown app "%". Use an id from get_apps.', v_app using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' then
    new.user_id    := old.user_id;
    new.created_at := old.created_at;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

comment on function public.claude_notification_settings_guard() is
  'Shared: before insert or update on claude_notification_settings. Raises the validator''s message, refuses an app '
  'id not in apps, keeps user_id and created_at fixed and stamps updated_at.';
revoke all on function public.claude_notification_settings_guard() from public, anon;

drop trigger if exists claude_notification_settings_guard on public.claude_notification_settings;
create trigger claude_notification_settings_guard
  before insert or update on public.claude_notification_settings
  for each row execute function public.claude_notification_settings_guard();


-- ============================================================================
-- 3. The arnold app's description, which enrichment reads to route captures.
-- ============================================================================
update public.apps
   set description = 'Workouts, movement and wellbeing: gym classes, exercise sessions, sleep and fitness goals.'
 where id = 'arnold';


-- ============================================================================
-- 4. Register: owner RLS, explicit grants (no anon), audited.
-- ============================================================================
select platform.register_table(
  'public.claude_notification_settings',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'Shared. The Claude hourly notifications window, caps and participating apps; one row per user. Written by update_claude_notification_settings (tier 2).'
);

grant select, insert, update, delete on public.claude_notification_settings to authenticated, service_role;

commit;

-- ============================================================================
-- 5. Result: must say CONFORMANT. Then run supabase/tests/arnold_v1-k7m/3_notification_settings_verify.sql.
-- ============================================================================
select public.platform_check_conformance() as conformance;
