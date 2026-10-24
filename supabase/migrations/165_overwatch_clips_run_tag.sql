-- Purpose: Overwatch Step 4. clips gains run_tag, repo and branch, so a CLI report can be found by its run tag (and
-- every report under a project code by prefix) without going through the paired inbox row. Backfilled from
-- inbox.source_metadata, where clip-capture has stored them since the clipboard project. clip-capture writes them
-- from the redeploy that follows this migration.
-- Kind: schema change (three columns, one check, one index) plus a one-off backfill
-- Applied: NO
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.1. Run as one block in the SQL editor, BEFORE deploying
-- clip-capture: the new function writes these columns, so deploying first would fail every capture.
-- Safe to re-run: the columns, check and index are idempotent, and the backfill only fills rows still empty.
-- Then run supabase/tests/overwatch-q4n/1_verify_clips_run_tag.sql.
-- supabase/migrations/165_overwatch_clips_run_tag.sql

begin;

-- ============================================================================
-- 1. Columns
-- ============================================================================
alter table public.clips
  add column if not exists run_tag text,
  add column if not exists repo    text,
  add column if not exists branch  text;

comment on column public.clips.run_tag is
  'The run tag of the CLI prompt this report answers, e.g. overwatch-q4n-s4-k2mf. Null for Chrome clips and for '
  'untagged pushes. Everything before the step segment is the project code, so a prefix search finds every report '
  'of one project. Same pattern clip-capture accepts (clips_run_tag_format). Also kept in the paired '
  'inbox.source_metadata.run_tag, which get_recent_clips reads.';
comment on column public.clips.repo is
  'The repository folder the CLI ran in, as clip.mjs reports it from git, e.g. alfred-v5. Context, not identity: '
  'trimmed and capped at 120 characters by clip-capture, never validated. Null for Chrome clips.';
comment on column public.clips.branch is
  'The git branch the CLI ran on, e.g. worktree-overwatch-q4n. Context, not identity: trimmed and capped at 200 '
  'characters by clip-capture, never validated. Null for Chrome clips.';

-- ============================================================================
-- 2. Backfill from the paired inbox row
-- ============================================================================
-- Matched on clips.inbox_id, or on inbox.source_metadata.clip_id when the link-back update failed. Only rows with
-- all three still empty are touched, so a re-run changes nothing. A stored tag that does not fit the pattern is
-- left out rather than failing the check below.
update public.clips c
   set run_tag = case when i.source_metadata->>'run_tag' ~ '^[a-z0-9_-]{1,40}$'
                      then i.source_metadata->>'run_tag' end,
       repo    = nullif(left(trim(i.source_metadata->>'repo'), 120), ''),
       branch  = nullif(left(trim(i.source_metadata->>'branch'), 200), '')
  from public.inbox i
 where (i.id = c.inbox_id or i.source_metadata->>'clip_id' = c.id::text)
   and c.run_tag is null and c.repo is null and c.branch is null
   and (i.source_metadata ? 'run_tag' or i.source_metadata ? 'repo' or i.source_metadata ? 'branch');

-- ============================================================================
-- 3. Check and index
-- ============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.clips'::regclass and conname = 'clips_run_tag_format'
  ) then
    alter table public.clips
      add constraint clips_run_tag_format check (run_tag is null or run_tag ~ '^[a-z0-9_-]{1,40}$');
  end if;
end
$$;

-- text_pattern_ops so `run_tag like 'overwatch-q4n-%'` can use it.
create index if not exists clips_run_tag_idx
  on public.clips (run_tag text_pattern_ops) where run_tag is not null;

commit;

-- ============================================================================
-- 4. Result: backfill counts and conformance (must say CONFORMANT)
-- ============================================================================
-- No register_table call: public.clips is registered (063), and adding columns does not re-register a table.
select json_build_object(
  'clips_total',         (select count(*) from public.clips),
  'cli_clips',           (select count(*) from public.clips where source = 'cli'),
  'with_run_tag',        (select count(*) from public.clips where run_tag is not null),
  'with_repo_or_branch', (select count(*) from public.clips where repo is not null or branch is not null),
  'inbox_tags_not_copied', (
    select count(*) from public.clips c
      join public.inbox i on i.id = c.inbox_id or i.source_metadata->>'clip_id' = c.id::text
     where i.source_metadata->>'run_tag' ~ '^[a-z0-9_-]{1,40}$' and c.run_tag is null),
  'conformance',         public.platform_check_conformance()
) as result;
