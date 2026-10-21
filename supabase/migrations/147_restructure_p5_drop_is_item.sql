-- Purpose: Restructure P5 Step 6 (restructure_p5-h7m). Drop intents.is_item, unread since Restructure P4 Step 1; its last reader, the ai-enrich function, was deleted in P5 Step 5. An intention's item link is item_id being set.
-- Kind: schema change (drop one column, update one comment)
-- Applied: YES — 2026-10-21 by Alex: conformant true, failures []; only is_intention left on intents; new comment in place.
--
-- No new tables, so no platform.register_table call. Run as one block in the SQL editor,
-- then the conformance query. Safe to re-run.
-- Nothing in the database reads the column: no view, index, trigger or function names it
-- (process_inbox_item's comment says so in words only).

begin;

alter table public.intents drop column if exists is_item;

comment on column public.intents.is_intention is
  'True = a thing to do. An intention''s link to an item is item_id being set (is_item was dropped in migration 147).';

commit;
