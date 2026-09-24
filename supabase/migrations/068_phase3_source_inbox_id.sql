-- 068_phase3_source_inbox_id.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- Alfred Clipboard, Phase 3 Step 13: `source_inbox_id` on items, intents and
-- events, so a record created from a capture can say where it came from.
--
-- Spec: docs/technical-spec-clipboard.md section 5, Phase 3 decision F. The
-- investigation behind it is in docs/progress-clipboard.md.
--
-- ---------------------------------------------------------------------------
-- WHAT IS BROKEN TODAY
-- ---------------------------------------------------------------------------
--
-- `handleInboxSave` (src/Alfred.jsx:3062-3208) writes up to four records from one
-- capture and then HARD-DELETES the inbox row. Every field each record receives
-- is enumerated in that function and not one of them is the capture or its id, so
-- nothing anywhere records that an item, intention or event came from the inbox
-- at all.
--
-- The capture's text survives in exactly one place: the triage form pre-fills
-- `itemName` and `intentText` from it, so if Alex leaves the pre-fill alone the
-- text lands in `items.name` or `intents.text` — AS A TITLE. Anything longer than
-- a title (a forwarded email's body, a paragraph of context, the reason he
-- captured it) goes into a field whose job is to name the record, is replaced by
-- whatever he types, and is gone. After the delete it exists only in
-- platform.audit_log: recoverable by a person with SQL access, invisible to the
-- app and to Claude, and not associated with whatever the capture became.
--
-- ---------------------------------------------------------------------------
-- 🛑 THIS COLUMN DOES NOTHING USEFUL UNTIL STEP 14 LANDS
-- ---------------------------------------------------------------------------
--
-- ON DELETE SET NULL plus a triage path that hard-deletes means every link would
-- be nulled moments after it was written. The feature would look implemented and
-- record nothing.
--
-- Step 14 changes `handleInboxSave` to archive with archive_reason 'processed'
-- instead of deleting, AND to set this column — deliberately one change, because
-- either half alone is useless or misleading. This migration is safe to apply on
-- its own (the column simply stays null everywhere), but do not conclude anything
-- from a null until Step 14 is deployed.
--
-- ---------------------------------------------------------------------------
-- WHY text, AND WHY SET NULL
-- ---------------------------------------------------------------------------
--
-- `text` because `public.inbox.id` is text — Alfred's original tables use text
-- ids, unlike the newer uuid ones. A uuid column could not reference that key.
--
-- ON DELETE SET NULL, and neither alternative is acceptable:
--   CASCADE  would delete the ITEM when its inbox row went. An inbox row is a
--            scrap of captured text; the item is the thing Alex actually keeps.
--            Cascading from the lesser record to the greater one destroys real
--            data to tidy up a pointer.
--   RESTRICT would make a triaged inbox row undeletable, which is worse than the
--            problem it prevents — and would break the discard path, which is
--            allowed to remove rows.
-- SET NULL degrades to "origin unknown", which is the truth once the row is gone.
--
-- ---------------------------------------------------------------------------
-- COLLECTIONS ARE DELIBERATELY LEFT OUT
-- ---------------------------------------------------------------------------
--
-- `collection_items` is a membership row rather than a record of its own: its
-- provenance is the item's, and the item now carries it.
--
-- ---------------------------------------------------------------------------
-- IT CANNOT BE BACKFILLED
-- ---------------------------------------------------------------------------
--
-- The association was never recorded. platform.audit_log holds deleted inbox rows
-- but says nothing about what each became, and matching on text similarity would
-- be guessing dressed as history. Every row that exists before this lands keeps a
-- null `source_inbox_id`, permanently. Nothing in this file attempts otherwise.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE
-- ============================================================

