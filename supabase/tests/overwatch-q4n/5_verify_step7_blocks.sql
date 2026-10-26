-- Overwatch Step 7 verification. Read-only. Run after the two-checkout test: main claims docs/overwatch-block-test.md,
-- overwatch-q4n is refused by check and by the guard, then main releases it. Paste back the single result cell.
-- Expected: one episode, waiter overwatch-q4n, holder main's code, repeat_count at least 1, cleared_at set.
-- supabase/tests/overwatch-q4n/5_verify_step7_blocks.sql

select json_build_object(
  'test_episode', (select coalesce(json_agg(t), '[]'::json) from (
      select waiter_code, holder_code, item, run_tag, blocked_at, last_seen_at, repeat_count, cleared_at, created_at
        from public.claim_blocks
       where item = 'docs/overwatch-block-test.md'
       order by blocked_at
    ) t),
  'all_rows', (select count(*) from public.claim_blocks),
  'conformance', (select public.platform_check_conformance())
) as result;
