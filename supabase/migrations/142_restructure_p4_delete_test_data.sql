-- Purpose: Restructure P4 — delete the Phase 4 test data. One-off data cleanup, run once
-- by Alex after reading the listing (part 1). Not a schema change.
--
-- What is deleted (Alex reviewed the listing, 2026-10-19, and added the last five):
--   items    named 'p4 …' (any case); exactly 'SomeDay test 4', 'SomedayTest3',
--            'Someday4 test'; the item 'Someday test' (muydgf89leev5rai8z); and every item
--            in the three test contexts
--   intents  named the same way, plus exactly 'SomeDay test 4 no date'; 'Someday test'
--            (mv733wqdidgzw5zhvq) and 'Someday test two' (muydiy7l7eu32xyhrfl); every
--            intention on one of those items; and every intention in the three test contexts
--   contexts 'p4 archive test' (mv8ct4fnewneebt5vke), 'P4 archive test'
--            (mv89ojb86qpp3ks0i8j), 'Testing z' (muvmw4zofaq3h0t614s)
--   and everything attached: their events, executions, the notes on the intentions, items
--   and executions, reminders on the intentions, notification steps of the executions,
--   collection rows of the items.
-- One transaction: if anything still points at these rows (a foreign key with no
-- ON DELETE rule, e.g. a Warren Buffet table on a context), nothing is deleted.

-- ── Part 1: read-only listing. Run first, read, paste back the one cell. ─────────
-- (The same query is in the CLI report, uncommented.)

-- ── Part 2: the delete ───────────────────────────────────────────────────────────
begin;

create temp table p4_contexts on commit drop as
  select id from public.contexts
   where id in ('mv8ct4fnewneebt5vke', 'mv89ojb86qpp3ks0i8j', 'muvmw4zofaq3h0t614s');

create temp table p4_items on commit drop as
  select id from public.items
   where name ilike 'p4 %'
      or name in ('SomeDay test 4', 'SomedayTest3', 'Someday4 test')
      or id = 'muydgf89leev5rai8z'
      or context_id in (select id from p4_contexts);

create temp table p4_intents on commit drop as
  select id from public.intents
   where text ilike 'p4 %'
      or text in ('SomeDay test 4', 'SomeDay test 4 no date', 'SomedayTest3', 'Someday4 test')
      or id in ('mv733wqdidgzw5zhvq', 'muydiy7l7eu32xyhrfl')
      or context_id in (select id from p4_contexts)
      or item_id in (select id from p4_items);

create temp table p4_executions on commit drop as
  select id from public.executions where intent_id in (select id from p4_intents);

delete from public.notification_steps where execution_id in (select id from p4_executions);
delete from public.reminders where intent_id in (select id from p4_intents);
delete from public.notes
 where execution_id in (select id from p4_executions)
    or (target_type = 'intention' and target_id in (select id from p4_intents))
    or (target_type = 'item' and target_id in (select id from p4_items));
delete from public.executions where id in (select id from p4_executions);
delete from public.events where intent_id in (select id from p4_intents);
delete from public.intents where id in (select id from p4_intents);
delete from public.collection_items where item_id in (select id from p4_items);
delete from public.collection_item_removals where item_id in (select id from p4_items);
delete from public.items where id in (select id from p4_items);
delete from public.contexts where id in (select id from p4_contexts);

commit;
