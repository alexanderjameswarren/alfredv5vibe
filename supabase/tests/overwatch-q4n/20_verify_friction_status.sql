-- Overwatch Step 25 check, after 176 and the test. Read-only. Paste back the single result cell.
-- Expected: by_status open (and fixed only if any were resolved), none inconsistent; the three new checks; the open
-- index on status = 'open'; test_rows_left 0; conformance CONFORMANT.
-- supabase/tests/overwatch-q4n/20_verify_friction_status.sql

select json_build_object(
  'by_status', (select coalesce(json_agg(t), '[]'::json) from (
      select status, count(*) as entries, count(*) filter (where wont_fix_reason is not null) as with_reason
        from public.process_friction group by status order by status) t),
  'inconsistent_rows', (select count(*) from public.process_friction where (status = 'open') <> (resolved_at is null)),
  'checks', (select coalesce(json_agg(t), '[]'::json) from (
      select conname from pg_constraint where conrelid = 'public.process_friction'::regclass and contype = 'c' order by 1) t),
  'open_index', (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'process_friction_open_idx'),
  'test_rows_left', (select count(*) from public.process_friction where what_happened like 'TEST ow25 %'),
  'conformance', (select public.platform_check_conformance())
) as result;
