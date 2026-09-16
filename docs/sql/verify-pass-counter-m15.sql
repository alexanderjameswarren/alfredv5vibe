-- Pass counter, M1.5 verification — auto-save on Play, Apply removed.
--
-- Paste into the Supabase SQL editor. Most of M1.5 is visible in the app; these
-- queries cover only what is not.
--
-- SORT ORDER: every result set below is NEWEST FIRST. The newest row is the TOP
-- row, not the bottom one. Query M1.5-B is the duplicate check and is a count.
--
-- Queries are labelled M1.5-* so they can never be confused with the M1-*
-- queries in verify-pass-counter-m1.sql. Both files used to letter their
-- queries A-D for different things, which is exactly as confusing as it sounds.

-- ------------------------------------------------------------------
-- M1.5-A. Snippets for the song, NEWEST FIRST — newest snippet is the TOP row.
--    An auto-saved range appears here with no action from you.
-- ------------------------------------------------------------------
select
  to_char(sn.created_at at time zone 'America/Los_Angeles', 'MM-DD HH24:MI:SS') as created_pt,
  so.title            as song,
  sn.title            as snippet,
  sn.start_measure    as start_m,
  sn.end_measure      as end_m,
  sn.rest_measures    as rests,
  sn.settings ->> 'handMode' as hand
from public.sam_snippets sn
join public.sam_songs so on so.id = sn.song_id
where coalesce(sn.archived, false) = false
order by sn.created_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- M1.5-B. THE DUPLICATE CHECK. Playing the same unsaved range twice must
--    produce ONE snippet, not two.
--    Expect ZERO rows. Any row returned means a duplicate was created.
-- ------------------------------------------------------------------
select
  so.title                          as song,
  sn.start_measure                  as start_m,
  sn.end_measure                    as end_m,
  sn.rest_measures                  as rests,
  sn.settings ->> 'handMode'        as hand,
  count(*)                          as copies
from public.sam_snippets sn
join public.sam_songs so on so.id = sn.song_id
where coalesce(sn.archived, false) = false
group by so.title, sn.start_measure, sn.end_measure, sn.rest_measures, sn.settings ->> 'handMode'
having count(*) > 1;

-- ------------------------------------------------------------------
-- M1.5-C. Today's passes and what they were credited to. NEWEST FIRST.
--    "Whole song" here means snippet_id is null — the full-song case,
--    which must never name a snippet.
-- ------------------------------------------------------------------
select
  to_char(p.completed_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') as at_pt,
  s.title                          as song,
  coalesce(sn.title, 'Whole song') as range,
  p.bpm
from public.sam_passes p
join public.sam_songs s   on s.id  = p.song_id
left join public.sam_snippets sn on sn.id = p.snippet_id
where (p.completed_at at time zone 'America/Los_Angeles')::date
      = (now() at time zone 'America/Los_Angeles')::date
order by p.completed_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- M1.5-D. Sessions today and what they were attributed to. NEWEST FIRST.
--    Every run from now on should name its range; only genuine
--    full-song runs should read "Whole song".
-- ------------------------------------------------------------------
select
  to_char(ses.started_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') as started_pt,
  so.title                         as song,
  coalesce(sn.title, 'Whole song') as range,
  ses.summary ->> 'loopCount'      as loops
from public.sam_sessions ses
join public.sam_songs so   on so.id = ses.song_id
left join public.sam_snippets sn on sn.id = ses.snippet_id
where (ses.started_at at time zone 'America/Los_Angeles')::date
      = (now() at time zone 'America/Los_Angeles')::date
order by ses.started_at desc;   -- NEWEST FIRST
