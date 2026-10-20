-- Inbox atomic (inbox_atomic-q7d): prove process_inbox_item and archive_inbox_item are
-- all-or-nothing. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is
-- saved. It makes its own test captures, as the user with the most inbox rows (Alex),
-- and never reads or changes a real one.
-- The error starts "INBOX ATOMIC TEST PASSED" or "INBOX ATOMIC TEST FAILED".
-- supabase/tests/inbox_atomic/2_failure_test.sql

do $$
declare
  v_uid    uuid := (select user_id from public.inbox group by user_id order by count(*) desc limit 1);
  v_cap    text := 'test-inbox-atomic-' || gen_random_uuid();
  v_cap2   text := 'test-inbox-atomic-' || gen_random_uuid();
  v_item2  text := 'test-item-atomic-' || gen_random_uuid();
  v_rem    uuid;
  v_good   jsonb;
  v_bad    jsonb;
  v_r      jsonb;
  v_err    text;
  v_res    jsonb := '{}'::jsonb;
  v_failed text;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  insert into public.inbox (id, captured_text) values
    (v_cap,  'TEST capture (inbox atomic) — rolled back'),
    (v_cap2, 'TEST capture 2 (inbox atomic) — rolled back');
  insert into public.reminders (text, due_at, inbox_id)
    values ('TEST reminder (inbox atomic)', now() + interval '7 days', v_cap)
    returning id into v_rem;
  insert into public.items (id, name) values (v_item2, 'TEST item for link-back (inbox atomic)');

  v_good := jsonb_build_object(
    'item',   jsonb_build_object('name', 'TEST item (inbox atomic)'),
    'intent', jsonb_build_object('text', 'TEST intention (inbox atomic)'),
    'event',  jsonb_build_object('time', to_char(current_date + 3, 'YYYY-MM-DD')),
    'source_app', null);
  -- The item and the intention insert, and the reminder moves, before this date fails.
  v_bad := jsonb_set(v_good, '{event,time}', '"not-a-date"');

  -- a. Another user cannot process the capture.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  v_err := null;
  begin
    perform public.process_inbox_item(v_cap, v_good);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('a_other_user_refused', v_err is not distinct from 'P0002');
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- b. Fails partway: nothing left behind.
  v_err := null;
  begin
    perform public.process_inbox_item(v_cap, v_bad);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object(
    'b_failed_on_the_date', v_err is not distinct from '22007',
    'b_no_items', not exists (select 1 from public.items where source_inbox_id = v_cap),
    'b_no_intents', not exists (select 1 from public.intents where source_inbox_id = v_cap),
    'b_no_events', not exists (select 1 from public.events where source_inbox_id = v_cap),
    'b_reminder_still_on_capture', exists (select 1 from public.reminders where id = v_rem and inbox_id = v_cap and intent_id is null),
    'b_capture_still_open', exists (select 1 from public.inbox where id = v_cap and archived is not true and outcome = '[]'::jsonb));

  -- c. Succeeds: everything written, capture archived.
  v_r := public.process_inbox_item(v_cap, v_good);
  v_res := v_res || jsonb_build_object(
    'c_one_item', (select count(*) = 1 from public.items where source_inbox_id = v_cap),
    'c_one_intent', (select count(*) = 1 from public.intents where source_inbox_id = v_cap),
    'c_one_event', (select count(*) = 1 from public.events where source_inbox_id = v_cap),
    'c_intent_has_item', coalesce((select item_id = v_r -> 'item' ->> 'id' from public.intents where id = v_r -> 'intent' ->> 'id'), false),
    'c_reminder_moved', exists (select 1 from public.reminders where id = v_rem and inbox_id is null and intent_id = v_r -> 'intent' ->> 'id'),
    'c_one_reminder_counted', (v_r ->> 'reminders_moved')::int = 1,
    'c_archived_processed', exists (select 1 from public.inbox where id = v_cap and archived and archive_reason = 'processed' and jsonb_array_length(outcome) = 3),
    'c_intent_active_after_event', exists (select 1 from public.intents where id = v_r -> 'intent' ->> 'id' and status = 'active'));

  -- d. A second Process of the same capture is refused.
  v_err := null;
  begin
    perform public.process_inbox_item(v_cap, v_good);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_second_process_refused', v_err is not distinct from '55000');

  -- e. archive_inbox_item fails on its second link-back: the archive and the first link are undone.
  v_err := null;
  begin
    perform public.archive_inbox_item(v_cap2, jsonb_build_object('outcome', jsonb_build_array(
      jsonb_build_object('table', 'items', 'id', v_item2),
      jsonb_build_object('table', 'job_applications', 'id', 'not-a-uuid'))));
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object(
    'e_failed', v_err is not distinct from '22023',
    'e_capture_still_open', exists (select 1 from public.inbox where id = v_cap2 and archived is not true and outcome = '[]'::jsonb),
    'e_item_not_linked', exists (select 1 from public.items where id = v_item2 and source_inbox_id is null));

  -- f. archive_inbox_item succeeds.
  v_r := public.archive_inbox_item(v_cap2, jsonb_build_object('outcome', jsonb_build_array(
    jsonb_build_object('table', 'items', 'id', v_item2))));
  v_res := v_res || jsonb_build_object(
    'f_archived', coalesce((v_r ->> 'archived')::boolean and v_r ->> 'archive_reason' = 'processed', false),
    'f_linked_back', v_r -> 'linked_back' = jsonb_build_array('items:' || v_item2),
    'f_item_linked', exists (select 1 from public.items where id = v_item2 and source_inbox_id = v_cap2));

  -- g. Un-archiving with an outcome is refused.
  v_err := null;
  begin
    perform public.archive_inbox_item(v_cap2, '{"archived": false, "outcome": [{"table": "items", "id": "x"}]}'::jsonb);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('g_unarchive_with_outcome_refused', v_err is not distinct from '22023');

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;

  if v_failed is null then
    raise exception 'INBOX ATOMIC TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'INBOX ATOMIC TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
