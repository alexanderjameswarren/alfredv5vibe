-- Overwatch Step 57: inbox.suggested_group_id, inbox_check_suggested_group and process_inbox_item's group key.
-- Run after migration 184. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE, so nothing it writes is kept. It works as the user who owns the Money context
-- (Alex): makes a Project, a Menu, a Background, a closed and an archived group, one group owned by another user (when
-- there is one), and a few inbox captures.
-- The error starts "INBOX SUGGESTED GROUP TEST PASSED" or "INBOX SUGGESTED GROUP TEST FAILED".
-- supabase/tests/overwatch-q4n/28_inbox_suggested_group_test.sql

do $$
declare
  v_uid      uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_other    uuid;
  v_project  text := (select id from public.group_types where kind = 'project' order by created_at limit 1);
  v_menu_t   text := (select id from public.group_types where kind = 'menu' order by created_at limit 1);
  v_res      jsonb := '{}'::jsonb;
  v_failed   text;
  v_err      text;
  v_proj     text;
  v_menu     text;
  v_bg       text;
  v_closed   text;
  v_archived text;
  v_theirs   text;
  r          jsonb;
begin
  -- Another user's group, written before switching to Alex (RLS would hide it from him).
  select id into v_other from auth.users where id <> v_uid order by created_at limit 1;
  if v_other is not null then
    insert into public.item_groups (user_id, group_type_id, name) values (v_other, v_project, 'SG test theirs')
    returning id into v_theirs;
  end if;

  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  insert into public.item_groups (group_type_id, name, status) values (v_project, 'SG test project', 'active')
  returning id into v_proj;
  insert into public.item_groups (group_type_id, name) values (v_menu_t, 'SG test menu') returning id into v_menu;
  insert into public.item_groups (group_type_id, name, status) values (v_project, 'SG test background', 'background')
  returning id into v_bg;
  insert into public.item_groups (group_type_id, name) values (v_project, 'SG test closed') returning id into v_closed;
  update public.item_groups set status = 'closed', closed_reason = 'done' where id = v_closed;
  insert into public.item_groups (group_type_id, name, status) values (v_project, 'SG test archived', 'active')
  returning id into v_archived;
  update public.item_groups set archived = true where id = v_archived;

  -- a. The suggestion: any open group of Alex's is kept; closed, archived, unknown or someone else's is refused.
  insert into public.inbox (id, captured_text, suggested_group_id) values ('sg-test-1', 'SG test: one', v_proj);
  insert into public.inbox (id, captured_text, suggested_group_id) values ('sg-test-m', 'SG test: menu', v_menu);
  insert into public.inbox (id, captured_text, suggested_group_id) values ('sg-test-b', 'SG test: background', v_bg);
  v_res := v_res || jsonb_build_object(
    'a_project_accepted', (select suggested_group_id = v_proj from public.inbox where id = 'sg-test-1'),
    'a_menu_accepted', (select suggested_group_id = v_menu from public.inbox where id = 'sg-test-m'),
    'a_background_accepted', (select suggested_group_id = v_bg from public.inbox where id = 'sg-test-b'));
  insert into public.inbox (id, captured_text) values ('sg-test-2', 'SG test: two');
  begin
    update public.inbox set suggested_group_id = v_closed where id = 'sg-test-2';
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('a_closed_refused', v_err like '%not one of your open groups%');
  begin
    update public.inbox set suggested_group_id = v_archived where id = 'sg-test-2';
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('a_archived_refused', v_err like '%not one of your open groups%');
  begin
    update public.inbox set suggested_group_id = 'no-such-group' where id = 'sg-test-2';
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('a_unknown_refused', v_err like '%not one of your open groups%');
  if v_theirs is not null then
    begin
      update public.inbox set suggested_group_id = v_theirs where id = 'sg-test-2';
      v_err := 'no error';
    exception when others then v_err := sqlerrm; end;
    v_res := v_res || jsonb_build_object('a_other_users_refused', v_err like '%not one of your open groups%');
  end if;

  -- b. Filing with the group key adds the intention, at the end of the live members.
  r := public.process_inbox_item('sg-test-1', jsonb_build_object(
    'item', jsonb_build_object('name', 'SG test item'),
    'intent', jsonb_build_object('text', 'SG test intention'),
    'group', jsonb_build_object('group_id', v_proj)));
  v_res := v_res || jsonb_build_object(
    'b_intention_added', r->'group_member'->>'member_type' = 'intention'
                         and r->'group_member'->>'member_id' = r->'intent'->>'id',
    'b_position_one', (r->'group_member'->>'position')::int = 1,
    'b_filed', (select archived and archive_reason = 'processed' from public.inbox where id = 'sg-test-1'));

  -- c. An item alone goes in as the item, after the intention; a Menu and a Background group take members too.
  insert into public.inbox (id, captured_text) values ('sg-test-3', 'SG test: three');
  r := public.process_inbox_item('sg-test-3', jsonb_build_object(
    'item', jsonb_build_object('name', 'SG test item 2'), 'group', jsonb_build_object('group_id', v_proj)));
  v_res := v_res || jsonb_build_object(
    'c_item_added', r->'group_member'->>'member_type' = 'item' and (r->'group_member'->>'position')::int = 2);
  r := public.process_inbox_item('sg-test-m', jsonb_build_object(
    'item', jsonb_build_object('name', 'SG test dish'), 'group', jsonb_build_object('group_id', v_menu)));
  v_res := v_res || jsonb_build_object('c_menu_member', r->'group_member'->>'group_id' = v_menu);
  r := public.process_inbox_item('sg-test-b', jsonb_build_object(
    'intent', jsonb_build_object('text', 'SG test later'), 'group', jsonb_build_object('group_id', v_bg)));
  v_res := v_res || jsonb_build_object('c_background_member', r->'group_member'->>'group_id' = v_bg);

  -- d. A refused group writes nothing: the capture stays unfiled and no item is made.
  insert into public.inbox (id, captured_text) values ('sg-test-4', 'SG test: four');
  begin
    perform public.process_inbox_item('sg-test-4', jsonb_build_object(
      'item', jsonb_build_object('name', 'SG test never'), 'group', jsonb_build_object('group_id', v_closed)));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object(
    'd_closed_group_refused', v_err like '%not one of your open groups%',
    'd_nothing_written', (select not archived from public.inbox where id = 'sg-test-4')
                         and not exists (select 1 from public.items where name = 'SG test never'));
  begin
    perform public.process_inbox_item('sg-test-4', jsonb_build_object(
      'item', jsonb_build_object('name', 'SG test never'), 'group', jsonb_build_object('group_id', v_archived)));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_archived_group_refused', v_err like '%not one of your open groups%');
  begin
    perform public.process_inbox_item('sg-test-4', jsonb_build_object('group', jsonb_build_object('group_id', v_proj)));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_group_alone_refused', v_err like '%a group needs an item or an intent%');
  begin
    perform public.process_inbox_item('sg-test-4', jsonb_build_object(
      'item', jsonb_build_object('name', 'SG test never'), 'group', jsonb_build_object('group_id', '')));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_empty_group_id_refused', v_err like '%group.group_id is required%');

  -- e. Without the group key, filing is as before; a group that closes later keeps the suggestion.
  r := public.process_inbox_item('sg-test-4', jsonb_build_object('item', jsonb_build_object('name', 'SG test plain')));
  v_res := v_res || jsonb_build_object('e_no_group_key', r->'group_member' = 'null'::jsonb and r->'item' is not null);
  update public.item_groups set status = 'closed', closed_reason = 'done' where id = v_proj;
  update public.inbox set captured_text = 'SG test: one, edited' where id = 'sg-test-1';
  v_res := v_res || jsonb_build_object(
    'e_suggestion_kept', (select suggested_group_id = v_proj from public.inbox where id = 'sg-test-1'),
    'e_live_members', (select count(*) = 2 from public.item_group_members where group_id = v_proj and removed_at is null));

  -- f. Grants.
  v_res := v_res || jsonb_build_object(
    'f_anon_cannot_execute', not has_function_privilege('anon', 'public.process_inbox_item(text, jsonb)', 'execute'),
    'f_authenticated_can_execute', has_function_privilege('authenticated', 'public.process_inbox_item(text, jsonb)', 'execute'));

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'INBOX SUGGESTED GROUP TEST PASSED: all % checks true%. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res)),
      case when v_theirs is null then ' (no other user, so the other-user check did not run)' else '' end;
  end if;
  raise exception 'INBOX SUGGESTED GROUP TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
