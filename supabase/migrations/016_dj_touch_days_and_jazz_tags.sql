-- 016 - two WRONG DATA defects found by the 2026-09-02 second review run
--
--   (1) touch_days reads 1 for a playlist that has NEVER been touched.
--   (2) dj_jazz_activity's stated definition names six artists as proof of its
--       artist arm and returns two of them. The other four are invisible.
--
-- Both are §11.5 failures: a claim about what the data MEANS, falsifiable, and
-- false. Neither is a shape question. They are fixed here together because they
-- were found together and share a verification block.

-- ============================================================================
-- ⚠️ DEFECT 1: count(*) OVER A LEFT JOIN COUNTS THE SYNTHESISED NULL ROW
-- ============================================================================
-- Migration 015 wrote:
--
--     coalesce(count(*), 0)::int as touch_days
--     ...
--     from thresh th
--     left join day_hits dh on dh.playlist_id = th.playlist_id
--
-- When a playlist has NO rows in day_hits, the left join still emits one row
-- with every dh column null — and `count(*)` counts ROWS, not values, so it
-- returns 1. `coalesce` never fires because count(*) is never null. Twelve
-- playlists therefore reported:
--
--     touch_days: 1, last_touched_on: null, recent: 0, prior: 0
--
-- which is contradictory THREE WAYS in a single row: 1 ≠ 0 + 0, and a playlist
-- touched once has a date.
--
-- ⚠️ THE TWO HALVES WERE RIGHT, WHICH IS WHY IT SURVIVED REVIEW. The filtered
-- counts use `filter (where dh.played_on ...)`, and a null played_on satisfies
-- no comparison, so they correctly returned 0. Only the unfiltered total was
-- wrong. `runs` was right for the same reason. A defect that leaves most of the
-- row correct reads as an odd number rather than as a bug.
--
-- THE HARM IS EXACTLY THE DISTINCTION touch_days EXISTS TO DRAW. Post Malone
-- Concert has genuinely been touched once (2026-06-14). Chicago Concert has
-- never been touched at all. Before this fix they printed IDENTICALLY. The
-- metric answering "is this still in rotation" could not separate "once" from
-- "never" — and `get_dj_plays` is explicit that the null-vs-zero distinction is
-- deliberate everywhere else in this system.
--
-- FIX: count the VALUE, not the ROW.
--
-- ============================================================================
-- 🛑 AND WHY 015's OWN VERIFY BLOCK COULD NOT HAVE CAUGHT IT — RECORDED, BECAUSE
--    IT IS THE §11.1 SHAPE INSIDE A VERIFICATION BLOCK WRITTEN TO ENFORCE §11.1
-- ============================================================================
-- 015 shipped five verify queries and a stern note that they are "the point of
-- the migration block, not decoration". They were run. They passed. The defect
-- was in the rows they did not select:
--
--   * Step 1 asserted `touch_days > runs` on playlists that get PARTIAL LISTENS.
--     A never-touched playlist has no partial listens, so it was not in frame.
--   * Step 2 was the seasonal negative control for `went_quiet`, which reads
--     the FILTERED counts — the two that were correct.
--   * Step 3 checked last_touched_on where runs > 0. Wrong half again.
--   * Steps 4 and 5 were about the artist rollup entirely.
--
-- ⚠️ EVERY STEP LOOKED AT A PLAYLIST WITH PLAYS IN IT. The bug lives only where
-- there are none. §11.1 says a verification needs a case that FAILS if the thing
-- is broken; five careful checks were written and not one of them selected a
-- row from the population that could fail. **Writing the rule at the top of the
-- file does not apply it to the file.**
--
-- So the control below is not "touch_days looks plausible". It is an INVARIANT
-- over every row — touch_days = recent + prior, always — which is arithmetic
-- that cannot be satisfied by a wrong answer, and which fails loudly on exactly
-- the rows the old checks could not reach.

