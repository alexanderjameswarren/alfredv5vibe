-- sam_cleanup-m4t s8: test migration 216 (plan-wide item positions, a range planned twice, passes matched by
-- plan_item_id). Run with --test AFTER 216 is applied; before it, the create call is refused and ok is false.
-- It undoes itself: the inner block ends in its own error, the checks survive in a variable, and the result row
-- says { ok, failed, checks, counts }. A throwaway song and snippets are made inside the block. Creating the test
-- plan supersedes whichever plan is active for the length of the block only; the last checks confirm that plan is
-- still active and unchanged, and that plan 32 is as it was.

do $$
declare
  c_uid    constant uuid := '26f0707f-b586-4a3e-841c-8c313d6ab1e5';
  c_plan32 constant uuid := 'b6e8418a-c3fa-4263-91fd-421f4c0b0539';
  v_today  date := (now() at time zone 'America/Los_Angeles')::date;
  v_p32_before text;
  v_p32_after  text;
  v_p32_item   uuid;
  v_active     uuid;
  v_act_before text;
  v_act_after  text;
  v_song   uuid;
  v_snip   uuid;
  v_snip2  uuid;
  v_plan   uuid;
  v_warm   uuid;
  v_whole  uuid;
  v_climb  uuid;
  v_err    text;
  v_prog   jsonb;
  v_unpl   jsonb;
  c        jsonb := '{}';
  v_counts jsonb := '{}';
  v_result jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', c_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- Plan 32 as it stands: status plus every item, in a fingerprint.
  select p.status || ':' || coalesce(md5(string_agg(i.id::text || i.position || coalesce(i.snippet_id::text, '-'),
                                                     ',' order by i.position)), '')
    into v_p32_before
    from sam_practice_plans p left join sam_practice_plan_items i on i.plan_id = p.id
   where p.id = c_plan32 group by p.status;
  select id into v_p32_item from sam_practice_plan_items where plan_id = c_plan32 order by position limit 1;
  -- Whichever plan is active now (creating the test plan supersedes it inside the block).
  select id into v_active from sam_practice_plans where user_id = c_uid and status = 'active';
  select p.status || ':' || coalesce(md5(string_agg(i.id::text || i.position || coalesce(i.snippet_id::text, '-'),
                                                     ',' order by i.position)), '')
    into v_act_before
    from sam_practice_plans p left join sam_practice_plan_items i on i.plan_id = p.id
   where p.id = v_active group by p.status;
  c := c || jsonb_build_object('plan32_found', v_p32_before is not null and v_p32_item is not null);

  begin
    insert into sam_songs (title, measures, default_bpm, goal_bpm)
    values ('s8 test song', '[]'::jsonb, 60, 60) returning id into v_song;
    insert into sam_snippets (song_id, title, start_measure, end_measure)
    values (v_song, 's8 test bars 1-2', 1, 2) returning id into v_snip;
    insert into sam_snippets (song_id, title, start_measure, end_measure)
    values (v_song, 's8 test bars 3-4', 3, 4) returning id into v_snip2;

    -- Refusals: some items positioned and some not; two alike; not a whole number from 1.
    foreach v_err in array array['mixed', 'duplicate', 'zero'] loop
      begin
        perform sam_create_practice_plan(jsonb_build_object('review_instructions', 'test', 'songs', jsonb_build_array(
          jsonb_build_object('song_id', v_song, 'items', jsonb_build_array(
            jsonb_build_object('snippet_id', v_snip, 'target_bpm', 50, 'target_passes', 1, 'accuracy_target', 80,
                               'position', case v_err when 'zero' then 0 else 1 end),
            jsonb_build_object('target_bpm', 50, 'target_passes', 1, 'accuracy_target', 80)
              || case v_err when 'mixed' then '{}'::jsonb else jsonb_build_object('position', case v_err when 'duplicate' then 1 else 2 end) end)))));
        c := c || jsonb_build_object('refuses_' || v_err, false);
      exception when others then
        c := c || jsonb_build_object('refuses_' || v_err, sqlerrm like 'sam_create_practice_plan:%position%');
      end;
    end loop;

    -- Old callers: no positions, the same range twice, positions run in the order given.
    begin
      v_plan := sam_create_practice_plan(jsonb_build_object('review_instructions', 'test', 'songs', jsonb_build_array(
        jsonb_build_object('song_id', v_song, 'items', jsonb_build_array(
          jsonb_build_object('snippet_id', v_snip, 'target_bpm', 50, 'target_passes', 1, 'accuracy_target', 80),
          jsonb_build_object('snippet_id', v_snip, 'target_bpm', 70, 'target_passes', 1, 'accuracy_target', 80))))));
      c := c || jsonb_build_object('no_positions_keeps_order',
        (select array_agg(target_bpm::int order by position) = array[50, 70] and array_agg(position::int order by position) = array[1, 2]
           from sam_practice_plan_items where plan_id = v_plan));
      raise exception 'S8_UNDO_INNER';
    exception when others then
      if sqlerrm <> 'S8_UNDO_INNER' then c := c || jsonb_build_object('no_positions_error', sqlerrm); end if;
    end;

    -- The plan under test: a warm-up at 1, the whole song at 2, the climb on the warm-up's bars at 3.
    -- Listed out of order on purpose, so position, not song order, decides.
    v_plan := sam_create_practice_plan(jsonb_build_object('review_instructions', 'test', 'songs', jsonb_build_array(
      jsonb_build_object('song_id', v_song, 'items', jsonb_build_array(
        jsonb_build_object('snippet_id', v_snip, 'position', 3, 'target_bpm', 70, 'target_passes', 2, 'accuracy_target', 80),
        jsonb_build_object('position', 2, 'target_bpm', 60, 'target_passes', 1, 'accuracy_target', 80),
        jsonb_build_object('snippet_id', v_snip, 'position', 1, 'target_bpm', 50, 'target_passes', 2, 'accuracy_target', 80))))));
    select id into v_warm  from sam_practice_plan_items where plan_id = v_plan and position = 1;
    select id into v_whole from sam_practice_plan_items where plan_id = v_plan and position = 2;
    select id into v_climb from sam_practice_plan_items where plan_id = v_plan and position = 3;
    c := c || jsonb_build_object(
      'positions_plan_wide', (select array_agg(target_bpm::int order by position) = array[50, 60, 70]
                                from sam_practice_plan_items where plan_id = v_plan),
      'same_range_twice', (select count(*) = 2 from sam_practice_plan_items where plan_id = v_plan and snippet_id = v_snip),
      'song_listed_once', (select count(*) = 1 from sam_practice_plan_songs where plan_id = v_plan));

    -- Passes, all at 70 BPM and 100%: linked to the warm-up; linked to the climb; on the bars with no link; on the
    -- bars linked to a plan 32 item (another plan, so by range); the whole song with no link; bars 3-4, unplanned.
    insert into sam_passes (song_id, snippet_id, plan_item_id, bpm, playback_speed, hits, misses, notes_played)
    values (v_song, v_snip,  v_warm,     70, 100, 10, 0, 10),
           (v_song, v_snip,  v_climb,    70, 100, 10, 0, 10),
           (v_song, v_snip,  null,       70, 100, 10, 0, 10),
           (v_song, v_snip,  v_p32_item, 70, 100, 10, 0, 10),
           (v_song, null,    null,       70, 100, 10, 0, 10),
           (v_song, v_snip2, null,       70, 100, 10, 0, 10);

    select coalesce(jsonb_object_agg(p.plan_item_id::text, jsonb_build_object('attempts', p.attempts, 'qualifying', p.qualifying)), '{}')
      into v_prog from sam_plan_item_progress(v_plan, v_today, v_today) p;
    -- Only the test song: the function also returns Alex's real practice today on other songs.
    select coalesce(jsonb_agg(jsonb_build_object('snippet_id', u.snippet_id, 'attempts', u.attempts)), '[]')
      into v_unpl from sam_plan_unplanned_practice(v_plan, v_today, v_today) u where u.song_id = v_song;
    v_counts := jsonb_build_object(
      'warm', v_prog -> v_warm::text, 'whole', v_prog -> v_whole::text, 'climb', v_prog -> v_climb::text,
      'unplanned', v_unpl);
    c := c || jsonb_build_object(
      -- Own link + unlinked + plan-32-linked: 3 each. Neither counts the other's linked pass.
      'warm_counts_own_and_fallback', (v_prog -> v_warm::text ->> 'attempts')::int = 3,
      'climb_counts_own_and_fallback', (v_prog -> v_climb::text ->> 'attempts')::int = 3,
      'qualifying_per_item', (v_prog -> v_warm::text ->> 'qualifying')::int = 3
                             and (v_prog -> v_climb::text ->> 'qualifying')::int = 3,
      'whole_song_by_range', (v_prog -> v_whole::text ->> 'attempts')::int = 1,
      'unplanned_only_bars_3_4', jsonb_array_length(v_unpl) = 1
                                 and (v_unpl -> 0 ->> 'snippet_id')::uuid = v_snip2
                                 and (v_unpl -> 0 ->> 'attempts')::int = 1);

    raise exception 'S8_UNDO';
  exception when others then
    if sqlerrm <> 'S8_UNDO' then
      c := c || jsonb_build_object('error', sqlerrm);
    end if;
  end;

  -- After the undo: plan 32 exactly as before, and still the active plan; nothing of the test left.
  select p.status || ':' || coalesce(md5(string_agg(i.id::text || i.position || coalesce(i.snippet_id::text, '-'),
                                                     ',' order by i.position)), '')
    into v_p32_after
    from sam_practice_plans p left join sam_practice_plan_items i on i.plan_id = p.id
   where p.id = c_plan32 group by p.status;
  select p.status || ':' || coalesce(md5(string_agg(i.id::text || i.position || coalesce(i.snippet_id::text, '-'),
                                                     ',' order by i.position)), '')
    into v_act_after
    from sam_practice_plans p left join sam_practice_plan_items i on i.plan_id = p.id
   where p.id = v_active group by p.status;
  c := c || jsonb_build_object(
    'plan32_untouched', v_p32_after is not distinct from v_p32_before,
    'active_plan_still_active', v_active is not null
                                and (select status = 'active' from sam_practice_plans where id = v_active),
    'active_plan_untouched', v_act_after is not distinct from v_act_before,
    'test_rows_gone', not exists (select 1 from sam_songs where title = 's8 test song'));

  v_result := jsonb_build_object(
    'ok', not (c ? 'error') and not (c ? 'no_positions_error') and not exists (select 1 from jsonb_each(c) where jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb),
    'failed', (select coalesce(jsonb_agg(key), '[]'::jsonb) from jsonb_each(c)
                where (jsonb_typeof(value) = 'boolean' and value <> 'true'::jsonb) or key = 'error' or key = 'no_positions_error'),
    'checks', c,
    'counts', v_counts);
  perform set_config('s8.result', v_result::text, false);
end $$;

select current_setting('s8.result')::jsonb as result;
