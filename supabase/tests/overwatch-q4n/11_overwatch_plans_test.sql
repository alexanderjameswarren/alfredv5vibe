-- Overwatch Step 12: the plan rulebook (one active, its two RPCs, the guard), watch, notes, seen releases and process
-- friction. Open and run the whole file.
--
-- It ENDS IN AN ERROR ON PURPOSE. The error undoes everything it wrote, so nothing is saved, including the plan it
-- supersedes on the way. It runs as the user who owns the Money context (Alex).
-- The error starts "OVERWATCH TABLES TEST PASSED" or "OVERWATCH TABLES TEST FAILED".
-- supabase/tests/overwatch-q4n/11_overwatch_plans_test.sql

do $$
declare
  v_uid     uuid := (select user_id from public.contexts where id = 'muvitejhrgt3rgi8t6q');
  v_first   uuid;
  v_new     jsonb;
  v_r       jsonb;
  v_res     jsonb := '{}'::jsonb;
  v_failed  text;
  v_err     text;
  n         int;
begin
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  -- a. The starting plan is seeded and is the one active plan.
  select id into v_first from public.overwatch_plans where active;
  select count(*) into n from public.overwatch_plans where active;
  v_res := v_res || jsonb_build_object(
    'a_one_active', n = 1,
    'a_seeded_settings', (select settings ->> 'stall_days' = '5' and settings ->> 'push_time' = '07:30'
                            from public.overwatch_plans where id = v_first));

  -- b. update_overwatch_checks replaces the checks; bad checks are refused.
  v_r := public.update_overwatch_checks('[{"text": "TEST check", "check_on": "2026-11-01", "about": "dj"}]'::jsonb);
  v_res := v_res || jsonb_build_object('b_checks_replaced', jsonb_array_length(v_r -> 'checks_next_run') = 1);
  v_err := null;
  begin
    perform public.update_overwatch_checks('{"text": "not an array"}'::jsonb);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('b_not_array_refused', v_err is not distinct from '22023');
  v_err := null;
  begin
    perform public.update_overwatch_checks('[{"text": "no date"}]'::jsonb);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('b_missing_date_refused', v_err is not distinct from '22023');

  -- c. create_overwatch_plan supersedes: one active, linked back, checks carried over.
  v_new := public.create_overwatch_plan('TEST instructions', '{"stall_days": 7}'::jsonb, 'TEST reason');
  select count(*) into n from public.overwatch_plans where active;
  v_res := v_res || jsonb_build_object(
    'c_still_one_active', n = 1,
    'c_new_is_active', (v_new ->> 'active')::boolean and (v_new ->> 'supersedes_id')::uuid = v_first,
    'c_old_inactive', not (select active from public.overwatch_plans where id = v_first),
    'c_checks_carried', jsonb_array_length(v_new -> 'checks_next_run') = 1);

  -- d. A second active plan inserted directly is refused.
  v_err := null;
  begin
    insert into public.overwatch_plans (instructions, settings) values ('TEST second', '{}'::jsonb);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('d_second_active_refused', v_err is not distinct from '23505');

  -- e. Plan rows are not edited, and a superseded plan cannot come back.
  v_err := null;
  begin
    update public.overwatch_plans set instructions = 'edited' where id = (v_new ->> 'id')::uuid;
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('e_edit_refused', v_err is not distinct from '23514');
  v_err := null;
  begin
    update public.overwatch_plans set active = true where id = v_first;
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('e_reactivate_refused', v_err is not distinct from '23514');
  v_err := null;
  begin
    perform public.create_overwatch_plan('TEST', '{}'::jsonb, '');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('e_reason_required', v_err is not distinct from '22023');

  -- f. Watch items: dates in order, known kinds.
  insert into public.overwatch_watch (kind, text, app_id, ends_on) values ('ease_off', 'TEST', 'dj', current_date + 7);
  v_res := v_res || jsonb_build_object('f_watch_created', exists (select 1 from public.overwatch_watch where text = 'TEST'));
  v_err := null;
  begin
    insert into public.overwatch_watch (kind, text, starts_on, ends_on) values ('focus', 'TEST', current_date, current_date - 1);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('f_dates_out_of_order_refused', v_err is not distinct from '23514');

  -- g. One note per period per day.
  insert into public.overwatch_notes (period, for_date, body, plan_id) values ('nightly', '2000-01-01', 'TEST', (v_new ->> 'id')::uuid);
  v_err := null;
  begin
    insert into public.overwatch_notes (period, for_date, body) values ('nightly', '2000-01-01', 'TEST again');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('g_one_note_per_day', v_err is not distinct from '23505');

  -- h. A release entry is recorded once per source.
  insert into public.overwatch_seen_releases (source, entry_key, title) values ('claude_code_changelog', 'TEST-0.0.0', 'TEST');
  v_err := null;
  begin
    insert into public.overwatch_seen_releases (source, entry_key, title) values ('claude_code_changelog', 'TEST-0.0.0', 'TEST');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('h_release_once', v_err is not distinct from '23505');

  -- i. Friction: named processes and skill:<name>; anything else refused; resolved_by and resolved_at go together.
  insert into public.process_friction (what_happened, process, project_code) values
    ('TEST', 'cli_testing_steps', 'overwatch-q4n'), ('TEST', 'skill:cli-workflow', null);
  v_res := v_res || jsonb_build_object(
    'i_friction_created', (select count(*) = 2 from public.process_friction where what_happened = 'TEST'));
  v_err := null;
  begin
    insert into public.process_friction (what_happened, process) values ('TEST', 'random');
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('i_unknown_process_refused', v_err is not distinct from '23514');
  v_err := null;
  begin
    update public.process_friction set resolved_by = 'TEST fix' where what_happened = 'TEST';
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('i_resolved_pair_enforced', v_err is not distinct from '23514');

  -- j. Another user sees none of it.
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select (select count(*) from public.overwatch_plans) + (select count(*) from public.overwatch_watch)
       + (select count(*) from public.overwatch_notes) + (select count(*) from public.overwatch_seen_releases)
       + (select count(*) from public.process_friction) into n;
  v_res := v_res || jsonb_build_object('j_hidden_from_other_user', n = 0);
  v_err := null;
  begin
    perform public.update_overwatch_checks('[]'::jsonb);
  exception when others then v_err := sqlstate;
  end;
  v_res := v_res || jsonb_build_object('j_other_user_has_no_plan', v_err is not distinct from 'P0002');
  perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);

  select string_agg(key, ', ' order by key) into v_failed
    from jsonb_each(v_res) where value is distinct from 'true'::jsonb;

  if v_failed is null then
    raise exception 'OVERWATCH TABLES TEST PASSED: all % checks true. Nothing was saved.',
      (select count(*) from jsonb_object_keys(v_res));
  end if;
  raise exception 'OVERWATCH TABLES TEST FAILED: %. Nothing was saved. Details: %', v_failed, v_res;
end;
$$;
