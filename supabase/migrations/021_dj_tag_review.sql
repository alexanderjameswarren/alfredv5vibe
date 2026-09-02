-- 021 - the derived arm wrote garbage with the authority of a derivation
--
-- ============================================================================
-- 🛑 WHAT LANDED
-- ============================================================================
-- After 018 and 020 seeded the playlist arms, 118 artist strings carried tags.
-- Among the jazz ones, written as FACTS with source='playlist':
--
--   "Dec 29, 2023"      "Anything_F_744"      "aron!"      "Cavendish Music"
--
-- Every one of those is TRUE as a statement about membership: the string does
-- appear as dj_tracks.artist on a track in a kind='jazz' playlist. And every one
-- is FALSE as the thing the tag says, which is that this is a jazz artist.
--
-- ⚠️ THE DERIVATION ASSERTS MORE THAN IT KNOWS. It knows MEMBERSHIP. It writes a
-- CLAIM ABOUT AN ACT. The gap between those is §14.9 — dj_tracks.artist carries
-- scraped channel bylines, upload dates and filename fragments — a gap that was
-- already recorded, and which the derived arm then propagated with the authority
-- of a fact rather than the hesitancy of a guess.
--
-- 🛑 IT IS WORSE THAN THE UNTAGGED CASE IT REPLACED. An untagged junk string sits
-- in the candidate list where a human eventually looks at it. A junk string
-- tagged `source='playlist'` is marked "no judgement needed", counts toward
-- coverage, and will never be proposed again — the pollution is now load-bearing
-- for a number the weekly item prints.
--
-- ============================================================================
-- ⚠️ THIS MIGRATION DOES NOT CLEAN ANYTHING, AND THAT IS THE DECISION
-- ============================================================================
-- No rule here decides which strings are real. 🛑 EVERY SUCH RULE IS A GUESS
-- ABOUT TEXT, and this project has already recorded what those cost: §14.7's
-- "prefer the longer form" fixes Eddie Higgins and breaks Red Garland in one
-- stroke. A regex that catches "Dec 29, 2023" also catches a band with a number
-- in its name, and it would delete a curated row silently.
--
-- SO: SURFACE, DO NOT DECIDE. dj_tag_review ranks tags by HOW MUCH EVIDENCE
-- EXISTS THAT THE STRING NAMES AN ACT, using only facts already in the database:
--
--   distinct_tracks     how many dj_tracks rows carry this artist string
--   distinct_playlists  how many playlists it appears in
--   play_rows           how much it has actually been played
--   distinct_days       on how many days
--
-- ⚠️ NOT ONE OF THOSE LOOKS AT THE STRING. A real artist accumulates tracks,
-- playlists and plays; a byline scraped onto one upload accumulates one track and
-- stops. That is a factual asymmetry, not a linguistic judgement — and it is
-- offered as an ORDERING for a human review, never as a verdict.
--
-- ⚠️ THE CLEANUP IS ITS OWN JOB AND IS NOT STARTED. Deleting or rejecting
-- polluted tags is a hand-reviewed pass over a ranked list. Doing it inside the
-- weekly item would put an irreversible judgement about 118 rows inside a
-- conversation about concerts.

