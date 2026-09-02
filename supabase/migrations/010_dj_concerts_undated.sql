-- 010 - allow undated concerts, and forbid the two statuses that cannot be undated
--
-- ============================================================================
-- WHY. IMPORTING 43 PLAYLISTS FOUND A TABLE THAT COULD NOT HOLD THE HISTORY.
-- ============================================================================
-- Only 2 of 44 YouTube playlists were ever recorded in Supabase. Importing the
-- rest means recording concerts Alex has ALREADY BEEN TO - No Doubt, Coldplay,
-- Jelly Roll, Post Malone, The Killers, Lady Gaga, Adele, Katy Perry - plus acts
-- he screened and passed on.
--
-- starts_on was NOT NULL, so none of that history could be recorded at all
-- without inventing a date. Inventing one is strictly worse than having none: a
-- guessed date is indistinguishable from a known one once written, and it would
-- make a 2019 show look like it happened on a specific day nobody checked. That
-- is spec 13.2's "never take the nearest silently", one table over.
--
-- ============================================================================
-- AN UNDATED ROW IS INERT FOR DATE FILTERS, BY CONSTRUCTION - NOT BY DISCIPLINE
-- ============================================================================
-- The obvious worry is that undated rows corrupt the weekly job's past/upcoming
-- split (spec 12.8). They cannot, and the reason is three-valued logic rather
-- than care:
--
--     NULL <  current_date   ->  NULL  ->  not matched by Section 1 (past)
--     NULL >= current_date   ->  NULL  ->  not matched by Section 2 (upcoming)
--
-- An undated row falls out of BOTH halves. It cannot land wrongly in one.
--
-- ⚠️ THIS HOLDS ONLY WHILE BOTH QUERIES COMPARE THE DATE EXPLICITLY. A query
-- written as `where not (starts_on >= current_date)` would ALSO drop them, but
-- one written as `coalesce(starts_on, '1900-01-01') < current_date` would sweep
-- every undated row into the past half - including the watchlist rows below,
-- which have never happened at all. Do not coalesce this column into a filter.
--
-- ============================================================================
-- SCREENING IS REDEFINED, DELIBERATELY, AND IT IS NOT A NEW STATUS
-- ============================================================================
-- "screening" already meant "deciding whether it is worth going". With a date
-- that is a specific show. WITHOUT one it is an act worth considering whenever
-- they tour - a standing watchlist entry. Same question, different specificity,
-- so it is the same status rather than a sixth one.
--
-- This is load-bearing for the future Vegas-scanner project: undated screening
-- rows ARE the watchlist, and the scanner fills in starts_on when a show
-- appears. Oasis and Black Eyed Peas are the first two - both wanted, neither
-- touring.
--
-- ⚠️ SO THE CONSTRAINT IS NARROWER THAN "UNDATED MEANS HISTORICAL". The real
-- rule is about which statuses IMPLY A SPECIFIC SHOW:
--
--     interested = want to go to THIS show, not committed
--     committed  = going to THIS show
--
-- Neither can mean anything without a date, so those two are forbidden undated.
-- screening (watchlist), attended / missed / rejected (history) are all fine.
--
-- ============================================================================
-- SAFETY
-- ============================================================================
-- ADD CONSTRAINT validates existing rows and aborts loudly if any violate. No
-- pre-check is needed here and none is written: every existing row predates this
-- migration, when starts_on was NOT NULL, so all of them satisfy the left branch
-- trivially. If this ever fails, the data is not what this comment claims and
-- the migration SHOULD stop.

alter table public.dj_concerts
  alter column starts_on drop not null;

alter table public.dj_concerts
  drop constraint if exists dj_concerts_undated_status;

-- Stated as the prohibition rather than as a list of permitted statuses, because
-- the prohibition is the actual rule and survives re-reading. Trade-off, named:
-- if a SEVENTH status is ever added it will be allowed undated by default. That
-- is the permissive failure. It is preferred here because adding a status
-- already requires editing dj_concerts_status_check three lines away, where this
-- constraint is impossible to miss.
alter table public.dj_concerts
  add constraint dj_concerts_undated_status
  check (starts_on is not null or status not in ('interested', 'committed'));

