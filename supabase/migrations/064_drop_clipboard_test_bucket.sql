-- 064_drop_clipboard_test_bucket.sql
--
-- ONE-OFF TEARDOWN. Apply once. Safe to re-run (idempotent, and does nothing
-- once the bucket is gone).
--
-- Removes the `clipboard-test` storage bucket left over from the clipboard
-- spike (2026-09-23). Its temporary read policy and the "CLIPBOARD TEST" inbox
-- item were already dealt with by hand in Step 1; the bucket itself had no
-- delete option Alex could find in the dashboard.
--
-- ---------------------------------------------------------------------------
-- WHAT THE CLI ALREADY REPORTS (checked 2026-09-23, before this file was run)
-- ---------------------------------------------------------------------------
--
--   supabase storage ls --linked --experimental
--     -> {"paths":["sam-audio/","sam-scores/"]}        <- no clipboard-test
--   supabase storage rm -r ss:///clipboard-test --linked --experimental
--     -> {"deleted":[],"buckets_deleted":[]}           <- nothing to remove
--
-- So the Storage API does not see the bucket, and it is likely already gone.
-- This file exists to confirm that against `storage.buckets`, which is the
-- authoritative record, and to remove a stale row if one survived. Expect Step
-- 1 to return empty and Step 3 to report nothing deleted. That is success, not
-- a failed run.
--
-- ---------------------------------------------------------------------------
-- 🛑 DO NOT `DELETE FROM storage.objects` TO EMPTY A BUCKET
-- ---------------------------------------------------------------------------
--
-- `storage.objects` is an INDEX of files, not the files. Deleting rows there
-- removes Supabase's knowledge of the objects while the bytes stay in the
-- backing store: unreachable, undeletable through any normal route, and still
-- counted against storage. The guard below therefore refuses to touch the
-- bucket row while object rows exist, and tells you the right tool instead:
--
--   npx supabase storage rm -r ss:///clipboard-test/ --linked --experimental
--
-- That goes through the Storage API and deletes the actual files.
--
-- Deleting the BUCKET row is a different matter and is fine here -- it is
-- metadata, and an empty bucket has no bytes behind it.
--
-- ---------------------------------------------------------------------------
-- IF THE DELETE IN STEP 2 IS BLOCKED
-- ---------------------------------------------------------------------------
--
-- Some Supabase projects restrict writes to the storage schema from the SQL
-- editor. If Step 2 raises a permissions error rather than reporting a count,
-- use one of these instead, in order of least friction:
--
--   1. Dashboard -> Storage. In the left-hand bucket list, hover `clipboard-test`
--      and open the three-dot menu -> "Delete bucket". This option is commonly
--      hidden until the bucket is EMPTY, which is the likely reason it could not
--      be found earlier. The bucket is empty now.
--
--   2. Storage API, from a terminal. Needs the service_role key from
--      Dashboard -> Project Settings -> API. Paste it into your own shell; it
--      does not need to be shared with anyone:
--
--        KEY='<service_role key>'
--        REF='zuqjyfqnvhddnchhpbcz'
--        curl -X POST "https://$REF.supabase.co/storage/v1/bucket/clipboard-test/empty" \
--          -H "Authorization: Bearer $KEY" -H "apikey: $KEY"
--        curl -X DELETE "https://$REF.supabase.co/storage/v1/bucket/clipboard-test" \
--          -H "Authorization: Bearer $KEY" -H "apikey: $KEY"
--
--      The `empty` call first is required: the API refuses to delete a bucket
--      that still holds objects.


-- ============================================================
-- STEP 1 -- what is actually there?
-- ============================================================

select json_build_object(
  'bucket_row', (select coalesce(json_agg(t), '[]'::json) from (
      select id, name, public, file_size_limit, allowed_mime_types, created_at
      from storage.buckets where id = 'clipboard-test'
    ) t),
  'object_rows', (select coalesce(json_agg(t), '[]'::json) from (
      select name, created_at,
             pg_size_pretty(coalesce((metadata->>'size')::bigint, 0)) as size
      from storage.objects where bucket_id = 'clipboard-test'
      order by name
    ) t),
  'object_row_count', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as objects,
             pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as total_size
      from storage.objects where bucket_id = 'clipboard-test'
    ) t),
  'leftover_policies', (select coalesce(json_agg(t), '[]'::json) from (
      select policyname, cmd, qual
      from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and (policyname ilike '%clipboard-test%'
          or coalesce(qual, '') like '%clipboard-test%')
    ) t),
  'all_buckets', (select coalesce(json_agg(t), '[]'::json) from (
      select id, public from storage.buckets order by id
    ) t)
) as result;


-- ============================================================
-- STEP 2 -- drop the bucket row, but ONLY if it holds no objects
-- ============================================================
--
-- The guard is the point of this block. If object rows exist, it raises instead
-- of deleting, because removing the bucket row while objects are indexed under
-- it would strand both the rows and the bytes.

do $$
declare
  v_bucket_exists boolean;
  v_object_count  integer;
begin
  select exists (select 1 from storage.buckets where id = 'clipboard-test')
    into v_bucket_exists;

  if not v_bucket_exists then
    raise notice 'clipboard-test: no bucket row. Nothing to do -- already gone.';
    return;
  end if;

  select count(*) into v_object_count
  from storage.objects where bucket_id = 'clipboard-test';

  if v_object_count > 0 then
    raise exception
      'clipboard-test still indexes % object(s). NOT deleting the bucket row. '
      'Empty it through the Storage API first, which deletes the real files: '
      'npx supabase storage rm -r ss:///clipboard-test/ --linked --experimental '
      '-- then re-run this file.', v_object_count;
  end if;

  delete from storage.buckets where id = 'clipboard-test';
  raise notice 'clipboard-test: empty bucket row deleted.';
end
$$;


-- ============================================================
-- STEP 3 -- confirm it is gone
-- ============================================================

select json_build_object(
  'clipboard_test_bucket_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select id from storage.buckets where id = 'clipboard-test'
    ) t),
  'clipboard_test_objects_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as objects from storage.objects where bucket_id = 'clipboard-test'
    ) t),
  'buckets_after', (select coalesce(json_agg(t), '[]'::json) from (
      select id, public, file_size_limit, allowed_mime_types
      from storage.buckets order by id
    ) t)
) as result;
