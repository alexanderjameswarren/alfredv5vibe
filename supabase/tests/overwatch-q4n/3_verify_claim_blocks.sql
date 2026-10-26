-- Overwatch Step 6 verification. Read-only. Run after the CLI has sent its test events to overwatch-ingest
-- (waiter overwatch-test-a, holder overwatch-test-b). Paste back the single result cell.
-- Expected: one episode, item docs/overwatch-test.md, run_tag overwatch-test-a-s1-zz00, blocked_at 20:00 UTC,
-- repeat_count 2 (the wrong-secret repeat never counted), last_seen_at and cleared_at both 20:03 UTC (the clear),
-- same_user_as_clips true.
-- supabase/tests/overwatch-q4n/3_verify_claim_blocks.sql

select json_build_object(
  'test_episodes', (select coalesce(json_agg(t), '[]'::json) from (
      select waiter_code, holder_code, item, run_tag, blocked_at, last_seen_at, repeat_count, cleared_at,
             user_id = (select c.user_id from public.clips c order by c.created_at desc limit 1) as same_user_as_clips
        from public.claim_blocks
       where waiter_code = 'overwatch-test-a'
       order by blocked_at
    ) t),
  'all_rows', (select count(*) from public.claim_blocks),
  'conformance', (select public.platform_check_conformance())
) as result;