comment on column public.dj_concerts.starts_on is
  'First (or only) night. NULL means NO DATE IS RECORDED, which is legitimate in '
  'exactly two shapes: (a) HISTORY - a show that happened, or was passed on, '
  'whose date is lost (attended / missed / rejected); (b) WATCHLIST - an undated '
  'screening row, meaning an act worth seeing whenever they tour, which the '
  'planned Vegas scanner fills in once a show appears. NULL is NOT "a date we '
  'will know shortly" for interested or committed: both imply a SPECIFIC show, '
  'and dj_concerts_undated_status forbids them without a date. '
  '⚠️ Undated rows are INERT for date filters by construction - NULL < today and '
  'NULL >= today are both NULL, so such a row falls out of BOTH the past and '
  'upcoming halves of the weekly job rather than landing wrongly in one. That '
  'guarantee survives only while queries compare this column DIRECTLY; '
  'coalescing it to a sentinel date would sweep the watchlist rows into the past.';

comment on column public.dj_concerts.status is
  'screening = deciding whether it is worth going. WITH a date that is a specific '
  'show; WITHOUT one it is a standing watchlist entry - an act worth considering '
  'whenever they tour. Same question, different specificity, which is why it is '
  'not a separate status. interested = want to, not committed. committed = going. '
  'attended = went. missed = did not go BUT still want to see them. rejected = '
  'not for me. The lingering want in missed is a fact about the ARTIST, so it is '
  'recorded as artist feedback; this column only records what happened that '
  'night. '
  '⚠️ interested and committed both imply a SPECIFIC show and are therefore '
  'REJECTED without starts_on - see dj_concerts_undated_status. screening, '
  'attended, missed and rejected may all be undated.';

-- ---------------------------------------------------------------------------
-- VERIFY - the column is nullable, the constraint exists AND BITES, and the
-- platform contract is still satisfied.
-- ---------------------------------------------------------------------------
do $$
declare
  is_nullable boolean;
  accepted    boolean := false;   -- the constraint let the bad row through
  refused     boolean := false;   -- the constraint rejected it, as designed
  why         text;               -- why the probe could not run at all
begin
  select a.attnotnull = false into is_nullable
    from pg_attribute a
   where a.attrelid = 'public.dj_concerts'::regclass
     and a.attname  = 'starts_on';
  if not is_nullable then
    raise exception 'starts_on is still NOT NULL - the undated import cannot run.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dj_concerts'::regclass
       and conname  = 'dj_concerts_undated_status'
  ) then
    raise exception 'dj_concerts_undated_status was not created.';
  end if;

  -- ⚠️ A CONSTRAINT THAT EXISTS IS NOT A CONSTRAINT THAT REJECTS ANYTHING.
  -- Asserting only that pg_constraint holds a row would pass just as happily
  -- against a check of `true` (spec 11.1: a verification needs a case that
  -- FAILS if the thing is broken). So actually attempt the forbidden write and
  -- require it to be refused.
  --
  -- ⚠️ THE RAISE MUST SIT OUTSIDE THIS BLOCK. A `raise exception` placed after
  -- the INSERT would be caught by this block's own `when others` and downgraded
  -- to a notice - the failure signal swallowed by the handler meant to describe
  -- it (spec 11.19). So the block only RECORDS what happened; the verdict is
  -- passed below.
  --
  -- user_id is supplied explicitly rather than left to its auth.uid() default:
  -- a migration run from the SQL editor has no auth.uid(), so the default would
  -- produce a NOT NULL violation and this probe would report "unproven" every
  -- time while looking like it ran.
  begin
    insert into public.dj_concerts (user_id, artist_id, starts_on, status)
    select user_id, id, null, 'committed' from public.dj_artists limit 1;
    accepted := true;
  exception
    when check_violation then refused := true;
    when others            then why := sqlerrm;
  end;

  if accepted then
    raise exception 'dj_concerts_undated_status did NOT reject an undated '
      '"committed" row. The constraint exists but does not bite.';
  elsif refused then
    raise notice 'dj_concerts_undated_status verified: undated "committed" refused.';
  else
    -- Do not claim a pass that was not observed.
    raise notice 'Could not exercise dj_concerts_undated_status (%). The '
      'constraint is PRESENT BUT UNPROVEN - re-check once dj_artists has a row.',
      coalesce(why, 'dj_artists is empty');
  end if;

  if exists (select 1 from platform.conformance_failures) then
    raise exception 'platform.conformance_failures is not empty after this '
      'migration. Run: select * from platform.conformance_failures;';
  end if;
end $$;

-- ⚠️ NOTHING IS ROLLED BACK HERE, AND NOTHING NEEDS TO BE. The probe above runs
-- inside a plpgsql BEGIN/EXCEPTION block, which is a SUBTRANSACTION: catching
-- check_violation undoes its INSERT automatically. And in the branch where the
-- row IS accepted, the DO block raises and aborts, which unwinds the insert with
-- it. This migration writes no concert rows on any path.

-- Belt and braces, from a tool call rather than SQL:
--   check_platform_conformance   ->  must report CONFORMANT (28 tables)
