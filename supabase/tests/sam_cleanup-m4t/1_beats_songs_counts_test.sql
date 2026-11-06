-- sam_cleanup-m4t s4b: before deleting the 8 archived "Someone Like You" copies that still store beats[] measures.
-- Run with --test. It undoes itself: the inner block ends in its own error, the results survive in a variable, and the
-- result row says { ok, failed, checks, counts, deleted }. "counts" gives the --expect numbers for the delete;
-- "deleted" is the same delete rehearsed here (events, sessions, songs) and then undone.

do $$
declare
  c_ids constant uuid[] := array[
    '6d2b5206-8f04-4ec4-abf4-8122383b927a', '179dd081-1575-42c2-89a9-7b05d927aa93',
    '10856805-6e74-412e-9398-ac6a2f471156', 'ee14dee1-c783-4277-ab9b-e19ff5e5fdf9',
    '1a39dad3-30a8-4da7-bcc7-5446614cb7ea', '032f4a21-2a5e-496b-ae1d-6c128c88ce79',
    '311de635-9df6-4bde-af39-c07290b031fa', 'e6013004-9d75-458f-9d27-3b42776538d6']::uuid[];
  v_counts  jsonb;
  v_checks  jsonb := '{}';
  v_deleted jsonb := '{}';
  v_n       int;
  v_result  jsonb;
begin
  select jsonb_build_object(
    'songs',          (select count(*) from public.sam_songs where id = any(c_ids)),
    'sessions',       (select count(*) from public.sam_sessions where song_id = any(c_ids)),
    'session_events', (select count(*) from public.sam_session_events e
                        where e.song_id = any(c_ids)
                           or e.session_id in (select id from public.sam_sessions where song_id = any(c_ids))),
    'passes',         (select count(*) from public.sam_passes p
                        where p.song_id = any(c_ids)
                           or p.session_id in (select id from public.sam_sessions where song_id = any(c_ids))),
    'snippets',       (select count(*) from public.sam_snippets where song_id = any(c_ids)),
    'measures',       (select count(*) from public.sam_song_measures where song_id = any(c_ids)),
    'scores',         (select count(*) from public.sam_song_scores where song_id = any(c_ids)),
    'lyrics',         (select count(*) from public.sam_song_lyrics where song_id = any(c_ids)),
    'fingerings',     (select count(*) from public.sam_song_fingerings where song_id = any(c_ids)),
    'plan_songs',     (select count(*) from public.sam_practice_plan_songs where song_id = any(c_ids)),
    'goals',          (select count(*) from public.sam_goals where song_id = any(c_ids)),
    'children_outside', (select count(*) from public.sam_songs
                          where parent_song_id = any(c_ids) and not (id = any(c_ids)))
  ) into v_counts;

  v_checks := jsonb_build_object(
    'all_8_found', (v_counts ->> 'songs')::int = 8,
    'all_archived_someone_like_you', (select count(*) = 8 from public.sam_songs
                                       where id = any(c_ids) and archived and title = 'Someone Like You'),
    'every_measure_is_beats', (select bool_and(m ? 'beats' and jsonb_typeof(m -> 'beats') = 'array'
                                                and not (m ? 'rh') and not (m ? 'lh'))
                                 from public.sam_songs s, jsonb_array_elements(s.measures) m
                                where s.id = any(c_ids)),
    'in_no_live_plan', (select count(*) = 0 from public.sam_practice_plan_songs ps
                          join public.sam_practice_plans pl on pl.id = ps.plan_id
                         where ps.song_id = any(c_ids) and pl.status <> 'superseded'),
    'no_goal', (v_counts ->> 'goals')::int = 0,
    'no_child_outside_the_8', (v_counts ->> 'children_outside')::int = 0
  );

  begin
    delete from public.sam_session_events e
     where e.song_id = any(c_ids)
        or e.session_id in (select id from public.sam_sessions where song_id = any(c_ids));
    get diagnostics v_n = row_count;
    v_deleted := v_deleted || jsonb_build_object('session_events', v_n);
    delete from public.sam_sessions where song_id = any(c_ids);
    get diagnostics v_n = row_count;
    v_deleted := v_deleted || jsonb_build_object('sessions', v_n);
    delete from public.sam_songs where id = any(c_ids) and archived and title = 'Someone Like You';
    get diagnostics v_n = row_count;
    v_deleted := v_deleted || jsonb_build_object('songs', v_n,
      'songs_left', (select count(*) from public.sam_songs where id = any(c_ids)));
    raise exception 'S4B_UNDO';
  exception when others then
    if sqlerrm <> 'S4B_UNDO' then
      v_deleted := v_deleted || jsonb_build_object('error', sqlerrm);
    end if;
  end;

  v_result := jsonb_build_object(
    'ok', not exists (select 1 from jsonb_each(v_checks) where value <> 'true'::jsonb) and not (v_deleted ? 'error'),
    'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(v_checks) where value <> 'true'::jsonb),
    'checks', v_checks,
    'counts', v_counts,
    'deleted', v_deleted);
  perform set_config('s4b.result', v_result::text, false);
end $$;

select current_setting('s4b.result')::jsonb as result;
