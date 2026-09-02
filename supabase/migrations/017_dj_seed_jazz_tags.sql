-- 017 - seed the jazz tags, which is the half of 016 that is DATA
--
-- ============================================================================
-- WHY THIS IS A SEPARATE FILE AND NOT THE BOTTOM OF 016
-- ============================================================================
-- 016 makes the third arm exist. This makes it do something. They fail
-- differently and they are reviewed differently: 016 is a mechanism to check
-- against the spec, this is a LIST OF NAMES to check against the play history,
-- and merging them would hide a wrong name inside a correct migration.
--
-- 016's verify block raises a NOTICE — not a pass — while this file is
-- unapplied, and says the migration is half-applied. That notice is what this
-- file clears.
--
-- ============================================================================
-- ⚠️ THE JOIN TO dj_tracks IS THE TYPO CHECK, AND IT IS THE POINT
-- ============================================================================
-- Every arm of the jazz definition is an EXACT STRING match on
-- dj_tracks.artist. A tag reading 'Eddie Higgins' when the data says 'Eddie
-- Higgins Trio' inserts cleanly, matches nothing, and makes the jazz report
-- quietly WRONG in the same direction it was already wrong — which is the
-- failure this whole migration pair exists to fix.
--
-- So the insert does not carry a literal user_id. It JOINS to dj_tracks on the
-- artist string, taking user_id from there (the same shape migration 008 used).
-- A name that does not appear in the play history produces NO ROW, and the
-- verify block below counts what landed and names what did not.
--
-- ⚠️ A SILENTLY SHORT SEED WOULD BE INDISTINGUISHABLE FROM A CORRECT ONE. That
-- is §14.5's shape — a read that stops early and says so nowhere — so this
-- fails loudly with the missing names rather than reporting success.
--
-- ============================================================================
-- WHERE THE NAMES CAME FROM, AND WHY THERE ARE ONLY TWELVE
-- ============================================================================
-- Measured 2026-09-02 via get_dj_plays mode=artists over a 90-day window: every
-- artist in the top 50 that is jazz AND was invisible to the old definition.
-- The strings are COPIED FROM THAT OUTPUT, not typed from memory.
--
-- ⚠️ 'Harrison' (4 distinct days) IS DELIBERATELY ABSENT. It may be a truncated
-- or scraped byline (§14.9) rather than an artist name. Tagging an unknown to
-- make a list longer is how a curated allowlist stops being curated — and the
-- whole argument for curating this by hand (§14.7) is that rules break here.
--
-- ⚠️ Wes Montgomery, Oscar Peterson, Miles Davis, Ella Fitzgerald and the rest
-- of the playlist-reachable artists are NOT tagged. They do not need to be:
-- arms 1 and 2 already catch them, and a tag would make the coverage figure
-- look better without changing a single row. `by_source` would then report
-- 'tagged' for artists the tags are not doing any work for.

insert into public.dj_artist_tags (user_id, artist, tag, note)
select distinct t.user_id, v.artist, 'jazz', v.note
from (values
  -- ⚠️ THE HEADLINE CASE. 20 distinct days, 206 play rows, 81 distinct canonical
  -- groups — more repertoire than any other artist in the library, Weezer
  -- included — and named in migration 013's definition string as an example of
  -- what the artist arm catches, while being unreachable by it.
  ('Thelonious Monk',
   'Measured 2026-09-02: 20 distinct days, 81 distinct groups, in no playlist. The case that proved 013''s definition string false.'),
  -- ⚠️ A "Trio" STRING, TAGGED AS THE DATA SPELLS IT. §4.1.4 records that
  -- "Eddie Higgins"/"Eddie Higgins Trio" is the exact pair an alias rule would
  -- have to handle, and §14.7 records why a rule cannot: "prefer the longer
  -- form" fixes this one and breaks Red Garland.
  ('Eddie Higgins Trio',
   'Measured 2026-09-02: 16 distinct days, in no playlist. Tagged under the joined string as dj_tracks spells it — this is a match key, not a name.'),
  ('Bill Evans',
   'Measured 2026-09-02: 11 distinct days, in no playlist. Named in 013''s definition string and unreachable by the arm it was cited as evidence for.'),
  ('Herbie Hancock',
   'Measured 2026-09-02: 8 distinct days, 93 play rows, in no playlist. Named in 013''s definition string and unreachable by it.'),
  ('Red Garland',
   'Measured 2026-09-02: 7 distinct days, in no playlist. Named in 013''s definition string and unreachable by it. §14.7''s counter-example to any longest-form alias rule.'),
  ('Keith Jarrett',
   'Measured 2026-09-02: 7 distinct days, in no playlist.'),
  ('Dizzy Gillespie',
   'Measured 2026-09-02: 6 distinct days, 37 play rows, in no playlist.'),
  ('Charlie Parker',
   'Measured 2026-09-02: 5 distinct days, in no playlist.'),
  ('Wynton Kelly',
   'Measured 2026-09-02: 5 distinct days, in no playlist.'),
  ('Wayne Shorter',
   'Measured 2026-09-02: 4 distinct days, 22 play rows, in no playlist.'),
  ('John Coltrane',
   'Measured 2026-09-02: 4 distinct days, in no playlist.'),
  ('Johnny Hodges',
   'Measured 2026-09-02: 4 distinct days, in no playlist.')
) as v(artist, note)
join public.dj_tracks t on t.artist = v.artist
on conflict (user_id, artist, tag) do nothing;

