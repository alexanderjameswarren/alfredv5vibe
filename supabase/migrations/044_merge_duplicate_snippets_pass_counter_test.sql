-- MOVED 2026-09-18 from docs/sql/merge-duplicate-snippets-2026-09-15.sql
-- Originally written 2026-09-15. Content unchanged below this header.
-- Purpose: One-off: merge the duplicate 'Measures 1-2 Both No Rest' snippets on the Pass Counter Test song, preserving practice history.
-- Kind: one-off data repair
-- Applied: unknown
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- One-off cleanup: merge the duplicate "Measures 1-2 Both No Rest" snippets on
-- song "Pass Counter Test" (3ff7d3bd-e07a-4025-b38a-5f11d1527a0e).
--
-- NOT a migration. Run it by hand in the Supabase SQL editor after reading it.
-- Claude has not run any part of this.
--
-- WHY THESE TWO EXIST: matching ignored archived snippets until M1.8, so
-- archiving a snippet and recreating its range inserted a second row with the
-- same identity. M1.8 fixes the cause; this repairs the damage.
--
--   KEEP    6726c464-a8ad-48c5-a70a-a480a5986880  created 2026-09-15 19:31:36Z
--   REMOVE  e409ab5e-019f-411a-9e37-f6cac949c183  created 2026-09-15 19:45:41Z
--
-- Keep the OLDER row. It is the original — the newer one is the accident — and
-- any history predating 19:45 can only point at it, so keeping it moves the
-- fewest rows. Keeping the older created_at also preserves the snippet's real
-- age, which is what the newest-first list orders on.
--
-- ############ READ THIS BEFORE RUNNING ############
-- The two foreign keys behave DIFFERENTLY, and one of them is dangerous:
--
--   sam_passes.snippet_id   -> ON DELETE CASCADE
--       Deleting the snippet SILENTLY DELETES ITS PASSES. No error, no warning.
--   sam_sessions.snippet_id -> no ON DELETE clause (NO ACTION)
--       Deleting the snippet ERRORS if sessions still point at it.
--
-- So the repointing MUST happen before the delete. Step 3 below is wrapped in a
-- transaction for exactly this reason: if anything in it fails, nothing commits
-- and no passes are lost.
-- ##################################################

-- ------------------------------------------------------------------
-- STEP 1 (read-only). What is about to move? Run this FIRST.
--    Expect the "remove" row's counts to be what gets repointed.
-- ------------------------------------------------------------------
select
  sn.id,
  case sn.id
    when '6726c464-a8ad-48c5-a70a-a480a5986880' then 'KEEP'
    else 'REMOVE'
  end                                                       as action,
  sn.title,
  sn.archived,
  to_char(sn.created_at at time zone 'America/Los_Angeles', 'MM-DD HH24:MI:SS') as created_pt,
  (select count(*) from public.sam_passes   p where p.snippet_id   = sn.id) as passes,
  (select count(*) from public.sam_sessions se where se.snippet_id = sn.id) as sessions
from public.sam_snippets sn
where sn.id in (
  '6726c464-a8ad-48c5-a70a-a480a5986880',
  'e409ab5e-019f-411a-9e37-f6cac949c183'
)
order by sn.created_at desc;   -- NEWEST FIRST

-- ------------------------------------------------------------------
-- STEP 2 (read-only). Any OTHER duplicate identities anywhere?
--    Archived rows INCLUDED — that is the point of M1.8.
--    Expect exactly one group: 1-2 / rests 0 / both, copies 2.
--    After step 3 this must return ZERO rows.
-- ------------------------------------------------------------------
select
  so.title                   as song,
  sn.start_measure           as start_m,
  sn.end_measure             as end_m,
  coalesce(sn.rest_measures, 0) as rests,
  coalesce(sn.settings ->> 'handMode', 'both') as hand,
  count(*)                   as copies,
  array_agg(sn.id order by sn.created_at desc) as ids_newest_first
from public.sam_snippets sn
join public.sam_songs so on so.id = sn.song_id
group by so.title, sn.start_measure, sn.end_measure,
         coalesce(sn.rest_measures, 0), coalesce(sn.settings ->> 'handMode', 'both')
having count(*) > 1;

-- ------------------------------------------------------------------
-- STEP 3. The merge. All or nothing.
--    Repoint history onto the keeper, THEN delete the duplicate.
-- ------------------------------------------------------------------
begin;

update public.sam_passes
   set snippet_id = '6726c464-a8ad-48c5-a70a-a480a5986880'
 where snippet_id = 'e409ab5e-019f-411a-9e37-f6cac949c183';

update public.sam_sessions
   set snippet_id = '6726c464-a8ad-48c5-a70a-a480a5986880'
 where snippet_id = 'e409ab5e-019f-411a-9e37-f6cac949c183';

-- Safety net: refuse to delete while anything still references the duplicate.
-- If this raises, something else points at it — roll back and investigate
-- rather than forcing the delete, because the passes FK would cascade.
do $$
declare
  remaining integer;
begin
  select (select count(*) from public.sam_passes   where snippet_id = 'e409ab5e-019f-411a-9e37-f6cac949c183')
       + (select count(*) from public.sam_sessions where snippet_id = 'e409ab5e-019f-411a-9e37-f6cac949c183')
    into remaining;
  if remaining <> 0 then
    raise exception 'Still % referencing rows — not deleting', remaining;
  end if;
end $$;

delete from public.sam_snippets
 where id = 'e409ab5e-019f-411a-9e37-f6cac949c183';

commit;

-- ------------------------------------------------------------------
-- STEP 4 (read-only). Confirm.
--    4a: the keeper survives, carrying BOTH snippets' history.
--    4b: re-run STEP 2 — it must now return ZERO rows.
-- ------------------------------------------------------------------
select
  sn.id,
  sn.title,
  sn.archived,
  to_char(sn.created_at at time zone 'America/Los_Angeles', 'MM-DD HH24:MI:SS') as created_pt,
  (select count(*) from public.sam_passes   p where p.snippet_id   = sn.id) as passes,
  (select count(*) from public.sam_sessions se where se.snippet_id = sn.id) as sessions
from public.sam_snippets sn
where sn.song_id = '3ff7d3bd-e07a-4025-b38a-5f11d1527a0e'
order by sn.created_at desc;   -- NEWEST FIRST
