-- Analyzer port M4 — verification queries. Supabase SQL editor.
--
-- Each numbered query is ONE statement returning ONE JSON cell (`result`).
-- Select it, Run, copy the cell. Where a step says "save as", paste the cell
-- into that file under tools/sam-tools/ and run the compare command shown.
--
-- Scores version 1 is hard-coded below; it must equal SCORES_VERSION in
-- supabase/functions/_shared/samScores.ts.


-- ============================================================================
-- 1. COVERAGE — after `await samScores.backfill()`.
--    Expect: with_measures = with_measures_and_fresh_scores
--            = row_count_matches_measures, and problems = [].
-- ============================================================================
with songs as (
  select s.title,
         (select count(*) from public.sam_song_measures m where m.song_id = s.id)::int as measures,
         f.fresh,
         f.stored_rows
  from public.sam_songs s
  cross join lateral public.sam_song_scores_freshness(s.id, 1) f
  where not s.archived
)
select json_build_object(
  'non_archived_songs',             count(*),
  'with_measures',                  count(*) filter (where measures > 0),
  'with_measures_and_fresh_scores', count(*) filter (where measures > 0 and fresh),
  'row_count_matches_measures',     count(*) filter (where measures > 0 and stored_rows = measures),
  'without_measures',               coalesce(json_agg(title order by title) filter (where measures = 0), '[]'::json),
  'problems', coalesce(
    json_agg(json_build_object('title', title, 'measures', measures,
                               'stored_rows', stored_rows, 'fresh', fresh) order by title)
      filter (where measures > 0 and (not fresh or stored_rows <> measures)),
    '[]'::json)
) as result
from songs;


-- ============================================================================
-- 2. THE FOUR REFERENCE SONGS — dump their stored rows.
--    Save as tools/sam-tools/scores-reference.json, export the same four songs
--    from the app (Export button) into tools/sam-tools/, then:
--      node bin/compare-scores.js cli scores-reference.json \
--        "<Someone Like You export>.json" "<Say It Ain't So export>.json" \
--        "<The Entertainer export>.json" "<The Scientist export>.json"
--    Expect four MATCH lines, 0 mismatches each.
--    Export AFTER the backfill, so the files and the rows describe the same
--    measures.
-- ============================================================================
select json_object_agg(s.title, json_build_object(
  'song_id', s.id,
  'measures_edited_at', s.measures_edited_at,
  'rows', (select json_agg(sc order by sc.measure_number)
           from public.sam_song_scores sc where sc.song_id = s.id)
)) as result
from public.sam_songs s
where s.id in (
  '030333d9-1b9f-4f74-80fb-7fbed587fda6',  -- Someone Like You
  '7a8d3645-c9b9-4518-a28a-5f9800bd02fa',  -- Say It Ain't So
  '8d83a19e-b0e0-4168-aa68-cad7c3fcecde',  -- The Entertainer.
  'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'   -- The Scientist - Coldplay
);


-- ============================================================================
-- 3. NO-OP — recomputing an unchanged song writes nothing.
--    a. Run query 3 (below) and save as tools/sam-tools/noop-before.json.
--    b. Console: await samScores.twice("030333d9-1b9f-4f74-80fb-7fbed587fda6")
--       Expect: 2nd call fresh, measures_read 0, rows_written 0 (and, since
--       the backfill already ran, the 1st call should be fresh too).
--    c. Run query 3 again, save as noop-after.json, then:
--         node bin/compare-scores.js diff noop-before.json noop-after.json --all-columns
--       Expect: "82 measures — 0 changed, 82 identical (all columns compared)"
--       — computed_at included, so not a single row was rewritten.
-- ============================================================================
select json_object_agg(s.title, json_build_object(
  'song_id', s.id,
  'measures_edited_at', s.measures_edited_at,
  'rows', (select json_agg(sc order by sc.measure_number)
           from public.sam_song_scores sc where sc.song_id = s.id)
)) as result
from public.sam_songs s
where s.id = '030333d9-1b9f-4f74-80fb-7fbed587fda6';


