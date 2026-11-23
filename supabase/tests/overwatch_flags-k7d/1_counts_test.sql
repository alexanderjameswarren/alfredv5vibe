-- overwatch_flags-k7d: test the stalled and deadline_candidates changes to public.overwatch_nightly_counts.
-- Runs after the migration, with --test. It undoes itself: the inner block ends in its own error, the checks survive in a
-- variable, and the result row says { ok, failed, check_count, checks }. Settings are pinned by a throwaway plan, and only
-- the fixtures (ids and codes ofk*) are checked, so real rows can be present.
-- project_plans.status_written_at is stamped now by trigger when a status line is written, so the clock moves instead: v_soon is 3 days on (under
-- stall_days 5), v_late is 40 days on (well past it).

do $$
declare
  c_tz      constant text := 'America/Los_Angeles';
  c_done    constant text := 'OFK_UNDO';
  v_today   date := (now() at time zone c_tz)::date;
  v_soon    timestamptz := ((v_today + 3 + time '12:00') at time zone c_tz);
  v_late    timestamptz := ((v_today + 40 + time '12:00') at time zone c_tz);
  v_set     jsonb := '{"stall_days": 5, "waiting_on_alex_days": 3, "fading_days": 30, "overdue_days": 2,
                       "overrun_factor": 1.5, "active_project_limit": 1000, "inbox_backlog_threshold": 5,
                       "routing_low_confidence": 0.6, "urgent_within_days": 7, "inventory_stale_days": 7}';
  v_type    text;
  v_g       jsonb := '{}';
  v_id      text;
  v_name    text;
  v_r       jsonb;
  v_rows    jsonb;
  c         jsonb := '{}';
  v_result  jsonb;
