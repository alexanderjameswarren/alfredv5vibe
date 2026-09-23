-- 067_phase2_job_posting_url_duplicate_of_and_clips_links_truncated.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- Alfred Clipboard, Phase 2 Step 9. Three columns across two tables:
--
--   job_applications.posting_url   where the posting lives
--   job_applications.duplicate_of  this row is another copy of that one
--   clips.links_truncated          the link list was cut at 1,000
--
-- Spec: docs/technical-spec-clipboard.md section 3.4, plus the links_truncated
-- gap recorded against Step 3 and deferred here on purpose (see below).
--
-- ⚠️ TOOLS ARE NOT TOUCHED BY THIS FILE. Step 10 teaches
-- create_job_application and update_job_application to accept the two new job
-- columns, makes get_job_application_sources exclude duplicates, and has
-- clip-capture set links_truncated from the links_dropped it already computes.
-- Until Step 10 deploys, all three columns simply sit at their defaults, which
-- is why this can be applied on its own without breaking anything.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE
-- ============================================================

select json_build_object(
  'job_applications_columns_today', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'job_applications'
      order by ordinal_position
    ) t),
  'job_applications_constraints_today', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = 'public.job_applications'::regclass
      order by conname
    ) t),
  'clips_has_links_truncated_yet', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'clips'
        and column_name = 'links_truncated'
    ) t),
  'row_counts', (select coalesce(json_agg(t), '[]'::json) from (
      select (select count(*) from public.job_applications) as job_applications,
             (select count(*) from public.clips)            as clips
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- job_applications.posting_url
-- ============================================================

alter table public.job_applications
  add column if not exists posting_url text;

comment on column public.job_applications.posting_url is
  'Where the posting lives, when it is known. Null for roles logged from a warm '
  'intro, a conversation, or anywhere without a page. '
  '⚠️ DELIBERATELY NOT UNIQUE, and job_applications_posting_url_idx is a plain '
  'index for lookup rather than a constraint. The same address can legitimately '
  'appear on more than one row: the duplicate_of mechanism EXISTS to record that '
  'Alex engaged with one posting twice, so forbidding it would forbid the thing '
  'the next column is for. It also must not block a re-application to a role '
  'that was reposted at the same address a year later.';

-- Partial, because the column is null on most rows and an index entry for each
-- of those would be dead weight. (user_id, posting_url) rather than posting_url
-- alone so the lookup a tool actually performs -- "have I already got this
-- posting?" -- is answered from the index without a filter step.
create index if not exists job_applications_posting_url_idx
  on public.job_applications (user_id, posting_url)
  where posting_url is not null;


-- ============================================================
-- STEP 2 -- job_applications.duplicate_of
-- ============================================================
--
-- ON DELETE SET NULL, matching sam_songs.parent_song_id and for the same
-- reason: deleting the main row must not destroy the copies, which carry their
-- own dates, notes and statuses. An orphaned duplicate reads as a main row,
-- which is the least-wrong outcome available -- a cascade would silently delete
-- history, and a restrict would make the main row undeletable.

alter table public.job_applications
  add column if not exists duplicate_of uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_applications'::regclass
      and conname = 'job_applications_duplicate_of_fkey'
  ) then
    alter table public.job_applications
      add constraint job_applications_duplicate_of_fkey
      foreign key (duplicate_of) references public.job_applications (id)
      on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_applications'::regclass
      and conname = 'job_applications_duplicate_of_not_self'
  ) then
    alter table public.job_applications
      -- Spec 3.4 writes this as `duplicate_of <> id`. `IS DISTINCT FROM` is the
      -- same constraint for every possible input -- the two differ only when one
      -- side is NULL, and there both permit the row (a NULL `<>` yields NULL,
      -- which a CHECK treats as satisfied; `id` is a primary key and never NULL).
      -- Written the explicit way because a constraint that evaluates to NULL and
      -- passes *because* of how CHECK handles NULL is a thing readers have to
      -- work out, and this one does not need working out.
      add constraint job_applications_duplicate_of_not_self
      check (duplicate_of is distinct from id);
  end if;
end
$$;

