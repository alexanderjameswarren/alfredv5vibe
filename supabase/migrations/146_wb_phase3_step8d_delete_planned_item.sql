-- Purpose: Warren Buffet Phase 3, Step 8d-1. wb_delete_planned_item: delete one planned item with all its matches (every status) in one transaction; its Not-needed skips go by cascade. Only the Money app calls it; there is no MCP delete tool, on purpose (A46). Transactions, splits and projects are never touched.
-- Kind: schema change (one new function)
-- Applied: YES — 2026-10-21 by Alex: conformant true, failures []; check_platform_conformance CONFORMANT, 68 tables; tests 12/12 (other user refused by RLS).
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p3-q5k.md A46.
-- A15: no number the help states is defined here; no help comments are due.
-- No real financial data in this file. Run as one block, then supabase/tests/warren_buffet_p3/1_delete_planned_item_tests.sql;
-- the conformance result at the end must be conformant true.
-- supabase/migrations/146_wb_phase3_step8d_delete_planned_item.sql

begin;

create or replace function public.wb_delete_planned_item(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_name      text;
  n_confirmed int;
  n_suggested int;
  n_rejected  int;
  n_skips     int;
begin
  -- Invoker, so RLS decides what is visible: another user's private item is "not found".
  select name into v_name from public.wb_planned_items where id = p_id for update;
  if not found then
    raise exception 'wb_delete_planned_item: no planned item % that you can see', p_id using errcode = '23503';
  end if;

  select count(*) filter (where status = 'confirmed'), count(*) filter (where status = 'suggested'),
         count(*) filter (where status = 'rejected')
  into n_confirmed, n_suggested, n_rejected
  from public.wb_planned_matches where planned_item_id = p_id;
  select count(*) into n_skips from public.wb_planned_skips where planned_item_id = p_id;

  -- Matches first (the item's foreign key is on delete restrict); skips cascade with the item.
  delete from public.wb_planned_matches where planned_item_id = p_id;
  delete from public.wb_planned_items where id = p_id;

  return jsonb_build_object('planned_item_id', p_id, 'name', v_name,
    'confirmed', n_confirmed, 'suggested', n_suggested, 'rejected', n_rejected, 'skips', n_skips);
end;
$$;

comment on function public.wb_delete_planned_item(uuid) is
  'Warren Buffet: delete one planned item and, in the same transaction, all its matches (confirmed, suggested and rejected); its Not-needed skips go by cascade. Returns planned_item_id, name and the counts removed (confirmed, suggested, rejected, skips). Confirmed matches removed send those payments back into the burn rate. Transactions, splits and projects are never touched. Security invoker, so RLS applies: an item the caller cannot see is refused and nothing changes. Called only by the Money app; there is no MCP delete tool (A46). The rows are audited.';

revoke all on function public.wb_delete_planned_item(uuid) from public, anon;
grant execute on function public.wb_delete_planned_item(uuid) to authenticated;

commit;

-- ============================================================================
-- Conformance: this is the result the SQL editor shows. Expect conformant
-- true and failures []. Then run supabase/tests/warren_buffet_p3/1_delete_planned_item_tests.sql.
-- ============================================================================
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
