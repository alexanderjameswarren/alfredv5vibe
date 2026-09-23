-- 066_inbox_archive_reason.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- Alfred Clipboard, Step 5b: `inbox.archive_reason`, so an archived row says
-- WHY it left the inbox.
--
-- ---------------------------------------------------------------------------
-- WHY THIS COLUMN EXISTS NOW, AND THE BUG THAT FORCED IT
-- ---------------------------------------------------------------------------
--
-- Until Step 4 the inbox had exactly one disposal: the trash can hard-deleted
-- the row, because a capture that did not make it through never happened.
-- `archived` and `triaged_at` sat written by nothing.
--
-- Clips broke that, because a clip is TWO rows. `public.clips` holds the page
-- text and the slices; the inbox row is a lightweight pointer at it. Trashing
-- the inbox card deleted the pointer and left the clip, and `get_recent_clips`
-- judges "already handled" by reading the paired inbox row -- so a clip whose
-- inbox row had been deleted looked LIVE and kept coming back to every new
-- conversation, permanently. Discarding a clip was the one action that could not
-- make it go away.
--
-- So the trash can now ARCHIVES (spec decision 14), and there are two different
-- reasons a row can be archived that must not be confused:
--
--   'discarded'  Alex binned it from the inbox screen. Not wanted.
--   'processed'  Claude handled it and tidied up after itself
--                (archive_inbox_item).
--
-- Both leave the inbox screen and both are reversible. The difference matters
-- for Phase 3's "recently archived" panel, which is meant to show where each
-- item went -- and "you threw this away" and "this was dealt with" are not the
-- same sentence.
--
-- ---------------------------------------------------------------------------
-- TWO CONSTRAINTS, AND THE SECOND IS AN ADDITION
-- ---------------------------------------------------------------------------
--
-- `inbox_archive_reason_check` allows null, 'discarded' or 'processed'. Asked
-- for.
--
-- `inbox_archive_reason_needs_archived` is NOT asked for and is added
-- deliberately, modelled on `job_applications_due_needs_action` in this same
-- schema, which exists for the identical shape of problem: a dependent field
-- that is meaningless without its parent flag. A reason without `archived` would
-- be a row that reads as dispositioned while it sits in the inbox, which is the
-- kind of state that produces a bug report nobody can reproduce. Every writer
-- today satisfies it -- the trash can and archive_inbox_item both set the pair
-- together, and archive_inbox_item clears the pair together. Drop it if it ever
-- gets in the way; it is one line.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE
-- ============================================================

select json_build_object(
  'archive_reason_exists_yet', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'inbox'
        and column_name = 'archive_reason'
    ) t),
  'inbox_constraints', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = 'public.inbox'::regclass
      order by conname
    ) t),
  'archived_rows_today', (select coalesce(json_agg(t), '[]'::json) from (
      select count(*) as total,
             count(*) filter (where archived is true) as archived_true,
             count(*) filter (where triaged_at is not null) as triaged
      from public.inbox
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- the column
-- ============================================================

alter table public.inbox
  add column if not exists archive_reason text;

comment on column public.inbox.archive_reason is
  'WHY this row was archived, or null while it is still in the inbox. '
  '''discarded'' = Alex binned it from the inbox screen with the trash can. '
  '''processed'' = it was handled and tidied away, by archive_inbox_item from a '
  'Claude conversation. Both are reversible and neither deletes anything. '
  'Set together with archived and triaged_at, and cleared together with them on '
  'un-archive (inbox_archive_reason_needs_archived enforces the pairing). '
  'Read by Phase 3''s "recently archived" panel, which shows where each item '
  'went -- "you threw this away" and "this was dealt with" are different '
  'sentences. NOTE the remaining hard-delete: triage through the app''s '
  'process/save flow still DELETES the row on success, so a processed capture '
  'from that path has no row and therefore no reason. Phase 3''s process button '
  'is meant to archive with ''processed'' instead.';


-- ============================================================
-- STEP 2 -- the constraints
-- ============================================================
--
-- Added separately from the column so a re-run of this file does not fail on an
-- already-present constraint.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inbox'::regclass and conname = 'inbox_archive_reason_check'
  ) then
    alter table public.inbox
      add constraint inbox_archive_reason_check
      check (archive_reason is null or archive_reason in ('discarded', 'processed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inbox'::regclass and conname = 'inbox_archive_reason_needs_archived'
  ) then
    alter table public.inbox
      add constraint inbox_archive_reason_needs_archived
      check (archive_reason is null or archived is true);
  end if;
end
$$;


-- ============================================================
-- STEP 3 -- conformance. MUST still say CONFORMANT.
-- ============================================================
--
-- No register_table call: public.inbox was registered on 2026-07-24 and adding
-- a column does not re-register a table. This is here because the contract says
-- every migration that touches schema ends with the check.

select public.platform_check_conformance();


-- ============================================================
-- STEP 4 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  'archive_reason_column', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable, column_default,
             col_description('public.inbox'::regclass, ordinal_position::int) as comment
      from information_schema.columns
      where table_schema = 'public' and table_name = 'inbox'
        and column_name = 'archive_reason'
    ) t),
  'new_constraints', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.inbox'::regclass
        and conname like 'inbox_archive_reason%'
      order by conname
    ) t),
  'archive_reason_spread', (select coalesce(json_agg(t), '[]'::json) from (
      select archive_reason, archived, count(*) as rows
      from public.inbox group by archive_reason, archived order by 3 desc
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
