-- 063_clips_table_and_clipboard_bucket.sql
--
-- SCHEMA CHANGE. Apply once, in order.
--
-- Alfred Clipboard, Phase 1 Step 2: the `clips` table, the `clipboard` storage
-- bucket, and the bucket's read policy.
-- Spec: docs/technical-spec-clipboard.md sections 3.1 and 3.2.
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON `inbox` (spec decision 4)
-- ---------------------------------------------------------------------------
--
-- The Alfred app runs `supabase.from("inbox").select("*")` on every page load
-- AND on every background refresh (src/Alfred.jsx, loadData and refreshData).
-- A megabyte of page text on the inbox row would be dragged across the wire
-- twice per refresh, for every row, forever. So the inbox row stays a
-- lightweight pointer and everything heavy lives here, read only when asked
-- for.
--
-- ---------------------------------------------------------------------------
-- NO FOREIGN KEY ON inbox_id, AND THAT IS DELIBERATE
-- ---------------------------------------------------------------------------
--
-- Human triage in the app HARD-DELETES the inbox row (src/Alfred.jsx,
-- deleteInboxItem — the row is the capture, and a capture that does not make it
-- through never happened). A foreign key would either block that delete or
-- cascade it and take the clip with it. Neither is wanted: a triaged clip
-- should keep its text and slices while its inbox pointer goes stale. So
-- inbox_id is a plain text column and a dangling value is a normal state, not
-- corruption.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT CONSTRAINED HERE, ON PURPOSE
-- ---------------------------------------------------------------------------
--
-- page_text is capped at 1 MB and links at 1,000 entries BY THE CAPTURE
-- FUNCTION, which truncates and sets text_truncated (spec 3.1 and 4.1). Those
-- caps are deliberately NOT database checks: the specified behaviour is
-- graceful truncation with a flag, and a CHECK constraint would turn an
-- oversized page into a hard insert failure and lose the clip instead.
--
-- The two limits that ARE checks are structural rather than degradable: a clip
-- is `clipboard` or `cli` and nothing else, and a CLI report has no screenshot,
-- so 25 slices or a sliced CLI clip is a bug with no sensible partial reading.
--
-- ---------------------------------------------------------------------------
-- AUDITED = TRUE, with one thing to watch
-- ---------------------------------------------------------------------------
--
-- The platform contract reserves p_audited => false for "high-volume
-- append-only telemetry". Clips are append-only but a few a day, so that
-- exception does not apply and this registers audited, like every other table
-- holding user content.
--
-- ⚠️ THE COST IS REAL AND WORTH REMEMBERING: the audit trigger keeps a copy of
-- each row, so a clip's full page text is stored twice, and DELETING a clip
-- will not reclaim the audit copy. The clipboard is explicitly temporary
-- working space (spec section 1) with no deletion job during rollout (decision
-- 10), and there is already a dated Alfred inbox item for 2026-10-23 to review
-- storage size. Audit duplication belongs in that review. If it turns out to
-- dominate, flipping this to false is a one-line follow-up migration.


-- ============================================================
-- STEP 0 -- BEFORE PICTURE. Nothing should exist yet.
-- ============================================================

select json_build_object(
  'clips_table_exists', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_name = 'clips'
    ) t),
  'clipboard_bucket_exists', (select coalesce(json_agg(t), '[]'::json) from (
      select id, public, file_size_limit, allowed_mime_types
      from storage.buckets where id = 'clipboard'
    ) t),
  'existing_storage_policies', (select coalesce(json_agg(t), '[]'::json) from (
      select policyname, cmd, qual
      from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
      order by policyname
    ) t)
) as result;


-- ============================================================
-- STEP 1 -- the clips table
-- ============================================================

create table if not exists public.clips (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid()
                                   references auth.users (id),
  source               text        not null,
  url                  text,
  title                text,
  page_text            text        not null,
  text_truncated       boolean     not null default false,
  links                jsonb       not null default '[]'::jsonb,
  slice_paths          text[]      not null default '{}'::text[],
  -- cardinality() is IMMUTABLE, which is what lets this be a stored generated
  -- column. 0 means "no screenshot" and is a normal value, not missing data.
  slice_count          integer     generated always as (cardinality(slice_paths)) stored,
  screenshot_truncated boolean     not null default false,
  page_width           integer,
  page_height          integer,
  inbox_id             text,
  captured_at          timestamptz,
  created_at           timestamptz not null default now(),

  constraint clips_source_check
    check (source in ('clipboard', 'cli')),

  -- Two-digit slice numbering (slice-01.jpg .. slice-24.jpg) and the start
  -- endpoint's documented range of 0..24 slices, per spec 3.2 and 4.1.
  constraint clips_slice_paths_max_24
    check (cardinality(slice_paths) <= 24),

  -- A CLI report is text. It never has a screenshot (spec 4.1, point 3), so
  -- slices on a cli row mean the capture function sent the wrong source.
  constraint clips_cli_has_no_slices
    check (source <> 'cli' or cardinality(slice_paths) = 0)
);

