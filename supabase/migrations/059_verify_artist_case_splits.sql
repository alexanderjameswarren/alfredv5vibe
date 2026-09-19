-- 059 — READ-ONLY VERIFICATION. Nothing is applied; nothing is written.
--
-- Scopes the artist CASE splits 058 turned up, and answers the question they
-- raise: does anything downstream actually read the wrong number?
--
-- ============================================================================
-- WHAT 058 FOUND, AND WHAT IT IS NOT
-- ============================================================================
--
-- 058's last block was written to look for LEADING-ARTICLE splits. It returned
-- CASE splits instead:
--
--     Fleetwood Mac / FLEETWOOD MAC          9 tracks
--     Queens of the Stone Age / Of The       9
--     Cake / CAKE                            7
--     Alice in Chains / Alice In Chains      3
--     fun. / Fun.                            3
--     the Chordettes / The Chordettes        2
--
-- 🛑 match_key IS ALREADY CASE-INSENSITIVE, SO THIS IS NOT A NORMALISER DEFECT.
-- Verified 2026-09-19 by running buildMatchKey over all six real pairs:
--
--     SAME  Fleetwood Mac / FLEETWOOD MAC            -> fleetwood mac|dreams
--     SAME  Cake / CAKE                              -> cake|the distance
--     SAME  Alice in Chains / Alice In Chains        -> alice in chains|would
--     SAME  fun. / Fun.                              -> fun|some nights
--     SAME  the Chordettes / The Chordettes          -> the chordettes|mr sandman
--     SAME  Queens of the Stone Age / Of The         -> queens of the stone age|no one knows
--
-- normalisePart() opens with raw.toLowerCase().trim() and buildMatchKey() runs
-- the primary artist through it. ⚠️ THE INFERENCE "separate match_keys, therefore
-- the normaliser is not case-insensitive" DOES NOT HOLD: these are different
-- VIDEO IDS with different TITLES. dj_tracks is one row per video_id, so two
-- different songs never share a match_key whatever their byline says. Nothing
-- was supposed to collapse at write time, and nothing failed to.
--
-- ============================================================================
-- SO WHAT IS THE CLASS? NEITHER §14.7 NOR A DEFECT.
-- ============================================================================
--
-- NOT §14.7. That warns against a derived rule whose direction reverses between
-- acts ("prefer the longer form" fixed Eddie Higgins and broke Red Garland). A
-- case fold has no direction to reverse: it passes §14.53's test cleanly —
-- (a) one expansion, deterministic; (b) cannot distinguish two real acts. ⚠️ AND
-- IT IS MOOT, because match_key ALREADY DOES IT.
--
-- NOT A DEFECT EITHER. get_dj_plays mode=artists groups on dj_tracks.artist as a
-- RAW DISPLAY STRING, and says so in its own description and `gaps`: "Grouping is
-- on dj_tracks.artist as an EXACT STRING... SPLITS ARE REAL AND PRESENT". This is
-- §14.1 — no artist identity — behaving exactly as documented. The case splits
-- are a new INSTANCE of a known gap, not a new gap.
--
-- 🛑 THE PART THAT IS GENUINELY NEW, AND IS THE REASON TO ACT: the documented
-- examples were SEMANTIC splits ("Oscar Peterson Trio" vs "Oscar Peterson") that
-- need a human to decide whether they are one act. A CASE split needs no
-- judgement at all. It is the subset of §14.1 that can be closed mechanically,
-- and it has been sitting inside a gap labelled "needs curation".
--
-- ⚠️ AND THE FIX IS READ-TIME, NOT A BACKFILL. Because match_key already agrees,
-- grouping the rollup on lower(artist) changes no stored row, no match_key and no
-- canonical_track_id. That is a much cheaper repair than the split appears to
-- imply, and it is why this is worth doing rather than filing.
--
-- ============================================================================
-- WHAT IS AND IS NOT AFFECTED — checked, not assumed
-- ============================================================================
--
--   AFFECTED   get_dj_plays mode=artists      groups on the raw string
--   AFFECTED   dj_artist_tags joins           tags key on the artist string, so
--                                             one spelling can be tagged and the
--                                             other not
--   AFFECTED   weekly review Section 3/4      built on the rollup above
--
--   NOT        familiarity / cram             groups on canonical_track_id, from
--                                             match_key, which case-folds
--   NOT        concert playlists & the diff   keyed on video_id; artist compares
--                                             go through _artist_matches, which
--                                             lowercases
--   NOT        get_dj_setlists                keyed on mbid; refuses names
--
-- ⚠️ QUEENS OF THE STONE AGE, THE SHOW ON THE 26th: the concert playlist is NOT
-- affected. Verified 2026-09-19 — all six playlist tracks resolve to six distinct
-- canonical groups with correct per-track familiarity, despite "My God Is the
-- Sun" being stored as "Queens of the Stone Age" and the other five as "Queens Of
-- The Stone Age". The diff, set_shape and cram order all read whole. What reads
-- half is the BY-ARTIST rollup, which the concert flow does not use.

