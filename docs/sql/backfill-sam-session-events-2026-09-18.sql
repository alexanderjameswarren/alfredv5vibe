-- Backfill sam_session_events from sam_sessions.events — Supabase SQL editor.
--
-- Context: the result check constraint accepted only 'hit' and 'miss', so any
-- insert batch containing a 'partial' or a 'wrong' was refused whole, and the
-- writer stopped there — losing every later batch of that session too. The
-- jsonb copy in sam_sessions.events has no such filter and is the fuller
-- record: 1,919 of 2,204 ended sessions, against 1,137 in the table.
--
-- 🛑 RUN 029 FIRST (supabase/migrations/029_sam_session_events_result_values.sql).
--    Without it every 'partial' and 'wrong' row here is refused exactly as
--    before, and you will backfill only the hits and misses.
--
-- Each query is ONE statement returning ONE json cell. Run 1 first and read it;
-- run 2 to write; run 3 to check the result.
--
-- HOW IT STAYS SAFE TO RE-RUN. The app appends events in array order and
-- inserts them in that order, so a partially written session holds exactly the
-- FIRST n elements of its array. Query 2 therefore inserts only elements past
-- the number of rows a session already has (`ord > existing`). Run it again and
-- every session's count equals its array length, so nothing is selected. It
-- never updates or deletes an existing row.
--
-- created_at is set to the session's own end time, NOT now(): these rows
-- describe practice that happened months ago, and bucketing them by insert
-- time would put the whole history in September.


-- ============================================================================
-- 1. BEFORE WRITING ANYTHING — what would this touch, and is the JSON uniform?
--    Expect: shape_variants lists only the seven known keys, and
--    unexpected_result_values is [].
-- ============================================================================
with ended as (
  select s.id, s.song_id, s.ended_at, s.events,
         coalesce(jsonb_array_length(case when jsonb_typeof(s.events) = 'array' then s.events end), 0) as json_events
  from public.sam_sessions s
  where s.ended_at is not null
),
counts as (
  select e.id, e.json_events,
         (select count(*) from public.sam_session_events ev where ev.session_id = e.id) as table_rows
  from ended e
),
elements as (
  select e.id as session_id, t.ev
  from ended e, lateral jsonb_array_elements(e.events) as t(ev)
  where e.json_events > 0
)
select json_build_object(
  'sessions_ended',            (select count(*) from ended),
  'sessions_with_json',        (select count(*) from ended where json_events > 0),
  'sessions_with_table_rows',  (select count(*) from counts where table_rows > 0),
  'sessions_to_backfill',      (select count(*) from counts where json_events > table_rows),
  'rows_to_insert',            (select coalesce(sum(json_events - table_rows), 0) from counts where json_events > table_rows),
  'sessions_table_ahead_of_json', (select count(*) from counts where table_rows > json_events),
  'shape_variants', (select json_agg(t) from (
      select keys, count(*) as events
      from (select (select string_agg(k, ',' order by k) from jsonb_object_keys(ev) k) as keys from elements) x
      group by keys order by count(*) desc) t),
  'result_values', (select json_agg(t) from (
      select ev->>'result' as result, count(*) as events from elements group by 1 order by 2 desc) t),
  'unexpected_result_values', (select coalesce(json_agg(distinct ev->>'result'), '[]'::json) from elements
      where ev->>'result' is null or ev->>'result' not in ('hit', 'miss', 'partial', 'wrong')),
  'null_measure_numbers', (select count(*) from elements where ev->>'measure' is null),
  'timing_present',      (select count(*) from elements where ev->>'timingDeltaMs' is not null),
  'oldest_session',      (select min(ended_at) from ended where json_events > 0),
  'newest_session',      (select max(ended_at) from ended where json_events > 0)
) as result;


