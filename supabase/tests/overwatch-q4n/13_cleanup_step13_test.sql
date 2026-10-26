-- Overwatch Step 13 tool test, cleanup. Deletes only what the test made: activity rows with source_ref starting
-- ow-test-step13, and the two test Project groups (their plan and links go with them). Run as one block; returns
-- what is left, which should be nothing.
-- supabase/tests/overwatch-q4n/13_cleanup_step13_test.sql

begin;

delete from public.activity where source_ref like 'ow-test-step13%';
delete from public.item_groups where id in ('ow-test-step13-a', 'ow-test-step13-b');

select json_build_object(
  'activity_left', (select count(*) from public.activity where source_ref like 'ow-test-step13%'),
  'groups_left', (select count(*) from public.item_groups where id like 'ow-test-step13-%'),
  'plans_left', (select count(*) from public.project_plans where group_id like 'ow-test-step13-%'),
  'links_left', (select count(*) from public.project_links
                  where from_group_id like 'ow-test-step13-%' or to_group_id like 'ow-test-step13-%')
) as result;

commit;
