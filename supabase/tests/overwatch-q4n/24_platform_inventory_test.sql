-- Overwatch Step 43: platform_inventory, platform_open_work, finish_summaries and replace_platform_inventory. Run
-- after the platform inventory migration. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE, so nothing it writes is kept. It calls the function as the service role, for the
-- user who owns the Money context (Alex), then reads as Alex and as a stranger.
-- The error starts "PLATFORM INVENTORY TEST PASSED" or "PLATFORM INVENTORY TEST FAILED".
-- supabase/tests/overwatch-q4n/24_platform_inventory_test.sql

do $$
declare
  v_uid    uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_res    jsonb := '{}'::jsonb;
  v_failed text;
  v_err    text;
  v_id     uuid;
  r        jsonb;
  n        int;
  fn       constant text := 'public.replace_platform_inventory(uuid, jsonb, jsonb)';
begin
  execute 'set local role service_role';

  -- a. A first rebuild: a generic-reader tool, a trigger, one open-work line.
  r := public.replace_platform_inventory(v_uid,
    '[{"kind": "tool", "name": "ow_test_tool", "app_id": "overwatch", "reads": ["*", "platform.registry"],
       "writes": [], "location": "supabase/functions/_shared/tools/x.ts", "details": {"tier": 1}},
      {"kind": "trigger", "name": "items.ow_test_trigger", "reads": ["items"], "writes": ["activity"]}]'::jsonb,
    '[{"file": "docs/progress-ow-test.md", "line": 3, "kind": "checkbox", "text": "  - [ ] something  ",
       "project_code": "ow-test"}]'::jsonb);
  v_res := v_res || jsonb_build_object(
    'a_counts', r->>'parts' = '2' and r->>'open_work' = '1',
    'a_star_becomes_reads_any', (select reads_any and reads = array['platform.registry']
                                   from public.platform_inventory where user_id = v_uid and name = 'ow_test_tool'),
    'a_app_and_details', (select app_id = 'overwatch' and details->>'tier' = '1'
                            from public.platform_inventory where user_id = v_uid and name = 'ow_test_tool'),
    'a_trigger_kind', exists (select 1 from public.platform_inventory
                               where user_id = v_uid and kind = 'trigger' and writes = array['activity']),
    'a_text_trimmed', (select text = '- [ ] something' and project_code = 'ow-test'
                         from public.platform_open_work where user_id = v_uid and file = 'docs/progress-ow-test.md'));
  select id into v_id from public.platform_inventory where user_id = v_uid and name = 'ow_test_tool';

  -- b. The next rebuild keeps the tool's id, updates it, drops what it did not see; an unknown app becomes null.
  r := public.replace_platform_inventory(v_uid,
    '[{"kind": "tool", "name": "ow_test_tool", "app_id": "no_such_app", "reads": ["items"], "writes": ["items"]}]'::jsonb,
    '[]'::jsonb);
  v_res := v_res || jsonb_build_object(
    'b_removed', r->>'removed_parts' = '1' and r->>'removed_open_work' = '1',
    'b_id_kept', (select id = v_id from public.platform_inventory where user_id = v_uid and name = 'ow_test_tool'),
    'b_updated', (select reads = array['items'] and not reads_any and app_id is null
                    from public.platform_inventory where user_id = v_uid and name = 'ow_test_tool'),
    'b_one_part_left', (select count(*) from public.platform_inventory where user_id = v_uid) = 1,
    'b_no_open_work', (select count(*) from public.platform_open_work where user_id = v_uid) = 0);

  -- c. A bad send changes nothing.
  begin
    perform public.replace_platform_inventory(v_uid, '[{"kind": "bogus", "name": "x"}]'::jsonb, '[]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_bad_kind_refused', v_err like '%platform_inventory_kind_check%');
  begin
    perform public.replace_platform_inventory(v_uid,
      '[{"kind": "tool", "name": "dup"}, {"kind": "tool", "name": "dup"}]'::jsonb, '[]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_duplicate_refused', v_err like '%appears twice%');
  begin
    perform public.replace_platform_inventory(v_uid, '[]'::jsonb, '[]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_empty_refused', v_err like '%non-empty%');
  begin
    perform public.replace_platform_inventory(v_uid, '[{"kind": "tool", "name": "w", "writes": ["*"]}]'::jsonb, '[]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_star_in_writes_refused', v_err like '%platform_inventory_no_star%');
  begin
    perform public.replace_platform_inventory(v_uid, '[{"kind": "tool", "name": "ok"}]'::jsonb,
      '[{"file": "src/not-docs.js", "line": 1, "kind": "checkbox", "text": "x"}]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object(
    'c_bad_file_refused', v_err like '%platform_open_work_file_format%',
    'c_old_rows_kept', (select count(*) = 1 and bool_and(name = 'ow_test_tool' and id = v_id)
                          from public.platform_inventory where user_id = v_uid));

  -- d. finish_summaries as Alex.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  insert into public.finish_summaries (project_code, branch, merge_commit, finished_at, migrations, diff_stat)
  values ('ow-test', 'worktree-ow-test', 'abc1234', now(), array['supabase/migrations/180_x.sql'],
          '{"files": 3, "insertions": 10, "deletions": 2}'::jsonb)
  returning id into v_id;
  v_res := v_res || jsonb_build_object(
    'd_owner_default', (select user_id = v_uid and reviewed_at is null from public.finish_summaries where id = v_id));
  begin
    insert into public.finish_summaries (project_code, merge_commit, finished_at) values ('ow-test', 'abc1234', now());
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_one_per_merge', v_err like '%finish_summaries_merge_key%');
  begin
    insert into public.finish_summaries (project_code, merge_commit, finished_at, reviewed_by_run)
    values ('ow-test', 'def5678', now(), 'run-1');
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_run_needs_reviewed_at', v_err like '%finish_summaries_reviewed_pair%');
  update public.finish_summaries set reviewed_at = now(), reviewed_by_run = 'run-1' where id = v_id;
  v_res := v_res || jsonb_build_object(
    'd_marked_reviewed', (select reviewed_at is not null from public.finish_summaries where id = v_id),
    'd_alex_sees_inventory', (select count(*) from public.platform_inventory) = 1,
    'd_authenticated_cannot_execute', not has_function_privilege('authenticated', fn, 'execute'));

  -- e. A stranger sees none of it; anon is granted nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select (select count(*) from public.platform_inventory) + (select count(*) from public.platform_open_work)
       + (select count(*) from public.finish_summaries) into n;
  v_res := v_res || jsonb_build_object(
    'e_hidden_from_other_user', n = 0,
    'e_anon_cannot_select', not has_table_privilege('anon', 'public.platform_inventory', 'select')
                            and not has_table_privilege('anon', 'public.platform_open_work', 'select')
                            and not has_table_privilege('anon', 'public.finish_summaries', 'select'),
    'e_anon_cannot_execute', not has_function_privilege('anon', fn, 'execute'),
    'e_service_role_can_execute', has_function_privilege('service_role', fn, 'execute'));

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'PLATFORM INVENTORY TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'PLATFORM INVENTORY TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
