-- Purpose: Overwatch Step 5. platform_runs.app and platform_schedules.app stop being a fixed six-app check and become a
-- foreign key to apps(id), so every app in the apps table (drive_mix, jobs, overwatch and any added later) can log runs
-- and have a schedule. The MCP tools' app input follows in the same step: free text, checked against apps.
-- Kind: schema change (two check constraints replaced by two foreign keys; two column comments)
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.1. Run as one block in the SQL editor, BEFORE deploying mcp: the
-- new tools accept app ids the old checks would refuse. Deploying first only means such a call fails on the check.
-- Safe to re-run: the drops are if-exists and each key is added only when missing.
-- supabase/migrations/166_overwatch_platform_app_fk.sql

begin;

-- ============================================================================
-- 1. Every app value already in use must be an apps row (else the keys cannot be added)
-- ============================================================================
do $$
declare
  stray text;
begin
  select string_agg(distinct x.app, ', ') into stray
    from (select app from public.platform_runs union select app from public.platform_schedules) x
   where not exists (select 1 from public.apps a where a.id = x.app);
  if stray is not null then
    raise exception 'platform_runs / platform_schedules use app values with no apps row: %. Add the apps rows first.', stray;
  end if;
end
$$;

-- ============================================================================
-- 2. Replace the checks with foreign keys
-- ============================================================================
alter table public.platform_runs      drop constraint if exists platform_runs_app_check;
alter table public.platform_schedules drop constraint if exists platform_schedules_app_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_runs'::regclass and conname = 'platform_runs_app_fkey'
  ) then
    alter table public.platform_runs
      add constraint platform_runs_app_fkey foreign key (app) references public.apps (id);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.platform_schedules'::regclass and conname = 'platform_schedules_app_fkey'
  ) then
    alter table public.platform_schedules
      add constraint platform_schedules_app_fkey foreign key (app) references public.apps (id);
  end if;
end
$$;

comment on column public.platform_runs.app is
  'The app this job belongs to: an apps.id (platform_runs_app_fkey). A key rather than free text so a typo fails '
  'loudly instead of creating a row no staleness query will ever match. Adding an app is a new apps row; nothing '
  'here changes. Replaced the fixed six-app check in Overwatch Step 5.';
comment on column public.platform_schedules.app is
  'The app this job belongs to: an apps.id (platform_schedules_app_fkey), matching platform_runs.app. Replaced the '
  'fixed six-app check in Overwatch Step 5.';

commit;

-- ============================================================================
-- 3. Result: the new keys, no old checks left, and conformance (must say CONFORMANT)
-- ============================================================================
-- No register_table call: both tables are registered, and changing a constraint does not re-register a table.
select json_build_object(
  'app_constraints', (select coalesce(json_agg(t), '[]'::json) from (
      select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition
        from pg_constraint
       where conrelid in ('public.platform_runs'::regclass, 'public.platform_schedules'::regclass)
         and conname in ('platform_runs_app_check', 'platform_schedules_app_check',
                         'platform_runs_app_fkey', 'platform_schedules_app_fkey')
       order by 1, 2
    ) t),
  'apps_in_use', (select coalesce(json_agg(t), '[]'::json) from (
      select app, count(*) as rows
        from (select app from public.platform_runs union all select app from public.platform_schedules) x
       group by app order by app
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
