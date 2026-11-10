-- Homer: the import RPC (dry run, apply, idempotency, refusals, owners) and the two read functions (default and
-- stored verdicts, the plan rule, quiet series, tired gap, never left out). Queue with --test after both migrations.
-- Runs as Alex (authenticated, under RLS) on throwaway TEST rows, all undone.
-- Result: one row with all_passed, failed and checks.
-- supabase/tests/homer-h4k/3_queries_import_test.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_scales constant jsonb := '[{"key":"tone","label":"Tone","kind":"range","min":1,"max":5}]';
  v_batch jsonb;
  v_dry jsonb; v_app jsonb; v_again jsonb; v_chg jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_err text;
  v_before int; v_after int;
  v_r1 uuid;
  rec record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    v_batch := jsonb_build_object(
      'readers', '[{"key":"test_r1","name":"TEST R1"}]'::jsonb,
      'devices', jsonb_build_array(
        jsonb_build_object('device_id', 'TEST-D1', 'owner', 'test_r1', 'owner_reason', 'TEST', 'sessions', 3, 'hours', 12.5,
                           'first_session', (current_date - 400)::text, 'last_session', (current_date - 10)::text),
        jsonb_build_object('device_id', 'TEST-D2'),
        jsonb_build_object('device_id', 'TEST-D3', 'owner', 'nobody')),
      'series', '[{"name":"TEST Liked","series_asin":"BTESTS0001"},{"name":"TEST Once","series_asin":"BTESTS0002"},{"name":"TEST NoAsin"}]'::jsonb,
      'books', '[
        {"asin":"BTESTL0001","title":"TEST Liked 1","series_asin":"BTESTS0001","series_position":1,"acquired":"kindle_unlimited"},
        {"asin":"BTESTL0002","title":"TEST Liked 2","series_asin":"BTESTS0001","series_position":2,"acquired":"purchase"},
        {"asin":"BTESTL0003","title":"TEST Liked 3","series_asin":"BTESTS0001","series_position":3},
        {"asin":"BTESTO0001","title":"TEST Once 1","series_asin":"BTESTS0002","series_position":1},
        {"asin":"BTESTN0001","title":"TEST NoAsin 1","series_name":"TEST NoAsin","series_position":1},
        {"asin":"BTESTX0001","title":"TEST bad series","series_asin":"BTESTS9999"}]'::jsonb,
      'reads', jsonb_build_array(
        jsonb_build_object('import_key', 'export:BTESTL0001:TEST-D1', 'asin', 'BTESTL0001', 'device_id', 'TEST-D1',
          'started_on', (current_date - 420)::text, 'finished_on', (current_date - 400)::text, 'hours', 6.2, 'completion', 'automatic'),
        jsonb_build_object('import_key', 'export:BTESTL0002:TEST-D1', 'asin', 'BTESTL0002', 'device_id', 'TEST-D1',
          'started_on', (current_date - 399)::text, 'finished_on', (current_date - 390)::text, 'hours', 5.0, 'completion', 'manual'),
        jsonb_build_object('import_key', 'export:BTESTO0001:TEST-D1', 'asin', 'BTESTO0001', 'device_id', 'TEST-D1',
          'started_on', (current_date - 20)::text, 'finished_on', (current_date - 10)::text, 'hours', 4.0, 'completion', 'automatic'),
        jsonb_build_object('import_key', 'export:BTESTN0001:TEST-D1', 'asin', 'BTESTN0001', 'device_id', 'TEST-D1',
          'started_on', (current_date - 30)::text, 'hours', 1.0),
        jsonb_build_object('import_key', 'export:BTESTO0001:TEST-D2', 'asin', 'BTESTO0001', 'device_id', 'TEST-D2',
          'started_on', (current_date - 50)::text, 'hours', 0.7),
        jsonb_build_object('import_key', 'export:BTESTZ0001:TEST-D1', 'asin', 'BTESTZ0001', 'device_id', 'TEST-D1')));

    select (select count(*) from public.homer_readers where key like 'test\_%')
         + (select count(*) from public.homer_devices where device_id like 'TEST-%')
         + (select count(*) from public.homer_series where name like 'TEST %')
         + (select count(*) from public.homer_books where asin like 'BTEST%')
         + (select count(*) from public.homer_reads where import_key like 'export:BTEST%') into v_before;

    -- a. Batch limits and shape.
    v_err := null;
    begin perform public.homer_import_batch(jsonb_build_object('readers',
            (select jsonb_agg(jsonb_build_object('key', 'test_' || i, 'name', 'TEST')) from generate_series(1, 501) i)), true);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_over_500_refused', v_err is not distinct from '22023');
    v_err := null;
    begin perform public.homer_import_batch('{"genres":[]}'::jsonb, true);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_unknown_kind_refused', v_err is not distinct from '22023');

    -- b. A dry run reports the real counts and changes nothing.
    v_dry := public.homer_import_batch(v_batch, true);
    select (select count(*) from public.homer_readers where key like 'test\_%')
         + (select count(*) from public.homer_devices where device_id like 'TEST-%')
         + (select count(*) from public.homer_series where name like 'TEST %')
         + (select count(*) from public.homer_books where asin like 'BTEST%')
         + (select count(*) from public.homer_reads where import_key like 'export:BTEST%') into v_after;
    v_checks := v_checks || jsonb_build_object(
      'b_dry_run_flag', (v_dry ->> 'dry_run')::boolean,
      'b_dry_run_changes_nothing', v_after = v_before,
      'b_dry_counts', v_dry #>> '{counts,readers,inserted}' = '1' and v_dry #>> '{counts,devices,inserted}' = '2'
                      and v_dry #>> '{counts,devices,refused}' = '1' and v_dry #>> '{counts,series,inserted}' = '3'
                      and v_dry #>> '{counts,books,inserted}' = '5' and v_dry #>> '{counts,books,refused}' = '1'
                      and v_dry #>> '{counts,reads,inserted}' = '5' and v_dry #>> '{counts,reads,refused}' = '1',
      'b_refusals_named', jsonb_array_length(v_dry -> 'refused') = 3
                          and exists (select 1 from jsonb_array_elements(v_dry -> 'refused') x where x ->> 'key' = 'BTESTX0001'
                                      and x ->> 'reason' like '%not found%'));

    -- c. Apply gives the same counts; a second run changes nothing.
    v_app := public.homer_import_batch(v_batch, false);
    v_checks := v_checks || jsonb_build_object(
      'c_apply_matches_dry', (v_app -> 'counts') = (v_dry -> 'counts'),
      'c_rows_written', (select count(*) = 5 from public.homer_reads where import_key like 'export:BTEST%'));
    v_again := public.homer_import_batch(v_batch, false);
    v_checks := v_checks || jsonb_build_object(
      'c_second_run_no_inserts', (select bool_and((value ->> 'inserted')::int = 0) from jsonb_each(v_again -> 'counts')),
      'c_second_run_no_updates', (select bool_and((value ->> 'updated')::int = 0) from jsonb_each(v_again -> 'counts')),
      'c_second_run_all_unchanged', v_again #>> '{counts,reads,unchanged}' = '5' and v_again #>> '{counts,books,unchanged}' = '5'
                                    and v_again #>> '{counts,series,unchanged}' = '3' and v_again #>> '{counts,devices,unchanged}' = '2');

    -- d. A changed field is one update; owners: labelled device's reads get the reader, unknown device's stay null.
    v_chg := public.homer_import_batch(jsonb_build_object('reads', jsonb_build_array((v_batch -> 'reads' -> 0) || '{"hours": 6.9}')), false);
    select id into v_r1 from public.homer_readers where key = 'test_r1';
    v_checks := v_checks || jsonb_build_object(
      'd_changed_field_updated', v_chg #>> '{counts,reads,updated}' = '1',
      'd_owner_set_from_label', (select reader_id = v_r1 from public.homer_devices where device_id = 'TEST-D1'),
      'd_read_takes_owner', (select reader_id = v_r1 from public.homer_reads where import_key = 'export:BTESTL0001:TEST-D1'),
      'd_unknown_device_read_null', (select reader_id is null from public.homer_reads where import_key = 'export:BTESTO0001:TEST-D2'),
      'd_series_by_name', (select s.name = 'TEST NoAsin' from public.homer_books b join public.homer_series s on s.id = b.series_id
                            where b.asin = 'BTESTN0001'));
    -- A batch without the owner never clears one already set.
    perform public.homer_import_batch(jsonb_build_object('devices', jsonb_build_array((v_batch -> 'devices' -> 0) - 'owner')), false);
    v_checks := v_checks || jsonb_build_object('d_missing_owner_keeps_owner',
      (select reader_id = v_r1 from public.homer_devices where device_id = 'TEST-D1'));

    -- e. Default verdicts follow the active plan's rule and are never stored.
    perform public.create_homer_plan('TEST', jsonb_build_object('scales', c_scales,
      'default_verdict', '{"liked_min_finished":2,"otherwise":"didnt_click"}'::jsonb, 'tired_gap_days', 180, 'quiet_after_days', 120), 'TEST plan');
    v_checks := v_checks || jsonb_build_object(
      'e_two_finished_is_liked', (select verdict = 'liked' and is_default and books_finished = 2 from public.homer_series_verdicts('test_r1') where series_name = 'TEST Liked'),
      'e_one_finished_is_didnt_click', (select verdict = 'didnt_click' and is_default from public.homer_series_verdicts('test_r1') where series_name = 'TEST Once'),
      'e_partial_is_didnt_click', (select verdict = 'didnt_click' and books_finished = 0 and books_started = 1 from public.homer_series_verdicts('test_r1') where series_name = 'TEST NoAsin'),
      'e_no_verdicts_stored', not exists (select 1 from public.homer_verdicts where reader_id = v_r1));
    perform public.create_homer_plan('TEST', jsonb_build_object('scales', c_scales,
      'default_verdict', '{"liked_min_finished":3,"otherwise":"didnt_click"}'::jsonb, 'tired_gap_days', 180, 'quiet_after_days', 120), 'TEST rule 3');
    v_checks := v_checks || jsonb_build_object('e_rule_change_applies_at_once',
      (select verdict = 'didnt_click' from public.homer_series_verdicts('test_r1') where series_name = 'TEST Liked'));
    perform public.create_homer_plan('TEST', jsonb_build_object('scales', c_scales,
      'default_verdict', '{"liked_min_finished":2,"otherwise":"didnt_click"}'::jsonb, 'tired_gap_days', 180, 'quiet_after_days', 120), 'TEST rule 2');

    -- f. A stored verdict overrides the default.
    insert into public.homer_verdicts (reader_id, subject_kind, series_id, verdict, set_by, note)
      select v_r1, 'series', id, 'loved', 'alex', 'TEST' from public.homer_series where series_asin = 'BTESTS0002';
    v_checks := v_checks || jsonb_build_object('f_stored_overrides_default',
      (select verdict = 'loved' and not is_default and stored_verdict = 'loved' from public.homer_series_verdicts('test_r1') where series_name = 'TEST Once'));

    -- g. Quiet series: liked/loved/tired only, last finished book, days since, next book, quiet threshold.
    select * into rec from public.homer_quiet_series('test_r1') where series_name = 'TEST Liked';
    v_checks := v_checks || jsonb_build_object(
      'g_liked_listed', rec.series_id is not null,
      'g_last_book', rec.last_finished_position = 2 and rec.last_finished_title = 'TEST Liked 2',
      'g_days_since', rec.days_since = 390 and rec.last_read_on = current_date - 390,
      'g_is_quiet', rec.is_quiet and rec.quiet_after_days = 120,
      'g_next_book', rec.next_position = 3 and rec.next_asin = 'BTESTL0003',
      'g_tired_gap_null_unless_tired', rec.tired_gap_passed is null);
    select * into rec from public.homer_quiet_series('test_r1') where series_name = 'TEST Once';
    v_checks := v_checks || jsonb_build_object('g_recent_not_quiet', rec.series_id is not null and not rec.is_quiet and rec.days_since = 10);
    v_checks := v_checks || jsonb_build_object('g_didnt_click_left_out',
      not exists (select 1 from public.homer_quiet_series('test_r1') where series_name = 'TEST NoAsin'));
    insert into public.homer_verdicts (reader_id, subject_kind, series_id, verdict, set_by)
      select v_r1, 'series', id, 'tired', 'claude' from public.homer_series where series_asin = 'BTESTS0001';
    v_checks := v_checks || jsonb_build_object('g_tired_gap_passed',
      (select tired_gap_passed from public.homer_quiet_series('test_r1') where series_name = 'TEST Liked'));
    update public.homer_verdicts set verdict = 'never', set_by = 'alex' where reader_id = v_r1 and series_id = (select id from public.homer_series where series_asin = 'BTESTS0002');
    v_checks := v_checks || jsonb_build_object('g_never_left_out',
      not exists (select 1 from public.homer_quiet_series('test_r1') where series_name = 'TEST Once'));

    -- h. Grants.
    v_checks := v_checks || jsonb_build_object(
      'h_anon_cannot_import', not has_function_privilege('anon', 'public.homer_import_batch(jsonb, boolean)', 'execute'),
      'h_anon_cannot_read_verdicts', not has_function_privilege('anon', 'public.homer_series_verdicts(text)', 'execute'),
      'h_anon_cannot_read_quiet', not has_function_privilege('anon', 'public.homer_quiet_series(text)', 'execute'),
      'h_security_invoker', not exists (select 1 from pg_proc where proname in ('homer_import_batch', 'homer_series_verdicts', 'homer_quiet_series') and prosecdef));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks,
      'dry_run_result', v_dry);
    raise exception 'homer_queries_import_undo';
  exception when others then
    if sqlerrm <> 'homer_queries_import_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks', v_checks);
    end if;
  end;
  perform set_config('homer.queries_import_result', v_result::text, true);
end;
$$;

select current_setting('homer.queries_import_result')::jsonb as result;
