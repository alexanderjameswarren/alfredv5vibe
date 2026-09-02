-- 019 - measure the tag backlog by SHARE OF LISTENING, not by artist count
--
-- ============================================================================
-- 🛑 THE NUMBER 368 IS TRUE AND IT IS THE WRONG NUMBER TO REPORT
-- ============================================================================
-- Measured 2026-09-02, immediately after 018:
--
--   played_artists 393, tagged_active 87, untagged_total 368,
--   untagged_derivable 0, untagged_proposals 368
--
-- At eight proposals a week that is eighteen months, and a weekly section
-- carrying an eighteen-month backlog is §11.7 at a scale nothing survives: it
-- gets skipped by the third week and then it is worse than absent.
--
-- ⚠️ BUT THE BACKLOG IS NOT 368 DECISIONS DEEP. IT IS A COUNT OF A TAIL.
-- 393 artists were played in 90 days; the top twenty account for 1,341 play rows
-- while most of the remaining 348 were played on one or two days. An artist
-- played once cannot move a section that ranks by listening — so a count treats
-- Weezer (336 rows) and a single stray play as one unit of work each, which is
-- the arithmetic that makes the task look infinite.
--
-- ⚠️ AND THE COUNT WILL NEVER REACH ZERO, BY CONSTRUCTION. The candidate pool is
-- "played in the trailing window", and the window slides. New one-off artists
-- arrive every week. Reporting progress as "368 remaining" guarantees a number
-- that does not move however many decisions get made — the exact definition of
-- decoration.
--
-- ============================================================================
-- SO COVERAGE IS MEASURED IN PLAY ROWS, WHICH IS A DENOMINATOR THAT CLOSES
-- ============================================================================
-- Every row in dj_plays has exactly one artist string, so play rows PARTITION.
-- tagged_rows + untagged_rows = played_rows, always, and a share computed from
-- them is a real fraction of listening rather than a fraction of a name list.
--
-- ⚠️ THAT MAKES THE TOP OF THE LIST WORTH ANSWERING AND THE TAIL SAFE TO IGNORE.
-- Deciding Weezer moves the share by 336 rows. Deciding a one-off moves it by
-- one. The section can honestly say "these eight take you from 43% to 71%"
-- instead of "359 to go", and the first sentence is both truer and finite.
--
-- ⚠️ play_rows CARRIES §5's CAVEAT AND IT DOES NOT MATTER HERE. A play row is a
-- (track, day) bucket, not a listen — repeats do not stack. It is therefore a
-- poor absolute count and a perfectly good RELATIVE weight, which is the only
-- thing it is used for.
--
-- ============================================================================
-- ⚠️ THE ORDERING CHANGES TO play_rows, AND THE 2026-09-02 DATA IS WHY
-- ============================================================================
-- 018 ordered candidates by distinct_days. Against the real backlog that put
-- five rock acts ahead of the one jazz artist in the top ten:
--
--   Green Day       16 days, 20 groups,  27 rows   <- ranked 5th
--   Miles Davis     15 days, 49 groups,  83 rows   <- ranked 6th
--
-- Miles Davis is three times the listening and twice the repertoire, and
-- distinct_days ranked him below. **A thin artist heard on many days outranked a
-- deep one**, which is the opposite of what the ordering is for.
--
-- 🛑 play_rows IS THE SORT KEY BECAUSE IT IS THE SAME UNIT AS THE PROGRESS
-- METRIC. Coverage is measured in play rows, so ordering by play rows means the
-- top N are exactly the N decisions that buy the most coverage. The sort key and
-- the thing being maximised are the same quantity — no composite score, no
-- weights to tune, and nothing that needs a paragraph to read correctly (§12.12).
--
-- ⚠️ IT ALSO ABSORBS BOTH SIGNALS RATHER THAN CHOOSING BETWEEN THEM. play_rows
-- rises with frequency AND with breadth: Monk is 94 groups over 21 days = 226
-- rows; Green Day is 20 groups over 16 days = 27. distinct_days and
-- distinct_groups are still RETURNED, because the shape belongs in the sentence
-- — "Miles Davis, 49 songs across 15 days" reads differently from "Green Day,
-- 20 songs across 16", and that difference is what Alex is actually deciding on.

-- ---------------------------------------------------------------------------
-- dj_tag_coverage — the share, and the partition that makes it honest
-- ---------------------------------------------------------------------------
-- ⚠️ RETURN TYPE CHANGES, SO IT IS DROPPED FIRST.
drop function if exists public.dj_tag_coverage(text, int);

