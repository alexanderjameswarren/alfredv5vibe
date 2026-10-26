-- Overwatch Step 5 cleanup. Deletes the one test run the claude.ai tool test writes (app drive_mix,
-- job overwatch_step5_test), and nothing else. Run after the tool test passes. Returns what it deleted.
-- supabase/tests/overwatch-q4n/2_cleanup_step5_test_run.sql

with gone as (
  delete from public.platform_runs
   where app = 'drive_mix' and job = 'overwatch_step5_test'
  returning id, app, job, status, started_at
)
select json_build_object(
  'deleted', (select coalesce(json_agg(t), '[]'::json) from (select * from gone) t)
) as result;
