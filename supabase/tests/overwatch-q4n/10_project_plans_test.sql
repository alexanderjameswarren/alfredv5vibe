-- Overwatch Step 11: project_plans and project_links, the Project-only guard, the stamps and the checks.
-- Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved. It makes its own test
-- groups as the user who owns the Money context (Alex), and never reads or changes a real one.
-- The error starts "PROJECT PLANS TEST PASSED" or "PROJECT PLANS TEST FAILED".
-- supabase/tests/overwatch-q4n/10_project_plans_test.sql

do $$
declare
  v_uid     uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_project text := (select id from public.group_types where kind = 'project' order by created_at limit 1);
  v_menu    text := (select id from public.group_types where kind = 'menu' order by created_at limit 1);
  p         text := 'test-ow11-' || substr(gen_random_uuid()::text, 1, 8);
  v_res     jsonb := '{}'::jsonb;
  v_failed  text;
  v_err     text;
  n         int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  insert into public.item_groups (id, group_type_id, name) values
    (p || '-g1', v_project, 'TEST project 1'),
    (p || '-g2', v_project, 'TEST project 2'),
    (p || '-m',  v_menu,    'TEST menu');

  -- a. A plan on a Project, with no status line yet: no status stamp.
  insert into public.project_plans (group_id, project_code, effort_estimate) values (p || '-g1', p, 12);
  v_res := v_res || jsonb_build_object(
    'a_plan_created', exists (select 1 from public.project_plans where group_id = p || '-g1' and user_id = v_uid),
    'a_no_status_stamp', (select status_written_at is null from public.project_plans where group_id = p || '-g1'));

  -- b. Changing the target date leaves the stamp; writing the status line sets it.
  update public.project_plans set target_date = current_date + 30 where group_id = p || '-g1';
  v_res := v_res || jsonb_build_object(
    'b_date_only_no_stamp', (select status_written_at is null from public.project_plans where group_id = p || '-g1'));
  update public.project_plans set where_now = 'TEST step 3', next_step = 'TEST step 4' where group_id = p || '-g1';
  v_res := v_res || jsonb_build_object(
    'b_status_line_stamped', (select status_written_at is not null from public.project_plans where group_id = p || '-g1'));

  -- c. Only Projects: a Menu is refused.
  v_err := null;
  begin
    insert into public.project_plans (group_id) values (p || '-m');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('c_menu_refused', v_err is not distinct from '23514');

  -- d. Waiting on another Project: allowed with kind project; refused without it, on itself, or on a Menu.
  update public.project_plans set waiting_on_kind = 'project', waiting_on_group_id = p || '-g2', waiting_on = 'TEST'
   where group_id = p || '-g1';
  v_res := v_res || jsonb_build_object(
    'd_wait_on_project_ok', exists (select 1 from public.project_plans where group_id = p || '-g1' and waiting_on_group_id = p || '-g2'));
  v_err := null;
  begin
    update public.project_plans set waiting_on_kind = 'alex' where group_id = p || '-g1';
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_group_needs_kind_project', v_err is not distinct from '23514');
  v_err := null;
  begin
    update public.project_plans set waiting_on_group_id = p || '-g1' where group_id = p || '-g1';
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_not_on_itself', v_err is not distinct from '23514');
  v_err := null;
  begin
    update public.project_plans set waiting_on_group_id = p || '-m' where group_id = p || '-g1';
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_not_on_a_menu', v_err is not distinct from '23514');

  -- e. A project code names one project.
  v_err := null;
  begin
    insert into public.project_plans (group_id, project_code) values (p || '-g2', p);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('e_code_once', v_err is not distinct from '23505');

  -- f. Links: Project to Project, once per kind, never to itself, never to a Menu.
  insert into public.project_links (from_group_id, to_group_id, kind, note) values (p || '-g1', p || '-g2', 'depends_on', 'TEST');
  v_res := v_res || jsonb_build_object(
    'f_link_created', exists (select 1 from public.project_links where from_group_id = p || '-g1' and created_by = 'alex'));
  v_err := null;
  begin
    insert into public.project_links (from_group_id, to_group_id, kind) values (p || '-g1', p || '-g2', 'depends_on');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('f_link_once', v_err is not distinct from '23505');
  v_err := null;
  begin
    insert into public.project_links (from_group_id, to_group_id, kind) values (p || '-g1', p || '-g1', 'no_parallel');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('f_not_to_itself', v_err is not distinct from '23514');
  v_err := null;
  begin
    insert into public.project_links (from_group_id, to_group_id, kind) values (p || '-g1', p || '-m', 'no_parallel');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('f_not_to_a_menu', v_err is not distinct from '23514');

  -- g. Another user sees neither.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select (select count(*) from public.project_plans where group_id like p || '%')
       + (select count(*) from public.project_links where from_group_id like p || '%') into n;
  v_res := v_res || jsonb_build_object('g_hidden_from_other_user', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- h. Deleting the Project waited on clears the wait and removes the link.
  delete from public.item_groups where id = p || '-g2';
  v_res := v_res || jsonb_build_object(
    'h_wait_cleared', (select waiting_on_group_id is null from public.project_plans where group_id = p || '-g1'),
    'h_link_gone', not exists (select 1 from public.project_links where from_group_id = p || '-g1'));

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;

  if v_failed is null then
    raise exception 'PROJECT PLANS TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'PROJECT PLANS TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