create or replace function public.dj_playlist_engagement(
  p_playlist_ids uuid[],
  p_window_days  int default 90,
  p_recent_days  int default 30
)
returns table (
  playlist_id           uuid,
  distinct_groups       int,
  threshold             int,
  window_days           int,
  recent_days           int,
  runs                  int,
  last_run_on           date,
  last_touched_on       date,
  touch_days            int,
  touch_days_recent     int,
  touch_days_prior      int,
  went_quiet            boolean
)
language sql
stable
as $$
  with member as (
    select distinct pt.playlist_id,
           coalesce(t.canonical_track_id, t.id) as grp
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where pt.playlist_id = any(p_playlist_ids)
  ),
  sized as (
    select m.playlist_id, count(*)::int as distinct_groups
    from member m group by m.playlist_id
  ),
  thresh as (
    select s.playlist_id, s.distinct_groups,
           greatest(4, least(20, ceil(s.distinct_groups::numeric / 2)::int)) as threshold
    from sized s
  ),
  grp_track as (
    select distinct m.playlist_id, m.grp, t.id as track_id
    from member m
    join public.dj_tracks t on coalesce(t.canonical_track_id, t.id) = m.grp
  ),
  day_hits as (
    select gt.playlist_id, p.played_on,
           count(distinct gt.grp)::int as groups_played
    from grp_track gt
    join public.dj_plays p on p.track_id = gt.track_id
    where p.played_on >= current_date - p_window_days
    group by gt.playlist_id, p.played_on
  )
  select th.playlist_id,
         th.distinct_groups,
         th.threshold,
         p_window_days as window_days,
         p_recent_days as recent_days,
         -- Already correct: a null groups_played satisfies no comparison, so
         -- the filter excludes the synthesised row.
         count(*) filter (where dh.groups_played >= th.threshold)::int as runs,
         max(dh.played_on) filter (where dh.groups_played >= th.threshold) as last_run_on,
         max(dh.played_on) as last_touched_on,
         -- ⚠️ FIXED 016: count(dh.played_on), NOT count(*).
         --
         -- count(*) counts ROWS and the left join always supplies at least one,
         -- so a never-touched playlist read 1. count(<column>) counts NON-NULL
         -- VALUES and returns 0 for the same row, which is the true answer.
         --
         -- ⚠️ THE `coalesce` WAS NEVER LOAD-BEARING AND IS DROPPED, DELIBERATELY.
         -- count() never returns null, so coalesce(count(...), 0) is dead code
         -- that READS like a null guard. Leaving it would suggest the null case
         -- had been considered here, which is precisely the belief that made
         -- this defect survive a review.
         count(dh.played_on)::int as touch_days,
         count(*) filter (
           where dh.played_on >= current_date - p_recent_days)::int as touch_days_recent,
         count(*) filter (
           where dh.played_on <  current_date - p_recent_days)::int as touch_days_prior,
         -- Unchanged. `went_quiet` reads the filtered counts, which were right
         -- throughout — stated so nobody re-derives whether the fix moved it.
         (count(*) filter (
            where dh.played_on <  current_date - p_recent_days) >= 3
          and count(*) filter (
            where dh.played_on >= current_date - p_recent_days) = 0) as went_quiet
  from thresh th
  left join day_hits dh on dh.playlist_id = th.playlist_id
  group by th.playlist_id, th.distinct_groups, th.threshold;
$$;

comment on function public.dj_playlist_engagement(uuid[], int, int) is
  'Spec §12.9 plus migration 015''s rotation metrics, with 016''s count fix. '
  'runs = DAYS in the window on which at least `threshold` distinct canonical '
  'groups from the playlist were played; threshold = clamp(ceil(0.5 * '
  'distinct_groups), 4, 20). runs answers "have I LEARNED this set" and is the '
  'CONCERT metric. '
  '⚠️ touch_days answers a different question — "is this still in ROTATION" — and '
  'counts days with ANY track, no threshold. Report the one that matches the '
  'question, never both as if they were the same idea. '
  '⚠️ FIXED 016: touch_days is count(dh.played_on), not count(*). Over the LEFT '
  'JOIN, count(*) counted the synthesised null row and returned 1 for twelve '
  'playlists that have never been touched — indistinguishable from a playlist '
  'touched exactly once, which is the one distinction this metric exists to draw. '
  'INVARIANT, now asserted: touch_days = touch_days_recent + touch_days_prior on '
  'every row. '
  '⚠️ went_quiet is a CHANGE, not a level: warm before the last `recent_days` '
  '(3+ touch days) and silent within them. A silence shorter than recent_days '
  'cannot fire it, deliberately. It reads the FILTERED counts and was never '
  'affected by the 015 defect. '
  '⚠️ DAYS, NOT SESSIONS: dj_plays buckets by UTC day. '
  '⚠️ A track in two playlists counts toward both — named, not solved.';

