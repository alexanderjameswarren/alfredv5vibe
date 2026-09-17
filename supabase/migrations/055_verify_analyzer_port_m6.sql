-- MOVED 2026-09-18 from docs/sql/verify-analyzer-port-m6.sql
-- Originally written 2026-09-16. Content unchanged below this header.
-- Purpose: Analyzer port M6 verification: the statement-level stamping triggers, including a cascade delete, all undone on completion.
-- Kind: verification (writes inside a subtransaction that is rolled back)
-- Applied: n/a — run by Alex after migration 028
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- Analyzer port M6 — verification of migration 028. Supabase SQL editor.
--
-- Paste the whole file and Run once. It returns ONE JSON cell (`result`).
--
-- It writes, then UNDOES everything it wrote. The test runs inside a
-- subtransaction that ends by raising a private exception, which rolls it
-- back; the handler returns the collected results. The scratch songs, their
-- measure rows, the stamps and the audit rows they generate are all gone
-- afterwards. The Scientist is read as a template only and never modified.
--
-- How "stamps once per statement" is measured: pg_stat_xact_user_tables
-- counts UPDATEs of sam_songs made in this transaction. The count is read
-- just before and just after one statement on sam_song_measures, and the
-- difference is the number of stamps that statement caused. Nothing else
-- updates sam_songs on a measure INSERT or DELETE.
--
-- Expect: all_pass = true, and conformance = CONFORMANT.

create or replace function pg_temp.verify_analyzer_port_m6()
returns json
language plpgsql
as $$
declare
  v_src      constant uuid := 'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096';  -- The Scientist (template)
  v_sentinel constant timestamptz := '2000-01-01 00:00:00+00';
  v_a uuid;
  v_b uuid;
  v_before bigint;
  v_result json;
  v_detail text;
  s1 jsonb; s2 jsonb; s3 jsonb; s4 jsonb; s5 jsonb; s6 jsonb;
