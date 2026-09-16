-- What a "no MIDI" heuristic WOULD reclassify, if applied to history.
--
-- READ-ONLY. Changes nothing. Claude has run none of it.
-- NEWEST FIRST — the newest row is the TOP row.
--
-- Sessions from 2026-09-16 onward carry summary.midi.everConnected and need no
-- heuristic. These queries are only about rows written before that.
--
-- The candidate heuristic is "hits = 0 AND misses > 0". Query B is the reason
-- to distrust it.

-- ------------------------------------------------------------------
-- A. How many historical sessions would a heuristic touch, and how
--    much practice time do they represent?
-- ------------------------------------------------------------------
select
  count(*)                                                        as sessions,
  round(sum(extract(epoch from (ended_at - started_at))) / 60.0)  as minutes,
  min(started_at)::date                                           as oldest,
  max(started_at)::date                                           as newest
from public.sam_sessions
where ended_at is not null
  and summary -> 'midi' is null                    -- pre-flag rows only
  and coalesce((summary ->> 'hits')::int, 0) = 0
  and coalesce((summary ->> 'misses')::int, 0) > 0;

-- ------------------------------------------------------------------
-- B. THE REASON TO BE CAREFUL. The same signature is produced by three
--    different things, and the row cannot tell them apart:
--      1. no keyboard attached          (unmeasured — should be excluded)
--      2. playback ran, nobody played   (unmeasured — should be excluded)
--      3. played, but every note wrong  (MEASURED, and genuinely 0%)
--
--    `recordEvent` folds both "miss" and "wrong" into `misses`, so case 3
--    is indistinguishable from cases 1 and 2 in the summary.
--
--    `avg_timing_ms` is the closest thing to a discriminator: a real
--    attempt usually produces SOME timing deltas. A row with 0 hits,
--    non-zero misses AND a non-zero average timing delta probably had a
--    keyboard attached. Treat it as a hint, not a rule.
-- ------------------------------------------------------------------
select
  to_char(ses.started_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') as started_pt,
  so.title                                              as song,
  coalesce(sn.title, 'Whole song')                      as range,
  (ses.summary ->> 'hits')::int                         as hits,
  (ses.summary ->> 'misses')::int                       as misses,
  (ses.summary ->> 'avgTimingDeltaMs')::int             as avg_timing_ms,
  round(extract(epoch from (ses.ended_at - ses.started_at)) / 60.0, 1) as minutes
from public.sam_sessions ses
join public.sam_songs so on so.id = ses.song_id
left join public.sam_snippets sn on sn.id = ses.snippet_id
where ses.ended_at is not null
  and ses.summary -> 'midi' is null
  and coalesce((ses.summary ->> 'hits')::int, 0) = 0
  and coalesce((ses.summary ->> 'misses')::int, 0) > 0
order by ses.started_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- C. The session that prompted this, for reference.
-- ------------------------------------------------------------------
select
  to_char(started_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') as started_pt,
  summary ->> 'hits'             as hits,
  summary ->> 'misses'           as misses,
  summary ->> 'avgTimingDeltaMs' as avg_timing_ms,
  settings ->> 'bpm'             as bpm_at_start,
  summary -> 'midi'              as midi_flag,
  summary -> 'tempo'             as tempo_envelope
from public.sam_sessions
where id = '84052716-adc6-4653-b139-c36e48b7c03b';
