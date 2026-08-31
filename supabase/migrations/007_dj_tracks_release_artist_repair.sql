-- 007 - repair the "Release" artist defect in dj_tracks
--
-- ============================================================================
-- WHY THIS IS SQL AND NOT A TOOL
-- ============================================================================
-- dj_tracks is insert-only: artist and match_key are written once and never
-- updated (spec 4.1.2). That rule exists to stop AN AUTOMATED WRITER clobbering
-- curation - not to forbid a reviewed correction.
--
-- So: NO TOOL GAINS THE ABILITY TO UPDATE dj_tracks. Not record_dj_plays, not a
-- new update_dj_track. If such a tool existed the courier could reach it, which
-- is the exact failure 4.1.2 prevents. This is hand-run SQL, enumerated, with
-- git as the audit trail and the old values in comments below.
--
-- ============================================================================
-- WHAT IS WRONG
-- ============================================================================
-- 42 tracks were imported with artist = 'Release'. That is not an artist: it is
-- YouTube's fallback label on auto-generated "- Topic" channels. The parser was
-- correct; the source data was not. The 42 span TWENTY different channels and a
-- dozen unrelated acts - Miles Davis, Oscar Peterson, Dave Brubeck, a Dr. Seuss
-- soundtrack, Christmas carols - all collapsed under one phantom name, and one
-- pair (Deck the Halls) is WRONGLY MERGED as a result.
--
-- 30 of the 42 have been resolved against YouTube Music's own metadata, matched
-- on video_id only. 12 are NOT resolved and are deliberately LEFT AS 'Release':
-- a row that is wrong-but-honest beats a row that is confidently wrong, and
-- match_key is written once. See docs/dj-release-repair-review.md.
--
-- ============================================================================
-- HOW TO ROLL BACK
-- ============================================================================
-- Every changed row's OLD artist and OLD match_key are in the comment at the end
-- of its VALUES line. All 30 old artists are 'Release' and all 30 old match_keys
-- are 'release|<normalised title>'. To reverse: set artist back to 'Release' and
-- match_key back to the commented value for those 30 video_ids, then re-run the
-- canonical rebuild in STEP 4. Nothing else in this file is destructive.
--
-- ============================================================================
-- AFTER RUNNING THIS, RUN scripts/dj-grouping-check.js. CROSS_KEY MUST BE 0.
-- That is a GATE, not a formality: the Deck the Halls split (STEP 3/4) is
-- exactly the case that produces a CROSS_KEY violation if it is missed.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- STEP 0 - preconditions. Abort rather than repair a database in another state.
-- ---------------------------------------------------------------------------
do $$
declare n_rows int; n_users int;
begin
  select count(*), count(distinct user_id) into n_rows, n_users
  from public.dj_tracks where artist = 'Release';

  if n_rows <> 42 then
    raise exception 'Expected exactly 42 tracks with artist = ''Release'', found %. '
      'Nothing changed. Re-measure before repairing.', n_rows;
  end if;
  -- Scoping depends on this: every statement below filters on artist='Release'
  -- or on the enumerated video_ids. If two users held Release rows, those
  -- filters would reach across accounts.
  if n_users <> 1 then
    raise exception 'Release tracks span % users; this migration assumes one. '
      'Nothing changed.', n_users;
  end if;
end $$;

-- Snapshot BEFORE, for the verification at the end and for a manual rollback.
drop table if exists dj_release_repair_before;
create temporary table dj_release_repair_before as
  select id, user_id, video_id, title, artist, match_key, canonical_track_id, created_at
  from public.dj_tracks
  where artist = 'Release';

-- ---------------------------------------------------------------------------
-- STEP 1 - the 30 corrections. Enumerated literally: 30 video_ids, 30 artists,
-- 30 match_keys. No pattern matching, no LIKE, no derived values.
--
-- match_key values were computed OFFLINE with the real buildMatchKey() from
-- dj-normalise.ts, not hand-written, so they are byte-identical to what the
-- importer would have produced had the artist been right.
--
-- The `and t.artist = 'Release'` predicate is a belt: it makes this statement
-- touch nothing if it is somehow run twice.
-- ---------------------------------------------------------------------------
update public.dj_tracks t
set artist = v.new_artist,
    match_key = v.new_key
