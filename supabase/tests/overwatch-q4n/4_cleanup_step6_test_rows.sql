-- Overwatch Step 6 cleanup. Deletes only the test episodes the CLI sent (waiter overwatch-test-a), nothing else.
-- Run after 3_verify_claim_blocks.sql passes. Returns what it deleted.
-- supabase/tests/overwatch-q4n/4_cleanup_step6_test_rows.sql

with gone as (
  delete from public.claim_blocks
   where waiter_code = 'overwatch-test-a' and holder_code = 'overwatch-test-b'
  returning id, waiter_code, holder_code, item, repeat_count, cleared_at
)
select json_build_object(
  'deleted', (select coalesce(json_agg(t), '[]'::json) from (select * from gone) t)
) as result;
