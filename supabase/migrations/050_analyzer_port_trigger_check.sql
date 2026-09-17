-- MOVED 2026-09-18 from docs/sql/analyzer-port-trigger-check.sql
-- Originally written 2026-09-16. Content unchanged below this header.
-- Purpose: Analyzer port: does anything already stamp measures_edited_at? The answer decided how M6 was built.
-- Kind: read-only diagnostic
-- Applied: n/a — read-only; run by Alex before migration 026
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here, not the order they were run; the original
-- date above is the historical record. Alex runs every file himself.

-- Analyzer port — does anything already stamp measures_edited_at?
-- Read-only. Run BEFORE supabase/migrations/026_sam_song_scores.sql; the answer
-- decides how M6 (keeping scores fresh) is built. Spec §4 M6.
--
-- Expected if every writer stamps in app code (the current evidence): only the
-- platform audit trigger(s) — tgname like '%audit%' — on each table, and
-- nothing whose definition mentions measures_edited_at or sam_songs.

-- 1. Every non-internal trigger on the two tables.
select c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relname in ('sam_songs', 'sam_song_measures')
  and not t.tgisinternal
order by c.relname, t.tgname;

-- 2. Any function body anywhere in the database that mentions the column — a
--    trigger on some other table, or a function the triggers above call.
select n.nspname as schema, p.proname as function
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.prosrc ilike '%measures_edited_at%'
order by 1, 2;
