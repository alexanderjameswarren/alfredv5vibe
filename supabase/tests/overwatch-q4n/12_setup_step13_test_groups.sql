-- Overwatch Step 13 tool test, setup. Creates two Project groups for the claude.ai tool test:
-- "OW TEST Step 13 A" (ow-test-step13-a) and "OW TEST Step 13 B" (ow-test-step13-b), active, owned by the user of the
-- Money context. Nothing else. Safe to re-run. Remove them with 13_cleanup_step13_test.sql.
-- supabase/tests/overwatch-q4n/12_setup_step13_test_groups.sql

insert into public.item_groups (id, user_id, group_type_id, name, status)
select v.id, c.user_id,
       (select t.id from public.group_types t where t.kind = 'project' order by t.created_at limit 1),
       v.name, 'active'
  from public.contexts c
 cross join (values ('ow-test-step13-a', 'OW TEST Step 13 A'), ('ow-test-step13-b', 'OW TEST Step 13 B')) as v(id, name)
 where c.id = 'muvitejhrgt3rgi8t6q'
on conflict (id) do nothing;

select json_build_object(
  'test_groups', (select coalesce(json_agg(t), '[]'::json) from (
      select g.id, g.name, g.status, t.kind
        from public.item_groups g join public.group_types t on t.id = g.group_type_id
       where g.id like 'ow-test-step13-%' order by g.id
    ) t)
) as result;
