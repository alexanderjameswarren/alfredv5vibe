-- Purpose: Restructure P0 fix 1. Foreign keys from intents, items and events context_id to contexts(id), on delete set null. An item id once landed in a context field and nothing caught it.
-- Kind: schema change (data fix-up, then three FKs)
-- Applied: YES — 2026-10-06 by Alex. Three FKs convalidated, 0 orphans; conformance CONFORMANT (45 tables).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md). Numbering is
-- the order files were ADDED here. Alex runs every file himself.
--
-- Checked 2026-10-06: every column is text, no FK to contexts existed, no empty
-- strings. Ten rows pointed at two dead context ids (mllfgqu1n8z7oyqcccf,
-- mltvsb5nl3zp275wegp): 3 archived intents, 4 archived events, and 3 live items —
-- February test rows "private item", "first item" and "second tem".
-- Run as one block in the SQL editor.
-- supabase/migrations/087_restructure_p0_context_id_fks.sql

begin;

-- ============================================================================
-- A. Null every context_id that does not resolve
-- ============================================================================
update public.intents x set context_id = null
 where x.context_id is not null
   and not exists (select 1 from public.contexts c where c.id = x.context_id);

update public.items x set context_id = null
 where x.context_id is not null
   and not exists (select 1 from public.contexts c where c.id = x.context_id);

update public.events x set context_id = null
 where x.context_id is not null
   and not exists (select 1 from public.contexts c where c.id = x.context_id);

-- ============================================================================
-- B. The constraints. NOT VALID then VALIDATE keeps the lock on each table short.
-- ============================================================================
alter table public.intents drop constraint if exists intents_context_id_fkey;
alter table public.intents
  add constraint intents_context_id_fkey
  foreign key (context_id) references public.contexts(id) on delete set null not valid;
alter table public.intents validate constraint intents_context_id_fkey;

alter table public.items drop constraint if exists items_context_id_fkey;
alter table public.items
  add constraint items_context_id_fkey
  foreign key (context_id) references public.contexts(id) on delete set null not valid;
alter table public.items validate constraint items_context_id_fkey;

alter table public.events drop constraint if exists events_context_id_fkey;
alter table public.events
  add constraint events_context_id_fkey
  foreign key (context_id) references public.contexts(id) on delete set null not valid;
alter table public.events validate constraint events_context_id_fkey;

commit;

-- ============================================================================
-- Verify (read-only): expect three rows, all convalidated = true, and zero orphans.
-- ============================================================================
-- select json_build_object(
--   'fks', (select coalesce(json_agg(t), '[]'::json) from (
--     select conrelid::regclass::text as tbl, conname, convalidated, pg_get_constraintdef(oid) as def
--     from pg_constraint where contype = 'f' and confrelid = 'public.contexts'::regclass) t),
--   'orphans', (select coalesce(json_agg(t), '[]'::json) from (
--     select 'intents' as tbl, count(*) as n from public.intents x
--       where x.context_id is not null and not exists (select 1 from public.contexts c where c.id = x.context_id)
--     union all
--     select 'items', count(*) from public.items x
--       where x.context_id is not null and not exists (select 1 from public.contexts c where c.id = x.context_id)
--     union all
--     select 'events', count(*) from public.events x
--       where x.context_id is not null and not exists (select 1 from public.contexts c where c.id = x.context_id)) t)
-- ) as result;
