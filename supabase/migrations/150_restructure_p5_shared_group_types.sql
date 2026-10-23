-- Purpose: Restructure P5 Step 11 follow-up (restructure_p5-h7m). Group types become shared across contexts: every context can use every type and only chooses its default (contexts.default_group_type_id, kept). group_types.context_id is dropped. Any signed-in user can READ every type (so Elise's shared Recipes context still finds Menu); only the owner can add, edit or delete one.
-- Kind: schema change (drop one column, replace one policy with four)
-- Applied: NO
--
-- Run as one block in the SQL editor, then supabase/tests/restructure_p5-h7m/step11_shared_group_types_verify.sql.
-- Safe to re-run. No new table, so no register_table call: group_types stays registered with
-- policy_mode 'none' (its policies are written here), RLS on, audited.
-- Dropped rather than left unused: the old policy reads context_id and is replaced anyway, and a
-- column that looks meaningful but is not would invite the next reader to filter by it.
-- A type a group uses cannot be deleted: item_groups.group_type_id is ON DELETE RESTRICT.

begin;

drop policy if exists group_types_access on public.group_types;
alter table public.group_types drop column if exists context_id;

comment on table public.group_types is
  'ALFRED. Restructure P5. What a group is called and how it executes: Menu/Menus (together), Project/Projects and Series/Series (separately), and any the user adds in Settings. Shared across contexts: a context only chooses its default (contexts.default_group_type_id). Every signed-in user reads every type; only the owner adds, edits or deletes. A type in use cannot be deleted (item_groups.group_type_id restricts).';

drop policy if exists group_types_read on public.group_types;
create policy group_types_read on public.group_types for select to authenticated
  using (true);

drop policy if exists group_types_insert on public.group_types;
create policy group_types_insert on public.group_types for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists group_types_update on public.group_types;
create policy group_types_update on public.group_types for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists group_types_delete on public.group_types;
create policy group_types_delete on public.group_types for delete to authenticated
  using (user_id = auth.uid());

commit;
