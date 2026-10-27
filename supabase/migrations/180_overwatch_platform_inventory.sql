-- Purpose: Overwatch Step 43 (Phase 7). Three tables and one function for the inventory and impact review:
-- platform_inventory (every moving part, rebuilt by scripts/inventory.mjs), platform_open_work (unfinished work written
-- down in docs/), finish_summaries (what a worktree's Finish carried into main), and replace_platform_inventory, which
-- swaps a user's whole inventory and open work in one transaction. Written by the overwatch-ingest edge function
-- (service role) from gitpush and `npm run inventory -- --send`; read by the nightly and weekly jobs.
-- Kind: schema change (new tables, registered; new function)
-- Applied: NO — not yet run.
--
-- Spec: docs/technical-spec-overwatch-q4n.md sections 4.9, 4.13 to 4.15, 5.4 to 5.6. Run as one block in the SQL
-- editor. Safe to re-run: tables, constraints, indexes, the function and registration are idempotent.
-- supabase/migrations/180_overwatch_platform_inventory.sql

begin;

-- ============================================================================
-- 1. platform_inventory
-- ============================================================================
create table if not exists public.platform_inventory (
  id                   uuid        primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users (id),
  kind                 text        not null,
  name                 text        not null,
  app_id               text        references public.apps (id) on delete set null,
  reads                text[]      not null default '{}',
  writes               text[]      not null default '{}',
  reads_any            boolean     not null default false,
  location             text,
  fingerprint          text,
  last_changed_project text,
  details              jsonb       not null default '{}'::jsonb,
  seen_at              timestamptz not null default now(),

  constraint platform_inventory_part_key unique (user_id, kind, name),
  constraint platform_inventory_kind_check
    check (kind in ('tool', 'skill', 'edge_function', 'schedule', 'table', 'screen', 'task_prompt', 'trigger')),
  constraint platform_inventory_name_length check (length(name) between 1 and 300),
  -- "*" is recorded as reads_any, never as a table name.
  constraint platform_inventory_no_star check (not ('*' = any (reads)) and not ('*' = any (writes))),
  constraint platform_inventory_reads_any_tool check (not reads_any or kind = 'tool'),
  constraint platform_inventory_project_format
    check (last_changed_project is null or last_changed_project ~ '^[a-z0-9_-]{1,40}$'),
  constraint platform_inventory_details_object check (jsonb_typeof(details) = 'object')
);

comment on table public.platform_inventory is
  'OVERWATCH. Every moving part of the platform, one row each: MCP tools with the tables they declare, skills, edge '
  'functions, schedules, tables, screens, task prompts and triggers. Rebuilt whole by scripts/inventory.mjs and '
  'replaced in one transaction by replace_platform_inventory (via overwatch-ingest); never hand-edited. Read by the '
  'nightly finish-summary review and the weekly drift audit. Spec: docs/technical-spec-overwatch-q4n.md 4.9.';
comment on column public.platform_inventory.id is 'Row id. Kept across rebuilds while the part keeps its kind and name.';
comment on column public.platform_inventory.user_id is
  'Owner. Set explicitly by replace_platform_inventory, since overwatch-ingest writes with the service role. Owner RLS '
  'scopes every read.';
comment on column public.platform_inventory.kind is
  'tool, skill, edge_function, schedule, table, screen, task_prompt or trigger. Triggers come from the schema snapshot, '
  'not from tool declarations.';
comment on column public.platform_inventory.name is
  'The part''s name, unique within its kind: a tool or skill name, a function folder, a table name, a route, a prompt '
  'file, or <table>.<trigger> for a trigger.';
comment on column public.platform_inventory.app_id is 'The app it belongs to, when the inventory can tell; null otherwise.';
comment on column public.platform_inventory.reads is
  'Tables and views it reads: a tool''s declared reads, a skill''s or prompt''s tools'' reads, a trigger''s own table.';
comment on column public.platform_inventory.writes is 'Tables it writes: a tool''s declared writes, a trigger''s targets.';
comment on column public.platform_inventory.reads_any is
  'True for a generic reader that reads any registered table (a tool declaring "*" in reads, e.g. get_records). The '
  'named tables it always reads are still in reads.';
comment on column public.platform_inventory.location is 'Repo path of its source, e.g. supabase/functions/_shared/tools/ken.ts.';
comment on column public.platform_inventory.fingerprint is 'Hash of its source text, so a rebuild can tell a part changed.';
comment on column public.platform_inventory.last_changed_project is
  'Project code of the last Finish that changed its source, when known; null otherwise.';
comment on column public.platform_inventory.details is
  'Kind-specific facts as a JSON object, e.g. a skill''s tool names, a trigger''s timing and events, a tool''s tier.';
comment on column public.platform_inventory.seen_at is 'When the latest rebuild saw it.';

create index if not exists platform_inventory_reads_idx on public.platform_inventory using gin (reads);
create index if not exists platform_inventory_writes_idx on public.platform_inventory using gin (writes);

-- ============================================================================
-- 2. platform_open_work
-- ============================================================================
create table if not exists public.platform_open_work (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null default auth.uid() references auth.users (id),
  file          text        not null,
  line          integer     not null,
  kind          text        not null,
  text          text        not null,
  project_code  text,
  seen_at       timestamptz not null default now(),

  constraint platform_open_work_place_key unique (user_id, file, line),
  constraint platform_open_work_kind_check check (kind in ('checkbox', 'deferred_phase', 'not_fixed')),
  constraint platform_open_work_file_format check (file ~ '^docs/.+\.md$' and length(file) <= 300),
  constraint platform_open_work_line_positive check (line >= 1),
  constraint platform_open_work_text_length check (length(text) between 1 and 500),
  constraint platform_open_work_project_format check (project_code is null or project_code ~ '^[a-z0-9_-]{1,40}$')
);

comment on table public.platform_open_work is
  'OVERWATCH. Unfinished work written down in docs/: open checkboxes, deferred phases and "not fixed here" notes in '
  'spec, progress and review files (docs/ and docs/history/), each with its file and line. Rebuilt whole with the '
  'inventory by replace_platform_inventory; never hand-edited. Feeds the Phase 8 review passes and the weekly audit. '
  'Spec: docs/technical-spec-overwatch-q4n.md 4.13.';
comment on column public.platform_open_work.id is 'Row id.';
comment on column public.platform_open_work.user_id is
  'Owner. Set explicitly by replace_platform_inventory (service role). Owner RLS scopes every read.';
comment on column public.platform_open_work.file is 'Repo path of the doc, e.g. docs/history/progress-dj.md.';
comment on column public.platform_open_work.line is 'Line number in the file, 1-based, as of the latest rebuild.';
comment on column public.platform_open_work.kind is
  'checkbox (an open "- [ ]"), deferred_phase (a phase or step marked deferred) or not_fixed (a "not fixed here" '
  'or follow-up note).';
comment on column public.platform_open_work.text is 'The line, trimmed, at most 500 characters.';
comment on column public.platform_open_work.project_code is
  'The project code from the file name (progress-<code>.md, technical-spec-<code>.md, review-<code>.md), else null.';
comment on column public.platform_open_work.seen_at is 'When the latest rebuild saw it.';

create index if not exists platform_open_work_project_idx on public.platform_open_work (user_id, project_code);

-- ============================================================================
-- 3. finish_summaries
-- ============================================================================
create table if not exists public.finish_summaries (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null default auth.uid() references auth.users (id),
  project_code     text        not null,
  branch           text,
  merge_commit     text        not null,
  finished_at      timestamptz not null,
  diff_stat        jsonb       not null default '{}'::jsonb,
  migrations       text[]      not null default '{}',
  tools            text[]      not null default '{}',
  skills           text[]      not null default '{}',
  functions        text[]      not null default '{}',
  task_prompts     text[]      not null default '{}',
  paths            text[]      not null default '{}',
  reviewed_at      timestamptz,
  reviewed_by_run  text,
  created_at       timestamptz not null default now(),

  constraint finish_summaries_merge_key unique (user_id, merge_commit),
  constraint finish_summaries_project_format check (project_code ~ '^[a-z0-9_-]{1,40}$'),
  constraint finish_summaries_commit_format check (merge_commit ~ '^[0-9a-f]{7,40}$'),
  constraint finish_summaries_diff_stat_object check (jsonb_typeof(diff_stat) = 'object'),
  constraint finish_summaries_reviewed_pair check (reviewed_by_run is null or reviewed_at is not null)
);

comment on table public.finish_summaries is
  'OVERWATCH. What a worktree''s gitpush Finish carried into main: the diff stat and the migrations, tools, skills, '
  'edge functions and task prompts it changed. Sent by gitpush through overwatch-ingest; the nightly job compares each '
  'unreviewed one with the inventory, raises follow-up items, then sets reviewed_at. Spec: '
  'docs/technical-spec-overwatch-q4n.md 4.14 and 5.4.';
comment on column public.finish_summaries.id is 'Row id.';
comment on column public.finish_summaries.user_id is
  'Owner. Set explicitly by overwatch-ingest (service role). Owner RLS scopes every read.';
comment on column public.finish_summaries.project_code is 'The worktree that finished, e.g. overwatch-q4n.';
comment on column public.finish_summaries.branch is 'Its branch, e.g. worktree-overwatch-q4n.';
comment on column public.finish_summaries.merge_commit is 'The merge commit in main (short or full hash). One summary per merge.';
comment on column public.finish_summaries.finished_at is 'When the Finish merged.';
comment on column public.finish_summaries.diff_stat is 'JSON object: { files, insertions, deletions } for the merge.';
comment on column public.finish_summaries.migrations is 'Numbered migration paths new or changed in the merge.';
comment on column public.finish_summaries.tools is 'Tool names whose defineTool block changed.';
comment on column public.finish_summaries.skills is 'Skill files changed (.claude/skills/*/SKILL.md).';
comment on column public.finish_summaries.functions is 'Edge function folders changed (supabase/functions/*).';
comment on column public.finish_summaries.task_prompts is 'Task prompt docs changed (docs/**/*task-prompt*.md).';
comment on column public.finish_summaries.paths is 'Every path in the merge.';
comment on column public.finish_summaries.reviewed_at is
  'When the nightly job compared it with the inventory; null until then, so a failed night leaves it for the next.';
comment on column public.finish_summaries.reviewed_by_run is 'The platform_runs id of the run that reviewed it.';
comment on column public.finish_summaries.created_at is 'When overwatch-ingest wrote the row.';

create index if not exists finish_summaries_unreviewed_idx
  on public.finish_summaries (user_id, finished_at) where reviewed_at is null;

-- ============================================================================
-- 4. replace_platform_inventory: the whole inventory and open work, swapped in one transaction
-- ============================================================================
create or replace function public.replace_platform_inventory(p_user_id uuid, p_parts jsonb, p_open_work jsonb)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_now        timestamptz := clock_timestamp();
  v_dupe       text;
  v_parts      int;
  v_work       int;
  v_gone_parts int;
  v_gone_work  int;
begin
  if p_user_id is null then
    raise exception 'replace_platform_inventory: p_user_id is required.' using errcode = '22023';
  end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) = 0 then
    raise exception 'replace_platform_inventory: parts must be a non-empty JSON array; nothing was changed.'
      using errcode = '22023';
  end if;
  if p_open_work is null or jsonb_typeof(p_open_work) <> 'array' then
    raise exception 'replace_platform_inventory: open_work must be a JSON array; nothing was changed.'
      using errcode = '22023';
  end if;

  select e->>'kind' || ' ' || (e->>'name') into v_dupe
    from jsonb_array_elements(p_parts) e
   group by e->>'kind', e->>'name' having count(*) > 1 limit 1;
  if v_dupe is not null then
    raise exception 'replace_platform_inventory: % appears twice; nothing was changed.', v_dupe using errcode = '22023';
  end if;
  select (e->>'file') || ':' || (e->>'line') into v_dupe
    from jsonb_array_elements(p_open_work) e
   group by e->>'file', e->>'line' having count(*) > 1 limit 1;
  if v_dupe is not null then
    raise exception 'replace_platform_inventory: open work % appears twice; nothing was changed.', v_dupe
      using errcode = '22023';
  end if;

  insert into public.platform_inventory
    (user_id, kind, name, app_id, reads, writes, reads_any, location, fingerprint, last_changed_project, details, seen_at)
  select p_user_id, e->>'kind', e->>'name',
         (select a.id from public.apps a where a.id = e->>'app_id'),
         array(select x from jsonb_array_elements_text(coalesce(e->'reads', '[]'::jsonb)) x where x <> '*'),
         array(select x from jsonb_array_elements_text(coalesce(e->'writes', '[]'::jsonb)) x),
         coalesce((e->>'reads_any')::boolean, false)
           or (coalesce(e->'reads', '[]'::jsonb) ? '*'),
         e->>'location', e->>'fingerprint', e->>'last_changed_project',
         coalesce(e->'details', '{}'::jsonb), v_now
    from jsonb_array_elements(p_parts) e
  on conflict (user_id, kind, name) do update set
    app_id = excluded.app_id, reads = excluded.reads, writes = excluded.writes, reads_any = excluded.reads_any,
    location = excluded.location, fingerprint = excluded.fingerprint,
    last_changed_project = excluded.last_changed_project, details = excluded.details, seen_at = excluded.seen_at;
  get diagnostics v_parts = row_count;

  insert into public.platform_open_work (user_id, file, line, kind, text, project_code, seen_at)
  select p_user_id, e->>'file', (e->>'line')::int, e->>'kind', left(trim(e->>'text'), 500), e->>'project_code', v_now
    from jsonb_array_elements(p_open_work) e
  on conflict (user_id, file, line) do update set
    kind = excluded.kind, text = excluded.text, project_code = excluded.project_code, seen_at = excluded.seen_at;
  get diagnostics v_work = row_count;

  delete from public.platform_inventory where user_id = p_user_id and seen_at < v_now;
  get diagnostics v_gone_parts = row_count;
  delete from public.platform_open_work where user_id = p_user_id and seen_at < v_now;
  get diagnostics v_gone_work = row_count;

  return jsonb_build_object('parts', v_parts, 'open_work', v_work,
                            'removed_parts', v_gone_parts, 'removed_open_work', v_gone_work);