-- ---------------------------------------------------------------------------
-- dj_tag_review — the evidence, ordered weakest first, with NO verdict
-- ---------------------------------------------------------------------------
create or replace function public.dj_tag_review(
  p_tag         text default null,
  p_source      text default null,
  p_window_days int  default 90,
  p_limit       int  default 20
)
returns table (
  artist             text,
  tag                text,
  status             text,
  source             text,
  note               text,
  distinct_tracks    int,
  distinct_playlists int,
  play_rows          int,
  distinct_days      int,
  last_played_on     date
)
language sql
stable
as $$
  with tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  playlists_by_artist as (
    select t.artist, count(distinct pt.playlist_id)::int as n
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  plays_by_artist as (
    select t.artist,
           count(*)::int as play_rows,
           count(distinct p.played_on)::int as distinct_days,
           max(p.played_on) as last_played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  )
  select at.artist,
         at.tag,
         at.status,
         at.source,
         at.note,
         coalesce(tb.n, 0),
         coalesce(pb.n, 0),
         coalesce(pl.play_rows, 0),
         coalesce(pl.distinct_days, 0),
         pl.last_played_on
  from public.dj_artist_tags at
  left join tracks_by_artist    tb on tb.artist = at.artist
  left join playlists_by_artist pb on pb.artist = at.artist
  left join plays_by_artist     pl on pl.artist = at.artist
  where (p_tag is null or at.tag = p_tag)
    and (p_source is null or at.source = p_source)
  -- 🛑 WEAKEST EVIDENCE FIRST. This is an ORDERING FOR A HUMAN, not a ruling.
  -- A one-track, one-playlist, never-played string is the cheapest thing to
  -- check; a 94-song artist is not worth anyone's attention. Nothing here
  -- inspects the text.
  order by coalesce(tb.n, 0) asc,
           coalesce(pl.play_rows, 0) asc,
           coalesce(pb.n, 0) asc,
           at.artist
  limit p_limit;
$$;

comment on function public.dj_tag_review(text, text, int, int) is
  'Review surface for dj_artist_tags, ordered WEAKEST EVIDENCE FIRST. '
  '🛑 IT MAKES NO CLAIM ABOUT WHICH STRINGS ARE REAL ARTISTS AND MUST NOT BE '
  'READ AS ONE. It reports four facts already in the database — distinct_tracks, '
  'distinct_playlists, play_rows, distinct_days — and orders by them. NOTHING '
  'HERE INSPECTS THE TEXT. '
  '⚠️ WHY NO RULE: after the 018/020 seeds, jazz tags included "Dec 29, 2023", '
  '"Anything_F_744", "aron!" and "Cavendish Music" — all TRUE as membership '
  'statements and all false as claims about an act (§14.9). Any regex that '
  'catches a date also catches a band with a number in its name, and would '
  'delete a curated row silently — §14.7 records what text rules cost here. '
  '⚠️ A real act accumulates tracks, playlists and plays; a byline scraped onto '
  'one upload accumulates one track and stops. That asymmetry is factual, and it '
  'is an ordering for a human, never a verdict. '
  '⚠️ THE CLEANUP IS A SEPARATE, UNSTARTED JOB. Do not reject rows from inside '
  'the weekly item.';

-- ---------------------------------------------------------------------------
-- dj_tag_coverage — one more column, so the weekly item can caveat its own number
-- ---------------------------------------------------------------------------
-- ⚠️ RETURN TYPE CHANGES, SO IT IS DROPPED FIRST. Depends on 020's shape.
drop function if exists public.dj_tag_coverage(text, int);

create or replace function public.dj_tag_coverage(
  p_tag         text default 'jazz',
  p_window_days int default 90
)
returns table (
  tag                     text,
  window_days             int,
  played_artists          int,
  played_rows             int,
  tagged_active           int,
  tagged_rejected         int,
  tagged_rows             int,
  categorised_artists     int,
  categorised_rows        int,
  uncategorised_artists   int,
  uncategorised_rows      int,
  uncategorised_derivable int,
  -- ADDED 021. Active tags for p_tag whose artist string appears on exactly ONE
  -- dj_tracks row. A FACT about evidence, not a claim that they are junk — but
  -- it is where the junk is, and the section that prints tagged_rows should be
  -- able to qualify it in one line without a second call.
  tagged_single_track     int
)
language sql
stable
as $$
  with rows_by_artist as (
    select t.artist, count(*)::int as play_rows
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  kind_tag as (
    select * from (values ('jazz', 'jazz'), ('concert', 'concert')) as m(kind, tag)
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlists pl
    join kind_tag k on k.kind = pl.kind
    join public.dj_playlist_tracks pt on pt.playlist_id = pl.id
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  tracks_by_artist as (
    select t.artist, count(*)::int as n
    from public.dj_tracks t
    where t.artist is not null and t.artist <> ''
    group by t.artist
  ),
  for_tag as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  categorised as (
    select distinct at.artist from public.dj_artist_tags at where at.status = 'active'
  ),
  decided as (
    select distinct at.artist from public.dj_artist_tags at
  ),
  uncategorised as (
    select r.artist, r.play_rows,
           (r.artist in (select artist from derivable)) as is_derivable
    from rows_by_artist r
    where r.artist not in (select artist from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from rows_by_artist)::int,
         (select coalesce(sum(play_rows), 0) from rows_by_artist)::int,
         (select count(*) from for_tag where status = 'active')::int,
         (select count(*) from for_tag where status = 'rejected')::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where r.artist in (select artist from for_tag where status = 'active'))::int,
         (select count(*) from rows_by_artist r
           where r.artist in (select artist from categorised))::int,
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where r.artist in (select artist from categorised))::int,
         (select count(*) from uncategorised)::int,
         (select coalesce(sum(play_rows), 0) from uncategorised)::int,
         (select count(*) from uncategorised where is_derivable)::int,
         (select count(*) from for_tag f
            join tracks_by_artist tb on tb.artist = f.artist
           where f.status = 'active' and tb.n = 1)::int;
$$;

comment on function public.dj_tag_coverage(text, int) is
  '🛑 TWO DIFFERENT SHARES AND THEY ARE NOT INTERCHANGEABLE. '
  'CATEGORISATION (categorised_rows / played_rows) answers "how much of my '
  'listening does the system know anything about" — it moves whatever answer is '
  'given, so it is the backlog metric and the ONLY one a tagging projection may '
  'use. THE TAG SHARE (tagged_rows / played_rows) answers "how much of my '
  'listening is jazz" — a listening FACT, not a progress bar. '
  '⚠️ A REJECTED-ONLY ARTIST IS DECIDED BUT NOT CATEGORISED, so the buckets do '
  'not sum to played_rows. '
  '⚠️ tagged_single_track (021) COUNTS ACTIVE TAGS WHOSE ARTIST STRING APPEARS ON '
  'EXACTLY ONE TRACK. It is where the junk is: the 018/020 playlist seeds tagged '
  '"Dec 29, 2023" and "Cavendish Music" as jazz, both true as membership and '
  'false as claims about an act (§14.9). It is a fact about EVIDENCE and not a '
  'verdict — quote it as a caveat on tagged_rows, and send anyone who wants to '
  'look to dj_tag_review. '
  '⚠️ uncategorised_derivable should be 0 in normal operation.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  cov      record;
  weakest  record;
  n_review int;
begin
  select * into cov from public.dj_tag_coverage('jazz', 90);

  if cov.tagged_single_track > cov.tagged_active then
    raise exception
      'tagged_single_track (%) exceeds tagged_active (%) — the subset is not a '
      'subset.', cov.tagged_single_track, cov.tagged_active;
  end if;

  raise notice
    'Jazz tags: % active, of which % rest on a single track.',
    cov.tagged_active, cov.tagged_single_track;

  select count(*) into n_review from public.dj_tag_review(null, null, 90, 500);
  if n_review = 0 then
    raise exception
      'dj_tag_review returned no rows. 118 tag rows existed on 2026-09-02, so '
      'zero means a join dropped them rather than that the list is empty.';
  end if;
  raise notice 'dj_tag_review sees % tag row(s).', n_review;

  -- ⚠️ THE ORDERING IS THE WHOLE PRODUCT, so it is asserted rather than trusted.
  -- The first row must carry the FEWEST tracks — that is what makes the review
  -- worth reading top-down.
  select * into weakest from public.dj_tag_review(null, null, 90, 1);
  if weakest.distinct_tracks >
     (select min(distinct_tracks) from public.dj_tag_review(null, null, 90, 500))
  then
    raise exception
      'dj_tag_review is not ordered weakest-first: "%" has % track(s) at the top '
      'of the list.', weakest.artist, weakest.distinct_tracks;
  end if;

  raise notice
    'Weakest evidence: "%" — % track(s), % playlist(s), % play row(s).',
    weakest.artist, weakest.distinct_tracks, weakest.distinct_playlists,
    weakest.play_rows;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. Functions only.
-- ---------------------------------------------------------------------------
