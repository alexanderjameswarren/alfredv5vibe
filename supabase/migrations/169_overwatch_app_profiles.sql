-- Purpose: Overwatch Step 9 (Phase 2). public.app_profiles: Alex's own notes on each app (how the nightly job reads its
-- activity, how many quiet days count as fading, and a page on what the app does today). Per user, so a tool can write
-- it under owner RLS; public.apps stays shared reference data written only by migrations. Also adds the overwatch apps row.
-- Kind: schema change (new table, one trigger function) plus one apps row
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.1. Run as one block in the SQL editor.
-- Safe to re-run: the table, trigger, registration and apps row are idempotent.
-- Then run supabase/tests/overwatch-q4n/7_app_profiles_test.sql.
-- supabase/migrations/169_overwatch_app_profiles.sql

begin;

-- ============================================================================
-- 1. The overwatch app
-- ============================================================================
-- path is set now as the spec says; the screen arrives in Phase 6. Checked 2026-10-24: nothing in the app renders
-- apps.path or button_name (pickers and the context page show name and icon only), so no button or link appears early.
insert into public.apps (id, name, description, icon, path, button_name) values
  ('overwatch', 'Overwatch',
   'What Alex has done, is doing and wants to do across every app: projects and their status, CLI project reports, '
   || 'stalls, quiet apps, ideas and parked projects, process friction, and drift between skills, tools and schedules.',
   'Radar', '/overwatch', 'Overwatch')
on conflict (id) do update set
  name        = excluded.name,
  description = excluded.description,
  icon        = excluded.icon,
  path        = excluded.path,
  button_name = excluded.button_name;

-- ============================================================================
-- 2. app_profiles
-- ============================================================================
create table if not exists public.app_profiles (
  id                       uuid        primary key default gen_random_uuid(),
  user_id                  uuid        not null default auth.uid() references auth.users (id),
  app_id                   text        not null references public.apps (id),
  activity_recipe          text,
  rhythm_days              integer,
  current_state            text,
  current_state_updated_at timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint app_profiles_one_per_app unique (user_id, app_id),
  constraint app_profiles_rhythm_days_range check (rhythm_days is null or rhythm_days between 1 and 365)
);

comment on table public.app_profiles is
  'OVERWATCH. One row per user per app: how the nightly job reads the app''s activity, how long a silence counts as '
  'quiet, and a page describing what the app does today. Per user so update_app_profile (tier 2) can write it under '
  'owner RLS; public.apps itself stays shared and migration-written. Spec: docs/technical-spec-overwatch-q4n.md 4.1.';
comment on column public.app_profiles.id is 'Row id.';
comment on column public.app_profiles.user_id is 'Owner. Owner RLS scopes every read and write.';
comment on column public.app_profiles.app_id is 'The app, an apps.id. One profile per user per app (app_profiles_one_per_app).';
comment on column public.app_profiles.activity_recipe is
  'Plain words telling the nightly job how to read this app''s activity and what counts, naming the tools to call. '
  'Example: "One row per practice day: total minutes and songs touched, from get_sam_sessions." Null: not written yet.';
comment on column public.app_profiles.rhythm_days is
  'Days of silence before the app counts as quiet, 1 to 365. Null means the app has no rhythm (Timer, Games) and is '
  'never flagged as quiet.';
comment on column public.app_profiles.current_state is
  'About one page: what the app does today, its main flows and known gaps. Rewritten after a project touching the app '
  'finishes. Markdown.';
comment on column public.app_profiles.current_state_updated_at is
  'When current_state last changed. Stamped by the app_profiles_touch trigger; writes from clients are ignored.';
comment on column public.app_profiles.created_at is 'Row creation.';
comment on column public.app_profiles.updated_at is 'Last change to any column. Stamped by the app_profiles_touch trigger.';

create or replace function public.app_profiles_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.current_state_updated_at := case when new.current_state is not null then now() end;
  elsif new.current_state is distinct from old.current_state then
    new.current_state_updated_at := now();
  else
    new.current_state_updated_at := old.current_state_updated_at;
  end if;
  return new;
end;
$$;

comment on function public.app_profiles_touch() is
  'Overwatch: stamps app_profiles.updated_at, and current_state_updated_at only when current_state changes.';
revoke all on function public.app_profiles_touch() from public, anon;

drop trigger if exists app_profiles_touch on public.app_profiles;
create trigger app_profiles_touch
  before insert or update on public.app_profiles
  for each row execute function public.app_profiles_touch();

-- ============================================================================
-- 3. Register: owner RLS, explicit grants (no anon), audited
-- ============================================================================
select platform.register_table(
  'public.app_profiles',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Per-user notes on each app: activity recipe, rhythm in days, and current state. Written by update_app_profile (tier 2); read by the nightly job.'
);

commit;

-- ============================================================================
-- 4. Result: the apps row, the table, its registration and grants, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'overwatch_app', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, icon, path, button_name from public.apps where id = 'overwatch'
    ) t),
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             col_description(a.attrelid, a.attnum) is not null as has_comment
        from pg_attribute a
       where a.attrelid = 'public.app_profiles'::regclass and a.attnum > 0 and not a.attisdropped
       order by a.attnum
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, exempt, mcp_read
        from platform.registry where table_name = 'public.app_profiles'
    ) t),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'app_profiles'
       group by grantee order by grantee
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