-- ============================================================================
-- 2. THE BACKFILL. Inserts only what is missing. Safe to run twice.
--    Returns rows inserted and sessions touched.
-- ============================================================================
with ended as (
  select s.id, s.song_id, s.ended_at, s.started_at, s.events,
         coalesce(jsonb_array_length(case when jsonb_typeof(s.events) = 'array' then s.events end), 0) as json_events
  from public.sam_sessions s
  where s.ended_at is not null
),
todo as (
  select e.*, (select count(*) from public.sam_session_events ev where ev.session_id = e.id) as table_rows
  from ended e
  where e.json_events > 0
),
missing as (
  select t.id as session_id, t.song_id, coalesce(t.ended_at, t.started_at) as at, x.ev
  from todo t, lateral jsonb_array_elements(t.events) with ordinality as x(ev, ord)
  where t.json_events > t.table_rows
    and x.ord > t.table_rows          -- the rows that never landed, in order
),
prepared as (
  select m.session_id, m.song_id, m.at,
         (m.ev->>'measure')::integer as measure_number,
         (m.ev->>'beat')::numeric    as beat,
         m.ev->>'result'             as result,
         coalesce((select array_agg(v::integer order by o)
                   from jsonb_array_elements_text(case when jsonb_typeof(m.ev->'playedNotes') = 'array'
                                                       then m.ev->'playedNotes' end) with ordinality as p(v, o)),
                  '{}'::integer[])   as played_notes,
         coalesce((select array_agg(v::integer order by o)
                   from jsonb_array_elements_text(case when jsonb_typeof(m.ev->'expectedNotes') = 'array'
                                                       then m.ev->'expectedNotes' end) with ordinality as q(v, o)),
                  '{}'::integer[])   as expected_notes,
         (m.ev->>'timingDeltaMs')::integer as timing_delta_ms,
         coalesce((m.ev->>'loopIteration')::integer, 0) as loop_iteration
  from missing m
  where m.ev->>'measure' is not null
    and m.ev->>'beat' is not null
    and m.ev->>'result' in ('hit', 'miss', 'partial', 'wrong')
),
inserted as (
  insert into public.sam_session_events
    (session_id, song_id, measure_id, measure_number, beat, result,
     played_notes, expected_notes, timing_delta_ms, loop_iteration, created_at)
  select p.session_id, p.song_id,
         -- Resolved exactly as the app does: this song's measure with that
         -- played number, or null when there is none.
         sm.id,
         p.measure_number, p.beat, p.result,
         p.played_notes, p.expected_notes, p.timing_delta_ms, p.loop_iteration,
         p.at
  from prepared p
  left join public.sam_song_measures sm
    on sm.song_id = p.song_id and sm.number = p.measure_number
  returning session_id, result, measure_id
)
select json_build_object(
  'rows_inserted',     (select count(*) from inserted),
  'sessions_touched',  (select count(distinct session_id) from inserted),
  'by_result',         (select json_agg(t) from (
                          select result, count(*) as rows from inserted group by 1 order by 2 desc) t),
  'measure_id_null',   (select count(*) from inserted where measure_id is null),
  'skipped_unusable',  (select count(*) from missing m
                        where m.ev->>'measure' is null or m.ev->>'beat' is null
                           or m.ev->>'result' is null
                           or m.ev->>'result' not in ('hit', 'miss', 'partial', 'wrong'))
) as result;


-- ============================================================================
-- 3. AFTERWARDS — how complete is the telemetry now?
--    `short_of_summary` counts sessions holding fewer rows than their own
--    summary.totalBeats claims; those are sittings whose jsonb copy is missing
--    or short too (a tab closed mid-practice writes the summary but no events),
--    and nothing can recover them.
-- ============================================================================
with ended as (
  select s.id, s.ended_at, s.summary,
         coalesce((s.summary->>'totalBeats')::int, 0) as summary_beats,
         coalesce(jsonb_array_length(case when jsonb_typeof(s.events) = 'array' then s.events end), 0) as json_events,
         (select count(*) from public.sam_session_events ev where ev.session_id = s.id) as table_rows
  from public.sam_sessions s
  where s.ended_at is not null
)
select json_build_object(
  'sessions_ended',             (select count(*) from ended),
  'sessions_with_rows',         (select count(*) from ended where table_rows > 0),
  'sessions_without_rows',      (select count(*) from ended where table_rows = 0),
  'of_those_no_json_either',    (select count(*) from ended where table_rows = 0 and json_events = 0),
  'short_of_summary',           (select count(*) from ended where table_rows < summary_beats),
  'short_of_summary_rows_missing', (select coalesce(sum(summary_beats - table_rows), 0) from ended where table_rows < summary_beats),
  'short_of_summary_but_json_had_more', (select count(*) from ended where table_rows < summary_beats and json_events > table_rows),
  'rows_total',                 (select count(*) from public.sam_session_events),
  'result_values',              (select json_agg(t) from (
                                   select result, count(*) as rows from public.sam_session_events group by 1 order by 2 desc) t),
  'timing_rows',                (select count(*) from public.sam_session_events where timing_delta_ms is not null),
  'table_size',                 (select pg_size_pretty(pg_total_relation_size('public.sam_session_events')))
) as result;