create or replace function public.dj_tag_coverage(
  p_tag         text default 'jazz',
  p_window_days int default 90
)
returns table (
  tag                  text,
  window_days          int,
  played_artists       int,
  tagged_active        int,
  tagged_rejected      int,
  untagged_total       int,
  untagged_derivable   int,
  untagged_proposals   int,
  -- ADDED 019. The denominator that closes.
  played_rows          int,
  tagged_rows          int,
  untagged_rows        int
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
  decided as (
    select at.artist, at.status
    from public.dj_artist_tags at
    where at.tag = p_tag
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    join public.dj_tracks t on t.id = pt.track_id
    where pl.kind = p_tag and t.artist is not null and t.artist <> ''
  ),
  untagged as (
    select r.artist, r.play_rows,
           (r.artist in (select artist from derivable)) as is_derivable
    from rows_by_artist r
    where r.artist not in (select artist from decided)
  )
  select p_tag,
         p_window_days,
         (select count(*) from rows_by_artist)::int,
         (select count(*) from decided where status = 'active')::int,
         (select count(*) from decided where status = 'rejected')::int,
         (select count(*) from untagged)::int,
         (select count(*) from untagged where is_derivable)::int,
         (select count(*) from untagged where not is_derivable)::int,
         (select coalesce(sum(play_rows), 0) from rows_by_artist)::int,
         -- ⚠️ ONLY status='active' COUNTS AS COVERED. A rejected artist is
         -- DECIDED but not tagged, so his rows belong to neither bucket — which
         -- is why these two do NOT sum to played_rows once anything is rejected.
         -- Stated in the comment rather than fixed by folding rejections into
         -- "tagged", which would inflate the share with artists deliberately
         -- excluded from the section.
         (select coalesce(sum(r.play_rows), 0) from rows_by_artist r
           where r.artist in (select artist from decided where status = 'active'))::int,
         (select coalesce(sum(play_rows), 0) from untagged)::int;
$$;

comment on function public.dj_tag_coverage(text, int) is
  '🛑 WHAT A TAG-FILTERED SECTION CANNOT SEE. Print it WITH the section, always. '
  '⚠️ REPORT THE SHARE, NOT THE COUNT. tagged_rows / played_rows is a real '
  'fraction of listening; untagged_total is a count of a TAIL and will never '
  'reach zero, because the candidate pool is "played in the window" and the '
  'window slides. Measured 2026-09-02: 368 untagged artists, of which the top '
  'twenty carried 1,341 play rows and most of the rest were one-offs. A count '
  'treats Weezer and a single stray play as one unit of work each, which is what '
  'makes the backlog look infinite. '
  '⚠️ play_rows PARTITION — every dj_plays row has exactly one artist string — so '
  'tagged_rows + untagged_rows = played_rows UNTIL something is rejected. A '
  'rejected artist is decided but NOT covered, so his rows are in neither: that '
  'is deliberate, because folding rejections into "tagged" would inflate the '
  'share with artists deliberately excluded from the section. '
  '`untagged_derivable` are FACTS and may be written without asking. '
  '`untagged_proposals` are JUDGEMENTS and need a human (§14.9: some of those '
  'strings are scraped bylines).';

-- ---------------------------------------------------------------------------
-- dj_tag_candidates — reordered on play_rows
-- ---------------------------------------------------------------------------
create or replace function public.dj_tag_candidates(
  p_tag         text default 'jazz',
  p_window_days int default 90,
  p_limit       int default 20
)
returns table (
  artist          text,
  distinct_days   int,
  play_rows       int,
  distinct_groups int,
  last_played_on  date,
  in_any_playlist boolean,
  derivable       boolean
)
language sql
stable
as $$
  with decided as (
    select at.artist from public.dj_artist_tags at where at.tag = p_tag
  ),
  derivable as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_playlists pl on pl.id = pt.playlist_id
    join public.dj_tracks t on t.id = pt.track_id
    where pl.kind = p_tag and t.artist is not null and t.artist <> ''
  ),
  in_pl as (
    select distinct t.artist
    from public.dj_playlist_tracks pt
    join public.dj_tracks t on t.id = pt.track_id
    where t.artist is not null and t.artist <> ''
  ),
  played as (
    select t.artist,
           coalesce(t.canonical_track_id, t.id) as grp,
           p.played_on
    from public.dj_plays p
    join public.dj_tracks t on t.id = p.track_id
    where p.played_on >= current_date - p_window_days
      and t.artist is not null and t.artist <> ''
      -- ⚠️ EXCLUDES REJECTED AS WELL AS ACTIVE. Both are decided.
      and t.artist not in (select artist from decided)
  )
  select pl.artist,
         count(distinct pl.played_on)::int as distinct_days,
         count(*)::int                     as play_rows,
         count(distinct pl.grp)::int       as distinct_groups,
         max(pl.played_on)                 as last_played_on,
         (pl.artist in (select artist from in_pl)) as in_any_playlist,
         (pl.artist in (select artist from derivable)) as derivable
  from played pl
  group by pl.artist
  -- Facts before judgements; then the decisions that buy the most coverage.
  -- ⚠️ CHANGED 019: play_rows, not distinct_days. Against the real backlog
  -- distinct_days ranked Green Day (16 days, 20 groups, 27 rows) above Miles
  -- Davis (15 days, 49 groups, 83 rows) — a thin artist over a deep one, which
  -- is backwards. play_rows is the unit coverage is measured in, so the top N
  -- are the N decisions that most increase it.
  order by (pl.artist in (select artist from derivable)) desc,
           count(*) desc,
           count(distinct pl.played_on) desc,
           count(distinct pl.grp) desc,
           pl.artist
  limit p_limit;
