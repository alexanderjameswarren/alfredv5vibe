-- Homer s5: every guard in the core migration refuses what it should and allows what it should.
-- Queue with --test. Runs as Alex (authenticated, under RLS) on throwaway TEST rows, all undone.
-- Result: one row with all_passed, failed and checks.
-- supabase/tests/homer-h4k/2_guards_test.sql

do $$
declare
  c_alex   constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_scales constant jsonb := '[
    {"key":"tone","label":"Tone","kind":"range","min":1,"max":5},
    {"key":"harem","label":"Harem level","kind":"choice","choices":["none","mild","big","absurd"]},
    {"key":"setting","label":"Setting","kind":"multi","choices":["urban","nobility","isekai"]}]';
  v_settings jsonb;
  v_checks jsonb := '{}'::jsonb;
  v_result jsonb;
  v_err    text;
  v_p1 jsonb; v_p2 jsonb; v_p3 jsonb;
  v_alex uuid; v_elise uuid;
  v_dev_owned uuid; v_dev_free uuid;
  v_series uuid; v_book uuid; v_book2 uuid;
  v_read uuid; v_read2 uuid; v_read3 uuid;
  v_verdict uuid; v_taste uuid; v_genre uuid;
  n int;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', c_alex, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    v_settings := jsonb_build_object('scales', c_scales,
      'default_verdict', '{"liked_min_finished":2,"otherwise":"didnt_click"}'::jsonb,
      'tired_gap_days', 180, 'quiet_after_days', 120, 'suggestions', '{"for_readers":["alex"]}'::jsonb);

    -- a. Plan settings are validated (RPC and check constraint).
    v_err := null;
    begin perform public.create_homer_plan('TEST', v_settings || '{"scales":[{"key":"x","label":"X","kind":"slider"}]}', 'TEST');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_bad_scale_kind_refused', v_err is not distinct from '22023');
    v_err := null;
    begin perform public.create_homer_plan('TEST', v_settings || jsonb_build_object('scales', c_scales || jsonb_build_array(c_scales -> 0)), 'TEST');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_duplicate_scale_refused', v_err is not distinct from '22023');
    v_err := null;
    begin perform public.create_homer_plan('TEST', v_settings || '{"default_verdict":{"liked_min_finished":2,"otherwise":"never"}}', 'TEST');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_default_never_refused', v_err is not distinct from '22023');
    v_err := null;
    begin perform public.create_homer_plan('TEST', v_settings - 'tired_gap_days', 'TEST');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_missing_tired_gap_refused', v_err is not distinct from '22023');
    v_err := null;
    begin insert into public.homer_plans (version, instructions, settings) values (999, 'TEST', '{"scales":"no"}');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('a_direct_bad_settings_refused', v_err is not distinct from '23514');

    -- b. A plan is written; superseding needs a summary and leaves exactly one active.
    v_p1 := public.create_homer_plan('TEST instructions', v_settings, 'TEST first');
    v_checks := v_checks || jsonb_build_object('b_plan_written', v_p1 ->> 'status' = 'active');
    v_err := null;
    begin perform public.create_homer_plan('TEST', v_settings, null);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('b_summary_required', v_err is not distinct from '22023');
    v_p2 := public.create_homer_plan('TEST v2', v_settings || jsonb_build_object('scales', c_scales ||
              '[{"key":"pace","label":"Pace","kind":"range","min":1,"max":3}]'::jsonb), 'TEST add pace', 'alex');
    select count(*) into n from public.homer_plans where status = 'active';
    v_checks := v_checks || jsonb_build_object(
      'b_one_active', n = 1,
      'b_version_next', (v_p2 ->> 'version')::int = (v_p1 ->> 'version')::int + 1,
      'b_linked', (v_p2 ->> 'supersedes_plan_id')::uuid = (v_p1 ->> 'id')::uuid,
      'b_old_superseded', (select status = 'superseded' and ended_at is not null from public.homer_plans where id = (v_p1 ->> 'id')::uuid));

    -- c. Plan rows are never edited or reactivated; a second active plan is refused.
    v_err := null;
    begin update public.homer_plans set instructions = 'edited' where id = (v_p2 ->> 'id')::uuid;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('c_edit_refused', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_plans set status = 'active', ended_at = null where id = (v_p1 ->> 'id')::uuid;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('c_reactivate_refused', v_err is not distinct from '23514');
    v_err := null;
    begin insert into public.homer_plans (version, instructions, settings) values (999, 'TEST second', v_settings);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('c_second_active_refused', v_err is not distinct from '23505');

    -- Fixture rows.
    insert into public.homer_readers (key, name) values ('test_alex', 'TEST Alex') returning id into v_alex;
    insert into public.homer_readers (key, name) values ('test_elise', 'TEST Elise') returning id into v_elise;
    insert into public.homer_devices (device_id, reader_id) values ('TEST-DEV-OWNED', v_alex) returning id into v_dev_owned;
    insert into public.homer_devices (device_id) values ('TEST-DEV-FREE') returning id into v_dev_free;
    insert into public.homer_series (name, series_asin) values ('TEST Series', 'BTESTSER01') returning id into v_series;
    insert into public.homer_books (asin, title, series_id, series_position, acquired)
      values ('BTEST00001', 'TEST Book 1', v_series, 1, 'kindle_unlimited') returning id into v_book;
    insert into public.homer_books (asin, title, series_id, series_position) values ('BTEST00002', 'TEST Book 2', v_series, 2)
      returning id into v_book2;

    -- d. Devices: owner_status is derived.
    v_checks := v_checks || jsonb_build_object(
      'd_owner_confirmed', (select owner_status = 'confirmed' from public.homer_devices where id = v_dev_owned),
      'd_owner_unknown',   (select owner_status = 'unknown' from public.homer_devices where id = v_dev_free));
    update public.homer_devices set proposed_reader_id = v_elise where id = v_dev_free;
    v_checks := v_checks || jsonb_build_object('d_owner_proposed', (select owner_status = 'proposed' from public.homer_devices where id = v_dev_free));

    -- e. Books: known acquisition values only; a position needs a series.
    v_err := null;
    begin insert into public.homer_books (asin, title, acquired) values ('BTEST00009', 'TEST', 'stolen');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('e_bad_acquired_refused', v_err is not distinct from '23514');
    v_err := null;
    begin insert into public.homer_books (asin, title, series_position) values ('BTEST00008', 'TEST', 3);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('e_position_without_series_refused', v_err is not distinct from '23514');

    -- f. Reads: reader from the device; null until it has an owner; carried when the owner is confirmed;
    --    one per book per device; a read needs a reader or a device.
    insert into public.homer_reads (book_id, device_id, source, finished_on, completion)
      values (v_book, v_dev_owned, 'export', '2026-01-02', 'automatic') returning id into v_read;
    insert into public.homer_reads (book_id, device_id, source) values (v_book, v_dev_free, 'export') returning id into v_read2;
    insert into public.homer_reads (book_id, device_id, reader_id, source) values (v_book2, v_dev_free, v_alex, 'export')
      returning id into v_read3;
    v_checks := v_checks || jsonb_build_object(
      'f_reader_from_device', (select reader_id = v_alex from public.homer_reads where id = v_read),
      'f_reader_null_without_owner', (select reader_id is null from public.homer_reads where id = v_read2));
    update public.homer_devices set reader_id = v_elise where id = v_dev_free;
    v_checks := v_checks || jsonb_build_object(
      'f_owner_carried', (select reader_id = v_elise from public.homer_reads where id = v_read2),
      'f_hand_set_reader_kept', (select reader_id = v_alex from public.homer_reads where id = v_read3));
    v_err := null;
    begin insert into public.homer_reads (book_id, device_id, source) values (v_book, v_dev_owned, 'export');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('f_one_per_book_device', v_err is not distinct from '23505');
    v_err := null;
    begin insert into public.homer_reads (book_id, source) values (v_book, 'chat');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('f_reader_or_device_required', v_err is not distinct from '23514');
    insert into public.homer_reads (book_id, reader_id, source, finished_on) values (v_book, v_alex, 'chat', '2026-02-01');
    v_checks := v_checks || jsonb_build_object('f_chat_read_without_device', true);
    v_err := null;
    begin insert into public.homer_reads (book_id, reader_id, source) values (v_book, v_alex, 'email');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('f_bad_source_refused', v_err is not distinct from '23514');
    v_err := null;
    begin insert into public.homer_reads (book_id, reader_id, source, started_on, finished_on) values (v_book2, v_elise, 'chat', '2026-03-02', '2026-03-01');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('f_dates_out_of_order_refused', v_err is not distinct from '23514');

    -- g. Verdicts: never needs set_by alex; only alex lifts it; one subject; one per reader and subject.
    v_err := null;
    begin insert into public.homer_verdicts (reader_id, subject_kind, series_id, verdict, set_by) values (v_alex, 'series', v_series, 'never', 'claude');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('g_never_by_claude_refused', v_err is not distinct from '23514');
    insert into public.homer_verdicts (reader_id, subject_kind, series_id, verdict, set_by)
      values (v_alex, 'series', v_series, 'never', 'alex') returning id into v_verdict;
    v_checks := v_checks || jsonb_build_object('g_never_by_alex_allowed', v_verdict is not null);
    v_err := null;
    begin update public.homer_verdicts set verdict = 'liked', set_by = 'claude' where id = v_verdict;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('g_claude_cannot_lift_never', v_err is not distinct from '23514');
    update public.homer_verdicts set verdict = 'tired', set_by = 'alex' where id = v_verdict;
    v_checks := v_checks || jsonb_build_object('g_alex_lifts_never', (select verdict = 'tired' from public.homer_verdicts where id = v_verdict));
    update public.homer_verdicts set verdict = 'liked', set_by = 'claude' where id = v_verdict;
    v_checks := v_checks || jsonb_build_object('g_claude_edits_other_verdicts', (select verdict = 'liked' from public.homer_verdicts where id = v_verdict));
    v_err := null;
    begin insert into public.homer_verdicts (reader_id, subject_kind, series_id, verdict, set_by) values (v_alex, 'series', v_series, 'loved', 'alex');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('g_one_per_subject', v_err is not distinct from '23505');
    v_err := null;
    begin insert into public.homer_verdicts (reader_id, subject_kind, series_id, book_id, verdict, set_by) values (v_elise, 'series', v_series, v_book, 'liked', 'alex');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('g_mixed_subject_refused', v_err is not distinct from '23514');
    insert into public.homer_verdicts (reader_id, subject_kind, author, verdict, set_by) values (v_alex, 'author', 'TEST Author', 'loved', 'claude');
    v_checks := v_checks || jsonb_build_object('g_author_verdict_allowed', true);

    -- h. Taste scores: checked against the active plan (v2 has tone, harem, setting, pace).
    insert into public.homer_taste_profiles (reader_id, series_id, description, scores)
      values (v_alex, v_series, 'TEST', '{"tone":2,"harem":"mild","setting":["urban"],"pace":3}') returning id into v_taste;
    v_checks := v_checks || jsonb_build_object('h_valid_scores_allowed',
      (select plan_id = (v_p2 ->> 'id')::uuid from public.homer_taste_profiles where id = v_taste));
    v_err := null;
    begin update public.homer_taste_profiles set scores = scores || '{"humor":3}' where id = v_taste;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('h_unknown_scale_refused', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_taste_profiles set scores = scores || '{"tone":7}' where id = v_taste;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('h_out_of_range_refused', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_taste_profiles set scores = scores || '{"harem":"huge"}' where id = v_taste;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('h_bad_choice_refused', v_err is not distinct from '23514');
    v_err := null;
    begin update public.homer_taste_profiles set scores = scores || '{"setting":["urban","space"]}' where id = v_taste;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('h_bad_multi_refused', v_err is not distinct from '23514');
    -- v3 drops tone: other edits keep the stored scores; rewriting the scores with tone is refused.
    v_p3 := public.create_homer_plan('TEST v3', v_settings || jsonb_build_object('scales', (c_scales - 0) ||
              '[{"key":"pace","label":"Pace","kind":"range","min":1,"max":3}]'::jsonb), 'TEST drop tone');
    update public.homer_taste_profiles set description = 'TEST edited' where id = v_taste;
    v_checks := v_checks || jsonb_build_object('h_dropped_scale_kept_on_other_edit',
      (select scores ? 'tone' and description = 'TEST edited' from public.homer_taste_profiles where id = v_taste));
    v_err := null;
    begin update public.homer_taste_profiles set scores = scores || '{"pace":1}' where id = v_taste;
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('h_dropped_scale_refused_on_rewrite', v_err is not distinct from '23514');
    update public.homer_taste_profiles set scores = (scores - 'tone') || '{"pace":1}' where id = v_taste;
    v_checks := v_checks || jsonb_build_object('h_rescored_on_new_plan',
      (select plan_id = (v_p3 ->> 'id')::uuid from public.homer_taste_profiles where id = v_taste));

    -- i. Genres and queue: verified before written; KU needs a date; one live item per ASIN; drop then re-add.
    insert into public.homer_genres (name) values ('TEST Genre') returning id into v_genre;
    insert into public.homer_genre_series (genre_id, series_id, is_example) values (v_genre, v_series, true);
    v_err := null;
    begin insert into public.homer_genre_series (genre_id, series_id) values (v_genre, v_series);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('i_series_once_per_genre', v_err is not distinct from '23505');
    v_err := null;
    begin insert into public.homer_queue_items (genre_id, reader_id, title) values (v_genre, v_alex, 'TEST unverified');
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('i_unverified_refused', v_err is not distinct from '23502');
    v_err := null;
    begin insert into public.homer_queue_items (genre_id, reader_id, title, verified_on, on_kindle_unlimited)
      values (v_genre, v_alex, 'TEST', current_date, true);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('i_ku_without_date_refused', v_err is not distinct from '23514');
    insert into public.homer_queue_items (genre_id, reader_id, title, asin, verified_on, on_kindle_unlimited, ku_checked_on)
      values (v_genre, v_alex, 'TEST Q', 'BTESTQ0001', current_date, true, current_date);
    v_err := null;
    begin insert into public.homer_queue_items (genre_id, reader_id, title, asin, verified_on) values (v_genre, v_alex, 'TEST Q', 'BTESTQ0001', current_date);
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('i_one_live_per_asin', v_err is not distinct from '23505');
    update public.homer_queue_items set archived_at = now() where asin = 'BTESTQ0001';
    insert into public.homer_queue_items (genre_id, reader_id, title, asin, verified_on) values (v_genre, v_alex, 'TEST Q', 'BTESTQ0001', current_date);
    v_checks := v_checks || jsonb_build_object('i_readd_after_drop', true);
    v_err := null;
    begin update public.homer_queue_items set status = 'finished' where asin = 'BTESTQ0001';
    exception when others then v_err := sqlstate; end;
    v_checks := v_checks || jsonb_build_object('i_bad_status_refused', v_err is not distinct from '23514');

    -- j. Another user sees none of it and cannot score without a plan of their own.
    perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    select (select count(*) from public.homer_plans) + (select count(*) from public.homer_readers)
         + (select count(*) from public.homer_devices) + (select count(*) from public.homer_series)
         + (select count(*) from public.homer_books) + (select count(*) from public.homer_reads)
         + (select count(*) from public.homer_verdicts) + (select count(*) from public.homer_taste_profiles)
         + (select count(*) from public.homer_genres) + (select count(*) from public.homer_genre_series)
         + (select count(*) from public.homer_queue_items) into n;
    v_checks := v_checks || jsonb_build_object('j_hidden_from_other_user', n = 0);

    -- k. Grants on the RPC.
    v_checks := v_checks || jsonb_build_object(
      'k_anon_cannot_create_plan', not has_function_privilege('anon', 'public.create_homer_plan(text, jsonb, text, text)', 'execute'));

    v_result := jsonb_build_object(
      'all_passed', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'passed', (select count(*) from jsonb_each(v_checks) where value = 'true'::jsonb),
      'total', (select count(*) from jsonb_each(v_checks)),
      'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
      'checks', v_checks);
    raise exception 'homer_guards_undo';
  exception when others then
    if sqlerrm <> 'homer_guards_undo' then
      v_result := jsonb_build_object('all_passed', false, 'error', sqlerrm, 'sqlstate', sqlstate, 'checks', v_checks);
    end if;
  end;
  perform set_config('homer.guards_result', v_result::text, true);
end;
$$;

select current_setting('homer.guards_result')::jsonb as result;