-- ============================================================================
-- 4. MUTATION TEST — edit one measure of a throwaway copy, recompute, and
--    confirm only that measure's scores changed. The copy is archived so it
--    never shows in the library, and 4e deletes it.
-- ============================================================================

-- 4a. Copy The Scientist (73 measures) into an archived throwaway song.
--     Note copy_id from the result.
with src as (
  select * from public.sam_songs where id = 'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096'
),
new_song as (
  insert into public.sam_songs (
    user_id, title, artist, key_signature, time_signature, default_bpm,
    measures, measures_edited_at, measures_compiled_at, archived
  )
  select user_id, 'M4 mutation copy — delete me', artist, key_signature, time_signature,
         default_bpm, measures, now(), now(), true
  from src
  returning id
),
copied as (
  insert into public.sam_song_measures (
    song_id, number, rh, lh, time_signature, audio_offset_ms, chord, section, source_measure
  )
  select (select id from new_song), m.number, m.rh, m.lh, m.time_signature,
         m.audio_offset_ms, m.chord, m.section, m.source_measure
  from public.sam_song_measures m
  where m.song_id = (select id from src)
  returning 1
)
select json_build_object(
  'copy_id', (select id from new_song),
  'measures_copied', (select count(*) from copied)
) as result;
-- Console: await samScores.compute("<copy_id>")   → status "computed", 73 rows
-- Then run 4c and save as mutation-before.json.

-- 4b. Edit measure 10 only: add a C8 to its first right-hand event. The
--     bump_parent_edited_at trigger stamps the song. Run AFTER saving
--     mutation-before.json.
update public.sam_song_measures m
set rh = jsonb_set(
  m.rh, '{0,notes}',
  coalesce(m.rh -> 0 -> 'notes', '[]'::jsonb) || '[{"midi": 108, "name": "C8"}]'::jsonb
)
from public.sam_songs s
where s.id = m.song_id
  and s.title = 'M4 mutation copy — delete me'
  and m.number = 10
returning json_build_object('measure', m.number, 'rh0_notes_now', m.rh -> 0 -> 'notes') as result;
-- Console: await samScores.compute("<copy_id>")   → status "computed"
-- Then run 4c again, save as mutation-after.json, and:
--   node bin/compare-scores.js diff mutation-before.json mutation-after.json
-- Expect: "73 measures — 1 changed, 72 identical", the one being m10, and a
-- different measures_edited_at before → after.

-- 4c. Dump the copy's stored rows.
select json_object_agg(s.title, json_build_object(
  'song_id', s.id,
  'measures_edited_at', s.measures_edited_at,
  'rows', (select json_agg(sc order by sc.measure_number)
           from public.sam_song_scores sc where sc.song_id = s.id)
)) as result
from public.sam_songs s
where s.title = 'M4 mutation copy — delete me';

-- 4d. (optional) The edit really changed the notes, and only in measure 10:
--     compare the copy's measures with the original's.
select json_build_object(
  'measures_differing_from_original', coalesce(json_agg(c.number order by c.number), '[]'::json)
) as result
from public.sam_song_measures c
join public.sam_songs cs on cs.id = c.song_id and cs.title = 'M4 mutation copy — delete me'
join public.sam_song_measures o
  on o.song_id = 'f3bb321f-aa95-4c73-bfdc-bdf3d36f8096' and o.number = c.number
where c.rh is distinct from o.rh or c.lh is distinct from o.lh;
-- Expect: [10]

-- 4e. CLEANUP — delete the copy. Its measures and scores cascade away.
with gone as (
  delete from public.sam_songs
  where title = 'M4 mutation copy — delete me'
  returning id
)
select json_build_object('deleted_songs', (select count(*) from gone)) as result;
-- Expect: deleted_songs 1. Then confirm nothing is left:
select json_build_object(
  'copies_left', (select count(*) from public.sam_songs where title = 'M4 mutation copy — delete me'),
  'score_rows_without_a_song', (select count(*) from public.sam_song_scores sc
                                where not exists (select 1 from public.sam_songs s where s.id = sc.song_id))
) as result;
-- Expect: 0 and 0.