-- ============================================================================
-- ⚠️ DEFECT 2: THE JAZZ DEFINITION DESCRIBES A MECHANISM THAT CANNOT DO WHAT IT
--    CLAIMS, AND NAMES FOUR ARTISTS IT CANNOT REACH AS ITS EVIDENCE
-- ============================================================================
-- Migration 013 shipped this, and the Edge Function repeats it to every caller:
--
--   "Membership alone would miss most of it — the heavily-played pianists
--    (Herbie Hancock, Red Garland, Oscar Peterson, Bill Evans, Thelonious Monk,
--    Wes Montgomery) arrived through PLAYS rather than through either playlist."
--
-- Measured 2026-09-02, `dj_jazz_activity(90)` returns TWO of those six. Herbie
-- Hancock, Red Garland, Bill Evans and Thelonious Monk are absent entirely.
--
-- 🛑 IT IS NOT A TUNING PROBLEM. THE ARM CANNOT REACH THEM BY CONSTRUCTION.
-- The artist arm is:
--
--     or t.artist in (select artist from jazz_artists)
--
-- and `jazz_artists` is derived FROM TRACKS ALREADY IN A JAZZ PLAYLIST. So the
-- arm only ever catches an artist who is ALREADY represented in a jazz playlist
-- by at least one track. It widens membership from track-level to artist-level;
-- it cannot reach outside the playlists at all. An artist with no track in
-- either playlist is unreachable no matter how much he is played.
--
-- Thelonious Monk: 20 distinct days, 206 play rows, 81 distinct canonical
-- groups — THE BROADEST REPERTOIRE OF ANY ARTIST IN THE LIBRARY, Weezer
-- included — and in no playlist. He beats the tool's own top row (Wes
-- Montgomery, 13 days) and Section 3 cannot see him.
--
-- ⚠️ THE SENTENCE WAS WRITTEN AS A JUSTIFICATION, WHICH IS WHY IT WENT UNCHECKED.
-- It reads as the REASON the artist arm exists. Read that way nobody asks it for
-- its output — a rationale is not usually a testable claim. It is one here, and
-- it is false for four of its six examples (§11.5).
--
-- ----------------------------------------------------------------------------
-- THE FIX: A THIRD ARM WITH A SOURCE OF ITS OWN
-- ----------------------------------------------------------------------------
-- Cutting the example list and shrinking the claim would be honest and would
-- leave Section 3 permanently unable to answer the question actually being
-- asked of it — "what am I listening to, and what am I missing". So the arm
-- gets a real source instead: a hand-curated tag.
--
-- 🛑 WHY A NEW TABLE AND NOT dj_artists.tags — THE DEVIATION, STATED LOUDLY
--
-- dj_artists.tags is the obvious home and it is the wrong one, for a reason
-- that is documented in this repo already. `upsert_dj_artist` says, in a comment
-- written to stop the question being reopened:
--
--   "`dj_artists.name` is a different system entirely and is read only by
--    get_dj_artists, this tool, and create_dj_concert's by-name lookup.
--    NOTHING JOINS THE TWO."
--
-- The two being dj_artists.name and dj_tracks.artist. Tagging dj_artists would
-- require creating exactly that join — as an EXACT STRING compare, because
-- there is nothing else to join on (§14.1). And then:
--
--   * dj_artists holds 22 rows, every one an mbid-keyed concert act. Its
--     contract is identity: `get_dj_artists` warns that a null mbid means
--     setlists cannot be read at all. Jazz artists have no mbid and need none.
--     The table would hold two kinds of row with two different contracts.
--   * The tag must be applied to the string AS dj_tracks SPELLS IT, because
--     that is the only join key available. That means rows named "Eddie Higgins
--     Trio" and "Oscar Peterson Trio" — display strings, not identities. Putting
--     those in dj_artists would make its `name` column mean two things.
--
-- So the tag lives on its own table, keyed on the play string, and is honest
-- about being a curated ALLOWLIST rather than an identity.
--
-- ⚠️ THIS DOES NOT CLOSE §14.1 AND MUST NOT BE DESCRIBED AS DOING SO. There is
-- still no link between plays and artist identity. This is the same shape as
-- §4.1.4's ARTIST_ALIASES: hand-curated precisely BECAUSE rules break — §14.7
-- records that "prefer the longer form" fixes Eddie Higgins and breaks Red
-- Garland in the same stroke. A dozen curated rows is the fix; a rule is not.

