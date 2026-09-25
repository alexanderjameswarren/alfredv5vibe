-- 074 - READ-ONLY DUMP. Nothing here changes data.
--
-- MOVED HEADER: verification/extraction query. Never "applied".
--
-- 🛑 THIS REPLACES 073 AS THE INPUT TO THE BACKFILL. 073's SQL approximation of
-- normalisePart DECIDED which rows were affected, and it decided wrong: it
-- proposed "Earth, Wind & Fire" -> `earth` and "Tyler, The Creator" -> `tyler`,
-- because COMMA_ARTIST_NAMES lives in TypeScript and has no SQL equivalent.
-- Both names were already in that list; the query simply could not see it.
--
-- SO THIS QUERY DECIDES NOTHING. It dumps CANDIDATES on a purely structural
-- test - "the byline contains a comma" - and the real functions
-- (splitArtistByline, canonicalArtist, normalisePart, buildMatchKey) compute
-- every new key from this output. One implementation, the deployed one.
--
-- WHAT TO DO: run it, paste the single result cell back. It feeds
-- scripts/dj-plan-rekey.mjs, which emits the backfill migration.

with candidates as (
  select id, video_id, title, artist, match_key, canonical_track_id, created_at
  from public.dj_tracks
  where match_key is not null
    and (
      artist like '%,%'                       -- every multi-name byline
      or video_id in ('onvLuR7E5sM','eapPwd8v5Xg','5TvNzAe3oGo',   -- the 072 six,
                      'Pkn2rDQx0Ok','GbEM3eJ5Isk','dUt4eBkHWkY')   -- comma or not
    )
),
-- Every row that could MERGE with a candidate, or that shares a group a
-- candidate is leaving. A re-key only ever changes the primary half, so the
-- complete set is "everything keyed to one of these titles".
titles as (select distinct split_part(match_key, '|', 2) as t from candidates),
neighbours as (
  select id, video_id, title, artist, match_key, canonical_track_id, created_at
  from public.dj_tracks
  where match_key is not null
    and split_part(match_key, '|', 2) in (select t from titles)
    and id not in (select id from candidates)
)
select json_build_object(
  'sizes', (select coalesce(json_agg(t), '[]'::json) from (
    select (select count(*) from candidates) as candidates,
           (select count(*) from neighbours) as neighbours,
           (select count(*) from titles) as distinct_titles
  ) t),
  -- ⚠️ IF EITHER LIST IS CAPPED, SAY SO AND DO NOT RUN THE BACKFILL. A truncated
  -- dump would silently produce a partial re-key against a frozen key space.
  'candidates', (select coalesce(json_agg(t), '[]'::json) from (
    select video_id, title, artist, match_key, canonical_track_id, created_at
    from candidates order by artist, title limit 1000
  ) t),
  'neighbours', (select coalesce(json_agg(t), '[]'::json) from (
    select video_id, title, artist, match_key, canonical_track_id, created_at
    from neighbours order by match_key, created_at limit 1000
  ) t),
  -- Which candidates the album path wrote. Structural, not inferred: this is
  -- the column that decides what is in scope.
  'album_written_video_ids', (select coalesce(json_agg(t), '[]'::json) from (
    select distinct c.video_id from candidates c
    join public.dj_album_tracks at on at.video_id = c.video_id
  ) t)
) as result;
