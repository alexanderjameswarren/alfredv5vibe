-- Overwatch Step 53: portfolios, portfolio_plans, portfolio_lanes, portfolio_slices, create_portfolio_plan and the
-- two guards. Run after the portfolio plans migration. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE, so nothing it writes is kept. It works as the user who owns the Money context
-- (Alex): makes two test groups (a Project and a Menu), a test portfolio and two plan versions, then reads as a
-- stranger. The error starts "PORTFOLIO PLANS TEST PASSED" or "PORTFOLIO PLANS TEST FAILED".
-- One rule is not testable here: a lane or slice added in a LATER transaction than its plan is refused, but this
-- whole test is one transaction. The guard's check for it is the plan's created_at against now().
-- supabase/tests/overwatch-q4n/26_portfolio_plans_test.sql

do $$
declare
  v_uid     uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_res     jsonb := '{}'::jsonb;
  v_failed  text;
  v_err     text;
  v_proj    text;
  v_proj2   text;
  v_menu    text;
  v_pf      uuid;
  v_v1      uuid;
  v_v2      uuid;
  v_v1_lane uuid;
  v_slice   uuid;
  r         jsonb;
  n         int;
  fn        constant text := 'public.create_portfolio_plan(uuid, text, text, date, text, text, jsonb)';
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  insert into public.item_groups (group_type_id, name)
  values ((select id from public.group_types where kind = 'project' order by created_at limit 1), 'PF test project A')
  returning id into v_proj;
  insert into public.item_groups (group_type_id, name)
  values ((select id from public.group_types where kind = 'project' order by created_at limit 1), 'PF test project B')
  returning id into v_proj2;
  insert into public.item_groups (group_type_id, name)
  values ((select id from public.group_types where kind = 'menu' order by created_at limit 1), 'PF test menu')
  returning id into v_menu;
  insert into public.portfolios (name, context_ids, position) values ('PF test portfolio', array['ctx-test'], 9)
  returning id into v_pf;

  -- a. The first version: two lanes; project A split across two slices (paused, resumed later), B in progress.
  r := public.create_portfolio_plan(v_pf, 'Bugs first, then tools that speed up the work.', 'Look again after A.',
    current_date + 14, 'First plan.', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'note', 'heavy work', 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_proj2, 'status', 'in_progress', 'why', 'unblocks A'),
        jsonb_build_object('position', 2, 'group_id', v_proj, 'phases', 'Phases 2 and 3'))),
      jsonb_build_object('name', 'SAM', 'position', 2, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_proj, 'phases', 'Phase 1', 'status', 'paused',
                           'paused_reason', 'waiting on B'))),
      jsonb_build_object('name', 'Empty', 'position', 3)));
  v_v1 := (r->>'id')::uuid;
  select id into v_v1_lane from public.portfolio_lanes where plan_id = v_v1 and name = 'Main';
  v_res := v_res || jsonb_build_object(
    'a_counts', r->>'lanes' = '3' and r->>'slices' = '3',
    'a_active_first', (select active and supersedes_id is null and written_by = 'alex' and review_by = current_date + 14
                         from public.portfolio_plans where id = v_v1),
    'a_lanes_in_order', (select array_agg(name order by position) = array['Main', 'SAM', 'Empty']
                           from public.portfolio_lanes where plan_id = v_v1),
    'a_same_group_twice', (select count(*) = 2 from public.portfolio_slices where plan_id = v_v1 and group_id = v_proj),
    'a_slice_fields', (select phases = 'Phase 1' and status = 'paused' and paused_reason = 'waiting on B'
                         from public.portfolio_slices s join public.portfolio_lanes l on l.id = s.lane_id
                        where s.plan_id = v_v1 and l.name = 'SAM'),
    'a_default_planned', (select status = 'planned' and why is null from public.portfolio_slices
                           where lane_id = v_v1_lane and position = 2));

  -- b. The next version supersedes it; the old one is kept, inactive.
  r := public.create_portfolio_plan(v_pf, 'B is done; A next.', null, null, 'B shipped.', 'overwatch', jsonb_build_array(
    jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
      jsonb_build_object('position', 1, 'group_id', v_proj2, 'status', 'done'),
      jsonb_build_object('position', 2, 'group_id', v_proj, 'status', 'in_progress', 'phases', 'Phases 1 to 3'),
      jsonb_build_object('position', 3, 'group_id', v_proj2, 'phases', 'Phase 4')))));
  v_v2 := (r->>'id')::uuid;
  v_res := v_res || jsonb_build_object(
    'b_supersedes', (select supersedes_id = v_v1 and active and written_by = 'overwatch'
                       from public.portfolio_plans where id = v_v2),
    'b_old_inactive', (select not active from public.portfolio_plans where id = v_v1),
    'b_one_active', (select count(*) = 1 from public.portfolio_plans where portfolio_id = v_pf and active),
    'b_old_kept', (select count(*) = 3 from public.portfolio_slices where plan_id = v_v1));

  -- c. Bad input refuses the whole call.
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_menu)))));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_menu_group_refused', v_err like '%not a Project group%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', 'no-such-group')))));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_unknown_group_refused', v_err like '%not one of your groups%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1), jsonb_build_object('name', 'SAM', 'position', 1)));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_duplicate_lane_position_refused', v_err like '%two lanes have position%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1), jsonb_build_object('name', 'Main', 'position', 2)));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_duplicate_lane_name_refused', v_err like '%appears twice%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_proj), jsonb_build_object('position', 1, 'group_id', v_proj2)))));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_duplicate_slice_position_refused', v_err like '%two slices at position%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_proj, 'status', 'in_progress'),
        jsonb_build_object('position', 2, 'group_id', v_proj2, 'status', 'in_progress')))));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_two_in_progress_refused', v_err like '%more than one slice in progress%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', jsonb_build_array(
      jsonb_build_object('name', 'Main', 'position', 1, 'slices', jsonb_build_array(
        jsonb_build_object('position', 1, 'group_id', v_proj, 'status', 'paused')))));
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_paused_needs_reason', v_err like '%portfolio_slices_paused_reason%');
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', '[]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('c_no_lanes_refused', v_err like '%non-empty%');
  begin
    perform public.create_portfolio_plan(v_pf, ' ', null, null, 'r', 'alex', '[{"name": "Main", "position": 1}]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object(
    'c_no_theory_refused', v_err like '%theory is required%',
    'c_v2_still_active', (select count(*) = 2 and bool_or(id = v_v2 and active)
                            from public.portfolio_plans where portfolio_id = v_pf));

  -- d. Lanes and slices go in only with their plan, and only into their own version's lanes.
  begin
    insert into public.portfolio_slices (plan_id, lane_id, position, group_id) values (v_v1, v_v1_lane, 9, v_proj);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_insert_into_old_version_refused', v_err like '%written with their plan%');
  begin
    insert into public.portfolio_slices (plan_id, lane_id, position, group_id) values (v_v2, v_v1_lane, 9, v_proj);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('d_lane_of_other_version_refused', v_err like '%portfolio_slices_lane_fk%');

  -- e. Frozen after writing: lanes never; a superseded version never; the active one's slices only by status.
  begin
    update public.portfolio_lanes set name = 'Renamed' where plan_id = v_v2;
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_lane_rename_refused', v_err like '%portfolio_lanes are not edited%');
  begin
    update public.portfolio_slices set status = 'done' where plan_id = v_v1 and status = 'in_progress';
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_old_version_frozen', v_err like '%superseded and is frozen%');
  select id into v_slice from public.portfolio_slices where plan_id = v_v2 and position = 3;
  begin
    update public.portfolio_slices set position = 4 where id = v_slice;
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_move_refused', v_err like '%only status and paused_reason%');
  begin
    update public.portfolio_slices set status = 'in_progress' where id = v_slice;
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_second_in_progress_refused', v_err like '%portfolio_slices_one_in_progress%');
  update public.portfolio_slices set status = 'paused', paused_reason = 'client work first' where id = v_slice;
  v_res := v_res || jsonb_build_object(
    'e_status_change_allowed', (select status = 'paused' and paused_reason = 'client work first'
                                  from public.portfolio_slices where id = v_slice));
  begin
    update public.portfolio_plans set theory = 'changed' where id = v_v2;
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_plan_edit_refused', v_err like '%rows are not edited%');
  begin
    update public.portfolio_plans set active = true where id = v_v1;
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('e_reactivate_refused', v_err like '%cannot become active again%');

  -- f. An archived portfolio takes no new version.
  update public.portfolios set archived = true where id = v_pf;
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', '[{"name": "Main", "position": 1}]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object('f_archived_refused', v_err like '%is archived%');

  -- g. A stranger sees none of it, and cannot write into Alex's portfolio; anon is granted nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select (select count(*) from public.portfolios) + (select count(*) from public.portfolio_plans)
       + (select count(*) from public.portfolio_lanes) + (select count(*) from public.portfolio_slices) into n;
  v_res := v_res || jsonb_build_object('g_hidden_from_other_user', n = 0);
  begin
    perform public.create_portfolio_plan(v_pf, 't', null, null, 'r', 'alex', '[{"name": "Main", "position": 1}]'::jsonb);
    v_err := 'no error';
  exception when others then v_err := sqlerrm; end;
  v_res := v_res || jsonb_build_object(
    'g_stranger_cannot_write', v_err like '%was not found%',
    'g_anon_cannot_select', not has_table_privilege('anon', 'public.portfolios', 'select')
                            and not has_table_privilege('anon', 'public.portfolio_plans', 'select')
                            and not has_table_privilege('anon', 'public.portfolio_lanes', 'select')
                            and not has_table_privilege('anon', 'public.portfolio_slices', 'select'),
    'g_anon_cannot_execute', not has_function_privilege('anon', fn, 'execute'),
    'g_authenticated_can_execute', has_function_privilege('authenticated', fn, 'execute'));

  -- h. The three new apps, with no screen.
  v_res := v_res || jsonb_build_object(
    'h_new_apps', (select count(*) = 3 and bool_and(path is null and button_name is null)
                     from public.apps where id in ('homer', 'guy', 'handyman')));

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'PORTFOLIO PLANS TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'PORTFOLIO PLANS TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