create table if not exists public.dj_artist_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- ⚠️ THE EXACT dj_tracks.artist STRING, NOT AN ARTIST NAME. "Eddie Higgins
  -- Trio" and "Eddie Higgins" are two rows here if both appear in the play
  -- history, because the join is an exact string compare and there is nothing
  -- else to join on. This column is a MATCH KEY, not a display name.
  artist text not null,
  -- Free vocabulary, but 'jazz' is the only one read today. A tag is a bucket
  -- for reporting, never a genre assertion about the artist.
  tag text not null,
  -- Not optional in spirit. An untagged-why row is an unexplained inclusion,
  -- and the next reader cannot tell a decision from a typo.
  note text,
  created_at timestamptz not null default now(),
  unique (user_id, artist, tag)
);

comment on table public.dj_artist_tags is
  'Hand-curated buckets over dj_tracks.artist STRINGS, for reporting. '
  '🛑 NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1. `artist` is the EXACT '
  'dj_tracks.artist string and is a match key, not a display name: "Eddie Higgins '
  'Trio" and "Eddie Higgins" are separate rows if both appear in the history. '
  '⚠️ DELIBERATELY NOT dj_artists.tags. dj_artists holds mbid-keyed concert-act '
  'IDENTITIES and nothing joins its `name` to dj_tracks.artist (see the comment in '
  'upsert_dj_artist). Overloading it would give one column two contracts. '
  'Exists because dj_jazz_activity''s artist arm could only ever reach artists '
  'already represented in a jazz playlist, so Thelonious Monk — 20 days and 81 '
  'distinct songs, the broadest repertoire in the library — was invisible to the '
  'jazz report while its own definition string named him as an example of what '
  'the arm catches. Curated rather than ruled, for the reason §14.7 gives: '
  '"prefer the longer form" fixes Eddie Higgins and breaks Red Garland.';

comment on column public.dj_artist_tags.artist is
  'EXACT dj_tracks.artist string. A match key, not a display name. Compare with '
  'get_dj_plays mode=artists output to find the spelling actually in the data.';

select platform.register_table(
  'public.dj_artist_tags',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: DJ. Hand-curated tag buckets over dj_tracks.artist strings, read by dj_jazz_activity''s third arm and dj_artist_activity''s p_tag filter. NOT an identity and does not close spec 14.1. Deliberately not dj_artists.tags, which is mbid-keyed and joins to nothing. Audited because a tag silently changes what the jazz report counts.'
);

-- ---------------------------------------------------------------------------
-- dj_jazz_activity — three arms now, and each row says which one caught it
-- ---------------------------------------------------------------------------
-- ⚠️ RETURN TYPE CHANGES, SO IT IS DROPPED FIRST. `in_playlist` is RENAMED to
-- `in_jazz_playlist` and `source` is added.
--
-- ⚠️ THE RENAME IS A DEFECT FIX, NOT TIDYING. The 2026-09-02 report carried
-- `in_playlist: false` for Wes Montgomery in Section 3 and `in_any_playlist:
-- true` for the same artist in Section 4. Both were correct — one means "in a
-- JAZZ playlist", the other "in ANY managed playlist" — and read together they
-- look like the tool contradicting itself. Two fields one word apart meaning
-- different things is a trap that costs a reader more than the rename costs.
drop function if exists public.dj_jazz_activity(int);