select json_build_object(
  'column_exists_yet', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public' and column_name = 'source_inbox_id'
      order by table_name
    ) t),
  'inbox_id_type', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name, format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a
      where a.attrelid = 'public.inbox'::regclass and a.attname = 'id'
        and not a.attisdropped
    ) t),
  'row_counts', (select coalesce(json_agg(t), '[]'::json) from (
      select (select count(*) from public.items)   as items,
             (select count(*) from public.intents) as intents,
             (select count(*) from public.events)  as events,
             (select count(*) from public.inbox)   as inbox
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- the three columns, their keys and their indexes
-- ============================================================
--
-- One loop rather than three copies, so the three tables cannot drift apart in a
-- later edit. Columns, constraints and indexes are each added only if absent, so
-- the whole file is safe to re-run.

do $$
declare
  t text;
begin
  foreach t in array array['items', 'intents', 'events']
  loop
    execute format(
      'alter table public.%I add column if not exists source_inbox_id text', t);

    if not exists (
      select 1 from pg_constraint
      where conrelid = format('public.%I', t)::regclass
        and conname = format('%s_source_inbox_id_fkey', t)
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (source_inbox_id) '
        'references public.inbox (id) on delete set null',
        t, format('%s_source_inbox_id_fkey', t));
    end if;

    -- Partial: the column is null on every row that did not come from a capture,
    -- which today is all of them and will always be most of them. Indexing those
    -- nulls would be dead weight on the tables Alfred reads most.
    execute format(
      'create index if not exists %I on public.%I (source_inbox_id) '
      'where source_inbox_id is not null',
      format('%s_source_inbox_idx', t), t);
  end loop;
end
$$;


-- ============================================================
-- STEP 2 -- column comments
-- ============================================================
--
-- Written out per table rather than generated in the loop above: a COMMENT is
-- documentation, and documentation assembled by string concatenation is the kind
-- nobody reads or updates.

comment on column public.items.source_inbox_id is
  'The public.inbox row this item was created from, or null when it was not '
  'created from a capture — which is true of almost every row and always will be. '
  'Set by the triage form (handleInboxSave). NOT BACKFILLABLE: the association '
  'was never recorded before migration 068, so every row predating it is null '
  'regardless of where it actually came from. '
  'ON DELETE SET NULL, because cascading from a scrap of captured text to the '
  'item Alex actually keeps would destroy real data to tidy up a pointer. '
  '⚠️ ITEMS ARE SHAREABLE through a shared context, so a collaborator can read '
  'this id while being unable to read the inbox row it names. That is an opaque '
  'id and nothing more — but do not build a feature that shows it to anyone but '
  'the owner.';

comment on column public.intents.source_inbox_id is
  'The public.inbox row this intention was created from, or null when it was not '
  'created from a capture. Set by the triage form (handleInboxSave). '
  'Not backfillable — see the same column on public.items. '
  'ON DELETE SET NULL: losing the capture must never delete the intention.';

comment on column public.events.source_inbox_id is
  'The public.inbox row this event was created from, or null when it was not '
  'created from a capture. Set by the triage form (handleInboxSave) when a '
  'capture is triaged straight onto a date. '
  'The event''s intention carries the same value, so this is redundant for an '
  'event created alongside one — kept anyway, because an event reached from the '
  'calendar should answer "where did this come from" without a join. '
  'ON DELETE SET NULL: losing the capture must never delete the event.';


-- ============================================================
-- STEP 3 -- conformance. MUST still say CONFORMANT.
-- ============================================================
--
-- No register_table call: items, intents and events were all registered on
-- 2026-07-24 and adding a column does not re-register a table. This is here
-- because the contract says every migration that touches schema ends with the
-- check.

select public.platform_check_conformance();


-- ============================================================
-- STEP 4 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  -- pg_attribute, not information_schema: col_description needs the real attnum,
  -- and ordinal_position equals attnum only on a table that has never had a
  -- column dropped. Reading a comment off the wrong column would be a silently
  -- misleading verification.
  'new_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable,
             col_description(a.attrelid, a.attnum) is not null as has_comment
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where a.attrelid in ('public.items'::regclass, 'public.intents'::regclass,
                           'public.events'::regclass)
        and a.attname = 'source_inbox_id'
        and not a.attisdropped
      order by c.relname
    ) t),
  'foreign_keys', (select coalesce(json_agg(t), '[]'::json) from (
      select conrelid::regclass::text as table_name, conname,
             pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname like '%source_inbox_id_fkey'
      order by conrelid::regclass::text
    ) t),
  'indexes', (select coalesce(json_agg(t), '[]'::json) from (
      select tablename, indexname, indexdef from pg_indexes
      where schemaname = 'public' and indexname like '%source_inbox_idx'
      order by tablename
    ) t),
  -- Every existing row untouched. Nothing in this file backfills, and nothing
  -- can: see the header.
  'all_nulls_as_expected', (select coalesce(json_agg(t), '[]'::json) from (
      select (select count(*) from public.items   where source_inbox_id is not null) as items_linked,
             (select count(*) from public.intents where source_inbox_id is not null) as intents_linked,
             (select count(*) from public.events  where source_inbox_id is not null) as events_linked
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
