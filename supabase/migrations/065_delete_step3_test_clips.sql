-- 065_delete_step3_test_clips.sql
--
-- ONE-OFF DATA CLEANUP. Apply once. Safe to re-run (idempotent).
--
-- 🛑 DO NOT RUN THIS UNTIL STEP 5'S VERIFICATION HAS PASSED. These two clips are
-- the fixtures every step from 3 to 5 has been tested against, and there is
-- nothing else in the clips table yet. Once Step 6 puts real clipped pages in,
-- they stop being needed.
--
-- Removes the two synthetic clips created by the Step 3 endpoint tests on
-- 2026-09-23, and their paired inbox rows:
--
--   clipboard  14746114-3a4d-44a1-909f-11d7157c255a  "Curl test clip"
--              inbox d680b849-2a88-4d52-89df-3f38ec732655
--              2 slices, 1x1 test pixels
--   cli        466a3631-de46-4de8-a0a0-edeb068ed24b  "Step 3 report"
--              inbox 4800354b-3525-4672-94eb-df4c43c1c30d
--              no slices
--
-- ---------------------------------------------------------------------------
-- THE SLICE FILES ARE NOT DELETED BY THIS FILE
-- ---------------------------------------------------------------------------
--
-- `storage.objects` is an index of files, not the files (same warning as 064).
-- Deleting rows from it strands the bytes. The two 1x1 JPEGs come out through
-- the Storage API instead:
--
--   npx supabase storage rm -r \
--     ss:///clipboard/26f0707f-b586-4a3e-841c-8c313d6ab1e5/14746114-3a4d-44a1-909f-11d7157c255a/ \
--     --linked --experimental
--
-- Claude runs that alongside this file. Order does not matter: a clip row
-- pointing briefly at removed files, or two orphaned files pointing at nothing,
-- are both transient states of the same teardown.
--
-- ---------------------------------------------------------------------------
-- THE AUDIT LOG KEEPS A COPY, AND THAT IS EXPECTED
-- ---------------------------------------------------------------------------
--
-- `clips` is registered audited, so `platform.audit_log` already holds a row
-- copy of each of these and the DELETE adds another entry. That is the cost
-- flagged in 063's header — deleting a clip does not reclaim its audit copy.
-- For two synthetic test rows it does not matter. It is worth remembering when
-- the 2026-10-23 storage review looks at real clips.
--
-- Inbox rows are deleted rather than archived, matching what human triage does
-- in the app: a capture that does not make it through never happened.


-- ============================================================
-- STEP 1 -- BEFORE PICTURE. Confirm these are the only clips.
-- ============================================================

select json_build_object(
  'all_clips', (select coalesce(json_agg(t), '[]'::json) from (
      select id, source, title, slice_count, inbox_id, created_at
      from public.clips order by created_at
    ) t),
  'the_two_inbox_rows', (select coalesce(json_agg(t), '[]'::json) from (
      select id, source_type, captured_text, archived, triaged_at
      from public.inbox
      where id in ('d680b849-2a88-4d52-89df-3f38ec732655',
                   '4800354b-3525-4672-94eb-df4c43c1c30d')
    ) t),
  'slice_objects', (select coalesce(json_agg(t), '[]'::json) from (
      select name from storage.objects
      where bucket_id = 'clipboard' order by name
    ) t)
) as result;


-- ============================================================
-- STEP 2 -- delete, children first
-- ============================================================
--
-- Clips before inbox rows. There is no foreign key either way (063 explains
-- why), so the order is not enforced and is chosen only so that nothing is left
-- pointing at a row that has gone: a clip whose inbox_id dangles is the normal
-- state this schema tolerates, whereas an inbox row whose clip has vanished is
-- an item Alex could open and find empty.

delete from public.clips
where id in ('14746114-3a4d-44a1-909f-11d7157c255a',
             '466a3631-de46-4de8-a0a0-edeb068ed24b');

delete from public.inbox
where id in ('d680b849-2a88-4d52-89df-3f38ec732655',
             '4800354b-3525-4672-94eb-df4c43c1c30d');


-- ============================================================
-- STEP 3 -- AFTER PICTURE. Both lists should be empty.
-- ============================================================

select json_build_object(
  'clips_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select id, source, title from public.clips order by created_at
    ) t),
  'test_inbox_rows_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select id, captured_text from public.inbox
      where id in ('d680b849-2a88-4d52-89df-3f38ec732655',
                   '4800354b-3525-4672-94eb-df4c43c1c30d')
    ) t),
  'clipboard_inbox_rows_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select id, source_type, captured_text from public.inbox
      where source_type in ('clipboard', 'cli') order by created_at
    ) t),
  'slice_objects_remaining', (select coalesce(json_agg(t), '[]'::json) from (
      select name from storage.objects
      where bucket_id = 'clipboard' order by name
    ) t)
) as result;
