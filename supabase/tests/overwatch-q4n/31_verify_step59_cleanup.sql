-- Overwatch Step 59: read-only check after 30_cleanup_step59_test.sql. Paste back the single result cell.
-- Expected: every test_rows_left count 0; Overwatch's live members are just its overview item; the Pinto Beans and
-- Spanish Rice menu's live members are its two recipes.
-- supabase/tests/overwatch-q4n/31_verify_step59_cleanup.sql

select json_build_object(
  'test_rows_left', (select coalesce(json_agg(t), '[]'::json) from (
      select
        (select count(*) from public.inbox where id in ('1d418dde-de01-424f-b512-038950434382',
           '0127ad09-f13a-4ac9-a134-79e0c49fb273', 'd7fb864c-3ee1-4cb5-84b5-485601871b47',
           '18e0ebf5-efe3-49bd-a64a-63462acb1de3')) as inbox_rows,
        (select count(*) from public.intents where source_inbox_id in ('1d418dde-de01-424f-b512-038950434382',
           '0127ad09-f13a-4ac9-a134-79e0c49fb273', 'd7fb864c-3ee1-4cb5-84b5-485601871b47',
           '18e0ebf5-efe3-49bd-a64a-63462acb1de3') or text like 'Test s59%') as intentions,
        (select count(*) from public.items where source_inbox_id in ('1d418dde-de01-424f-b512-038950434382',
           '0127ad09-f13a-4ac9-a134-79e0c49fb273', 'd7fb864c-3ee1-4cb5-84b5-485601871b47',
           '18e0ebf5-efe3-49bd-a64a-63462acb1de3') or name like 'Test s59%') as items,
        (select count(*) from public.item_group_members m
          where m.group_id in ('mvnv8pa2v6zip3xnpm', 'mvsimct1j1mmclmvjl9')
            and ((m.member_type = 'intention' and not exists (select 1 from public.intents i where i.id = m.member_id))
              or (m.member_type = 'item' and not exists (select 1 from public.items i where i.id = m.member_id))))
          as orphan_members_in_the_two_groups,
        (select count(*) from public.item_groups where id = 'mvsj5et0fpjhq48o7uh') as test_group
    ) t),
  'overwatch_members', (select coalesce(json_agg(t), '[]'::json) from (
      select m.member_type, m.position, coalesce(i.name, n.text) as name
        from public.item_group_members m
        left join public.items i on m.member_type = 'item' and i.id = m.member_id
        left join public.intents n on m.member_type = 'intention' and n.id = m.member_id
       where m.group_id = 'mvnv8pa2v6zip3xnpm' and m.removed_at is null
       order by m.position
    ) t),
  'pinto_menu_members', (select coalesce(json_agg(t), '[]'::json) from (
      select m.member_type, m.position, coalesce(i.name, n.text) as name
        from public.item_group_members m
        left join public.items i on m.member_type = 'item' and i.id = m.member_id
        left join public.intents n on m.member_type = 'intention' and n.id = m.member_id
       where m.group_id = 'mvsimct1j1mmclmvjl9' and m.removed_at is null
       order by m.position
    ) t)
) as result;
