-- Overwatch Step 14 tool test, cleanup. Deletes only the test records, all named "OW TEST Step 14": the watch item,
-- the note, the app profile written by the test, the seen release and the friction entry. It leaves the plan alone (the
-- test never confirms a new plan, and its last call puts the checks back to empty) and only reports the checks.
-- Run as one block; every count should be 0.
-- supabase/tests/overwatch-q4n/14_cleanup_step14_test.sql

begin;

delete from public.overwatch_watch         where text like 'OW TEST Step 14%';
delete from public.overwatch_notes         where body like 'OW TEST Step 14%';
delete from public.app_profiles            where activity_recipe like 'OW TEST Step 14%';
delete from public.overwatch_seen_releases where entry_key like 'OW TEST Step 14%';
delete from public.process_friction        where what_happened like 'OW TEST Step 14%';

select json_build_object(
  'watch_left',    (select count(*) from public.overwatch_watch where text like 'OW TEST Step 14%'),
  'notes_left',    (select count(*) from public.overwatch_notes where body like 'OW TEST Step 14%'),
  'profiles_left', (select count(*) from public.app_profiles where activity_recipe like 'OW TEST Step 14%'),
  'releases_left', (select count(*) from public.overwatch_seen_releases where entry_key like 'OW TEST Step 14%'),
  'friction_left', (select count(*) from public.process_friction where what_happened like 'OW TEST Step 14%'),
  'test_checks_on_active_plan', (select count(*) from public.overwatch_plans p, jsonb_array_elements(p.checks_next_run) c
                                  where p.active and c ->> 'text' like 'OW TEST Step 14%'),
  'active_plans', (select count(*) from public.overwatch_plans where active)
) as result;

commit;