comment on table public.clips is
  'ALFRED CLIPBOARD. One row per captured web page or pushed CLI report. Holds '
  'the heavy content -- full page text, every link, and the storage paths of the '
  'browser-sliced screenshot -- so the paired inbox row can stay a lightweight '
  'pointer. The app loads every inbox row in full on each refresh, which is why '
  'this split exists. Temporary working space, not a permanent record.';

comment on column public.clips.source is
  'clipboard = captured by the Chrome extension. cli = a report pushed by the '
  'Claude CLI via scripts/clip.mjs. Enforced by clips_source_check.';
comment on column public.clips.url is
  'The page address. Null for cli clips, which have no page.';
comment on column public.clips.title is
  'Page title, or the title given to a CLI report.';
comment on column public.clips.page_text is
  'The whole page''s text (document.body.innerText), or the CLI report body. NO '
  'main-content extraction -- a clip may hold several distinct items, for example '
  'several job cards, and Claude sorts that out in conversation (spec decision 1). '
  'Truncated to 1 MB by the capture function, which then sets text_truncated.';
comment on column public.clips.text_truncated is
  'True when page_text was cut at the 1 MB cap. Tells Claude the text it is '
  'reading is incomplete.';
comment on column public.clips.links is
  'Every <a href> on the page as [{"text": ..., "href": ...}], absolute, '
  'de-duplicated, capped at 1,000 by the capture function. This is how Claude '
  'can point at OTHER listings on a clipped job board without a second clip.';
comment on column public.clips.slice_paths is
  'Storage paths inside the clipboard bucket, IN PAGE ORDER, top to bottom: '
  '{user_id}/{clip_id}/slice-01.jpg and so on. Empty for cli clips and for a '
  'text-only clip whose screenshot failed. Written only after every slice is '
  'confirmed in storage, so a row never points at a missing file (spec decision 7).';
comment on column public.clips.slice_count is
  'Generated from cardinality(slice_paths). 0 means no screenshot.';
comment on column public.clips.screenshot_truncated is
  'True when the page was taller than 24 slices covered. The bottom of the page '
  'is not in storage at all.';
comment on column public.clips.page_width is
  'Width in pixels of the ORIGINAL capture, before the extension scaled it to '
  '1280. Null for cli clips.';
comment on column public.clips.page_height is
  'Height in pixels of the ORIGINAL capture. Null for cli clips.';
comment on column public.clips.inbox_id is
  'The paired public.inbox row. NO FOREIGN KEY ON PURPOSE: human triage in the '
  'app hard-deletes inbox rows, so a dangling value here is a normal state '
  '(the clip outlived its pointer), not corruption.';
comment on column public.clips.captured_at is
  'When the extension or the CLI captured this, as reported by the client. '
  'created_at is when the server wrote the row; the two differ by the upload.';

create index if not exists clips_user_created_idx
  on public.clips (user_id, created_at desc);

-- get_recent_clips filters by source ("read my CLI reports" vs "read my clips")
-- and then orders by recency, so the composite carries both.
create index if not exists clips_user_source_created_idx
  on public.clips (user_id, source, created_at desc);


