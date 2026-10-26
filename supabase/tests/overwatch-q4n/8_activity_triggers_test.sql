-- Overwatch Step 10: the activity triggers, against both close flows, Undo, Projects and Menus. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved. It makes its own test
-- records as the user who owns the Money context (Alex), and never reads or changes a real one.
-- The error starts "ACTIVITY TEST PASSED" or "ACTIVITY TEST FAILED".
-- supabase/tests/overwatch-q4n/8_activity_triggers_test.sql

do $$
declare
  v_uid     uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_ctx     text := 'muvitejhrgt3rgi8t6q';
  v_app     text := coalesce((select app_id from public.contexts where id = 'muvitejhrgt3rgi8t6q'), 'alfred');
  v_project text;
  v_menu    text;
  t0        timestamptz := date_trunc('second', now()) - interval '1 hour';
  t1        timestamptz := date_trunc('second', now()) - interval '30 minutes';
  p         text := 'test-ow10-' || substr(gen_random_uuid()::text, 1, 8) || '-';
  v_res     jsonb := '{}'::jsonb;
  v_failed  text;
  n         int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  select id into v_project from public.group_types where kind = 'project' order by created_at limit 1;
  select id into v_menu    from public.group_types where kind = 'menu'    order by created_at limit 1;
  v_res := v_res || jsonb_build_object('0_kinds_backfilled', v_project is not null and v_menu is not null);

  -- a. closeRecords: intention closed done, then a closed done execution on it. One row, the intention's.
  insert into public.intents (id, text, context_id, tags) values (p || 'ia', 'TEST a', v_ctx, '{overwatch-test}');
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'ia';
  insert into public.executions (id, intent_id, context_id, status, outcome, started_at, closed_at)
    values (p || 'ea', p || 'ia', v_ctx, 'closed', 'done', t0, t0);
  select count(*) into n from public.activity where target_id in (p || 'ia', p || 'ea');
  v_res := v_res || jsonb_build_object(
    'a_one_row', n = 1,
    'a_is_the_intention', exists (select 1 from public.activity where target_id = p || 'ia' and target_type = 'intention'
                                    and kind = 'done' and occurred_at = t0),
    'a_tags_snapshot', exists (select 1 from public.activity where target_id = p || 'ia' and tags = '{overwatch-test}'),
    'a_app_from_context', exists (select 1 from public.activity where target_id = p || 'ia' and app_id = v_app));

  -- b. Undo of (a): the execution is deleted and the intention reopened. No rows left.
  delete from public.executions where id = p || 'ea';
  update public.intents set status = 'active' where id = p || 'ia';
  select count(*) into n from public.activity where target_id in (p || 'ia', p || 'ea');
  v_res := v_res || jsonb_build_object('b_undo_removes_it', n = 0);

  -- c. closeExecution: execution closed done, then its intention closed done at the same time. One row, the execution's.
  insert into public.intents (id, text, context_id) values (p || 'ic', 'TEST c', v_ctx);
  insert into public.executions (id, intent_id, context_id, status, started_at)
    values (p || 'ec', p || 'ic', v_ctx, 'active', t1);
  update public.executions set status = 'closed', outcome = 'done', closed_at = t1 where id = p || 'ec';
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t1 where id = p || 'ic';
  select count(*) into n from public.activity where target_id in (p || 'ic', p || 'ec');
  v_res := v_res || jsonb_build_object(
    'c_one_row', n = 1,
    'c_is_the_execution', exists (select 1 from public.activity where target_id = p || 'ec' and target_type = 'execution'
                                    and title = 'TEST c' and source_ref = 'execution:' || p || 'ec'));

  -- d. An item closed on its own. One row.
  insert into public.items (id, name, context_id, tags) values (p || 'td', 'TEST d', v_ctx, '{overwatch-item}');
  update public.items set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'td';
  v_res := v_res || jsonb_build_object(
    'd_item_alone_logs', (select count(*) = 1 from public.activity where target_id = p || 'td' and target_type = 'item'
                            and tags = '{overwatch-item}'));

  -- e. An item closed with its intention (intention first, as closeRecords does). One row, the intention's.
  insert into public.items (id, name, context_id) values (p || 'te', 'TEST e item', v_ctx);
  insert into public.intents (id, text, item_id, context_id) values (p || 'ie', 'TEST e', p || 'te', v_ctx);
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'ie';
  update public.items set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'te';
  select count(*) into n from public.activity where target_id in (p || 'te', p || 'ie');
  v_res := v_res || jsonb_build_object('e_item_with_intention_one_row', n = 1);

  -- f. A Project: its own intention and an execution on it never log; the group's close is one shipped row.
  insert into public.item_groups (id, group_type_id, context_id, name) values (p || 'gf', v_project, v_ctx, 'TEST project');
  insert into public.intents (id, text, context_id, group_id) values (p || 'if', 'TEST f own', v_ctx, p || 'gf');
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'if';
  insert into public.executions (id, intent_id, context_id, group_id, status, outcome, started_at, closed_at)
    values (p || 'ef', p || 'if', v_ctx, p || 'gf', 'closed', 'done', t0, t0);
  update public.item_groups set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'gf';
  select count(*) into n from public.activity where target_id in (p || 'gf', p || 'if', p || 'ef');
  v_res := v_res || jsonb_build_object(
    'f_one_row', n = 1,
    'f_is_shipped', exists (select 1 from public.activity where target_id = p || 'gf' and kind = 'shipped'
                              and group_id = p || 'gf' and title = 'TEST project'));

  -- g. A task that belongs to the Project carries its group_id.
  insert into public.intents (id, text, context_id) values (p || 'ig', 'TEST g task', v_ctx);
  insert into public.item_group_members (group_id, member_type, member_id, position) values (p || 'gf', 'intention', p || 'ig', 1);
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'ig';
  v_res := v_res || jsonb_build_object(
    'g_member_task_carries_project', exists (select 1 from public.activity where target_id = p || 'ig' and group_id = p || 'gf'));

  -- h. Reopening the Project removes its shipped row.
  update public.item_groups set status = 'active' where id = p || 'gf';
  v_res := v_res || jsonb_build_object(
    'h_reopen_removes_shipped', not exists (select 1 from public.activity where target_id = p || 'gf'));

  -- i. A Menu is not a Project: its own intention's close logs a done row, and the Menu's close logs nothing.
  insert into public.item_groups (id, group_type_id, context_id, name) values (p || 'gi', v_menu, v_ctx, 'TEST menu');
  insert into public.intents (id, text, context_id, group_id) values (p || 'ii', 'TEST i own', v_ctx, p || 'gi');
  update public.intents set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'ii';
  update public.item_groups set status = 'closed', closed_reason = 'done', status_changed_at = t0 where id = p || 'gi';
  v_res := v_res || jsonb_build_object(
    'i_menu_own_intention_logs', exists (select 1 from public.activity where target_id = p || 'ii'),
    'i_menu_close_logs_nothing', not exists (select 1 from public.activity where target_id = p || 'gi'));

  -- j. Closed as "won't do" logs nothing.
  insert into public.intents (id, text, context_id) values (p || 'ij', 'TEST j', v_ctx);
  update public.intents set status = 'closed', closed_reason = 'wont_do', status_changed_at = t0 where id = p || 'ij';
  v_res := v_res || jsonb_build_object(
    'j_wont_do_logs_nothing', not exists (select 1 from public.activity where target_id = p || 'ij'));

  -- k. Rows belong to the user, and another user cannot see them.
  v_res := v_res || jsonb_build_object(
    'k_owner_is_user', not exists (select 1 from public.activity where target_id like p || '%' and user_id <> v_uid));
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into n from public.activity where target_id like p || '%';
  v_res := v_res || jsonb_build_object('k_hidden_from_other_user', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;

  if v_failed is null then
    raise exception 'ACTIVITY TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'ACTIVITY TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
