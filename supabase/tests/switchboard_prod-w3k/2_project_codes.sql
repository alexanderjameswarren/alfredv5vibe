-- switchboard_prod-w3k s8: verify effort counting across a Project's codes (spec 9): project_codes, the project_plans
-- trigger, the duplicate refusal and overwatch_project_progress. Run after the project_codes migration, through the queue
-- with --test. Runs as Alex (authenticated, so RLS applies), on throwaway groups, plans and clips, and undoes itself.
-- Result: one row, with all_passed, failed and checks.
-- supabase/tests/switchboard_prod-w3k/2_project_codes.sql

do $$
declare
  c_done constant text := 'PCT_UNDO';
  c_cols constant text := 'TABLE(group_id text, name text, group_status text, context_id text, has_plan boolean, '
    || 'project_code text, target_date date, effort_estimate integer, where_now text, next_step text, waiting_on text, '
    || 'waiting_on_kind text, waiting_on_group_id text, hurdle_kind text, status_written_at timestamp with time zone, '
    || 'steps_used integer, reports integer, last_report_at timestamp with time zone, first_report_at timestamp with time zone)';
  c_fn   constant regprocedure := 'public.overwatch_project_progress(text[], text[])'::regprocedure;
  v_type   text;
  v_a      text;
  v_b      text;
  v_r      record;
  v_ok     boolean;
  v_msg    text;
  c        jsonb := '{}';
  v_result jsonb;
begin
  begin
    -- 1. The table, the function and the backfill, before any fixture.
    c := c || jsonb_build_object(
      'table_registered', exists (select 1 from platform.registry where table_name = 'public.project_codes'),
      'table_rls_on', (select relrowsecurity from pg_class where oid = 'public.project_codes'::regclass),
      'table_anon_nothing', not has_table_privilege('anon', 'public.project_codes', 'select')
                            and not has_table_privilege('anon', 'public.project_codes', 'insert'),
      'fn_columns_unchanged', pg_get_function_result(c_fn) = c_cols,
      'fn_arguments_unchanged', pg_get_function_identity_arguments(c_fn) = 'p_status text[], p_group_ids text[]',
      'fn_invoker', (select not prosecdef from pg_proc where oid = c_fn),
      'fn_anon_cannot_execute', not has_function_privilege('anon', c_fn, 'execute'),
      'plan_trigger_exists', exists (select 1 from pg_trigger where tgname = 'project_plans_record_code'
                                      and tgrelid = 'public.project_plans'::regclass),
      'backfill_switchboard_codes', (select count(*) = 4 from public.project_codes
                                      where group_id = 'mvsmdaag09pvs6wddm03'
                                        and project_code in ('switchboard2-h8r', 'switchboard_repo-k7m',
                                                             'switchboard_prodrepo-w3k', 'switchboard_prod-w3k')),
      'backfill_actblue_codes', (select count(*) = 2 from public.project_codes
                                  where group_id = 'mw9h5nd2tqlxtvmz0bj'
                                    and project_code in ('cd_ab_recurring_fix-t6k', 'cd_ab_diagnose-r4m')),
      'backfill_every_plan_code', not exists (select 1 from public.project_plans p where p.project_code is not null
        and not exists (select 1 from public.project_codes x where x.group_id = p.group_id and x.project_code = p.project_code)));

    -- 2. As Alex, through RLS.
    perform set_config('request.jwt.claims',
      json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    select id into v_type from public.group_types where kind = 'project' order by created_at limit 1;
    insert into public.item_groups (group_type_id, name, status) values (v_type, 'pct A', 'active') returning id into v_a;
    insert into public.item_groups (group_type_id, name, status) values (v_type, 'pct B', 'active') returning id into v_b;

    -- The trigger records a new plan's code, and keeps the old one when it changes.
    insert into public.project_plans (group_id, project_code) values (v_a, 'pct-a1');
    c := c || jsonb_build_object('trigger_records_new_code',
      exists (select 1 from public.project_codes where group_id = v_a and project_code = 'pct-a1' and source = 'plan'));
    update public.project_plans set project_code = 'pct-a2' where group_id = v_a;
    c := c || jsonb_build_object('trigger_keeps_old_code',
      (select count(*) = 2 from public.project_codes where group_id = v_a and project_code in ('pct-a1', 'pct-a2')));

    -- A side code, as update_project_plan add_project_codes writes it.
    insert into public.project_codes (group_id, project_code, source) values (v_a, 'pct-side', 'side');

    -- Reports: (a1,1) (a1,2) (a2,1) (a2,1b) (side,1) = 4 steps and 5 reports. pct-a2x is another code: not counted.
    insert into public.clips (source, page_text, run_tag)
    values ('cli', 'x', 'pct-a1-s1-aaaa'), ('cli', 'x', 'pct-a1-s2-aaaa'), ('cli', 'x', 'pct-a2-s1-aaaa'),
           ('cli', 'x', 'pct-a2-s1b-aaaa'), ('cli', 'x', 'pct-side-s1-aaaa'), ('cli', 'x', 'pct-a2x-s9-aaaa');
    select * into v_r from public.overwatch_project_progress(null, array[v_a]);
    c := c || jsonb_build_object(
      'side_code_counts_toward_steps', v_r.steps_used = 4,
      'reports_over_every_code', v_r.reports = 5,
      'first_and_last_report_set', v_r.first_report_at is not null and v_r.last_report_at is not null,
      'plan_code_is_current', v_r.project_code = 'pct-a2');

    -- A duplicate: a code another Project holds is refused, as a side code and as a plan code, naming the holder.
    begin
      insert into public.project_codes (group_id, project_code, source) values (v_b, 'pct-a1', 'side');
      v_ok := false; v_msg := null;
    exception when unique_violation then
      v_ok := true; get stacked diagnostics v_msg = message_text;
    end;
    c := c || jsonb_build_object('duplicate_side_code_refused', v_ok,
                                 'refusal_names_the_holder', coalesce(v_msg like '%pct A%' and v_msg like '%' || v_a || '%', false));
    begin
      insert into public.project_plans (group_id, project_code) values (v_b, 'pct-side');
      v_ok := false;
    exception when unique_violation then
      v_ok := true;
    end;
    c := c || jsonb_build_object('duplicate_plan_code_refused', v_ok);

    -- Switchboard 2.0 counts its earlier codes again (7 under switchboard_prod-w3k alone when this was written).
    select * into v_r from public.overwatch_project_progress(null, array['mvsmdaag09pvs6wddm03']);
    c := c || jsonb_build_object('switchboard_2_counts_earlier_codes', coalesce(v_r.steps_used > 7, false),
                                 'switchboard_2_steps_used', v_r.steps_used);

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(c) where jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(c) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(c) where jsonb_typeof(value) = 'boolean'),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c)
                  where jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb),
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('switchboard.verify_result', v_result::text, false);
end;
$$;

select current_setting('switchboard.verify_result')::jsonb as result;