-- ============================================================
-- STEP 2 -- the clipboard storage bucket
-- ============================================================
--
-- Private. 2 MB per object is comfortably above a 1280x900 JPEG at quality 0.8
-- (the spike's slices ran 40-80 KB) and low enough that a runaway upload is
-- refused by storage rather than by us. image/jpeg only, because the extension
-- encodes JPEG and nothing else should ever land here.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clipboard', 'clipboard', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public            = excluded.public,
      file_size_limit   = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ============================================================
-- STEP 3 -- the bucket's read policy
-- ============================================================
--
-- Folder-per-user: the first path segment must be the reader's own user id.
-- storage.foldername('uuid/clipid/slice-01.jpg') returns {uuid, clipid}, so [1]
-- is the owner segment.
--
-- ⚠️ DELIBERATELY *NOT* AN owner = auth.uid() CHECK, and this is the one place
-- this migration departs from "copy the sam-scores policy". Spec decision 6
-- has slices uploaded through service-issued signed upload links, so the
-- objects' `owner` column is the service role or null -- never Alex. An
-- owner-based policy would therefore match nothing and every slice read would
-- fail. sam-scores can afford either form because its uploads are
-- browser-direct with the user's own session; this bucket cannot. Step 4's
-- verification query prints both policies side by side for the record.
--
-- SELECT only. No INSERT, UPDATE or DELETE policy is needed or wanted: writes
-- arrive on signed upload links issued by the service role, which bypasses RLS,
-- so granting authenticated users write access here would widen the surface for
-- nothing.

drop policy if exists "clipboard: users read own" on storage.objects;

create policy "clipboard: users read own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'clipboard'
  and (storage.foldername(name))[1] = auth.uid()::text
);


-- ============================================================
-- STEP 4 -- register with the platform, then prove conformance
-- ============================================================
--
-- p_policy_mode => 'owner' generates the user_id = auth.uid() policy, type
-- aware (clips.user_id is uuid). register_table also enables RLS, issues the
-- grants Supabase requires, strips anon, attaches the audit trigger, and
-- records the table in platform.registry.
--
-- NOTE ON THE SKILL FILE: .claude/skills/mcp-platform/SKILL.md shows this call
-- as register_table('my_table', audited => true, ...). That form is STALE. The
-- live contract (COMMENT ON SCHEMA platform) requires p_-prefixed parameters
-- and an explicitly schema-qualified name, because the first parameter is
-- regclass and an unqualified name resolves through search_path. The live
-- contract wins, per the skill's own preamble.

select platform.register_table(
  'public.clips',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Alfred Clipboard. One row per captured page or pushed CLI report; holds the heavy page text, links and slice paths so the paired inbox row stays light. inbox_id has no FK because triage hard-deletes inbox rows.'
);

-- MUST return CONFORMANT. Anything else means drift -- read
-- platform.conformance_failures for the reason per column.
select public.platform_check_conformance();


-- ============================================================
-- STEP 5 -- AFTER PICTURE. Compare against Step 0.
-- ============================================================

select json_build_object(
  'clips_columns', (select coalesce(json_agg(t), '[]'::json) from (
      select column_name, data_type, is_nullable, column_default,
             is_generated, generation_expression
      from information_schema.columns
      where table_schema = 'public' and table_name = 'clips'
      order by ordinal_position
    ) t),
  'clips_constraints', (select coalesce(json_agg(t), '[]'::json) from (
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid = 'public.clips'::regclass
      order by conname
    ) t),
  'clips_indexes', (select coalesce(json_agg(t), '[]'::json) from (
      select indexname, indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'clips'
      order by indexname
    ) t),
  'clips_rls_policies', (select coalesce(json_agg(t), '[]'::json) from (
      select policyname, cmd, roles::text as roles, qual, with_check
      from pg_policies
      where schemaname = 'public' and tablename = 'clips'
      order by policyname
    ) t),
  -- to_jsonb(r) rather than named columns: platform.registry's column names are
  -- not something this file should assume, and a wrong guess here would fail
  -- the verification AFTER the DDL had already committed.
  'clips_registry_row', (select coalesce(json_agg(t), '[]'::json) from (
      select to_jsonb(r) as registry_row
      from platform.registry r
      where to_jsonb(r)::text like '%public.clips%'
    ) t),
  'clipboard_bucket', (select coalesce(json_agg(t), '[]'::json) from (
      select id, public, file_size_limit, allowed_mime_types
      from storage.buckets where id = 'clipboard'
    ) t),
  -- Both bucket policies together, so the clipboard/sam-scores divergence
  -- explained in Step 3 is on the record rather than in a comment only.
  'storage_policies_clipboard_and_sam', (select coalesce(json_agg(t), '[]'::json) from (
      select policyname, cmd, roles::text as roles, qual
      from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and (policyname ilike '%clipboard%'
          or policyname ilike '%sam%'
          or coalesce(qual, '') like '%sam-scores%'
          or coalesce(qual, '') like '%clipboard%')
      order by policyname
    ) t),
  'conformance', (select coalesce(json_agg(t), '[]'::json) from (
      select public.platform_check_conformance() as report
    ) t)
) as result;
