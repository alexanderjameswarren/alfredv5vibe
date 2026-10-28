-- Purpose: Overwatch Step 55. Elise named the house app Wall-E: the apps row 'handyman' (migration 181) becomes
-- id 'wall_e', name 'Wall-E', keeping its description and the Hammer icon, with no screen. Nothing referenced
-- 'handyman' when Alex checked (2026-10-28), so only the apps table changes; the guard below refuses to run if a
-- reference has appeared since. The "handyman" TAG on Home items and intents means "needs a tradesperson", not this
-- app, and is left alone.
-- Kind: one-off data change (one apps row renamed; no schema change)
-- Applied: NO — not yet run.
--
-- Run as one block in the SQL editor. Safe to re-run: once 'handyman' is gone it does nothing.
-- supabase/migrations/182_overwatch_rename_wall_e.sql

begin;

do $$
declare
  v_refs text;
begin
  select string_agg(tbl || ' ' || n, ', ') into v_refs from (
    select 'contexts' as tbl, count(*) as n from public.contexts where app_id = 'handyman'
    union all select 'inbox', count(*) from public.inbox where source_app = 'handyman'
    union all select 'activity', count(*) from public.activity where app_id = 'handyman'
    union all select 'app_profiles', count(*) from public.app_profiles where app_id = 'handyman'
    union all select 'overwatch_watch', count(*) from public.overwatch_watch where app_id = 'handyman'
    union all select 'platform_inventory', count(*) from public.platform_inventory where app_id = 'handyman'
    union all select 'platform_runs', count(*) from public.platform_runs where app = 'handyman'
    union all select 'platform_schedules', count(*) from public.platform_schedules where app = 'handyman'
  ) r where n > 0;
  if v_refs is not null then
    raise exception 'Wall-E rename refused: rows still reference apps.id handyman (%). Nothing was changed.', v_refs;
  end if;
end;
$$;

insert into public.apps (id, name, description, icon, path, button_name)
select 'wall_e', 'Wall-E', description, 'Hammer', null, null from public.apps where id = 'handyman'
on conflict (id) do nothing;

delete from public.apps where id = 'handyman';

commit;

-- ============================================================================
-- Result: the wall_e row and handyman_left (must be 0)
-- ============================================================================
select json_build_object(
  'wall_e', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, icon, path, button_name, description from public.apps where id = 'wall_e'
    ) t),
  'handyman_left', (select count(*) from public.apps where id = 'handyman')
) as result;
