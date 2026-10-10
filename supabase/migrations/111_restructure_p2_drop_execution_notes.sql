-- APPLIED 2026-10-10, before being numbered: run as
-- _pending_restructure_p2-q7m_drop_execution_notes.sql. Do not run again.
--
-- Purpose: Restructure Phase 2, step 5. Retire executions.notes: copy any text
--          the old app wrote there after migration 100's backfill into notes,
--          then drop the column. Nothing else changes.
-- Kind: schema change, with a one-off data copy. Apply once.
-- Applied: NO — awaiting Alex.
-- Progress: docs/restructure-p2-progress.md.
--
-- 🛑 ORDER. Run this ONLY after the restructure_p2-q7m branch is merged and
-- Vercel has deployed it. Until then the live app still writes
-- executions.notes, and a note typed between this migration and the deploy
-- would hit a column that no longer exists.
--
-- Run the PRE-CHECK below first: it lists any database function or view that
-- still mentions the column. The drop has no CASCADE on purpose — if anything
-- depends on the column, the drop fails and nothing is applied.

begin;

-- 1. Copy late text. Same shape as 100's backfill: one note on the execution's
--    intention, execution_id set, the execution's owner as author. Skipped when
--    a note with the same execution_id and body already exists.
insert into public.notes (user_id, target_type, target_id, body, execution_id, created_at, updated_at)
select x.user_id, 'intention', x.intent_id, x.notes, x.id,
       coalesce(x.started_at, x.created_at, now()),
       coalesce(x.closed_at, x.updated_at, now())
  from public.executions x
 where nullif(btrim(x.notes), '') is not null
   and exists (select 1 from public.intents t where t.id = x.intent_id)
   and not exists (
         select 1 from public.notes n
          where n.execution_id = x.id
            and btrim(n.body) = btrim(x.notes));

-- 2. Drop the column. No CASCADE.
alter table public.executions drop column notes;

commit;

-- Then run: check_platform_conformance (expect CONFORMANT, 52 tables).

-- ============================================================================
-- PRE-CHECK — run BEFORE the migration. Read-only. Paste back the one cell.
-- Expect: dependent_views [], functions_mentioning_notes lists only functions
-- that read public.notes (platform_search_items, platform_search_executions,
-- alfred_recent_completions, notes_delete_for_target), none reading x.notes.
-- ============================================================================
-- select json_build_object(
--   'dependent_views', (select coalesce(json_agg(t), '[]'::json) from (
--     select distinct v.table_schema, v.view_name
--       from information_schema.view_column_usage v
--      where v.table_schema = 'public' and v.table_name = 'executions' and v.column_name = 'notes') t),
--   'functions_mentioning_notes', (select coalesce(json_agg(t), '[]'::json) from (
--     select p.proname
--       from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
--      where ns.nspname in ('public', 'platform')
--        and p.prosrc ilike '%executions%' and p.prosrc ilike '%notes%'
--      order by 1) t),
--   'late_text_to_copy', (select coalesce(json_agg(t), '[]'::json) from (
--     select x.id as execution_id, x.status, left(x.notes, 80) as notes_start
--       from executions x
--      where nullif(btrim(x.notes), '') is not null
--        and not exists (select 1 from notes n where n.execution_id = x.id and btrim(n.body) = btrim(x.notes))) t),
--   -- Late text whose owner already has a DIFFERENT note on that run (edited in
--   -- the new app): copying would give them two. Expect []; if not, decide first.
--   'would_duplicate', (select coalesce(json_agg(t), '[]'::json) from (
--     select x.id as execution_id, left(x.notes, 80) as old_text, left(n.body, 80) as current_note
--       from executions x join notes n on n.execution_id = x.id and n.user_id = x.user_id
--      where nullif(btrim(x.notes), '') is not null
--        and btrim(n.body) <> btrim(x.notes)) t)
-- ) as result;
--
-- ============================================================================
-- VERIFICATION — run AFTER the migration. Read-only. Paste back the one cell.
-- Expect: column_still_there [], two_notes_same_author_same_run [],
-- conformance_failures [].
-- ============================================================================
-- select json_build_object(
--   'column_still_there', (select coalesce(json_agg(t), '[]'::json) from (
--     select column_name from information_schema.columns
--      where table_schema = 'public' and table_name = 'executions' and column_name = 'notes') t),
--   'execution_notes_in_notes', (select coalesce(json_agg(t), '[]'::json) from (
--     select count(*) as notes_with_execution, count(distinct execution_id) as executions_with_notes
--       from notes where execution_id is not null) t),
--   'two_notes_same_author_same_run', (select coalesce(json_agg(t), '[]'::json) from (
--     select execution_id, user_id, count(*) from notes
--      where execution_id is not null group by 1, 2 having count(*) > 1) t),
--   'conformance_failures', (select coalesce(json_agg(t), '[]'::json) from (
--     select * from platform.conformance_failures) t)
-- ) as result;