comment on column public.job_applications.duplicate_of is
  'Set when this row is another copy of an application already recorded, and '
  'points at the MAIN row. Null on a main row, which is almost all of them. '
  'Spec decision 13: duplicates are LINKED, NOT REMOVED -- each copy keeps its '
  'own applied_on, source, effort and notes, because "I applied to this twice, '
  'through two different job boards" is a fact worth keeping and is exactly what '
  'the per-source report needs in order to be honest. '
  '⚠️ NO CHAINS, AND THAT RULE IS ENFORCED BY THE TOOL, NOT HERE. A duplicate '
  'must always point at a main row, never at another duplicate. A CHECK cannot '
  'express it -- it would have to read another row -- so it would need a '
  'trigger, and a trigger for an invariant only update_job_application can '
  'violate is more machinery than the rule is worth. If chains ever appear, that '
  'is a tool bug; see the guard in _shared/tools/job-applications.ts. '
  'ON DELETE SET NULL: deleting a main row leaves its duplicates standing as '
  'main rows rather than destroying them. '
  'get_job_application_sources excludes rows where this is not null, so a '
  'duplicate never inflates a source''s total (Step 10).';


-- ============================================================
-- STEP 3 -- clips.links_truncated
-- ============================================================
--
-- The gap this closes, recorded in the Step 3 notes: clip-capture caps the link
-- list at 1,000 and, unlike the page text, had nowhere to say so. page_text has
-- text_truncated; links had nothing, so a clipped job board with more than a
-- thousand links would quietly drop the excess and every reader would believe
-- the list was whole.
--
-- Deferred to here rather than added in Phase 1 because changing the agreed data
-- model mid-phase is a worse habit than carrying a known gap for a few days with
-- the gap written down. clip-capture already computes the number; Step 10 wires
-- it up.

alter table public.clips
  add column if not exists links_truncated boolean not null default false;

comment on column public.clips.links_truncated is
  'True when the page had more than 1,000 links and the excess was dropped by '
  'the capture function. The stored `links` array is then the FIRST 1,000, which '
  'are the ones nearest the top of the page. '
  'Set from the links_dropped figure clip-capture already computes; de-duplication '
  'is NOT truncation, so three links with two distinct addresses leave this false. '
  'Reads alongside text_truncated (the page text was cut at 1 MB) and '
  'screenshot_truncated (the screenshot does not show the whole page) -- three '
  'independent facts about three different parts of the same clip. '
  'If "Claude missed a listing on a huge job board" is ever reported, this is the '
  'first column to look at.';


-- ============================================================
-- STEP 4 -- conformance. MUST still say CONFORMANT.
-- ============================================================
--
-- No register_table call: public.job_applications was registered on 2026-09-22
-- and public.clips on 2026-09-23, and adding a column does not re-register a
-- table. This is here because the contract says every migration that touches
-- schema ends with the check.

select public.platform_check_conformance();


-- ============================================================
-- STEP 5 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  -- pg_attribute rather than information_schema.columns, because col_description
  -- wants the real attnum. `ordinal_position` equals attnum only on a table that
  -- has never had a column dropped, and reading the comment off the wrong column
  -- would be a silently misleading verification.
  'new_job_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable,
             pg_get_expr(d.adbin, d.adrelid) as column_default,
             col_description(a.attrelid, a.attnum) as comment
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.job_applications'::regclass
        and a.attname in ('posting_url', 'duplicate_of')
        and not a.attisdropped
      order by a.attname
    ) t),
  'new_job_constraints', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.job_applications'::regclass
        and conname like '%duplicate_of%'
      order by conname
    ) t),
  'posting_url_index', (select coalesce(json_agg(t), '[]'::json) from (
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'job_applications'
        and indexname = 'job_applications_posting_url_idx'
    ) t),
  'clips_links_truncated', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             not a.attnotnull as is_nullable,
             pg_get_expr(d.adbin, d.adrelid) as column_default,
             col_description(a.attrelid, a.attnum) as comment
      from pg_attribute a
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'public.clips'::regclass
        and a.attname = 'links_truncated'
        and not a.attisdropped
    ) t),
  -- Every existing row should be untouched: both job columns null, every clip
  -- false. Nothing in this file backfills, because there is nothing to infer --
  -- an old clip's links may or may not have been cut and we did not record it.
  'existing_rows_untouched', (select coalesce(json_agg(t), '[]'::json) from (
      select (select count(*) from public.job_applications
               where posting_url is not null or duplicate_of is not null) as job_rows_with_new_values,
             (select count(*) from public.clips where links_truncated) as clips_flagged_truncated,
             (select count(*) from public.clips) as clips_total
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
