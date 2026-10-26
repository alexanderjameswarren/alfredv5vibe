-- Overwatch Step 21: project_estimates and record_project_estimate. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved. It makes its own test
-- groups as the user who owns the Money context (Alex), and never changes a real one; it only reads the Overwatch seed.
-- The error starts "PROJECT ESTIMATES TEST PASSED" or "PROJECT ESTIMATES TEST FAILED".
-- supabase/tests/overwatch-q4n/17_project_estimates_test.sql

do $$
declare
  v_uid     uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_project text := (select id from public.group_types where kind = 'project' order by created_at limit 1);
  v_menu    text := (select id from public.group_types where kind = 'menu' order by created_at limit 1);
  p         text := 'test-ow21-' || substr(gen_random_uuid()::text, 1, 8);
  v_r       jsonb;
  v_res     jsonb := '{}'::jsonb;
  v_failed  text;
  v_err     text;
  n         int;
  plan      int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- 0. The Overwatch seed: initial 40, then scope_increase +4; current 44.
  v_res := v_res || jsonb_build_object(
    '0_seed_history', (select string_agg(kind || ' ' || estimate, ', ' order by created_at) from public.project_estimates
                        where group_id = 'mvnv8pa2v6zip3xnpm') = 'initial 40, scope_increase 44',
    '0_seed_current', (select effort_estimate from public.project_plans where group_id = 'mvnv8pa2v6zip3xnpm') = 44);

  insert into public.item_groups (id, group_type_id, name) values
    (p || '-a', v_project, 'TEST estimates A'), (p || '-b', v_project, 'TEST estimates B'), (p || '-m', v_menu, 'TEST menu');

  -- a. initial from the CLI's figure (factor 1.0 unless the plan says otherwise), and the plan follows.
  v_r := public.record_project_estimate(p || '-a', 'initial', 'TEST plan prompt', null, 10, null, 1);
  select effort_estimate into plan from public.project_plans where group_id = p || '-a';
  v_res := v_res || jsonb_build_object(
    'a_initial_saved', v_r ->> 'kind' = 'initial' and (v_r ->> 'cli_estimate')::int = 10,
    'a_plan_follows', plan = (v_r ->> 'estimate')::int);

  -- b. scope changes add to the current figure; a re-estimate replaces it.
  v_r := public.record_project_estimate(p || '-a', 'scope_increase', 'TEST more work', null, null, 3, 4);
  v_res := v_res || jsonb_build_object('b_increase', (v_r ->> 'estimate')::int = plan + 3);
  v_r := public.record_project_estimate(p || '-a', 'scope_decrease', 'TEST less work', null, null, -2, 5);
  v_res := v_res || jsonb_build_object('b_decrease', (v_r ->> 'estimate')::int = plan + 1);
  v_r := public.record_project_estimate(p || '-a', 're_estimate', 'TEST new guess', 20, 20, null, 6);
  v_res := v_res || jsonb_build_object(
    'b_re_estimate', (select effort_estimate from public.project_plans where group_id = p || '-a') = 20);

  -- c. final records the actual steps and leaves the current estimate alone.
  v_r := public.record_project_estimate(p || '-a', 'final', 'TEST shipped', 18);
  v_res := v_res || jsonb_build_object(
    'c_final_saved', (v_r ->> 'estimate')::int = 18,
    'c_plan_unchanged', (select effort_estimate from public.project_plans where group_id = p || '-a') = 20,
    'c_five_rows', (select count(*) from public.project_estimates where group_id = p || '-a') = 5);

  -- d. One initial and one final per project.
  v_err := null;
  begin perform public.record_project_estimate(p || '-a', 'initial', 'TEST again', 5);
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('d_second_initial_refused', v_err is not distinct from '23505');
  v_err := null;
  begin perform public.record_project_estimate(p || '-a', 'final', 'TEST again', 5);
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('d_second_final_refused', v_err is not distinct from '23505');

  -- e. Rows are not edited; scope needs an initial first; a Menu is refused; a reason is required.
  v_err := null;
  begin update public.project_estimates set reason = 'edited' where group_id = p || '-a';
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_edit_refused', v_err is not distinct from '23514');
  v_err := null;
  begin perform public.record_project_estimate(p || '-b', 'scope_increase', 'TEST', null, null, 2);
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_initial_first', v_err is not distinct from '22023');
  v_err := null;
  begin perform public.record_project_estimate(p || '-m', 'initial', 'TEST', 5);
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_menu_refused', v_err is not distinct from '23514');
  v_err := null;
  begin perform public.record_project_estimate(p || '-b', 'initial', ' ', 5);
  exception when others then v_err := sqlstate; end;
  v_res := v_res || jsonb_build_object('e_reason_required', v_err is not distinct from '22023');

  -- f. Another user sees none of it.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into n from public.project_estimates;
  v_res := v_res || jsonb_build_object('f_hidden_from_other_user', n = 0);
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'PROJECT ESTIMATES TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'PROJECT ESTIMATES TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
