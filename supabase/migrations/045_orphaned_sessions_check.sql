-- MOVED 2026-09-18 from docs/sql/orphaned-sessions-2026-09-16.sql
-- Originally written 2026-09-15. Content unchanged below this header.
-- Purpose: Diagnostic: practice sessions with a null ended_at — whether anything in the row bounds how long the sitting was.
-- Kind: read-only diagnostic
-- Applied: n/a — read-only
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- Orphaned practice sessions: rows with a null ended_at.
--
-- READ-ONLY. Nothing here changes data. Claude has run none of it.
-- NEWEST FIRST throughout — the newest row is the TOP row.
--
-- Purpose: establish whether anything in these rows bounds how long the sitting
-- actually lasted. Query B is the one that decides it.

-- ------------------------------------------------------------------
-- A. When did they happen, and did the August code change stop them?
--    `closeOpenSong` (commit a2ffcec, 2026-08-21) was the first time
--    in-app navigation away from an open song ran endSession().
-- ------------------------------------------------------------------
select
  to_char(date_trunc('month', started_at at time zone 'America/Los_Angeles'), 'YYYY-MM') as month_pt,
  count(*) as orphaned
from public.sam_sessions
where ended_at is null
group by 1
order by 1 desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- B. THE DECIDING QUERY. Is there anything in these rows to bound the
--    sitting's length?
--
--    `summary` and `events` are written ONLY by endSession, which by
--    definition never ran for these rows — so both should be empty.
--    If `beats_scored` is 0/null and `playthroughs` is 0 on every row,
--    nothing is knowable beyond started_at and no honest lower bound
--    exists. If any row DOES carry a summary, an older version of the
--    app wrote it, and those rows can be bounded (see the note below).
-- ------------------------------------------------------------------
select
  to_char(ses.started_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') as started_pt,
  so.title                                            as song,
  coalesce(sn.title, 'Whole song')                    as range,
  coalesce(ses.summary ->> 'totalBeats', '-')         as beats_scored,
  coalesce(jsonb_array_length(
    case when jsonb_typeof(ses.summary -> 'playthroughs') = 'array'
         then ses.summary -> 'playthroughs' else '[]'::jsonb end), 0) as playthroughs,
  coalesce(ses.summary ->> 'loopCount', '-')          as loop_count,
  coalesce(jsonb_array_length(
    case when jsonb_typeof(ses.events) = 'array'
         then ses.events else '[]'::jsonb end), 0)    as legacy_events,
  (select count(*) from public.sam_session_events e
     where e.session_id = ses.id)                     as event_rows,
  (select count(*) from public.sam_passes p
     where p.session_id = ses.id)                     as passes,
  ses.settings ->> 'bpm'                              as bpm
from public.sam_sessions ses
join public.sam_songs so on so.id = ses.song_id
left join public.sam_snippets sn on sn.id = ses.snippet_id
where ses.ended_at is null
order by ses.started_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- C. Only meaningful if B showed non-zero `passes` on some row.
--    A pass row is a hard fact: the sitting was still running when it
--    was written, so max(completed_at) is a defensible FLOOR for
--    ended_at. sam_passes only exists from 2026-09-14, so this cannot
--    help any orphan older than that — it is here for future ones.
--
--    Still read-only: this shows what WOULD be written, it writes nothing.
-- ------------------------------------------------------------------
select
  ses.id,
  to_char(ses.started_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') as started_pt,
  to_char(max(p.completed_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI:SS') as last_pass_pt,
  round(extract(epoch from (max(p.completed_at) - ses.started_at)) / 60.0, 1) as floor_minutes
from public.sam_sessions ses
join public.sam_passes p on p.session_id = ses.id
where ses.ended_at is null
group by ses.id, ses.started_at
order by ses.started_at desc;   -- NEWEST FIRST
