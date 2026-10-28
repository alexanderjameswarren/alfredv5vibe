-- Overwatch Step 59: delete the UI test's data, and nothing else. Open and run the whole file once.
--
-- The four test inbox rows, the records they became (found through each row's outcome AND source_inbox_id, so
-- nothing is chosen by name alone), those records' group memberships and activity rows, and the closed test group
-- "Test s59 closing project" with its activity rows. It checks everything first and changes nothing unless every
-- check passes: four inbox rows whose text starts "Test s59", exactly three intentions and one item, every one of
-- them named "Test s59 …", and the test group named as expected with no live members.
-- The Overwatch Project and the Pinto Beans and Spanish Rice menu keep everything else.
-- supabase/tests/overwatch-q4n/30_cleanup_step59_test.sql

do $$
declare
  v_inbox   text[] := array['1d418dde-de01-424f-b512-038950434382', '0127ad09-f13a-4ac9-a134-79e0c49fb273',
                            'd7fb864c-3ee1-4cb5-84b5-485601871b47', '18e0ebf5-efe3-49bd-a64a-63462acb1de3'];
  v_group   constant text := 'mvsj5et0fpjhq48o7uh';
  v_intents text[];
  v_items   text[];
  n_members int;
  n_activity int;
  n_events  int;
begin
  -- 1. The inbox rows.
  if (select count(*) from public.inbox where id = any (v_inbox) and captured_text like 'Test s59%') <> 4 then
    raise exception 'Cleanup refused: the four inbox rows are not all there with "Test s59" text. Nothing was changed.';
  end if;

  -- 2. The records they became: outcome entries and source_inbox_id, together.
  select array_agg(distinct id) into v_intents from (
    select o->>'id' as id from public.inbox i, jsonb_array_elements(coalesce(i.outcome, '[]'::jsonb)) o
     where i.id = any (v_inbox) and o->>'table' = 'intents'
    union select id from public.intents where source_inbox_id = any (v_inbox)
  ) x;
  select array_agg(distinct id) into v_items from (
    select o->>'id' as id from public.inbox i, jsonb_array_elements(coalesce(i.outcome, '[]'::jsonb)) o
     where i.id = any (v_inbox) and o->>'table' = 'items'
    union select id from public.items where source_inbox_id = any (v_inbox)
  ) x;
  if coalesce(array_length(v_intents, 1), 0) <> 3 or coalesce(array_length(v_items, 1), 0) <> 1 then
    raise exception 'Cleanup refused: expected 3 intentions and 1 item from the test captures, found % and %. Nothing was changed.',
      coalesce(array_length(v_intents, 1), 0), coalesce(array_length(v_items, 1), 0);
  end if;
  if exists (select 1 from public.intents where id = any (v_intents) and text not like 'Test s59%')
     or exists (select 1 from public.items where id = any (v_items) and name not like 'Test s59%')
     or (select count(*) from public.intents where id = any (v_intents)) <> 3
     or (select count(*) from public.items where id = any (v_items)) <> 1 then
    raise exception 'Cleanup refused: a record from the test captures is missing or not named "Test s59 …". Nothing was changed.';
  end if;

  -- 3. The test group.
  if not exists (select 1 from public.item_groups where id = v_group and name = 'Test s59 closing project')
     or exists (select 1 from public.item_group_members where group_id = v_group and removed_at is null) then
    raise exception 'Cleanup refused: group % is not "Test s59 closing project" with no live members. Nothing was changed.', v_group;
  end if;

  -- 4. Delete: memberships, activity, events, the records, the inbox rows, the group.
  delete from public.item_group_members
   where (member_type = 'intention' and member_id = any (v_intents)) or (member_type = 'item' and member_id = any (v_items));
  get diagnostics n_members = row_count;
  delete from public.activity
   where target_id = any (v_intents || v_items) or group_id = v_group;
  get diagnostics n_activity = row_count;
  delete from public.events where source_inbox_id = any (v_inbox) or intent_id = any (v_intents);
  get diagnostics n_events = row_count;
  delete from public.intents where id = any (v_intents);
  delete from public.items where id = any (v_items);
  delete from public.inbox where id = any (v_inbox);
  delete from public.item_groups where id = v_group;

  raise notice 'Step 59 cleanup: 4 inbox rows, 3 intentions, 1 item, % group memberships, % activity rows, % events and the test group deleted.',
    n_members, n_activity, n_events;
end;
$$;
