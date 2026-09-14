-- ===========================================================================
-- MIGRATION B — tags on collection items
--
-- Adds a `text[]` tags column to `collection_items` and to
-- `collection_item_removals`. Nothing is dropped, no data is converted, no
-- existing column is touched.
--
-- Project:   docs/technical-spec-tags.md §7
-- Progress:  docs/progress-tags.md — Phase 5
-- Run:       BY HAND, in the Supabase SQL editor. Not via the CLI.
-- Written:   2026-09-14. Not run by Claude; no database was contacted.
-- ===========================================================================
--
-- ---------------------------------------------------------------------------
-- 1. THIS ONE IS SAFELY REVERSIBLE
-- ---------------------------------------------------------------------------
--
-- Unlike Migration A, nothing here destroys information. The rollback is:
--
--     begin;
--     alter table public.collection_items          drop column tags;
--     alter table public.collection_item_removals  drop column tags;
--     commit;
--
-- Safe to run right up until Phase 6 ships, because until then **nothing reads
-- these columns**. No frontend code, no Edge Function, no RPC. They sit empty
-- and inert. After Phase 6 a rollback would discard whatever tags had been
-- applied since — which is real data, but per-shopping-trip and ephemeral by
-- design, not history worth a restore.
--
-- A backup is not required for this one. Taking one costs nothing if you would
-- rather.
--
-- ---------------------------------------------------------------------------
-- 2. TRIGGERS — no guard needed. Two independent reasons.
-- ---------------------------------------------------------------------------
--
-- Migration A needed `disable trigger user` around its UPDATE, because that
-- statement wrote every tagged row and `set_updated_at` would have stamped
-- today onto all of them. That does not apply here.
--
-- **Reason 1 — there is no UPDATE.** `ALTER TABLE` is DDL. It does not fire
-- row-level triggers at all: not BEFORE UPDATE, not AFTER INSERT/UPDATE/DELETE.
-- Existing rows are never passed through a trigger, so neither `set_updated_at`
-- nor the generic `audit_row` trigger that `platform.register_table(p_audited
-- => true)` attaches can fire. This holds whether or not these two tables are
-- registered as audited, which is why it did not need looking up.
--
-- **Reason 2 — neither table has an `updated_at` column at all.** The six
-- tables carrying `set_updated_at` are the Alfred record tables, and the one
-- named in that set is `item_collections` — the collection itself — NOT
-- `collection_items`, which is the membership join table. Their columns are
-- `id, collection_id, item_id, quantity, position, added_at, added_by` and
-- `id, collection_id, item_id, item_name, quantity, position, reason,
-- removed_at, removed_by`. No `updated_at` on either, so `set_updated_at`
-- cannot be attached to them in the first place.
--
-- So: no `TRIGGER GUARD` lines in this file, deliberately. Verification query
-- V4 below confirms afterwards that every trigger is still enabled, in case
-- anything was left disabled by an earlier run of Migration A.
--
-- ---------------------------------------------------------------------------
-- 3. LOCKING — metadata-only, milliseconds, but it IS an exclusive lock
-- ---------------------------------------------------------------------------
--
-- Since PostgreSQL 11, `ADD COLUMN ... NOT NULL DEFAULT <constant>` does **not
-- rewrite the table**. The default is recorded once in `pg_attribute` as a
-- "missing value" and existing rows materialise it on read. Supabase is well
-- past 11, so the fast path applies. `'{}'::text[]` is a constant literal cast
-- — immutable, not volatile — which is the condition for that fast path. A
-- volatile default (`now()`, `gen_random_uuid()`) would force a full rewrite;
-- this one does not.
--
-- **What it still takes is an ACCESS EXCLUSIVE lock** on each table for the
-- duration of the statement. That blocks every read and write against that
-- table while held. Held for milliseconds here, because there is no rewrite —
-- the work is a catalogue update whose cost does not scale with row count.
--
-- At this data size it is not a consideration. The recorded backfill put five
-- membership rows across four collections; removals accumulate but this is a
-- shopping list, so hundreds at the outside. I cannot see live counts from
-- here, but the operation is O(1) in rows either way.
--
-- The one real risk is **lock queueing**, and it is not about size: if a
-- long-running statement already holds a lock on either table, the ALTER waits
-- behind it, and every new query queues behind the ALTER. Two mitigations,
-- both cheap:
--
--   * Do not run this while the collection detail view is open on your phone.
--     It polls every five seconds.
--   * The `set lock_timeout` below makes the migration give up after three
--     seconds rather than stalling the app behind a queue. If it trips,
--     nothing has changed — close the app and run it again.
--
-- ---------------------------------------------------------------------------
-- 4. NO INDEX — confirmed, not assumed
-- ---------------------------------------------------------------------------
--
-- Spec §7 says an index would earn nothing. Checked against what Phase 6 will
-- actually do, and it is right:
--
--   * The collection list's tag filter runs CLIENT-SIDE, over members already
--     in React state. It reuses `TagFilter`, which derives its pills and counts
--     from whatever array it is handed. No query is involved.
--   * `loadCollectionTagPool` (spec §9.4) selects the `tags` column filtered by
--     `collection_id` and ordered by `removed_at` — it never filters BY tag. A
--     GIN index on `tags` could not be used by it.
--
-- So no statement anywhere puts `tags` in a WHERE clause, and a GIN index
-- would be pure write-amplification on a table written during shopping.
--
-- If that ever changes — say a cross-collection "everything tagged tjs" search
-- done server-side — revisit it then:
--     create index idx_collection_items_tags on public.collection_items using gin (tags);
--
-- ---------------------------------------------------------------------------
-- 5. WHAT ELSE DOES NOT NEED DOING
-- ---------------------------------------------------------------------------
--
-- * **No RLS change.** Both tables already have policies and they are
--   row-level, keyed on the parent collection. Adding a column does not create
--   a gap: a column is visible exactly when its row is.
-- * **No `platform.register_table`.** Both tables were registered when they
--   were created. Registration is per table, not per column.
-- * **No re-run protection.** `add column` without `if not exists` is
--   deliberate: run this twice and the second run fails loudly inside the
--   transaction and rolls back, changing nothing. That is better than silently
--   succeeding and leaving you unsure which state you are in.
--
-- ===========================================================================


