-- Analyzer port M3 — verify sam_song_scores. Run AFTER
-- supabase/migrations/026_sam_song_scores.sql, in the Supabase SQL editor.
--
-- Three independent parts. Run each one on its own (select it, then Run).
-- Nothing here leaves anything behind.


-- ============================================================================
-- 1. SHAPE — expect exactly the 16 columns below, the PK, the one FK, the
--    policy, and audit OFF in the registry.
-- ============================================================================
select column_name, data_type, is_nullable,
       col_description('public.sam_song_scores'::regclass, ordinal_position) is not null as has_comment
from information_schema.columns
where table_schema = 'public' and table_name = 'sam_song_scores'
order by ordinal_position;

select conname, contype, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.sam_song_scores'::regclass and contype in ('p', 'f')
order by contype;

select polname, polcmd, polroles::regrole[], pg_get_expr(polqual, polrelid) as using_expr
from pg_policy
where polrelid = 'public.sam_song_scores'::regclass;

select table_name, policy_mode, audited, exempt, notes
from platform.registry
where table_name = 'public.sam_song_scores';

select * from platform.conformance_failures;   -- expect: no rows


-- ============================================================================
-- 2. CASCADE + RLS — one block. It ALWAYS ends in an ERROR on purpose: the
--    error message IS the result, and raising it rolls back the throwaway song
--    and score row the block creates. Read the message; ignore the word ERROR.
--
--    Expected message:
--      M3 CHECKS (rolled back): owner sees 1 | other user sees 0 |
--      other user insert blocked | anon blocked | after song delete 0 rows
-- ============================================================================
do $$
declare
  v_owner       uuid;
  v_other       uuid := gen_random_uuid();   -- a user who owns nothing
  v_song        uuid;
  v_owner_sees  int;
  v_other_sees  int;
  v_other_write text;
  v_anon        text;
  v_after       int;
begin
  select user_id into v_owner from public.sam_songs limit 1;
  if v_owner is null then
    raise exception 'M3 CHECKS: no sam_songs row to borrow an owner from';
  end if;

  -- A throwaway song and one score row, written as the SQL editor's role
  -- (RLS does not apply to it).
  insert into public.sam_songs (user_id, title, measures)
  values (v_owner, 'M3 verify — throwaway', '[]'::jsonb)
  returning id into v_song;

  insert into public.sam_song_scores (
    song_id, measure_number, beats, rh_onsets, lh_onsets, rh_stack, lh_stack,
    rh_stretch, lh_stretch, rh_jump, lh_jump, rhythm_variety, accidentals,
    scores_version, computed_from_edited_at
  ) values (v_song, 1, 3.0, 6, 1, 1, 1, 0, 0, 5, 0, 1, 0, 1, null);

  -- RLS as the owner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_owner_sees from public.sam_song_scores where song_id = v_song;

  -- RLS as someone else: sees nothing, and cannot write to this song.
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into v_other_sees from public.sam_song_scores where song_id = v_song;
  begin
    insert into public.sam_song_scores (
      song_id, measure_number, beats, rh_onsets, lh_onsets, rh_stack, lh_stack,
      rh_stretch, lh_stretch, rh_jump, lh_jump, rhythm_variety, scores_version
    ) values (v_song, 2, 3.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
    v_other_write := 'other user insert ALLOWED (WRONG)';
  exception when insufficient_privilege then
    v_other_write := 'other user insert blocked';
  end;

  -- anon has no access at all.
  execute 'reset role';
  execute 'set local role anon';
  begin
    perform 1 from public.sam_song_scores limit 1;
    v_anon := 'anon can read (WRONG)';
  exception when insufficient_privilege then
    v_anon := 'anon blocked';
  end;

  -- Cascade: deleting the song removes its scores.
  execute 'reset role';
  delete from public.sam_songs where id = v_song;
  select count(*) into v_after from public.sam_song_scores where song_id = v_song;

  raise exception 'M3 CHECKS (rolled back): owner sees % | other user sees % | % | % | after song delete % rows',
    v_owner_sees, v_other_sees, v_other_write, v_anon, v_after;
end
$$;


-- ============================================================================
-- 3. NOTHING WAS LEFT BEHIND — expect 0 and 0.
-- ============================================================================
select
  (select count(*) from public.sam_song_scores) as score_rows,
  (select count(*) from public.sam_songs where title = 'M3 verify — throwaway') as throwaway_songs;