-- ---------------------------------------------------------------------------
-- VERIFY — the names landed, and the report actually moved
-- ---------------------------------------------------------------------------
-- 🛑 NOT "rows were inserted". §11.15: an operation that reports success without
-- verifying its EFFECT is a check that cannot fail. The effect here is that
-- dj_jazz_activity returns artists it could not previously reach, so that is
-- what is asserted.
do $$
declare
  expected  text[] := array[
    'Thelonious Monk', 'Eddie Higgins Trio', 'Bill Evans', 'Herbie Hancock',
    'Red Garland', 'Keith Jarrett', 'Dizzy Gillespie', 'Charlie Parker',
    'Wynton Kelly', 'Wayne Shorter', 'John Coltrane', 'Johnny Hodges'
  ];
  missing   text[];
  tagged_n  int;
  monk      record;
  before_n  int;
begin
  -- 1. ⚠️ EVERY NAME MUST HAVE MATCHED THE PLAY HISTORY. A name that did not is
  --    a typo or a spelling that differs from dj_tracks, and it fails HERE
  --    rather than as a quietly narrower jazz report six weeks from now.
  select array_agg(e order by e) into missing
  from unnest(expected) as e
  where not exists (
    select 1 from public.dj_artist_tags at
    where at.tag = 'jazz' and at.artist = e
  );

  if missing is not null then
    raise exception
      'These tags did not land because the artist string does not appear in '
      'dj_tracks: %. The join is an EXACT match — check the spelling against '
      'get_dj_plays mode=artists. A tag that matches nothing is invisible, and '
      'the jazz report would stay wrong in exactly the direction 016 fixed.',
      array_to_string(missing, ', ');
  end if;

  select count(*) into tagged_n from public.dj_artist_tags where tag = 'jazz';
  raise notice 'dj_artist_tags: % jazz tag(s) seeded.', tagged_n;

  -- 2. 🛑 THE CLAIM 013 MADE IN PROSE AND COULD NOT DELIVER, NOW ASSERTED.
  --    Monk must appear in the jazz report, through the TAG arm specifically.
  select * into monk
  from public.dj_jazz_activity(3650)
  where artist = 'Thelonious Monk';

  if monk is null then
    raise exception
      'Thelonious Monk is tagged jazz and dj_jazz_activity still does not '
      'return him. The tag arm is not wired up — check that migration 016 was '
      'applied before this file.';
  end if;

  if monk.source <> 'tagged' then
    raise exception
      'Thelonious Monk reached the jazz report via "%" rather than "tagged". '
      'That means one of the playlist arms now catches him, which would be a '
      'real change to the playlists — verify it is intended rather than '
      'assuming this seed is what fixed the report.', monk.source;
  end if;

  raise notice
    'Monk: % distinct days, % distinct groups, via %.',
    monk.distinct_days, monk.distinct_groups, monk.source;

  -- 3. NEGATIVE CONTROL. The playlist arms must STILL work — a rewrite that
  --    replaced them rather than adding to them would look like success here,
  --    because the tagged artists would arrive either way.
  select count(*) into before_n
  from public.dj_jazz_activity(3650)
  where source in ('playlist', 'artist_in_playlist');

  if before_n = 0 then
    raise exception
      'No rows reach the jazz report through the playlist arms any more. The '
      'tag arm has REPLACED them rather than joined them — 12 rows arrived that '
      'way on 2026-09-02 and they must still.';
  end if;

  raise notice '% row(s) still arrive via the playlist arms.', before_n;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. This file creates no tables — 016 registered
-- dj_artist_tags — but the check is what proves that rather than the assumption.
-- ---------------------------------------------------------------------------