$$;

comment on function public.dj_tag_candidates(text, int, int) is
  'Played artists in the window carrying NO decision for this tag — neither '
  'active nor rejected. The input to the weekly item''s tagging proposal. '
  '🛑 `derivable: true` IS A FACT, NOT A PROPOSAL. Write those without asking. '
  'Ordered first, so a fact is never buried in a list of judgements. '
  '⚠️ ORDERED BY play_rows (019), not distinct_days. play_rows is the unit '
  'dj_tag_coverage measures the share in, so the top N are exactly the N '
  'decisions that buy the most coverage — sort key and objective are the same '
  'quantity, with no composite score to tune. distinct_days ranked Green Day '
  'above Miles Davis on the real 2026-09-02 backlog. '
  '⚠️ distinct_days and distinct_groups ARE STILL RETURNED and belong in the '
  'printed line: "Miles Davis, 49 songs across 15 days" reads differently from '
  '"Green Day, 20 songs across 16", and that is what is being decided. '
  '⚠️ REJECTED ARTISTS ARE EXCLUDED. They are decided, not missing.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  cov        record;
  first_rows int;
  max_rows   int;
  top_artist text;
begin
  select * into cov from public.dj_tag_coverage('jazz', 90);

  -- 1. ⚠️ THE PARTITION. With nothing rejected yet these must sum exactly; the
  --    moment they do not, the share is being computed against a denominator
  --    that does not close and every percentage in the report is wrong.
  if cov.tagged_rejected = 0
     and cov.played_rows <> cov.tagged_rows + cov.untagged_rows then
    raise exception
      'play rows do not partition: played (%) <> tagged (%) + untagged (%), '
      'with nothing rejected. The coverage share has no valid denominator.',
      cov.played_rows, cov.tagged_rows, cov.untagged_rows;
  end if;

  -- 2. The counts still agree with each other (018's invariant, kept).
  if cov.untagged_total <> cov.untagged_derivable + cov.untagged_proposals then
    raise exception
      'untagged_total (%) <> derivable (%) + proposals (%).',
      cov.untagged_total, cov.untagged_derivable, cov.untagged_proposals;
  end if;

  -- ⚠️ NO LITERAL PERCENT SIGN IN A RAISE FORMAT STRING. In PL/pgSQL `%%` is an
  -- ESCAPED literal percent, not a placeholder, so '(%%)' contributed zero
  -- placeholders while an argument was passed for it — "too many parameters
  -- specified for RAISE", at compile time. Writing '%%%' to mean
  -- "placeholder then percent sign" does not work either: the scanner reads
  -- left to right, takes `%%` first, and renders the sign BEFORE the number.
  -- The word costs nothing and cannot be got wrong.
  raise notice
    'Coverage: % of % play rows tagged — % pct. % untagged artists over % played.',
    cov.tagged_rows, cov.played_rows,
    round(100.0 * cov.tagged_rows / nullif(cov.played_rows, 0), 1),
    cov.untagged_total, cov.played_artists;

  -- 3. 🛑 THE ORDERING ACTUALLY CHANGED, CHECKED AGAINST THE CASE THAT MOTIVATED
  --    IT. Measured 2026-09-02 the top two candidates by play_rows are Weezer
  --    (336) then Foo Fighters (289) — the same two the OLD distinct_days
  --    ordering produced, so comparing that pair proves nothing. The claim is
  --    that rank order is monotonic in play_rows, so assert that directly: the
  --    first row must carry the maximum.
  --
  -- ⚠️ ONLY VALID WHILE THERE ARE NO FACTS PENDING, and that is checked rather
  -- than assumed. `derivable` rows sort FIRST regardless of play_rows — by
  -- design — so with any of them present the first row legitimately is not the
  -- maximum and this check would fail on correct behaviour (§11.16: a control
  -- must reproduce the real defect, not a neighbour).
  if cov.untagged_derivable = 0 then
    select artist, play_rows into top_artist, first_rows
    from public.dj_tag_candidates('jazz', 90, 8) limit 1;

    select max(play_rows) into max_rows
    from public.dj_tag_candidates('jazz', 90, 8);

    if first_rows is distinct from max_rows then
      raise exception
        'dj_tag_candidates is not ordered by play_rows: the first row (%, % rows) '
        'is not the maximum in the page (% rows). 019 changed the sort key and '
        'the change did not take.', top_artist, first_rows, max_rows;
    end if;

    raise notice 'Top candidate: % — % play rows.', top_artist, first_rows;
  else
    raise notice
      '% derivable fact(s) pending, so the ordering check is skipped: facts '
      'sort first by design and the top row is legitimately not the maximum.',
      cov.untagged_derivable;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. No tables created or altered here — functions only.
-- ---------------------------------------------------------------------------
