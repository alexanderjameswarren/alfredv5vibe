-- 022 - confirming a watchlist entry makes it go quiet
--
-- ============================================================================
-- 🛑 THE SIGNAL FIRED TWICE WITH THE SAME ANSWER
-- ============================================================================
-- Oasis and Black Eyed Peas appeared in two consecutive weekly reviews with
-- nothing to decide. Alex answered "still interested" both times, and the second
-- ask carried no information the first had not already collected.
--
-- ⚠️ THAT IS §11.7 ARRIVING FROM THE OTHER DIRECTION. The usual failure is a flag
-- that fires on the normal case. This is a QUESTION that does: asked weekly, a
-- slow-moving fact produces the same answer every week until the reader stops
-- reading the section it lives in — and Section 1b is the ONLY place an undated
-- screening row is ever surfaced.
--
-- ⚠️ AND THE NO-THRESHOLD RULE STAYS (§14.17). `mode=undecided` still applies no
-- test to how WARM a row is: filtering on went_quiet is what made Oasis
-- invisible. This filters on whether the QUESTION HAS BEEN ANSWERED, which is a
-- different thing entirely — one is a guess about interest, the other is a
-- record of a conversation that happened.
--
-- ============================================================================
-- WHY A DATE COLUMN AND NOT A dj_feedback ROW
-- ============================================================================
-- dj_feedback records a fact about an ARTIST — "still curious about this act".
-- This records that a specific WATCHLIST ROW was reviewed on a specific day.
-- Storing it as feedback would need a convention for reading feedback back as a
-- review timestamp, which is a second meaning bolted onto a table that already
-- has one (§11.4).
--
-- ⚠️ NULL MEANS NEVER REVIEWED, AND A NEW ROW SURFACES IMMEDIATELY. The
-- null-vs-zero distinction this project keeps insisting on, once more: a
-- watchlist entry created today has not been "recently confirmed", it has never
-- been asked about.
--
-- ============================================================================
-- THE INTERVAL IS 90 DAYS, AND IT IS NOT A NEW CONSTANT
-- ============================================================================
-- 90 days is already this system's window everywhere it measures listening —
-- §12.9's engagement window, dj_tag_coverage, dj_tag_candidates. Reusing it
-- rather than inventing a second number is §11.14's argument: two constants that
-- both mean "the period this system reasons over" would be enforced in one.
--
-- It is also right on its own terms. "Do you still want to see this band" is a
-- quarterly question, not a weekly one. And nothing is lost by waiting: THE
-- SYSTEM CANNOT DETECT A TOUR ANNOUNCEMENT — the Vegas scanner does not exist —
-- so the weekly re-ask was never what would catch one. Alex is.
--
-- ⚠️ IT IS A PARAMETER, NOT A LITERAL, so the choice is inspectable and can be
-- changed by a caller without a migration.

alter table public.dj_concerts
  add column if not exists reviewed_on date;

comment on column public.dj_concerts.reviewed_on is
  'The day an UNDATED SCREENING row was last confirmed as "still interested". '
  '⚠️ NULL MEANS NEVER ASKED, and such a row surfaces immediately — it is not the '
  'same as "recently confirmed". '
  'get_dj_concerts mode=undecided hides a row for a period after this date '
  '(default 90 days, the same window §12.9 uses for listening). Oasis and Black '
  'Eyed Peas were asked about in two consecutive weekly reviews and answered the '
  'same way both times; a question that fires on the normal case gets skipped '
  'exactly like a flag that does (§11.7). '
  '🛑 THIS IS NOT A THRESHOLD ON INTEREST. §14.17 records that filtering '
  'mode=undecided on went_quiet is what made Oasis invisible. This filters on '
  'whether the QUESTION HAS BEEN ANSWERED — a record of a conversation, not a '
  'guess about how much someone cares. '
  '⚠️ Only meaningful for undated screening rows. A dated show is governed by its '
  'date.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
do $$
declare
  n_undated int;
  n_stamped int;
begin
  -- The column exists and is readable.
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'dj_concerts'
      and column_name = 'reviewed_on'
  ) then
    raise exception 'dj_concerts.reviewed_on was not created.';
  end if;

  -- ⚠️ EVERY EXISTING ROW MUST BE NULL. A default of now() would have marked the
  -- entire watchlist as "just confirmed" and silenced Section 1b for a quarter
  -- on its first run — the section going quiet because of a migration rather
  -- than because anyone answered anything.
  select count(*) into n_undated
  from public.dj_concerts where starts_on is null and status = 'screening';

  select count(*) into n_stamped
  from public.dj_concerts where reviewed_on is not null;

  if n_stamped <> 0 then
    raise exception
      '% row(s) already carry a reviewed_on. Nothing has been reviewed yet, so a '
      'default has back-dated a confirmation nobody gave.', n_stamped;
  end if;

  raise notice
    '% undated screening row(s), none stamped — all will surface on the next run.',
    n_undated;
end $$;

-- ---------------------------------------------------------------------------
-- Then, per platform house rules, finish the block with:
--   check_platform_conformance()
-- EXPECT: CONFORMANT. dj_concerts is an existing registered table; this adds one
-- nullable column, and the check is what proves the registration still holds.
-- ---------------------------------------------------------------------------