end;
$$;

comment on function public.replace_platform_inventory(uuid, jsonb, jsonb) is
  'Overwatch: replace one user''s whole platform_inventory and platform_open_work in one transaction. Upserts every '
  'part (kind + name) and open-work line (file + line) with this call''s seen_at, then deletes the rows it did not '
  'see. Any error (a bad kind, a duplicate, a malformed line) rolls back the whole call, so a failed send leaves the '
  'previous inventory in place. A "*" in a part''s reads becomes reads_any. Service role only: called by '
  'overwatch-ingest, which passes the user id.';
revoke all on function public.replace_platform_inventory(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_platform_inventory(uuid, jsonb, jsonb) to service_role;

-- ============================================================================
-- 5. Register: owner RLS, explicit grants (no anon), read settings
-- ============================================================================
-- The two rebuilt tables are not audited: every rebuild rewrites every row.
select platform.register_table(
  'public.platform_inventory',
  p_policy_mode => 'owner',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Every moving part of the platform, rebuilt whole by scripts/inventory.mjs through overwatch-ingest (replace_platform_inventory). Not audited: each rebuild rewrites every row.'
);
select platform.register_table(
  'public.platform_open_work',
  p_policy_mode => 'owner',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. Unfinished work found in docs/, rebuilt with the inventory. Not audited: each rebuild rewrites every row.'
);
select platform.register_table(
  'public.finish_summaries',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'App: Overwatch. What each worktree Finish carried into main, sent by gitpush through overwatch-ingest; reviewed by the nightly job.'
);

commit;

-- ============================================================================
-- 6. Result: the tables, their registration and grants, the function's grants, and conformance (must say CONFORMANT)
-- ============================================================================
select json_build_object(
  'columns', (select coalesce(json_agg(t), '[]'::json) from (
      select c.relname as table_name, a.attname as column_name,
             format_type(a.atttypid, a.atttypmod) as data_type,
             col_description(a.attrelid, a.attnum) is not null as has_comment
        from pg_attribute a join pg_class c on c.oid = a.attrelid
       where a.attrelid in ('public.platform_inventory'::regclass, 'public.platform_open_work'::regclass,
                            'public.finish_summaries'::regclass)
         and a.attnum > 0 and not a.attisdropped
       order by c.relname, a.attnum
    ) t),
  'registry', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, policy_mode, audited, exempt, mcp_read
        from platform.registry
       where table_name in ('public.platform_inventory', 'public.platform_open_work', 'public.finish_summaries')
       order by table_name
    ) t),
  'grants', (select coalesce(json_agg(t), '[]'::json) from (
      select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
        from information_schema.role_table_grants
       where table_schema = 'public' and table_name in ('platform_inventory', 'platform_open_work', 'finish_summaries')
       group by table_name, grantee order by table_name, grantee
    ) t),
  'function_execute', (select coalesce(json_agg(t), '[]'::json) from (
      select r as role,
             has_function_privilege(r, 'public.replace_platform_inventory(uuid, jsonb, jsonb)', 'execute') as can_execute
        from unnest(array['anon', 'authenticated', 'service_role']) r
    ) t),
  'conformance', public.platform_check_conformance()
) as result;
