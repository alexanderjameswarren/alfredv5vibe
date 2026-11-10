-- Purpose: Homer slice 1 (homer-h4k, phase B). Two read functions over the 224 tables: homer_series_verdicts (each
-- series a reader has read or judged, with the stored verdict or the plan's default) and homer_quiet_series (the
-- liked, loved and tired series, with the last book read and whether it has gone quiet).
-- Kind: schema change (2 functions). No data.
-- Applied: NO
--
-- Spec: docs/homer-spec-homer-h4k.md ("Functions"). Test: supabase/tests/homer-h4k/3_queries_import_test.sql.
-- Both are security invoker and stable: they read the caller's rows under RLS and write nothing.
-- supabase/migrations/225_homer_queries.sql

begin;

-- ============================================================================
-- 1. homer_series_verdicts
-- ============================================================================
create or replace function public.homer_series_verdicts(p_reader_key text default 'alex')
returns table (
  series_id                 uuid,
  series_name               text,
  series_asin               text,
  books_finished            integer,
  books_started             integer,
  highest_position_finished numeric,
  last_finished_on          date,
  last_read_on              date,
  stored_verdict            text,
  verdict                   text,
  is_default                boolean,
  note                      text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with reader as (
    select id from public.homer_readers where key = p_reader_key and user_id = auth.uid()
  ),
  rule as (
    select (settings #>> '{default_verdict,liked_min_finished}')::int as liked_min,
           settings #>> '{default_verdict,otherwise}' as otherwise
      from public.homer_plans
     where user_id = auth.uid() and status = 'active'
  ),
  reads as (
    select b.series_id,
           count(distinct b.id) filter (where r.finished_on is not null) as finished,
           count(distinct b.id) as started,
           max(b.series_position) filter (where r.finished_on is not null) as top_finished,
           max(r.finished_on) as last_finished,
           max(coalesce(r.finished_on, r.started_on)) as last_read
      from public.homer_reads r
      join public.homer_books b on b.id = r.book_id
     where r.reader_id = (select id from reader) and b.series_id is not null
     group by b.series_id
  ),
  stored as (
    select v.series_id, v.verdict, v.note
      from public.homer_verdicts v
     where v.reader_id = (select id from reader) and v.subject_kind = 'series'
  ),
  subjects as (
    select series_id from reads union select series_id from stored
  )
  select s.id,
         s.name,
         s.series_asin,
         coalesce(rd.finished, 0)::int,
         coalesce(rd.started, 0)::int,
         rd.top_finished,
         rd.last_finished,
         rd.last_read,
         st.verdict,
         coalesce(st.verdict,
                  case when coalesce(rd.finished, 0) >= (select liked_min from rule) then 'liked'
                       else (select otherwise from rule) end),
         st.verdict is null,
         st.note
    from subjects x
    join public.homer_series s on s.id = x.series_id
    left join reads rd on rd.series_id = x.series_id
    left join stored st on st.series_id = x.series_id
   order by rd.last_read desc nulls last, s.name;
$$;

comment on function public.homer_series_verdicts(text) is
  'Homer: every series the reader has read or judged. verdict is the stored one, or else the active plan''s default '
  '(books_finished >= default_verdict.liked_min_finished: liked; otherwise default_verdict.otherwise); is_default says '
  'which. With no active plan a default verdict is null. Read by get_homer_series and homer_quiet_series.';
revoke all on function public.homer_series_verdicts(text) from public, anon;
grant execute on function public.homer_series_verdicts(text) to authenticated, service_role;

-- ============================================================================
-- 2. homer_quiet_series
-- ============================================================================
create or replace function public.homer_quiet_series(p_reader_key text default 'alex')
returns table (
  series_id             uuid,
  series_name           text,
  verdict               text,
  is_default            boolean,
  books_finished        integer,
  last_finished_title   text,
  last_finished_position numeric,
  last_read_on          date,
  days_since            integer,
  quiet_after_days      integer,
  is_quiet              boolean,
  tired_gap_passed      boolean,
  next_position         numeric,
  next_title            text,
  next_asin             text
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
  next_book as (
    select distinct on (b.series_id) b.series_id, b.series_position, b.title, b.asin
      from public.homer_books b
      join last_book lb on lb.series_id = b.series_id
     where b.series_position > lb.series_position
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
         nb.asin
    from v
    left join last_book lb on lb.series_id = v.series_id
    left join next_book nb on nb.series_id = v.series_id
   order by (current_date - v.last_read_on) desc nulls last, v.series_name;
$$;

comment on function public.homer_quiet_series(text) is
  'Homer: the reader''s liked, loved and tired series (stored or default verdict) with the highest-position book '
  'finished, the last read date, days since, and is_quiet when that is at least the plan''s quiet_after_days. '
  'tired_gap_passed (tired only) says the plan''s tired_gap_days has passed. next_* is the next position the library '
  'holds after the last finished book, if any. Longest quiet first. Read by get_homer_quiet_series and the Homer tab.';
revoke all on function public.homer_quiet_series(text) from public, anon;
grant execute on function public.homer_quiet_series(text) to authenticated, service_role;

commit;

select public.platform_check_conformance() as conformance;
