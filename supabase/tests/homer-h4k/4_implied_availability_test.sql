-- Homer s10: completion 'implied', the series availability columns and their checks, and homer_quiet_series's
-- availability fields. Queue with --test after the s10 migration. Runs as Alex (authenticated, under RLS) on
-- throwaway TEST rows, all undone.
-- Result: one row with all_passed, failed and checks.
-- supabase/tests/homer-h4k/4_implied_availability_test.sql

do $$
declare
  c_alex constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_scales constant jsonb := '[{"key":"tone","label":"Tone","kind":"range","min":1,"max":5}]';
  v_app jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_err text;
  v_series uuid;
  rec record;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    -- Books 1 and 2 read (1 finished by Amazon, 2 implied); 3 and 4 in the library, unread.
    v_app := public.homer_import_batch(jsonb_build_object(
      'readers', '[{"key":"test_r1","name":"TEST R1"}]'::jsonb,
      'devices', '[{"device_id":"TEST-D1","owner":"test_r1","owner_reason":"TEST"}]'::jsonb,
      'series', '[{"name":"TEST Avail","series_asin":"BTESTS0101"}]'::jsonb,
      'books', '[
        {"asin":"BTESTA0001","title":"TEST Avail 1","series_asin":"BTESTS0101","series_position":1},
        {"asin":"BTESTA0002","title":"TEST Avail 2","series_asin":"BTESTS0101","series_position":2},
        {"asin":"BTESTA0003","title":"TEST Avail 3","series_asin":"BTESTS0101","series_position":3},
        {"asin":"BTESTA0004","title":"TEST Avail 4","series_asin":"BTESTS0101","series_position":4}]'::jsonb,
      'reads', jsonb_build_array(
        jsonb_build_object('import_key', 'export:BTESTA0001:TEST-D1', 'asin', 'BTESTA0001', 'device_id', 'TEST-D1',
          'started_on', (current_date - 60)::text, 'finished_on', (current_date - 50)::text, 'hours', 6, 'completion', 'automatic'),
        jsonb_build_object('import_key', 'export:BTESTA0002:TEST-D1', 'asin', 'BTESTA0002', 'device_id', 'TEST-D1',
          'started_on', (current_date - 45)::text, 'finished_on', (current_date - 40)::text, 'hours', 5, 'completion', 'implied'))),
      false);
    select id into v_series from public.homer_series where series_asin = 'BTESTS0101';

    -- a. completion 'implied' is allowed, and still needs finished_on.
    v_checks := v_checks || jsonb_build_object(
      'a_implied_read_accepted', v_app #>> '{counts,reads,inserted}' = '2' and v_app #>> '{counts,reads,refused}' = '0',
      'a_implied_stored', exists (select 1 from public.homer_reads where import_key = 'export:BTESTA0002:TEST-D1' and completion = 'implied'));
    v_err := null;
    begin update public.homer_reads set finished_on = null where import_key = 'export:BTESTA0002:TEST-D1';
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_implied_without_finish_refused', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_reads set completion = 'guessed' where import_key = 'export:BTESTA0002:TEST-D1';
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_other_completion_refused', v_err is not distinct from '23514');

    -- b. The availability columns exist, are commented, and their checks hold.
    v_checks := v_checks || jsonb_build_object('b_columns_commented', (
      select count(*) = 5 from pg_attribute a
       where a.attrelid = 'public.homer_series'::regclass and not a.attisdropped
         and a.attname in ('available_position', 'upcoming_position', 'upcoming_release_date', 'availability_checked_on', 'availability_source')
         and col_description(a.attrelid, a.attnum) is not null));
    v_err := null;
    begin update public.homer_series set available_position = 0 where id = v_series;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('b_position_must_be_positive', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_series set upcoming_release_date = current_date + 30 where id = v_series;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('b_release_date_needs_upcoming', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_series set available_position = 3, upcoming_position = 3 where id = v_series;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('b_upcoming_after_available', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_series set availability_source = '  ' where id = v_series;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('b_blank_source_refused', v_err is not distinct from '23514');

    -- c. homer_quiet_series availability. Two finished, so the plan's default makes the series liked.
    perform public.create_homer_plan('TEST', jsonb_build_object('scales', c_scales,
      'default_verdict', '{"liked_min_finished":2,"otherwise":"didnt_click"}'::jsonb, 'tired_gap_days', 180, 'quiet_after_days', 120), 'TEST plan');
    select * into rec from public.homer_quiet_series('test_r1') where series_name = 'TEST Avail';
    v_checks := v_checks || jsonb_build_object(
      'c_implied_counts_as_finished', rec.books_finished = 2 and rec.last_finished_position = 2,
      'c_unknown_availability_is_null', rec.available_position is null and rec.books_behind is null and rec.is_caught_up is null,
      'c_unknown_next_from_library', rec.next_position = 3);

    -- Book 3 is announced, not out: caught up, and no next book even though the library holds book 3.
    update public.homer_series set available_position = 2, upcoming_position = 3, upcoming_release_date = current_date + 50,
           availability_checked_on = current_date, availability_source = 'TEST' where id = v_series;
    select * into rec from public.homer_quiet_series('test_r1') where series_name = 'TEST Avail';
    v_checks := v_checks || jsonb_build_object(
      'c_caught_up', rec.books_behind = 0 and rec.is_caught_up,
      'c_upcoming_not_available', rec.next_position is null and rec.upcoming_position = 3
                                  and rec.upcoming_release_date = current_date + 50,
      'c_checked_on', rec.availability_checked_on = current_date);

    -- Four published: two behind, next is book 3.
    update public.homer_series set available_position = 4, upcoming_position = null, upcoming_release_date = null where id = v_series;
    select * into rec from public.homer_quiet_series('test_r1') where series_name = 'TEST Avail';
    v_checks := v_checks || jsonb_build_object(
      'c_books_behind', rec.books_behind = 2 and not rec.is_caught_up,
      'c_next_published', rec.next_position = 3 and rec.next_asin = 'BTESTA0003');

    -- d. Grants on the replaced function.
    v_checks := v_checks || jsonb_build_object(
      'd_anon_cannot_read_quiet', not has_function_privilege('anon', 'public.homer_quiet_series(text)', 'execute'),
      'd_authenticated_can_read_quiet', has_function_privilege('authenticated', 'public.homer_quiet_series(text)', 'execute'),
      'd_security_invoker', not exists (select 1 from pg_proc where proname = 'homer_quiet_series' and prosecdef));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'homer_implied_availability_undo';
  exception when others then
    if sqlerrm <> 'homer_implied_availability_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks', v_checks);
    end if;
  end;
  perform set_config('homer.implied_availability_result', v_result::text, true);
end;
$$;

select current_setting('homer.implied_availability_result')::jsonb as result;