-- ===========================================================================
-- PRE-FLIGHT — confirms the columns are not already there.
-- Expect ZERO ROWS. If either appears, this migration has already run.
-- ===========================================================================
--
--   select table_name, column_name, udt_name
--     from information_schema.columns
--    where table_schema = 'public'
--      and column_name  = 'tags'
--      and table_name in ('collection_items', 'collection_item_removals');


begin;

-- Give up rather than stall the app behind a lock queue. Nothing has changed
-- if this trips; just close the app and run it again.
set local lock_timeout = '3s';

alter table public.collection_items
  add column tags text[] not null default '{}'::text[];

alter table public.collection_item_removals
  add column tags text[] not null default '{}'::text[];

commit;


-- ===========================================================================
-- VERIFICATION — run every one of these AFTER the commit.
-- ===========================================================================

-- V1. Both columns exist, both are text[], both NOT NULL, both default '{}'.
--     Expect exactly TWO rows. Per row: data_type = 'ARRAY',
--     udt_name = '_text', is_nullable = 'NO', and column_default displaying as
--         '{}'::text[]
select table_name, column_name, data_type, udt_name, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and column_name  = 'tags'
   and table_name in ('collection_items', 'collection_item_removals')
 order by table_name;

-- V2. Every existing row reads back as an empty array, not null.
--     Expect empties = total and nulls = 0 on both lines.
select 'collection_items' as source,
       count(*) as total,
       count(*) filter (where tags = '{}') as empties,
       count(*) filter (where tags is null) as nulls
  from public.collection_items
union all
select 'collection_item_removals',
       count(*),
       count(*) filter (where tags = '{}'),
       count(*) filter (where tags is null)
  from public.collection_item_removals;

-- V3. Nothing else moved. Compare against what you know: membership counts per
--     collection should be exactly what the app shows.
select c.name,
       count(ci.id) as members
  from public.item_collections c
  left join public.collection_items ci on ci.collection_id = c.id
 group by c.name
 order by c.name;

-- V4. Every trigger on both tables is still enabled. EXPECT tgenabled = 'O'
--     on every row returned, or zero rows if neither table has user triggers.
--     This is a guard against a half-finished Migration A having left one
--     disabled, not something this migration could have caused.
select c.relname as table_name, t.tgname, t.tgenabled
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relname in ('collection_items', 'collection_item_removals')
   and not t.tgisinternal
 order by c.relname, t.tgname;

-- V5. No index was created on either tags column — deliberate, see section 4.
--     Expect ZERO ROWS.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename in ('collection_items', 'collection_item_removals')
   and indexdef ilike '%tags%';

-- V6. Platform conformance. NOT SQL — run the `check_platform_conformance`
--     MCP tool from a chat thread. House rules say a migration is not done
--     until it returns CONFORMANT.
