-- Purpose: Restructure P5 Step 14b (restructure_p5-h7m). executions.parent_execution_id: a recipe's execution inside a menu cook points at the menu's execution. Deleting the menu's execution deletes its recipe executions (on delete cascade); their notes go with them, and the last_completed triggers recompute on each delete.
-- Kind: schema change (one column, one index, one check) plus a one-off backfill
-- Applied: NO
--
-- Run as one block in the SQL editor, then supabase/tests/restructure_p5-h7m/step14b_parent_execution_verify.sql.
-- Safe to re-run. No new table, so no register_table call; conformance is unaffected.
-- The check keeps the shape: only a run with no intention (a recipe inside a menu) has a parent,
-- and never itself.
-- Backfill: the 14a matching rule. A recipe run (group_id set, intent_id null) gets the menu
-- run (same group_id, intent_id set) that closed at the same closed_at, or, while open, the open
-- menu run of that group. Expected to touch no rows after the 14a cleanup.

begin;

alter table public.executions
  add column if not exists parent_execution_id text references public.executions(id) on delete cascade;

comment on column public.executions.parent_execution_id is
  'Restructure P5. On a recipe''s execution inside a menu cook: the menu''s execution (group_id set, on the menu''s own intention). Null otherwise. Deleting the menu''s execution deletes these (cascade).';

create index if not exists idx_executions_parent on public.executions (parent_execution_id)
  where parent_execution_id is not null;

alter table public.executions drop constraint if exists executions_parent_is_recipe_run;
alter table public.executions add constraint executions_parent_is_recipe_run
  check (parent_execution_id is null or (intent_id is null and parent_execution_id <> id));

update public.executions r
   set parent_execution_id = m.id
  from public.executions m
 where r.parent_execution_id is null
   and r.group_id is not null
   and r.intent_id is null
   and m.group_id = r.group_id
   and m.intent_id is not null
   and (
     (r.status = 'closed' and m.status = 'closed' and m.closed_at = r.closed_at)
     or (r.status in ('active', 'paused') and m.status in ('active', 'paused'))
   );

commit;
