-- Purpose: Overwatch Step 6. public.claim_blocks: the history of claims blocks between CLI threads. The local blocks file
-- (.git/alfred-claim-blocks.json) keeps only blocks still in force; this table keeps every episode, so the nightly job
-- can see that two projects keep blocking each other and propose a no_parallel link. Written only by the
-- overwatch-ingest edge function (service role), from events the claims script sends (Step 7).
-- Kind: schema change (new table, registered)
-- Applied: YES — confirmed 2026-10-24, CONFORMANT (72 tables). The id and user_id comments were added afterwards and
-- run on their own.
--
-- Spec: docs/technical-spec-overwatch-q4n.md section 4.5. Run as one block in the SQL editor, before deploying
-- overwatch-ingest. Safe to re-run: the table, constraints, index and registration are idempotent.
-- supabase/migrations/167_overwatch_claim_blocks.sql

begin;

-- ============================================================================
-- 1. The table
-- ============================================================================
create table if not exists public.claim_blocks (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  waiter_code   text        not null,
  holder_code   text        not null,
  item          text        not null,
  run_tag       text,
  blocked_at    timestamptz not null,
  last_seen_at  timestamptz not null,
  repeat_count  integer     not null default 0,
  cleared_at    timestamptz,
  created_at    timestamptz not null default now(),

  -- One row per episode: a waiter blocked by a holder on one path, starting at blocked_at.
  constraint claim_blocks_episode_key unique (user_id, waiter_code, holder_code, item, blocked_at),
  constraint claim_blocks_codes_format
    check (waiter_code ~ '^[a-z0-9_-]{1,40}$' and holder_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint claim_blocks_run_tag_format check (run_tag is null or run_tag ~ '^[a-z0-9_-]{1,40}$'),
  constraint claim_blocks_item_length check (length(item) between 1 and 500),
  constraint claim_blocks_repeat_count_nonneg check (repeat_count >= 0),
  constraint claim_blocks_seen_after_blocked check (last_seen_at >= blocked_at),
  constraint claim_blocks_cleared_after_blocked check (cleared_at is null or cleared_at >= blocked_at)
);

comment on table public.claim_blocks is
  'OVERWATCH. History of claims blocks between CLI threads, one row per episode: a waiting project refused a file '
  'or folder another project holds, from blocked_at until the holder let go (cleared_at). The local blocks file '
  'keeps only live blocks; this keeps them all. Written only by the overwatch-ingest edge function from events the '
  'claims script sends. Three or more episodes between the same pair of codes inside 30 days make the nightly job '
  'propose a no_parallel project link. Spec: docs/technical-spec-overwatch-q4n.md section 4.5.';
comment on column public.claim_blocks.id is 'Row id.';
comment on column public.claim_blocks.user_id is
  'Owner. Set explicitly by overwatch-ingest from CLIPBOARD_USER_ID, since it writes with the service role and has no '
  'auth.uid(). Owner RLS scopes every read.';
comment on column public.claim_blocks.waiter_code is
  'Project code of the thread that was refused, e.g. overwatch-q4n. "main" for the main checkout when it has no code.';
comment on column public.claim_blocks.holder_code is
  'Project code of the thread holding the claim. Same form as waiter_code.';
comment on column public.claim_blocks.item is
  'The repo-relative file or folder the waiter asked for, as the claims script recorded it.';
comment on column public.claim_blocks.run_tag is
  'The waiter''s run tag when the claims script knew it (claims.mjs --run-tag), else null.';
comment on column public.claim_blocks.blocked_at is
  'When the episode started: the first refusal, as recorded in the local blocks file. Part of the episode key.';
comment on column public.claim_blocks.last_seen_at is
  'The latest refusal seen in this episode.';
comment on column public.claim_blocks.repeat_count is
  'Refusals after the first in this episode. Information only: the guard refuses every blocked edit, so this counts '
  'attempts, not episodes. Patterns count distinct blocked_at values instead. A resent event can count twice.';
comment on column public.claim_blocks.cleared_at is
  'When the block stopped being in force (the holder released, or the waiter got the file). Null while live, or '
  'when the clear was never seen.';
comment on column public.claim_blocks.created_at is 'When overwatch-ingest wrote the row.';

-- The 30-day pattern query: episodes per pair of codes, newest first.
create index if not exists claim_blocks_pair_idx
  on public.claim_blocks (user_id, waiter_code, holder_code, blocked_at desc);

-- ============================================================================
-- 2. Register: owner RLS, explicit grants (no anon), read settings
-- ============================================================================
-- Not audited: every repeat refusal updates the row, which would flood the audit log with counter bumps.
select platform.register_table(
  'public.claim_blocks',
  p_policy_mode => 'owner',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. History of claims blocks between CLI threads, one row per episode. Written by the overwatch-ingest edge function (service role) from claims-script events; read by the nightly job. Not audited: repeats bump a counter on every refused edit.'
);

commit;

-- ============================================================================
-- 3. Result: the table as created, its registration, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             a.attnotnull as not_null,
             col_description(a.attrelid, a.attnum) is not null as has_comment
        from pg_attribute a
       where a.attrelid = 'public.claim_blocks'::regclass and a.attnum > 0 and not a.attisdropped
       order by a.attnum
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, exempt, mcp_read
        from platform.registry where table_name = 'public.claim_blocks'
    ) t),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'claim_blocks'
       group by grantee order by grantee
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