create or replace function public.dj_jazz_activity(
  p_window_days int default 90
)
returns table (
  artist           text,
  distinct_days    int,
  play_rows        int,
  distinct_groups  int,
  first_played_on  date,
  last_played_on   date,
  in_jazz_playlist boolean,
  source           text
)
language sql
stable
as $$
  with jazz_tracks as (
    select distinct pt.track_id
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    where pl.kind = 'jazz'
  ),
  jazz_artists as (
    select distinct t.artist
    from jazz_tracks jt
    join public.dj_tracks t on t.id = jt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  -- ADDED 016: the third arm. RLS restricts this to the caller's own rows, so a
  -- tag is per-user like everything else here.
  tagged_artists as (
    select distinct at.artist
    from public.dj_artist_tags at
    where at.tag = 'jazz' and at.artist is not null and at.artist <> ''
  ),
  in_scope as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           (t.id in (select track_id from jazz_tracks)) as in_playlist,
           (t.artist in (select artist from jazz_artists)) as artist_in_playlist
    from public.dj_tracks t
    where t.id in (select track_id from jazz_tracks)
       or t.artist in (select artist from jazz_artists)
       or t.artist in (select artist from tagged_artists)
  )
  select s.artist,
         count(distinct p.played_on)::int as distinct_days,
         count(*)::int                    as play_rows,
         count(distinct s.grp)::int       as distinct_groups,
         min(p.played_on)                 as first_played_on,
         max(p.played_on)                 as last_played_on,
         bool_or(s.in_playlist)           as in_jazz_playlist,
         -- Which arm caught this artist. Reported per row because "why is this
         -- in the jazz list" is otherwise unanswerable without re-running the
         -- definition by hand, and the definition is the part most likely to be
         -- wrong (this migration being the evidence).
         case
           when bool_or(s.in_playlist)        then 'playlist'
           when bool_or(s.artist_in_playlist) then 'artist_in_playlist'
           else                                    'tagged'
         end::text                        as source
  from in_scope s
  join public.dj_plays p on p.track_id = s.id
  where p.played_on >= current_date - p_window_days
  group by s.artist
  order by count(distinct p.played_on) desc, count(*) desc, s.artist;
$$;

comment on function public.dj_jazz_activity(int) is
  'The jazz bucket''s "what have I been playing". '
  '🛑 JAZZ IS A PROXY, NOT A GENRE. Nothing marks a track as jazz: dj_tracks has '
  'no genre column and dj_artists (mbid-keyed concert acts) joins to nothing. '
  'THREE ARMS, and `source` says which caught each row: the track is in a '
  'kind=jazz playlist (playlist); its artist appears on a track in one '
  '(artist_in_playlist); or its artist string is tagged jazz in dj_artist_tags '
  '(tagged). '
  '⚠️ THE THIRD ARM WAS ADDED 016 BECAUSE THE FIRST TWO CANNOT REACH OUTSIDE THE '
  'PLAYLISTS. jazz_artists is derived FROM tracks already in a jazz playlist, so '
  'the artist arm widens membership from track-level to artist-level and no '
  'further. Migration 013''s definition string named six pianists as proof of '
  'that arm; four of them — Herbie Hancock, Red Garland, Bill Evans and '
  'Thelonious Monk — were unreachable by construction. Monk alone is 20 days and '
  '81 distinct groups, more repertoire than any other artist in the library. '
  '⚠️ THE TAG ARM IS ONLY AS COMPLETE AS THE TAGS. An untagged jazz artist is '
  'still invisible, and that is now a DATA gap the reader can close rather than a '
  'structural one they cannot. Report coverage honestly: say how many artists are '
  'tagged. '
  '⚠️ Both playlist arms are EXACT STRING matches on dj_tracks.artist, so "Oscar '
  'Peterson Trio" and "Oscar Peterson" do not unify (§4.1.4); the tag arm has the '
  'same property by design and is curated for that reason. '
  '⚠️ RENAMED 016: `in_playlist` -> `in_jazz_playlist`. It sat beside '
  'get_dj_plays mode=artists'' `in_any_playlist` in one report reading '
  'contradictorily for the same artist. Both were right; the names were one word '
  'apart and meant different things.';

-- ---------------------------------------------------------------------------
-- dj_artist_activity — same rollup, now filterable by tag
-- ---------------------------------------------------------------------------
-- ⚠️ ADDS A PARAMETER, SO IT IS DROPPED FIRST. `create or replace` with a new
-- signature creates an OVERLOAD rather than replacing — two functions, one
-- shadowing the other depending on how the caller binds its arguments. That is
-- the §11.4 shape: two things describing one idea, drifting silently.
--
-- WHY: the 2026-09-02 run found that six of the top twenty artists are jazz
-- artists in no playlist at all. Section 3 reports on two playlists; the
-- question actually being asked is "what am I listening to and what am I
-- missing", and this rollup is closer to it than Section 3 is. With p_tag the
-- rollup can BE the jazz section — same numbers, one filter — instead of a
-- second definition that has to agree with it. That is a spec decision (§12.8
-- fixes the sections), so this migration only makes the choice available.
drop function if exists public.dj_artist_activity(int, int);

