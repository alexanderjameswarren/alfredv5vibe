-- 073 - READ-ONLY DIAGNOSTIC. Nothing here changes data.
--
-- 🛑 SUPERSEDED BY 074 AS THE INPUT TO THE BACKFILL. Run 2026-09-25: 94 rows,
-- 0 merges, 88 album-written, 6 not. ⚠️ ITS PROPOSED KEYS WERE WRONG. The SQL
-- approximation below cannot see COMMA_ARTIST_NAMES, which lives in TypeScript,
-- so it proposed "Earth, Wind & Fire" -> `earth` and "Tyler, The Creator" ->
-- `tyler`. Both names were already in that list. THE COUNTS ARE STILL SOUND as
-- sizing; the KEYS were never usable. 074 dumps candidates on a purely
-- structural test and lets the deployed functions decide. Kept because the
-- mistake is the argument for 074's shape.
--
-- MOVED HEADER: verification query. Not a schema change, not a backfill, never
-- "applied". Run it, paste the single result cell back, and it is done.
--
-- PURPOSE. Size the match_key backfill described in
-- docs/plan-dj-album-match-key-backfill.md BEFORE anything is written. Every
-- number the plan leaves blank is answered here.
--
-- THE DEFECT. record_dj_album used to pass the whole joined byline as ONE
-- artist, so "Clifford Brown, Max Roach" became the primary and the row was
-- keyed 'clifford brown max roach|jordu'. The poll keys the same recording
-- 'clifford brown|jordu'. Two rows for one recording, never grouped.
--
-- ⚠️ `sql_primary` BELOW IS AN APPROXIMATION OF normalisePart() AND THAT IS
-- DELIBERATE. The real rule strips qualifier groups and dashed qualifiers,
-- which SQL should not try to reproduce - a second implementation of the
-- normaliser is exactly the drift 14.6 is about. This approximation handles
-- the parts that matter for an ARTIST (& -> and, apostrophes closed up,
-- everything else to single spaces, lowercased). Treat the counts as
-- "candidates to be confirmed by the real function", not as the final list.
-- The backfill itself must compute keys in TypeScript, never in this SQL.

with norm as (
  select
    id, video_id, title, artist, match_key, canonical_track_id, created_at,
    split_part(match_key, '|', 1) as stored_primary,
    btrim(regexp_replace(
      regexp_replace(
        replace(replace(lower(btrim(split_part(artist, ',', 1))), '&', ' and '), '''', ''),
        '[^a-z0-9]+', ' ', 'g'),
      '\s+', ' ', 'g')) as sql_primary,
    btrim(regexp_replace(
      regexp_replace(
        replace(replace(lower(btrim(artist)), '&', ' and '), '''', ''),
        '[^a-z0-9]+', ' ', 'g'),
      '\s+', ' ', 'g')) as sql_whole
  from public.dj_tracks
  where artist is not null and artist like '%,%' and match_key is not null
),
affected as (
  -- The signature of the defect: the stored primary is the WHOLE byline
  -- normalised, not the first name.
  select * from norm where stored_primary = sql_whole and sql_whole <> sql_primary
)
select json_build_object(
  'affected_count', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) as rows_to_rekey,
           count(distinct match_key) as distinct_old_keys,
           min(created_at) as earliest,
           max(created_at) as latest
    from affected
  ) t),
  'affected_rows', (select coalesce(json_agg(t), '[]'::json) from (
    select video_id, title, artist, match_key as old_key,
           sql_primary || '|' || split_part(match_key, '|', 2) as proposed_new_key,
           canonical_track_id is null as is_group_leader, created_at
    from affected order by artist, title limit 200
  ) t),
  -- WOULD IT MERGE INTO AN EXISTING GROUP? This is the whole risk. A row whose
  -- proposed key already exists joins that group; one whose key is new simply
  -- moves. Both are fine, but they need different canonical rebuilds.
  'would_merge_into_existing_group', (select coalesce(json_agg(t), '[]'::json) from (
    select a.video_id, a.artist, a.match_key as old_key,
           a.sql_primary || '|' || split_part(a.match_key, '|', 2) as new_key,
           count(o.id) as existing_rows_already_on_new_key
    from affected a
    join public.dj_tracks o
      on o.match_key = a.sql_primary || '|' || split_part(a.match_key, '|', 2)
     and o.id <> a.id
    group by 1,2,3,4 order by 5 desc
  ) t),
  -- Rows that DEPEND on the affected tracks. None of these store match_key
  -- (they hold track_id), so the backfill does not rewrite them - but a
  -- regrouping changes what a familiarity read returns for them, and that is
  -- the user-visible effect.
  'dependents', (select coalesce(json_agg(t), '[]'::json) from (
    select
      (select count(*) from public.dj_plays p where p.track_id in (select id from affected)) as plays,
      (select count(*) from public.dj_playlist_tracks pt where pt.track_id in (select id from affected)) as playlist_rows,
      -- ⚠️ dj_album_tracks HAS NO track_id. It carries `video_id` and joins to
      -- dj_tracks through that (023). A first draft of this query assumed a
      -- track_id and failed on it.
      (select count(*) from public.dj_album_tracks at
        where at.video_id in (select video_id from affected)) as album_rows,
      (select count(*) from public.dj_tracks t2 where t2.canonical_track_id in (select id from affected)) as rows_pointing_at_an_affected_leader
  ) t),
  -- dj_artist_tags joins on the ARTIST STRING, not on match_key, so it is
  -- untouched by a re-key. Counted anyway so "untouched" is a measurement.
  'artist_tag_rows_for_affected_bylines', (select coalesce(json_agg(t), '[]'::json) from (
    select count(*) as n from public.dj_artist_tags
    where artist in (select distinct artist from affected)
  ) t),
  -- ⚠️ THE STRUCTURAL CHECK ON THE HEURISTIC ABOVE, AND THE MORE TRUSTWORTHY
  -- NUMBER OF THE TWO. `affected` infers the defect from the SHAPE of the
  -- stored key; this asks the direct question instead - was this row written by
  -- the album path at all? dj_album_tracks.video_id is that record.
  --
  -- HOW TO READ IT. `affected_and_album_written` is the confident population.
  -- `affected_not_album_written` is rows the heuristic caught that no album
  -- wrote: either another writer has the same defect, or the SQL normalisation
  -- approximation is over-matching - EITHER WAY, do not re-key them until we
  -- know which. `album_written_not_affected` is the reassuring direction: album
  -- rows already keyed correctly, which is what a single-artist album looks like.
  'album_written_cross_check', (select coalesce(json_agg(t), '[]'::json) from (
    select
      (select count(*) from affected a
        where exists (select 1 from public.dj_album_tracks at where at.video_id = a.video_id))
        as affected_and_album_written,
      (select count(*) from affected a
        where not exists (select 1 from public.dj_album_tracks at where at.video_id = a.video_id))
        as affected_not_album_written,
      (select count(*) from public.dj_tracks t2
        where t2.artist like '%,%' and t2.match_key is not null
          and exists (select 1 from public.dj_album_tracks at where at.video_id = t2.video_id)
          and t2.id not in (select id from affected))
        as album_written_not_affected
  ) t)
) as result;
