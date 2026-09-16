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
