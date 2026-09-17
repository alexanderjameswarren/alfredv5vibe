-- MOVED 2026-09-18 from docs/sql/verify-pass-counter-m1.sql
-- Originally written 2026-09-15. Content unchanged below this header.
-- Purpose: Pass counter M1 verification (round 2, after the snippet fix).
-- Kind: read-only verification
-- Applied: n/a — read-only; run by Alex during M1
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- Pass counter, M1 verification (round 2 — after the snippet fix).
--
-- Paste the whole file into the Supabase SQL editor. Query M1-A is the one to
-- re-run after each test; M1-B, M1-C and M1-D answer specific spec criteria.
--
-- Queries are labelled M1-* so they can never be confused with the M1.5-*
-- queries in verify-pass-counter-m15.sql. Both files used to letter their
-- queries A-D for different things, which is exactly as confusing as it sounds.
--
-- SORT ORDER: every result set below is NEWEST FIRST. The most recent pass is
-- the TOP row, not the bottom one. (A misread of this is what produced a false
-- "repeat off is broken" report last round.) Queries B and D are totals, so
-- order does not apply to them.

-- ------------------------------------------------------------------
-- M1-A. Every pass recorded today. NEWEST FIRST — newest pass is the TOP row.
--    "range" reads "Whole song" or the snippet's title, so spec rule 6
--    (a whole-song pass never credits a snippet) is checkable by eye.
-- ------------------------------------------------------------------
select
  to_char(p.completed_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') as at_pt,
  s.title                                as song,
  coalesce(sn.title, 'Whole song')       as range,
  p.bpm,
  case when p.session_id is null then 'none' else 'yes' end as session
from public.sam_passes p
join public.sam_songs s   on s.id  = p.song_id
left join public.sam_snippets sn on sn.id = p.snippet_id
where (p.completed_at at time zone 'America/Los_Angeles')::date
      = (now() at time zone 'America/Los_Angeles')::date
order by p.completed_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- M1-B. Today's totals per song and per range — the numbers M2/M3/M4 will
--    eventually put on screen. Totals, so sort order is irrelevant here.
-- ------------------------------------------------------------------
select
  s.title                          as song,
  coalesce(sn.title, 'Whole song') as range,
  count(*)                         as passes_today
from public.sam_passes p
join public.sam_songs s   on s.id  = p.song_id
left join public.sam_snippets sn on sn.id = p.snippet_id
where (p.completed_at at time zone 'America/Los_Angeles')::date
      = (now() at time zone 'America/Los_Angeles')::date
group by s.title, sn.title
order by s.title, range;

-- ------------------------------------------------------------------
-- M1-C. The snippet fix, seen from the session side. NEWEST FIRST.
--    `sam_sessions.snippet_id` was null for every snippet session ever
--    recorded — the same missing id that dropped the passes. Sessions
--    started from today's tests onward should name the snippet.
--    Rows from BEFORE the fix will still read "Whole song"; that is
--    historic data and is not being rewritten.
-- ------------------------------------------------------------------
select
  to_char(ses.started_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') as started_pt,
  so.title                          as song,
  coalesce(sn.title, 'Whole song')  as range,
  ses.summary ->> 'loopCount'       as loops
from public.sam_sessions ses
join public.sam_songs so   on so.id = ses.song_id
left join public.sam_snippets sn on sn.id = ses.snippet_id
where (ses.started_at at time zone 'America/Los_Angeles')::date
      = (now() at time zone 'America/Los_Angeles')::date
order by ses.started_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- M1-D. Spec criterion: every row written has a non-null bpm.
--    Expect ZERO rows. Anything returned is a bug.
-- ------------------------------------------------------------------
select id, song_id, snippet_id, completed_at
from public.sam_passes
where bpm is null;
