-- Overwatch Step 33: the tab's view, first_report_at and the icon. Run after the tab views migration. Open and run
-- the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE, so it can never leave anything behind (it writes nothing anyway). It reads as the
-- user who owns the Money context (Alex), then as a stranger.
-- The error starts "TAB VIEWS TEST PASSED" or "TAB VIEWS TEST FAILED".
-- supabase/tests/overwatch-q4n/22_tab_views_test.sql

do $$
declare
  v_uid    uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_res    jsonb := '{}'::jsonb;
  v_failed text;
  n        int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- a. One view row per app with activity, each matching the newest activity row.
  v_res := v_res || jsonb_build_object(
    'a_one_row_per_app', (select count(*) from public.overwatch_app_last_activity)
                         = (select count(distinct app_id) from public.activity),
    'a_newest_matches', not exists (
      select 1 from public.overwatch_app_last_activity v
       where v.last_occurred_at is distinct from (select max(occurred_at) from public.activity a where a.app_id = v.app_id)),
    'a_count_matches', (select coalesce(sum(rows_logged), 0) from public.overwatch_app_last_activity)
                       = (select count(*) from public.activity));

  -- b. first_report_at: the Overwatch project's earliest CLI report, no later than its last.
  v_res := v_res || jsonb_build_object(
    'b_first_is_earliest', (select first_report_at from public.overwatch_project_progress(null, array['mvnv8pa2v6zip3xnpm']))
      = (select min(created_at) from public.clips where run_tag ~ '^overwatch-q4n-s[0-9]+[a-z]?-[a-z0-9]{4}$'),
    'b_first_before_last', not exists (
      select 1 from public.overwatch_project_progress(null) where first_report_at > last_report_at),
    'b_no_reports_no_first', not exists (
      select 1 from public.overwatch_project_progress(null) where reports = 0 and first_report_at is not null));

  -- c. The icon.
  v_res := v_res || jsonb_build_object(
    'c_icon', (select icon from public.apps where id = 'overwatch') = 'TowerControl');

  -- d. A stranger sees none of it; anon is granted nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*) into n from public.overwatch_app_last_activity;
  v_res := v_res || jsonb_build_object(
    'd_hidden_from_other_user', n = 0,
    'd_no_projects_for_other_user', (select count(*) from public.overwatch_project_progress(null)) = 0,
    'd_anon_cannot_select', not has_table_privilege('anon', 'public.overwatch_app_last_activity', 'select'),
    'd_anon_cannot_execute', not has_function_privilege('anon', 'public.overwatch_project_progress(text[], text[])', 'execute'));

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;
  if v_failed is null then
    raise exception 'TAB VIEWS TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'TAB VIEWS TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