from (values
  -- CLUSTER 2 - Oscar Peterson Trio in Tokyo. 5 rows confirmed by live poll
  -- metadata, 2 independently by search, 3 inherited from the same channel.
  ('kszNSrnr6eY', 'Oscar Peterson', 'oscar peterson|the good life'),                                  -- was 'Release' / 'release|the good life'
  ('REk-lpXcUbE', 'Oscar Peterson', 'oscar peterson|what am i here for'),                             -- was 'Release' / 'release|what am i here for'
  ('cEYxRSHXCCM', 'Oscar Peterson', 'oscar peterson|i hear music'),                                   -- was 'Release' / 'release|i hear music'
  ('pDrq9QpOs8Y', 'Oscar Peterson', 'oscar peterson|what are you doing the rest of your life'),       -- was 'Release' / 'release|what are you doing the rest of your life'
  ('-exsCz9cRq8', 'Oscar Peterson', 'oscar peterson|strike up the band'),                             -- was 'Release' / 'release|strike up the band'
  ('TI8Y1x7Gd7I', 'Oscar Peterson', 'oscar peterson|wheatland'),                                      -- was 'Release' / 'release|wheatland'
  ('ccFzr7Xymdg', 'Oscar Peterson', 'oscar peterson|old rockin chair'),                               -- was 'Release' / 'release|old rockin chair'
  ('4DNGhiNVigw', 'Oscar Peterson', 'oscar peterson|the more i see you'),                             -- was 'Release' / 'release|the more i see you'
  ('VtSNGN9Hb7M', 'Oscar Peterson', 'oscar peterson|the preacher'),                                   -- was 'Release' / 'release|the preacher'
  ('S0Bzo4N_1EE', 'Oscar Peterson', 'oscar peterson|blues etude'),                                    -- was 'Release' / 'release|blues etude'

  -- CLUSTER 1 - one search hit, 11 siblings on the same channel id. The credit
  -- is a compilation name rather than a performer, and that was weighed: it is
  -- weak but TRUE, where 'Release' is false AND merges unrelated acts.
  ('PoKBdBf6xgA', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|we wanna wish you a merry christmas'),  -- was 'Release' / 'release|we wanna wish you a merry christmas'
  ('L0Y988hxxDw', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|o christmas tree'),                     -- was 'Release' / 'release|o christmas tree'
  ('Bki99fexk0w', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|carol of the bells'),                   -- was 'Release' / 'release|carol of the bells'
  ('N80yIhTc3ok', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|all i want for christmas is you'),      -- was 'Release' / 'release|all i want for christmas is you'
  ('zntUnbpk7j8', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|o little town of bethlehem'),           -- was 'Release' / 'release|o little town of bethlehem'
  ('Esg_-gLnSDY', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|deck the halls'),                       -- was 'Release' / 'release|deck the halls'   <-- HALF OF THE WRONG MERGE
  ('E6h2cM9foHQ', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|feliz navidad'),                        -- was 'Release' / 'release|feliz navidad'
  ('whauhnjmRb4', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|silent night'),                         -- was 'Release' / 'release|silent night'
  ('Wg0dlVLr8co', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|the holly and the ivy'),                -- was 'Release' / 'release|the holly and the ivy'
  ('PXmx3MzwfuA', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|im dreaming of a white christmas'),     -- was 'Release' / 'release|im dreaming of a white christmas'
  ('HTLv2bNZpVU', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|the first noel'),                       -- was 'Release' / 'release|the first noel'
  ('LPBR7C47mw0', 'Jazzy Christmas Dinner & The Holiday Jazz', 'jazzy christmas dinner and the holiday jazz|jolly old st nicholas'),                -- was 'Release' / 'release|jolly old st nicholas'

  -- SINGLE-TRACK CLUSTERS - each resolved by a search hit on its own video_id.
  ('KNOFLu40NzY', 'The Smashing Pumpkins',                    'the smashing pumpkins|edin'),                          -- was 'Release' / 'release|edin'
  ('bRi_vfUpJhY', 'Miles Davis',                              'miles davis|out of nowhere'),                          -- was 'Release' / 'release|out of nowhere'
  ('xqUsr6d7a8Q', 'Dave Brubeck',                             'dave brubeck|take five remasterizado 2020'),           -- was 'Release' / 'release|take five remasterizado 2020'
  ('f_NATzuXF-I', 'Charles Trenet',                           'charles trenet|douce france'),                         -- was 'Release' / 'release|douce france'
  ('YbWWQPbeBDk', 'Doris Day, Paul Weston And His Orchestra', 'doris day|dream a little dream of me'),                -- was 'Release' / 'release|dream a little dream of me'   <-- joins an EXISTING group
  ('nxI6xiRvCQ8', 'Ed Ivory & Ken Page',                      'ed ivory and ken page|oogie boogies song'),            -- was 'Release' / 'release|oogie boogies song'
  ('blaNCikESpQ', 'The Lorax Singers',                        'the lorax singers|let it grow from dr seuss the lorax'),-- was 'Release' / 'release|let it grow from dr seuss the lorax'
  ('Bm8JBPFuqJg', 'Luc Brooks',                               'luc brooks|london plane')                              -- was 'Release' / 'release|london plane'
) as v(video_id, new_artist, new_key)
where t.video_id = v.video_id
  and t.artist = 'Release';

-- ---------------------------------------------------------------------------
-- STEP 2 - the 12 unresolved rows are NOT touched. Listed here so a later
-- reader knows they were considered and left, not missed:
--
--   V1_dIsqq_js  So What                    uWdVOwRGDnM  Freedie Freeloader
--   YPC8LrLp8wQ  Boplicity                  F_QWV9hk6mY  Jeru
--   HJyg_8mItR4  Mr Grinch                  2r4E1UE4Pgc  Let It Snow
--   UEwjhZ1txmc  Love Is Here to Stay       xtG3EpIiLBM  White Christmas
--   y8EgSUdC6rE  Round Midnight             JegU7wD5ukE  Happy Holiday
--   GDzkoJoFjh8  Deck the Halls             paB8i2_2Q0s  La vie en rose
--
-- Searching returned only the famous editions of each, never these uploads.
-- 3 and 4 are almost certainly Miles Davis by track listing (Kind of Blue,
-- Birth of the Cool) and that inference is DELIBERATELY not acted on - it is the
-- same reasoning that would have made 'Edin' obscure jazz rather than The
-- Smashing Pumpkins.
--
-- !! THESE DO NOT SELF-HEAL. dj_tracks inserts use ON CONFLICT DO NOTHING, so
--    playing one of these tracks today does NOT correct it: the poll submits the
--    right artist, the existing row wins, and the difference surfaces only as an
--    artist_disagreements entry - every time, forever, until a future repair.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- STEP 3 - clear canonical pointers in the blast radius.
--
-- Three groups of rows need clearing, and the third is the one that is easy to
-- miss:
--   (a) the 42 themselves - their keys just changed;
--   (b) any row POINTING AT one of the 42 - it may now point at a leader whose
--       match_key no longer matches, which is a CROSS_KEY violation;
--   (c) any row sharing a key the 42 are joining or vacating, so STEP 4 can
--       rebuild those groups from scratch rather than around a stale leader.
-- ---------------------------------------------------------------------------
create temporary table dj_release_repair_keys as
  select distinct match_key from public.dj_tracks
   where id in (select id from dj_release_repair_before)
     and match_key is not null
  union
  select distinct match_key from dj_release_repair_before
   where match_key is not null;

update public.dj_tracks
set canonical_track_id = null
where match_key in (select match_key from dj_release_repair_keys)
   or canonical_track_id in (select id from dj_release_repair_before);

-- ---------------------------------------------------------------------------
-- STEP 4 - rebuild canonical grouping for the affected keys ONLY.
--
-- The rule applied is dj-tracks.ts's own: within a match_key, the EARLIEST
-- CREATED row is the leader (canonical_track_id null) and every other points
-- directly at it. Applying it uniformly here reproduces exactly the state that
-- would exist had the artist been correct at import time - which is the whole
-- goal, rather than inventing a new grouping.
--
-- Scoped to dj_release_repair_keys, so no untouched group is disturbed.
-- ---------------------------------------------------------------------------
with leaders as (
  select distinct on (match_key) match_key, id
  from public.dj_tracks
  where match_key in (select match_key from dj_release_repair_keys)
  order by match_key, created_at asc, id asc      -- id breaks a created_at tie
)
update public.dj_tracks t
set canonical_track_id = case when t.id = l.id then null else l.id end
from leaders l
where t.match_key = l.match_key;

-- ---------------------------------------------------------------------------
-- STEP 5 - verify inside the transaction. Any failure aborts the whole repair.
-- ---------------------------------------------------------------------------
do $$
declare n int; bad int;
begin
  -- 30 corrected, 12 left.
  select count(*) into n from public.dj_tracks where artist = 'Release';
  if n <> 12 then
    raise exception 'Expected 12 rows still named ''Release'', found %. Rolled back.', n;
  end if;

  select count(*) into n from public.dj_tracks
   where id in (select id from dj_release_repair_before) and artist <> 'Release';
  if n <> 30 then
    raise exception 'Expected 30 corrected rows, found %. Rolled back.', n;
  end if;

  -- No row may point at a leader with a different match_key. This is the
  -- CROSS_KEY invariant, and the Deck the Halls split is what would break it.
  select count(*) into bad
  from public.dj_tracks a join public.dj_tracks b on a.canonical_track_id = b.id
  where a.match_key is distinct from b.match_key;
  if bad <> 0 then
    raise exception 'CROSS_KEY violation: % row(s) point at a leader with a '
      'different match_key. Rolled back.', bad;
  end if;

  -- No chains: a leader must not itself point somewhere.
  select count(*) into bad
  from public.dj_tracks a join public.dj_tracks b on a.canonical_track_id = b.id
  where b.canonical_track_id is not null;
  if bad <> 0 then
    raise exception 'CHAINED: % row(s) point at a non-leader. Rolled back.', bad;
  end if;

  -- Exactly one leader per multi-member key, across the WHOLE table.
  select count(*) into bad from (
    select match_key from public.dj_tracks
    where match_key is not null
    group by match_key
    having count(*) > 1 and count(*) filter (where canonical_track_id is null) <> 1
  ) x;
  if bad <> 0 then
    raise exception 'UNDER_FIRED: % key(s) do not have exactly one leader. '
      'Rolled back.', bad;
  end if;

  -- The Deck the Halls pair must now be SEPARATED.
  select count(distinct match_key) into n from public.dj_tracks
   where video_id in ('Esg_-gLnSDY', 'GDzkoJoFjh8');
  if n <> 2 then
    raise exception 'Deck the Halls pair still shares a match_key. Rolled back.';
  end if;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- AFTER COMMIT - read these, then run the gate.
-- ---------------------------------------------------------------------------
-- select artist, count(*) from public.dj_tracks
--  where id in (select id from dj_release_repair_before)
--  group by artist order by count(*) desc;
--
-- select video_id, title, artist, match_key, canonical_track_id
--   from public.dj_tracks where video_id in ('Esg_-gLnSDY', 'GDzkoJoFjh8');
--
-- select t.video_id, t.title, t.artist, t.canonical_track_id
--   from public.dj_tracks t
--  where t.match_key = 'doris day|dream a little dream of me';
--
-- THEN: paste scripts/dj-grouping-check.js in the browser console.
-- CROSS_KEY must be 0. That is the gate.
