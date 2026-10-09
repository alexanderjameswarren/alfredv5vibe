-- Purpose: Warren Buffet Phase 2 Step 3. One-time processing of every posted transaction with wb_process_transactions (from 103), in chunks of 100, returning a summary.
-- Kind: one-off data repair (run once; safe to re-run, since processing is idempotent)
-- Applied: YES — 2026-10-09 by Alex: 394/394 in 4 batches, 16 pairs, 1 candidate. Re-run after 107: 394/394, 0 new pairs, 0 candidates.
--
-- All SQL lives in supabase/migrations/ (see .claude/CLAUDE.md).
-- Spec: docs/technical-spec-warren_buffet_p2-m4t.md section 5.
-- Pending rows are left for the sync, which processes every row with processed_at null.
-- Unprocessed counts are in the verification file: a subquery here would read the
-- snapshot from before these calls.
-- Run as one statement in the SQL editor, then 106_wb_phase2_verify_step3.sql.
-- supabase/migrations/105_wb_phase2_reprocess_all.sql

with ordered as (
  select x.id,
         row_number() over (order by coalesce(x.posted_at, x.transacted_at), x.id) as rn
  from public.wb_transactions x
  where not x.pending
),
batches as (
  select (rn - 1) / 100 as batch, array_agg(id order by rn) as ids
  from ordered
  group by 1
),
results as (
  select b.batch, cardinality(b.ids) as size, public.wb_process_transactions(b.ids) as r
  from batches b
)
select json_build_object(
  'batches',             count(*),
  'rows_sent',           sum(size),
  'processed',           sum((r ->> 'processed')::int),
  'paired',              sum((r ->> 'paired')::int),
  'transfer_candidates', sum((r ->> 'transfer_candidates')::int),
  'rule_tags',           sum((r ->> 'rule_tags')::int)
) as result
from results;