create or replace function public.dj_artist_activity(
  p_window_days int default 90,
  p_limit       int default 20,
  -- null = every artist, the pre-016 behaviour. 'jazz' = only tagged artists.
  p_tag         text default null
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  first_played_on date,
  last_played_on  date,
  in_any_playlist boolean,
  tags            text[]
)
language sql
stable
as $$
  with tagged as (
    select at.artist, array_agg(distinct at.tag order by at.tag) as tags
    from public.dj_artist_tags at
    group by at.artist
  ),
  played as (
    select t.id, t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null
      and t.artist <> ''
      and (
        p_tag is null
        or t.artist in (select at2.artist from public.dj_artist_tags at2
                         where at2.tag = p_tag)
      )
  ),
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         min(pl.played_on)                 as first_played_on,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         -- Returned ALWAYS, not only when filtering. An untagged artist high in
         -- this list is the signal that the tag set is incomplete — which is the
         -- only way the reader can tell a small jazz section from a small jazz
         -- habit.
         coalesce((select tg.tags from tagged tg where tg.artist = pl.artist),
                  '{}'::text[])            as tags
  from played pl
  group by pl.artist
  order by count(distinct pl.played_on) desc, count(*) desc, pl.artist
  limit p_limit;
$$;

comment on function public.dj_artist_activity(int, int, text) is
  'Section 4''s headline: what was actually played, by artist, over a trailing '
  'window. p_tag filters to artists carrying that tag in dj_artist_tags (null = '
  'all, the pre-016 behaviour); `tags` is returned on every row regardless, so an '
  'UNTAGGED artist high in the list is visible as the tag set being incomplete. '
  '⚠️ distinct_days is DISTINCT DAYS PLAYED, not a play count (§5). '
  '🛑 NOT AN ARTIST IDENTITY AND DOES NOT CLOSE §14.1. Groups dj_tracks.artist as '
  'an EXACT STRING. "Oscar Peterson Trio" and "Oscar Peterson" do not unify '
  '(§4.1.4); collaborations appear under their full joined billing as one row; '
  'and §14.9''s scraped byline "Jazz and Blues Experience, 1.7M views" will '
  'appear here looking like an artist. State the limitation with the numbers.';

-- ---------------------------------------------------------------------------
-- VERIFY — invariants, not plausibility
-- ---------------------------------------------------------------------------
-- 🛑 READ THE §11.1 NOTE AT THE TOP OF THIS FILE BEFORE ADDING A CHECK HERE.
-- 015 shipped five checks that all passed and none of which could see the bug,
-- because every one of them selected a playlist that HAD PLAYS. A check that
-- cannot select a failing row is not a check.
do $$
declare
  never_touched int;
  inconsistent  int;
  monk_days     int;
  monk_in_jazz  int;
  tag_count     int;