begin
  begin
    -- Two archived scratch songs, copied from the template's metadata.
    insert into public.sam_songs (user_id, title, artist, key_signature, time_signature,
                                  default_bpm, measures, measures_edited_at, measures_compiled_at, archived)
    select user_id, 'M6 verify A — rolled back', artist, key_signature, time_signature,
           default_bpm, measures, v_sentinel, v_sentinel, true
    from public.sam_songs where id = v_src
    returning id into v_a;
    insert into public.sam_songs (user_id, title, artist, key_signature, time_signature,
                                  default_bpm, measures, measures_edited_at, measures_compiled_at, archived)
    select user_id, 'M6 verify B — rolled back', artist, key_signature, time_signature,
           default_bpm, measures, v_sentinel, v_sentinel, true
    from public.sam_songs where id = v_src
    returning id into v_b;

    -- 1. One INSERT statement, 3 rows, one song -> stamped, exactly once.
    update public.sam_songs set measures_edited_at = v_sentinel where id in (v_a, v_b);
    select n_tup_upd into v_before from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;
    insert into public.sam_song_measures (song_id, number, rh, lh, time_signature)
    select v_a, m.number, m.rh, m.lh, m.time_signature
    from public.sam_song_measures m where m.song_id = v_src and m.number between 1 and 3;
    select jsonb_build_object(
      'rows_inserted', (select count(*) from public.sam_song_measures where song_id = v_a),
      'song_updates',  n_tup_upd - v_before,
      'stamp_moved',   (select measures_edited_at <> v_sentinel from public.sam_songs where id = v_a),
      'stamp_is_now',  (select measures_edited_at = now() from public.sam_songs where id = v_a),
      'other_song_untouched', (select measures_edited_at = v_sentinel from public.sam_songs where id = v_b)
    ) into s1
    from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;

    -- 2. One INSERT statement, 4 rows across two songs -> each stamped once (2).
    update public.sam_songs set measures_edited_at = v_sentinel where id in (v_a, v_b);
    select n_tup_upd into v_before from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;
    insert into public.sam_song_measures (song_id, number, rh, lh, time_signature)
    select t.song_id, m.number, m.rh, m.lh, m.time_signature
    from public.sam_song_measures m
    join (values (v_a, 4), (v_a, 5), (v_b, 1), (v_b, 2)) as t(song_id, number) on t.number = m.number
    where m.song_id = v_src;
    select jsonb_build_object(
      'song_updates', n_tup_upd - v_before,
      'both_stamped', (select bool_and(measures_edited_at <> v_sentinel) from public.sam_songs where id in (v_a, v_b))
    ) into s2
    from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;

    -- 3. One DELETE statement, 1 row -> stamped once.
    update public.sam_songs set measures_edited_at = v_sentinel where id in (v_a, v_b);
    select n_tup_upd into v_before from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;
    delete from public.sam_song_measures where song_id = v_a and number = 1;
    select jsonb_build_object(
      'song_updates', n_tup_upd - v_before,
      'stamp_moved',  (select measures_edited_at <> v_sentinel from public.sam_songs where id = v_a),
      'other_song_untouched', (select measures_edited_at = v_sentinel from public.sam_songs where id = v_b)
    ) into s3
    from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;

    -- 4. One DELETE statement, 3 rows across two songs -> each stamped once (2).
    update public.sam_songs set measures_edited_at = v_sentinel where id in (v_a, v_b);
    select n_tup_upd into v_before from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;
    delete from public.sam_song_measures
    where (song_id = v_a and number in (2, 3)) or (song_id = v_b and number = 1);
    select jsonb_build_object(
      'song_updates', n_tup_upd - v_before,
      'both_stamped', (select bool_and(measures_edited_at <> v_sentinel) from public.sam_songs where id in (v_a, v_b))
    ) into s4
    from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;

    -- 5. A DELETE matching no rows -> no stamp.
    select n_tup_upd into v_before from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;
    delete from public.sam_song_measures where song_id = v_a and number = 9999;
    select jsonb_build_object('song_updates', n_tup_upd - v_before) into s5
    from pg_stat_xact_user_tables where relid = 'public.sam_songs'::regclass;

    -- 6. Delete a SONG that still has measures (A has 4 and 5). The cascade
    --    fires the DELETE trigger against a song that is being deleted.
    s6 := jsonb_build_object('measures_before', (select count(*) from public.sam_song_measures where song_id = v_a));
    begin
      delete from public.sam_songs where id = v_a;
      s6 := s6 || jsonb_build_object(
        'error', null,
        'song_gone', not exists (select 1 from public.sam_songs where id = v_a),
        'measures_after', (select count(*) from public.sam_song_measures where song_id = v_a));
    exception when others then
      s6 := s6 || jsonb_build_object('error', sqlerrm);
    end;

    v_result := json_build_object(
      'all_pass',
        (s1->>'rows_inserted')::int = 3 and (s1->>'song_updates')::int = 1
        and (s1->>'stamp_moved')::bool and (s1->>'stamp_is_now')::bool and (s1->>'other_song_untouched')::bool
        and (s2->>'song_updates')::int = 2 and (s2->>'both_stamped')::bool
        and (s3->>'song_updates')::int = 1 and (s3->>'stamp_moved')::bool and (s3->>'other_song_untouched')::bool
        and (s4->>'song_updates')::int = 2 and (s4->>'both_stamped')::bool
        and (s5->>'song_updates')::int = 0
        and (s6->>'measures_before')::int = 2 and s6->>'error' is null
        and (s6->>'song_gone')::bool and (s6->>'measures_after')::int = 0,
      '1_insert_3_rows_one_song__expect_1_update_stamp_moved', s1,
      '2_insert_4_rows_two_songs__expect_2_updates',            s2,
      '3_delete_1_row__expect_1_update_stamp_moved',            s3,
      '4_delete_3_rows_two_songs__expect_2_updates',            s4,
      '5_delete_no_rows__expect_0_updates',                     s5,
      '6_delete_song_with_measures__expect_no_error',           s6
    );
    raise exception 'm6-verify-rollback' using detail = v_result::text;
  exception when others then
    if sqlerrm <> 'm6-verify-rollback' then
      raise;
    end if;
    get stacked diagnostics v_detail = pg_exception_detail;
  end;

  -- Everything above is rolled back. What remains is read-only.
  return json_build_object(
    'checks', v_detail::json,
    'triggers_on_sam_song_measures', (
      select json_agg(json_build_object(
               'trigger', trigger_name, 'event', event_manipulation,
               'timing', action_timing, 'level', action_orientation)
             order by trigger_name, event_manipulation)
      from information_schema.triggers
      where event_object_schema = 'public' and event_object_table = 'sam_song_measures'),
    'scratch_songs_left', (select count(*) from public.sam_songs where title like 'M6 verify % — rolled back'),
    'conformance', (select json_agg(c) from platform.check_conformance() c)
  );
end;
$$;

select pg_temp.verify_analyzer_port_m6() as result;

-- Expect:
--   checks.all_pass                  true
--   triggers_on_sam_song_measures    stamp_song_on_measures_insert  INSERT AFTER STATEMENT
--                                    stamp_song_on_measures_delete  DELETE AFTER STATEMENT
--                                    bump_parent_edited_at          UPDATE AFTER ROW   (unchanged)
--                                    plus any audit trigger already there
--   scratch_songs_left               0
--   conformance                      CONFORMANT
-- If all_pass is false, the numbered sections say which check failed.