select json_build_object(
  'case_splits_and_their_weight', (
    select json_agg(t) from (
      select lower(artist)                  as folded,
             array_agg(distinct artist)     as spellings,
             count(*)                       as tracks,
             count(distinct match_key)      as distinct_keys
      from   dj_tracks
      group  by lower(artist)
      having count(distinct artist) > 1
      order  by count(*) desc
    ) t
  ),
  'do_any_case_split_pairs_share_a_title', (
    -- 🛑 THE ONLY WAY A CASE SPLIT COULD REACH match_key. If this returns rows,
    -- the same song exists under two bylines differing only in case — and the
    -- claim "match_key already folds them" would need re-checking against those
    -- rows specifically rather than in the abstract.
    select json_agg(t) from (
      select lower(artist)                as folded,
             match_key,
             array_agg(distinct artist)   as spellings,
             array_agg(distinct video_id) as video_ids
      from   dj_tracks
      group  by lower(artist), match_key
      having count(distinct artist) > 1
    ) t
  ),
  'tags_stranded_on_one_spelling', (
    -- The consequence that actually costs something: an act tagged under one
    -- spelling and untagged under the other, so the tag filter reads half.
    select json_agg(t) from (
      select t.artist              as tagged_spelling,
             t.tag,
             t.status,
             o.artist              as untagged_spelling,
             o.tracks
      from   dj_artist_tags t
      join   lateral (
               select artist, count(*) as tracks
               from   dj_tracks
               where  lower(artist) = lower(t.artist)
                 and  artist <> t.artist
               group  by artist
             ) o on true
      where  not exists (
               select 1 from dj_artist_tags t2
               where  t2.artist = o.artist and t2.tag = t.tag
             )
    ) t
  ),
  'qotsa_rows_in_full', (
    select json_agg(t) from (
      select artist, video_id, title, match_key, created_at::date as written
      from   dj_tracks
      where  lower(artist) like '%queens of the stone age%'
      order  by artist, title
    ) t
  )
) as result;

-- READING IT.
--
-- `case_splits_and_their_weight` — `distinct_keys` should equal `tracks` for every
--   row. If it is LOWER, two videos already share a match_key and the split is
--   cosmetic for those; if it EQUALS tracks, every row is its own song and the
--   split is purely a display-string one.
--
-- 🛑 `do_any_case_split_pairs_share_a_title` SHOULD BE NULL. A non-empty result
--   would mean two videos of the same song under two bylines — which match_key
--   folds correctly, but which is also the only shape where a case split could
--   ever have affected grouping. Worth knowing it is genuinely absent rather than
--   assumed absent.
--
-- `tags_stranded_on_one_spelling` — this is the one with a cost attached. Each row
--   is an act whose tag applies to one spelling only, so every tag-filtered read
--   silently omits the other. ⚠️ Fixing the ROLLUP to group on lower(artist) does
--   NOT fix this: the tag join is a separate read and needs the same fold.
--
-- `qotsa_rows_in_full` — for the 26th. Expect two spellings and nine tracks, every
--   match_key distinct, and no effect on the concert playlist.
