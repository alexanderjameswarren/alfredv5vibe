-- Overwatch Step 7 cleanup. Deletes only the test episode for docs/overwatch-block-test.md, nothing else.
-- Run after 5_verify_step7_blocks.sql passes. Returns what it deleted.
-- supabase/tests/overwatch-q4n/6_cleanup_step7_test_rows.sql

with gone as (
  delete from public.claim_blocks
   where item = 'docs/overwatch-block-test.md'
  returning id, waiter_code, holder_code, item, repeat_count, cleared_at
)
select json_build_object(
  'deleted', (select coalesce(json_agg(t), '[]'::json) from (select * from gone) t)
) as result;
