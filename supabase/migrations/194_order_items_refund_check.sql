-- Purpose: Warren Buffet Phase 4, Step 8c (run tag warren_buffet_p4-r6d-s8c-g7lw; spec P4-D7). Fixes wb_order_items_refund_check from 193: a refund_date with no refunded_amount came out NULL, and a check lets NULL through.
-- Kind: schema change (one replaced check constraint)
-- Applied: NO
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p4-r6d.md P4-D7.
-- Run as one block, then supabase/tests/warren_buffet_p4/3_orders_tests.sql; the conformance result at the end must be conformant true.
-- supabase/migrations/194_order_items_refund_check.sql

begin;

alter table public.wb_order_items drop constraint if exists wb_order_items_refund_check;
alter table public.wb_order_items add constraint wb_order_items_refund_check check (
  (refunded_amount is null and refund_date is null)
  or (refunded_amount is not null and refunded_amount > 0 and refund_date is not null));

commit;

-- Conformance: this is the result the SQL editor shows. Expect conformant true and failures [].
select json_build_object(
  'conformant', (select count(*) = 0 from platform.conformance_failures),
  'failures', (select coalesce(json_agg(t), '[]'::json) from (select * from platform.conformance_failures) t)
) as result;