begin
  -- ------------------------------------------------------------------
  -- 1. THE INVARIANT. touch_days = recent + prior, on EVERY row.
  --    Arithmetic, not plausibility — a wrong total cannot satisfy it, and it
  --    reaches the never-touched rows that 015's checks could not.
  --    Before 016 this returned 12. It must now return 0.
  -- ------------------------------------------------------------------
  select count(*) into inconsistent
  from public.dj_playlist_engagement(
         array(select id from public.dj_playlists), 90, 30) e
  where e.touch_days is distinct from (e.touch_days_recent + e.touch_days_prior);

  if inconsistent <> 0 then
    raise exception
      'touch_days <> recent + prior on % row(s). This is the 015 defect: '
      'count(*) over the LEFT JOIN counts the synthesised null row. Use '
      'count(dh.played_on).', inconsistent;
  end if;

  -- ------------------------------------------------------------------
  -- 2. THE NEGATIVE CONTROL, REPRODUCING THE ACTUAL DEFECT (§11.16).
  --    A playlist with a null last_touched_on has never been touched, so its
  --    touch_days MUST be 0. Measured 2026-09-02 there were twelve such rows,
  --    every one reading 1.
  -- ------------------------------------------------------------------
  select count(*) into never_touched
  from public.dj_playlist_engagement(
         array(select id from public.dj_playlists), 90, 30) e
  where e.last_touched_on is null and e.touch_days <> 0;

  if never_touched <> 0 then
    raise exception
      '% playlist(s) report last_touched_on = null with touch_days <> 0. A '
      'playlist that has never been touched has zero touch days; "never" and '
      '"once" must not print identically.', never_touched;
  end if;

  -- ------------------------------------------------------------------
  -- 3. The jazz arms still answer, and `source` is populated.
  --    ⚠️ NOT "the function exists". A wrong join returns rows just as happily.
  -- ------------------------------------------------------------------
  if not exists (select 1 from public.dj_jazz_activity(3650)) then
    raise exception
      'dj_jazz_activity returned no rows over 10 years. The playlist arms alone '
      'returned 12 rows over 90 days on 2026-09-02, so zero means the rewrite '
      'broke a join rather than that the library is empty.';
  end if;

  if exists (select 1 from public.dj_jazz_activity(3650) where source is null) then
    raise exception 'dj_jazz_activity returned a null `source`. Every row must '
      'say which arm caught it.';
  end if;

  -- ------------------------------------------------------------------
  -- 4. 🛑 THE CLAIM THAT WAS FALSE, NOW ASSERTABLE.
  --    This check PASSES VACUOUSLY until the tags are seeded, and says so
  --    rather than reading as a green light. That is deliberate: the code fix
  --    and the data fix are separate, and pretending otherwise is how a
  --    half-applied change reports success (§11.15).
  -- ------------------------------------------------------------------
  select count(*) into tag_count from public.dj_artist_tags where tag = 'jazz';

  if tag_count = 0 then
    raise notice
      '⚠️ dj_artist_tags holds NO jazz tags yet. The third arm is live and '
      'inert: dj_jazz_activity still returns exactly what it returned before '
      '016, and Thelonious Monk is still invisible to it. THIS MIGRATION IS '
      'HALF-APPLIED until the tags are seeded. Use get_dj_plays mode=artists to '
      'find the exact artist strings, then insert them.';
  else
    raise notice 'dj_artist_tags holds % jazz tag(s).', tag_count;

    -- Once tagged, Monk MUST appear. This is the exact claim migration 013
    -- asserted in prose and could not satisfy.
    select count(*) into monk_in_jazz
    from public.dj_jazz_activity(3650) where artist = 'Thelonious Monk';

    select count(*) into monk_days
    from public.dj_artist_tags where tag = 'jazz' and artist = 'Thelonious Monk';

    if monk_days > 0 and monk_in_jazz = 0 then
      raise exception
        'Thelonious Monk is tagged jazz and dj_jazz_activity still does not '
        'return him. The tag arm is not wired up. This is the exact failure '
        '013''s definition string described in prose and could not deliver.';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- SEEDING THE TAGS IS A SEPARATE, HUMAN STEP — AND IT IS NOT OPTIONAL
-- ---------------------------------------------------------------------------
-- ⚠️ THE STRINGS MUST BE COPIED FROM THE PLAY DATA, NOT TYPED FROM MEMORY. The
-- join is an exact compare, so "Eddie Higgins" will silently match nothing while
-- "Eddie Higgins Trio" is what the rows actually say. Get the spellings from:
--
--   select * from public.dj_artist_activity(90, 50);
--
-- The twelve measured on 2026-09-02 that are jazz and in NO playlist, with their
-- exact strings and their distinct_days:
--
--   Thelonious Monk (20)      Eddie Higgins Trio (16)   Bill Evans (11)
--   Herbie Hancock (8)        Red Garland (7)           Keith Jarrett (7)
--   Dizzy Gillespie (6)       Charlie Parker (5)        Wynton Kelly (5)
--   Wayne Shorter (4)         John Coltrane (4)         Johnny Hodges (4)
--
-- ⚠️ 'Harrison' (4 days) IS DELIBERATELY NOT ON THAT LIST. It may be a truncated
-- or scraped byline (§14.9) rather than an artist, and tagging an unknown to make
-- a list longer is how a curated allowlist stops being curated. Leave it until
-- somebody looks.
--
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. This migration DOES create a table, so register_table above
-- is load-bearing rather than ceremonial — the check is what proves it took.
