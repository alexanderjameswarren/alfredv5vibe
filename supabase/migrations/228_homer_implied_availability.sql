-- Purpose: Homer slice 1 (homer-h4k, s10). Implied finishes and series availability.
--   1. homer_reads.completion may be 'implied' (a book counted as finished because the reader went on in the series).
--   2. homer_series gains what is published and what is announced, filled in from chat with web search, so Claude
--      never suggests an unreleased book.
--   3. homer_quiet_series also returns availability: books_behind, is_caught_up and the upcoming book. Its next book
--      comes only from published positions.
-- Kind: schema change (1 check constraint replaced, 5 columns, 1 function replaced). No data.
-- Applied: NO
--
-- Spec: docs/homer-spec-homer-h4k.md (phase C mapping, "Tables", "Functions").
-- Test: supabase/tests/homer-h4k/4_implied_availability_test.sql.
-- supabase/migrations/228_homer_implied_availability.sql

begin;

-- ============================================================================
-- 1. completion 'implied'
-- ============================================================================
alter table public.homer_reads drop constraint if exists homer_reads_completion_values;
alter table public.homer_reads add constraint homer_reads_completion_values
  check (completion is null or completion in ('automatic', 'manual', 'implied'));
-- homer_reads_completion_needs_finish (completion needs finished_on) is unchanged.

comment on column public.homer_reads.completion is
  'automatic | manual, from UserUniqueTitlesCompleted; implied, when the reader read 2+ books of the series (the '
  'import marks every book they read in it finished); null if none of these.';

-- ============================================================================
-- 2. series availability
-- ============================================================================
alter table public.homer_series
  add column if not exists available_position     numeric(6,2),
  add column if not exists upcoming_position      numeric(6,2),
  add column if not exists upcoming_release_date  date,
  add column if not exists availability_checked_on date,
  add column if not exists availability_source    text;

alter table public.homer_series drop constraint if exists homer_series_available_position_positive;
alter table public.homer_series add constraint homer_series_available_position_positive
  check (available_position is null or available_position > 0);
alter table public.homer_series drop constraint if exists homer_series_upcoming_position_positive;
alter table public.homer_series add constraint homer_series_upcoming_position_positive
  check (upcoming_position is null or upcoming_position > 0);
alter table public.homer_series drop constraint if exists homer_series_upcoming_after_available;
alter table public.homer_series add constraint homer_series_upcoming_after_available
  check (upcoming_position is null or available_position is null or upcoming_position > available_position);
alter table public.homer_series drop constraint if exists homer_series_release_needs_upcoming;
alter table public.homer_series add constraint homer_series_release_needs_upcoming
  check (upcoming_release_date is null or upcoming_position is not null);
alter table public.homer_series drop constraint if exists homer_series_source_not_blank;
alter table public.homer_series add constraint homer_series_source_not_blank
  check (availability_source is null or btrim(availability_source) <> '');

comment on column public.homer_series.available_position is
  'Highest book position already published, from Claude''s web check. Null = not checked.';
comment on column public.homer_series.upcoming_position is
  'Next announced book''s position (e.g. a pre-order), if any. Never counted as available.';
comment on column public.homer_series.upcoming_release_date is
  'Release date of upcoming_position, if announced. Needs upcoming_position.';
comment on column public.homer_series.availability_checked_on is 'When Claude last checked availability.';
comment on column public.homer_series.availability_source is
  'Where Claude checked, in a few words (e.g. "Amazon series page", "author site").';

-- ============================================================================
-- 3. homer_quiet_series, with availability (the return type changes, so drop and recreate)
-- ============================================================================
drop function if exists public.homer_quiet_series(text);

create function public.homer_quiet_series(p_reader_key text default 'alex')
returns table (
  series_id               uuid,
  series_name             text,
  verdict                 text,
  is_default              boolean,
  books_finished          integer,
  last_finished_title     text,
  last_finished_position  numeric,
  last_read_on            date,
  days_since              integer,
  quiet_after_days        integer,
  is_quiet                boolean,
  tired_gap_passed        boolean,
  next_position           numeric,
  next_title              text,
  next_asin               text,
  available_position      numeric,
  books_behind            numeric,
  is_caught_up            boolean,
  upcoming_position       numeric,
  upcoming_release_date   date,
  availability_checked_on date
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with plan as (
    select (settings ->> 'quiet_after_days')::int as quiet_after,
           (settings ->> 'tired_gap_days')::int as tired_gap
      from public.homer_plans
     where user_id = auth.uid() and status = 'active'
  ),
  reader as (
    select id from public.homer_readers where key = p_reader_key and user_id = auth.uid()
  ),
  v as (
    select * from public.homer_series_verdicts(p_reader_key) where verdict in ('liked', 'loved', 'tired')
  ),
  last_book as (
    select distinct on (b.series_id) b.series_id, b.title, b.series_position
      from public.homer_reads r
      join public.homer_books b on b.id = r.book_id
     where r.reader_id = (select id from reader) and r.finished_on is not null and b.series_id in (select series_id from v)
     order by b.series_id, b.series_position desc nulls last, r.finished_on desc
  ),
  -- The next book the library holds, from published positions only (when availability is known).
  next_book as (
    select distinct on (b.series_id) b.series_id, b.series_position, b.title, b.asin
      from public.homer_books b
      join last_book lb on lb.series_id = b.series_id
      join public.homer_series s on s.id = b.series_id
     where b.series_position > lb.series_position
       and (s.available_position is null or b.series_position <= s.available_position)
     order by b.series_id, b.series_position
  )
  select v.series_id,
         v.series_name,
         v.verdict,
         v.is_default,
         v.books_finished,
         lb.title,
         lb.series_position,
         v.last_read_on,
         (current_date - v.last_read_on)::int,
         (select quiet_after from plan),
         coalesce(current_date - v.last_read_on >= (select quiet_after from plan), false),
         case when v.verdict = 'tired' then coalesce(current_date - v.last_read_on >= (select tired_gap from plan), false) end,
         nb.series_position,
         nb.title,
         nb.asin,
         s.available_position,
         -- greatest() ignores nulls, so the subtraction is guarded: unknown stays null.
         case when s.available_position is not null and lb.series_position is not null
              then greatest(s.available_position - lb.series_position, 0) end,
         case when s.available_position is not null and lb.series_position is not null
              then s.available_position <= lb.series_position end,
         s.upcoming_position,
         s.upcoming_release_date,
         s.availability_checked_on
    from v
    join public.homer_series s on s.id = v.series_id
    left join last_book lb on lb.series_id = v.series_id
    left join next_book nb on nb.series_id = v.series_id
   order by (current_date - v.last_read_on) desc nulls last, v.series_name;
$$;

comment on function public.homer_quiet_series(text) is
  'Homer: the reader''s liked, loved and tired series (stored or default verdict) with the highest-position book '
  'finished, the last read date, days since, and is_quiet when that is at least the plan''s quiet_after_days. '
  'tired_gap_passed (tired only) says the plan''s tired_gap_days has passed. next_* is the next position the library '
  'holds after the last finished book, from published positions only. books_behind is available_position minus the '
  'last finished position (null when either is unknown); is_caught_up is books_behind = 0. upcoming_* is the next '
  'announced book, never counted as available. Longest quiet first. Read by get_homer_quiet_series and the Homer tab.';
revoke all on function public.homer_quiet_series(text) from public, anon;
grant execute on function public.homer_quiet_series(text) to authenticated, service_role;

commit;

select public.platform_check_conformance() as conformance;