begin
  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', '26f0707f-b586-4a3e-841c-8c313d6ab1e5', 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    perform public.create_overwatch_plan('TEST plan', v_set, 'Test only; rolled back.');
    select id into v_type from public.group_types where kind = 'project' order by created_at limit 1;

    foreach v_name in array array['fresh', 'old_report', 'old', 'dated', 'dated_own', 'undated', 'dated_someday'] loop
      insert into public.item_groups (group_type_id, name, status)
      values (v_type, 'ofk ' || v_name, case when v_name = 'dated_someday' then 'someday' else 'active' end)
      returning id into v_id;
      v_g := v_g || jsonb_build_object(v_name, v_id);
    end loop;

    -- Every plan writes a status line (where_now), as update_project_plan does, so project_plans_check_group stamps
    -- status_written_at now. With no status line it stays null.
    insert into public.project_plans (group_id, project_code, target_date, where_now) values
      (v_g ->> 'fresh', 'ofk-fresh', null, 'ofk status'),
      (v_g ->> 'old_report', 'ofk-old-report', null, 'ofk status'),
      (v_g ->> 'old', 'ofk-old', null, 'ofk status'),
      (v_g ->> 'dated', 'ofk-dated', v_today + 60, 'ofk status'),
      (v_g ->> 'dated_own', 'ofk-dated-own', v_today + 60, 'ofk status'),
      (v_g ->> 'undated', 'ofk-undated', null, 'ofk status'),
      (v_g ->> 'dated_someday', 'ofk-dated-someday', v_today + 60, 'ofk status');

    -- old_report: a report 10 days ago, older than its status line. old: a report 10 days before v_late, newer than it.
    insert into public.clips (source, page_text, run_tag, created_at) values
      ('cli', 'x', 'ofk-old-report-s1-aaaa', ((v_today - 10 + time '12:00') at time zone c_tz)),
      ('cli', 'x', 'ofk-old-s1-aaaa', ((v_today + 30 + time '12:00') at time zone c_tz));

    -- Intentions whose description names a deadline, none with an event.
    insert into public.intents (id, text, is_intention, status, updated_at, recurrence_config, archived, group_id, description)
    values
      ('ofk_d_member', 'd member of a dated project', true, 'active', now(), null, false, null, 'claim by March 31'),
      ('ofk_d_own', 'd own group is a dated project', true, 'active', now(), null, false, v_g ->> 'dated_own', 'claim by March 31'),
      ('ofk_d_undated', 'd member of an undated project', true, 'active', now(), null, false, null, 'claim by March 31'),
      ('ofk_d_someday', 'd member of a someday dated project', true, 'active', now(), null, false, null, 'claim by March 31'),
      ('ofk_d_removed', 'd removed from a dated project', true, 'active', now(), null, false, null, 'claim by March 31'),
      ('ofk_d_plain', 'd in no project', true, 'active', now(), null, false, null, 'claim by March 31');
    insert into public.item_group_members (group_id, member_type, member_id, position, removed_at) values
      (v_g ->> 'dated', 'intention', 'ofk_d_member', 1, null),
      (v_g ->> 'undated', 'intention', 'ofk_d_undated', 1, null),
      (v_g ->> 'dated_someday', 'intention', 'ofk_d_someday', 1, null),
      (v_g ->> 'dated', 'intention', 'ofk_d_removed', 2, now());

    -- Soon: status lines are 3 days old.
    v_r := public.overwatch_nightly_counts(v_soon);
    v_rows := v_r -> 'stalled';
    c := c || jsonb_build_object(
      'stalled_not_fresh_no_reports', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'fresh')),
      'stalled_not_old_report_fresh_status', not v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'old_report')),
      'projects_rows_unchanged', not exists (select 1 from jsonb_array_elements(v_r -> 'projects') x
                                             where x ? 'last_sign_at' or x ? 'sign_days'));

    v_rows := v_r -> 'deadline_candidates';
    c := c || jsonb_build_object(
      'deadline_out_member_of_dated', not v_rows @> '[{"id": "ofk_d_member"}]'::jsonb,
      'deadline_out_own_group_dated', not v_rows @> '[{"id": "ofk_d_own"}]'::jsonb,
      'deadline_in_member_of_undated', v_rows @> '[{"id": "ofk_d_undated"}]'::jsonb,
      'deadline_in_member_of_someday', v_rows @> '[{"id": "ofk_d_someday"}]'::jsonb,
      'deadline_in_removed_member', v_rows @> '[{"id": "ofk_d_removed"}]'::jsonb,
      'deadline_in_no_project', v_rows @> '[{"id": "ofk_d_plain", "description": "claim by March 31"}]'::jsonb);

    -- Late: status lines are 40 days old; old's report is 10 days old.
    v_r := public.overwatch_nightly_counts(v_late);
    v_rows := v_r -> 'stalled';
    c := c || jsonb_build_object(
      'stalled_old_untouched', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'old', 'days', 10)),
      'stalled_old_last_sign_is_report', exists (
        select 1 from jsonb_array_elements(v_rows) x
         where x ->> 'group_id' = v_g ->> 'old' and (x ->> 'last_sign_at')::timestamptz = (x ->> 'last_report_at')::timestamptz),
      'stalled_fresh_once_status_old', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'fresh', 'days', 40,
                                                                                      'last_report_at', null)),
      'stalled_old_report_once_status_old', v_rows @> jsonb_build_array(jsonb_build_object('group_id', v_g ->> 'old_report', 'days', 40)));

    -- Security, unchanged from 219.
    c := c || jsonb_build_object(
      'invoker', (select not p.prosecdef from pg_proc p where p.oid = 'public.overwatch_nightly_counts(timestamptz)'::regprocedure),
      'anon_cannot_execute', not has_function_privilege('anon', 'public.overwatch_nightly_counts(timestamptz)', 'execute'),
      'authenticated_can_execute', has_function_privilege('authenticated', 'public.overwatch_nightly_counts(timestamptz)', 'execute'));

    v_result := jsonb_build_object(
      'ok', not exists (select 1 from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'failed', (select coalesce(jsonb_agg(key order by key), '[]'::jsonb) from jsonb_each(c) where value is distinct from 'true'::jsonb),
      'check_count', (select count(*) from jsonb_object_keys(c)),
      'checks', c);
    raise exception '%', c_done;
  exception when others then
    if sqlerrm <> c_done then
      v_result := jsonb_build_object('ok', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks_so_far', c);
    end if;
  end;
  perform set_config('overwatch_flags.result', v_result::text, false);
end;
$$;

select current_setting('overwatch_flags.result')::jsonb as result;
