# Technical spec: MCP read access

Project code: mcp_read_gaps-t8k
Progress: docs/history/progress-mcp-read-access.md

## Goal

Claude can read everything in Alfred's database except secrets, every read tool
behaves the same way, and a table added later gets MCP read access without extra
work. Read side only. No tool here closes, edits or deletes a record; writes are
restructure Phase 9 (the Claude action inbox).

## Decisions (Alex, 2026-10-23, run mcp_read_gaps-t8k-s2-p4hz)

1. Every table is visible, `allowed_emails` and `push_subscriptions` included.
   They are useful for troubleshooting.
2. The only secret columns are `push_subscriptions.endpoint`, `p256dh` and
   `auth_key`.
3. `wb_accounts.external_id` and `wb_transactions.raw` stay visible. `raw` is
   heavy, so it comes back only by ids.
4. `platform_search_items` drops SECURITY DEFINER, so RLS decides which rows a
   caller sees. Check the policies on items, intents and notes before and after
   (see "RLS performance"), and time the search before and after.
5. Item "links" means the `links` jsonb column from the restructure plan. It
   does not exist yet. The default-visible rule covers it once it is added.
   Related records come through `include: ["memberships"]`.
6. There is no long-text declaration. Columns are visible by default and only
   secret columns are declared. List reads preview long values automatically.
   Heavy jsonb comes back only by ids.
7. The conformance check flags a column whose name looks like a credential
   unless it is declared secret or explicitly cleared.
8. The final step searches `.claude/skills/` for references to the changed
   tools and their old limits.

Confirmed 2026-10-23, run mcp_read_gaps-t8k-s3-r8vc:

9. restructure_p5-h7m builds `get_groups` in its own step 16, and this thread
   does not. When this thread moves the other get_* tools onto the shared read
   helper (S8), it also moves `get_groups` onto the helper and adds the
   `memberships` include there.
10. Cleared by the credential-name check, because they are not credentials:
    `dj_tracks.match_key`, `drive_mix_songs.artist_key` and
    `sam_songs.key_signature`.
11. The S5 migration does two more things:
    - rewrites the items, intents, contexts and notes policies to call
      `(select auth.uid())` instead of bare `auth.uid()`;
    - adds a GIN index on `executions.item_ids`.
    search_items and get_items are timed as the authenticated user before and
    after the change, and both timings are reported.

Added 2026-10-23, run mcp_read_gaps-t8k-s5-n3qd:

12. search_items returns no `status` and includes closed items, so Claude cannot
    tell a closed item from an open one. It returns `status` (and
    `closed_reason`), as get_items does, and takes the same `status` filter.
    This is part of S5.
13. **Anon privileges** (Alfred intention mvleha5g3w4i21aovjn, "Platform: stop
    new functions and views being granted to anon by default"). This is its own
    step, S2b; see "Anon privileges" below.

## Read settings (Part A.1)

New columns on `platform.registry`:

| column | type | meaning |
|---|---|---|
| `mcp_read` | text, `'visible'` / `'hidden'`, null until set | whether get_records may read the table |
| `secret_columns` | text[] default `'{}'` | never returned by any generic read |
| `cleared_columns` | text[] default `'{}'` | credential-looking names reviewed and judged safe |

- `platform.register_table` gains `p_mcp_read text default 'visible'`,
  `p_secret_columns text[] default '{}'` and
  `p_cleared_columns text[] default '{}'`. Existing calls keep working, and new
  tables are visible by default.
- `platform.set_read_settings(regclass, mcp_read, secret_columns,
  cleared_columns)` changes the settings without re-running the grants and
  policies. The backfill uses it.
- `platform.conformance_failures` gains `issue_read`, which reports any of:
  - `mcp_read` is null;
  - a name in `secret_columns` or `cleared_columns` is not a real column;
  - a column whose name has a credential part is in neither list.
  `check_conformance` adds `issue_read` to its `concat_ws`.
- **Credential-name rule.** Split the column name on `_`. The column is flagged
  if any part is `token`, `secret`, `key`, `password`, `endpoint`, `p256dh` or
  `auth`, or if the name contains `password` or `secret`. Matching whole parts
  rather than substrings keeps `author` and `keyword` clear.
  - Flagged today and declared secret: `push_subscriptions.endpoint`,
    `p256dh`, `auth_key`.
  - Flagged today and cleared (decision 10): `dj_tracks.match_key`,
    `drive_mix_songs.artist_key` and `sam_songs.key_signature`.
  - Re-check the list against the live schema when the migration is written.
- **`public.platform_read_settings()`** is a SECURITY DEFINER RPC, because
  PostgREST cannot reach `platform`. For every visible registered table it
  returns:
  - `table` and its `columns` (name and type), with secret columns removed;
  - `has_context_id`, `has_archived` and `has_status`;
  - `heavy_columns`.
  It reads only the catalog and `pg_stats`, never row data, so it shows no one
  anything RLS would hide.
- **Heavy columns** are found automatically by `platform.heavy_jsonb_columns`
  (migration 161). It samples up to 200 stored values per jsonb column with
  `pg_column_size`. A column is heavy when the average is over 500 bytes or
  one value is over 2,000. It needs no ANALYZE.
  - 160 first used `pg_stats.avg_width` over 1,000 bytes, and that found
    nothing. ANALYZE records a TOASTed value at its pointer size, about 18
    bytes, so large jsonb never looks large. It also depends on ANALYZE
    having run at all.
  - The text below describes the old 160 rule. A table that has never been analysed has no stats, so
  nothing is heavy. The post-fetch size cap still protects the response. The
  S2 migration's result lists the heavy columns it found. If that list is
  wrong, the threshold changes.
- Every existing table is backfilled `visible`, with the secrets and clears
  above. The migration ends with `check_platform_conformance` returning
  CONFORMANT.

## Shared read helper (Part A.2, A.3) — `_shared/platform-read.ts`

Pure functions, with no database access and no Deno-only imports, so node tests
can run them. The read settings are passed in as input, so the helper is tested
before the migration exists.

- `parseReadOptions(args, settings)` validates and returns the shared options:
  - `limit` goes through clampLimit (default 20, cap 50);
  - `offset` is an integer ≥ 0, default 0;
  - `ids` is up to 50 non-empty strings;
  - `include` is a list of names the tool allows;
  - `archived` is `"exclude"` (the default), `"include"` or `"only"`. It is
    allowed only where the table has `archived`;
  - `no_context: true` means `context_id is null`, and is allowed only where the
    table has `context_id`. It cannot be combined with `context_id`.
  - Bad input throws a plain operational error that names the parameter.
- `selectColumns(settings, { byIds })` gives the column list for the select.
  It never includes secret columns. It leaves heavy columns out unless
  `byIds` is set.
- `shapeRows(rows, { byIds })`: in a list read, any string over 200 characters
  becomes its first 200 characters plus `… [cut: N chars; fetch by ids for
  full text]`. Reads by ids are returned whole. Secret keys are deleted again
  here as a second guard.
- `capResponse(rows, maxChars = 60000)` drops trailing rows until the JSON fits
  and returns `{ rows, cutForSize }`.
- `pageMeta({ offset, returned, total, cutForSize })` returns the envelope
  meta:
  - `truncated`, `total`, `limit_applied` and `next_offset`;
  - `notes[]`, saying what was cut and why.
- `MCP_READ_OPTIONS_SCHEMA`: the shared parameter descriptions, so every tool
  documents the options the same way.
- Wiring, which waits on the other two threads:
  - `EnvelopeMeta` in `platform.ts` gains `next_offset` and `notes`.
  - The NOTE in `runToolForMcp` in `mcp/index.ts` becomes: `NOTE: results
    truncated to N of M. Next page: offset=K.` followed by any notes.

## get_records (Part A.4) — `_shared/tools/records.ts`

Tier 1. It takes `table` (required) and the shared options, plus `context_id` and `status` where
the table has those columns. It reads the table's settings from
`platform_read_settings()`. A hidden or unregistered table gives an error naming
the visible tables. It selects only the readable columns through `ctx.db`, so RLS
decides which rows come back. The order is `created_at desc` when the column exists,
otherwise `id`. The total comes from `count: "exact"` on the same query.

## Search fix (Part B.4) — platform_search_items

Cause: `search_items` runs one `ilike '%<whole query>%'`, and get_items' search
does the same. "style consistency design contract" is not a contiguous part of
"Alfred-wide style consistency **and** design contract". The search also has
other faults:

- it pastes the raw query into `.or()`, which breaks on a comma or a bracket;
- it skips notes;
- it returns the heavy `elements` column;
- it stops at 20 rows without flagging the cut.

Fix:

- Split the text into words. Every word must match the name, the description
  or a linked note, with `%`, `_` and `\` escaped.
- Name matches sort first, then by name.
- New parameters `p_offset` and `p_ids`. The function drops SECURITY DEFINER
  and its `user_id = auth.uid()` filter, so RLS decides.
- search_items returns `status` and `closed_reason` on every row and takes
  get_items' `status` filter (any-of: someday, active, background, closed)
  (decision 12).
- `search_items` becomes a thin call to the same function. There is then one
  search, with paging and the truncation NOTE.

## Alfred tools (Part B.1–B.3, B.5)

- **get_items**: offset, ids, archived and no_context. It also takes `include`,
  any of:
  - `elements`, which is heavy and would otherwise come back only by ids;
  - `notes`, from notes whose target is the item;
  - `memberships`.
- **get_intents**: adds `description` (previewed in lists), plus offset, ids
  and `include` (`notes`, `memberships`).
- **get_events, get_execution_history, get_inbox, get_collections,
  get_contexts**: the shared options where their columns allow them.
- **`memberships` include**: for each record, its collections (from
  `collection_items` and `item_collections`) and its groups (from
  `item_group_members` where `removed_at is null`, `item_groups` and
  `group_types`). Each entry is `{ id, name, type, group_type }`.
- **get_groups** was built by restructure_p5-h7m (decision 9) in
  `supabase/functions/_shared/tools/groups.ts` and registered in
  `mcp/index.ts`.
  - It takes `context_id`, `status` (any of someday, active, background,
    closed), `group_type` (a type label such as Menu or Project, singular or
    plural, any case) and `limit`.
  - It reads only live groups (`archived = false`), ordered pinned first, then
    by updated_at.
  - The total comes from `count: "exact"`.
  - Each row has its type, context name, status, pin, last_completed_at,
    `own_intention_id`, `scheduled_date` and live members in position order.
  - In S8 it moves onto the shared helper, gaining `offset`, `ids` and
    `archived`. `memberships` there means the parent groups a group belongs to.
    The existing parameters stay as they are.

## S8 as built, and what is left

**S8a (run mcp_read_gaps-t8k-s8-q9rn).** These tools are on the shared read.
They keep their existing parameters and defaults, and gain limit, offset,
ids, archived and no_context where the table allows, plus the next-offset
NOTE.

- **get_items and search_items:** `readItems` in `tools/records.ts`. Lists
  go through `platform_search_items`; reads by ids go through readTable. Both
  take include elements, notes and memberships. search_items leaves out
  closed items by default and returns status, closed_reason and context_name.
- **get_intents:** returns description, and takes include notes and
  memberships. include_archived maps to `archived: include`.
- **get_events:** include_archived is mapped the same way.
- **get_collections:** members come from collection_items. The defaults stay
  50 rows with archived included.
- **get_inbox:** `captured_text` is always whole (`fullText`), because
  enrichment reads it.
- **get_contexts:** the defaults stay 50 rows with archived included.
- **get_groups:** adds description and archived, and takes include notes.
- **get_records:** takes include notes and memberships.

**S8b, as planned.** All 22 table-backed tools in the list below were moved.
The ones left as they are: get_execution_history (RPC), get_recent_clips,
the DJ mode reports (albums, artist tags, concerts, managed playlists, plays),
the view-backed Warren Buffet lists, get_wb_tags and get_wb_planned_matches.
Each column kept whole is listed in the progress doc.

- get_execution_history: its RPC needs `p_offset`.
- get_sam_songs, get_sam_sessions, get_sam_passes, get_sam_snippets.
- get_apps, get_recent_clips, get_reminders, get_job_applications.
- DJ: get_dj_albums, get_dj_artists, get_dj_artist_tags, get_dj_concerts,
  get_dj_managed_playlists, get_dj_plays, get_drive_mix_songs.
- Platform: get_platform_runs, get_platform_schedules.
- Ken: get_ken_areas, get_ken_items, get_ken_misconceptions.
- SAM plans: get_sam_goals, get_sam_practice_plans.
- Warren Buffet: get_wb_accounts, get_wb_transactions, get_wb_holdings,
  get_wb_balance_history, get_wb_merchants, get_wb_rules,
  get_wb_subscriptions, get_wb_tags, get_wb_projects, get_wb_planned_items,
  get_wb_planned_matches.
- Warren Buffet tools that read views: get_wb_review_queue,
  get_wb_missed_dates, get_wb_rule_health. readTable reads registered tables
  only, so these need a view path.

Open question for S8b: list previews would cut text that skills read whole
today, for example Ken `ground_truth`, SAM plan instructions and job notes.
The proposal is `fullText` per tool for those columns, as get_inbox does.

**Not list tools; they stay as they are.** These return a computed report, a
single record or images:

- general: get_tags, get_database_schema, get_platform_contract;
- SAM: get_sam_lyric_workspace, get_sam_song_measures, get_sam_measure_stats,
  get_sam_song_scores, get_sam_plan_progress, get_sam_practice_plan;
- other apps: get_clip_slices, get_drive_mix_pick, get_drive_mix_simulation,
  get_job_application_sources, get_ken_quiz_batch, get_ken_lyric_fragments;
- Warren Buffet: get_wb_net_worth, get_wb_cash_flow, get_wb_spending,
  get_wb_rule_preview, get_wb_free_cash, get_wb_cash_projection,
  get_wb_true_cost, get_wb_project_summary, get_wb_settings,
  get_wb_action_items.

## RLS performance (decision 4)

What the policies look like before any change, from the snapshot as of
migration 151:

- **`auth.uid()` per row.** `items_access`, `intents_access`, `contexts_access`
  and all three `notes_*` write policies call bare `auth.uid()`. Wrapping it as
  `(select auth.uid())` lets Postgres evaluate it once per query.
- **Sharing joins.** `items.context_id`, `intents.context_id` and
  `item_groups.context_id` are indexed, as are `items.user_id`,
  `intents.user_id` and `notes(target_type, target_id)`.
  `contexts.shared` has no index, but contexts is a table of about ten rows.
- **Nested RLS.** `notes_select` uses EXISTS against items, intents and
  item_groups, each of which runs its own policy, including the contexts
  subquery. This is fine when notes are read for known targets; it is worth
  timing for a text search over notes.
- **Not RLS, but on the search path.** The search's `executions.item_ids ? i.id`
  has no GIN index on `executions.item_ids`, so it scans executions for every
  item when search text is given.
- **What S5 changes (decision 11):**
  - every items, intents, contexts and notes policy calls `(select auth.uid())`;
  - new `create index ... on executions using gin (item_ids)`.
- **Timing.** A script in `supabase/tests/mcp_read_gaps/` runs
  `explain (analyze, buffers)` as `authenticated` with Alex's jwt claims set.
  It times the queries behind search_items and get_items. Alex runs it before
  the S5 migration and again after it, and both timings are reported.

## Anon privileges (decision 13)

**As built (migration 161),** with intention mvjx48agc7a04lgc1ne folded in
(explicit grants in the standard migration pattern before 2026-10-30):

- **Default privileges.** The global PUBLIC execute on new functions is
  revoked, and the per-schema anon defaults on functions, tables and sequences
  in `public` are revoked. authenticated and service_role keep their defaults.
- **Existing objects.** Every public routine, relation and sequence first gets
  explicit grants for whatever authenticated and service_role can do today.
  Then PUBLIC and anon are revoked. The transaction aborts if authenticated or
  service_role would lose anything.
- **anon keeps nothing.** No caller uses the anon key:
  - The app reads `allowed_emails` only with a session, so as authenticated.
    Its anon SELECT grant is revoked; it let anyone with the public key read
    the allowlist.
  - The Chrome extension posts to clip-capture with its own secret.
  - push-send and sam-song-scores forward the user's token, and
    `verify_jwt = true`.
  - Every other function uses the service role.
- **Views.** All 14 public views, `wb_subscription_overview` included, were
  already `security_invoker`. Nothing to change.
- **Conformance.** `platform.anon_access` (the decision table, empty) and
  `platform.anon_exposure` (anything anon reaches without a decision);
  `check_conformance` fails on either kind of problem.
- **register_table** now grants `service_role` explicitly, and usage on the
  table's own sequences.
- **Where the rule lives.** The contract text gains "RULES FOR ANY NEW VIEW OR
  FUNCTION". The mcp-platform skill gains Rule 2b, and `.claude/CLAUDE.md`
  has a pointer to it.
- **Not changed, but noted:** the `allowed_emails` policy is `USING (true)`
  for every role. Any signed-in Google account can read the list before the
  app signs it out. Narrowing the policy to `email = auth.email()` would close
  that.

The investigation notes below predate the build.

**Where things stand,** from the schema snapshot (through migration 157):

- The default privileges for objects that `postgres` creates in `public` give
  anon ALL on functions, ALL on sequences, and SELECT and MAINTAIN on tables.
- Postgres also gives PUBLIC execute on every new function, and anon inherits it.
- register_table strips anon from tables, but nothing strips it from functions
  or views.
- 52 of 116 public functions carry an explicit anon grant, and the view
  `wb_subscription_overview` is selectable by anon. Migration 159 revoked anon
  only from the Phase 3 `wb_` objects.
- The `platform` schema is safe: anon has no USAGE on it.

The S2b live query below confirms all of this, including any defaults owned
by `supabase_admin`.

**Fix (S2b migration):**

```sql
alter default privileges for role postgres in schema public revoke execute on functions from public, anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;
-- and the same for supabase_admin if the live query shows its defaults granting anon
```

Then the existing objects:

1. `revoke execute ... from public, anon` on every public function.
2. `revoke all ... from anon` on every view.
3. `grant execute ... to authenticated, service_role` where the function has no
   such grant.

Exceptions come from the live query and are recorded, never assumed:

- functions an anon caller really needs, such as an allowed_emails check run
  before sign-in;
- trigger functions, which need no execute grant at all.

**Conformance:**

- A new table `platform.anon_access` (object, kind, reason, decided_at) records
  every deliberate anon grant. allowed_emails' select is the first row.
- A new view `platform.anon_exposure` lists every public function anon can
  execute (`has_function_privilege('anon', oid, 'EXECUTE')`) and every public
  view or materialized view anon can select, unless it is in `anon_access`.
- `check_conformance` appends `ANON EXPOSURE — n objects reachable by anon
  without a decision: …` and is not CONFORMANT while that list has rows.

**Live query for S2b** (one JSON cell; to be run at that step):

```sql
select json_build_object(
  'default_acls', (select coalesce(json_agg(t), '[]'::json) from (
    select pg_get_userbyid(d.defaclrole) as owner_role, n.nspname as schema, d.defaclobjtype as kind, d.defaclacl::text as acl
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
     where n.nspname in ('public', 'platform') or d.defaclnamespace = 0) t),
  'anon_schema_usage', (select coalesce(json_agg(t), '[]'::json) from (
    select nspname, has_schema_privilege('anon', oid, 'USAGE') as usage
      from pg_namespace where nspname in ('public', 'platform')) t),
  'anon_functions', (select coalesce(json_agg(t), '[]'::json) from (
    select p.oid::regprocedure::text as fn, p.prosecdef as security_definer,
           (p.prorettype = 'trigger'::regtype) as is_trigger
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')
     order by 1) t),
  'anon_views', (select coalesce(json_agg(t), '[]'::json) from (
    select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('v', 'm') and has_table_privilege('anon', c.oid, 'SELECT')
     order by 1) t)
) as result;
```

## Build steps

**All steps complete, 2026-10-23.** Migrations 160–164 run; mcp v165
deployed and tested live. The "Waits on" column is kept as planned.

| Step | What | Waits on |
|---|---|---|
| S1 | This spec and the progress doc | — |
| S2 | Read-settings migration `160_mcp_read_settings.sql` plus `platform_read_settings()` | done (CONFORMANT, checkpointed) |
| S2b | `161_mcp_anon_privileges.sql`: anon and PUBLIC revoked, explicit grants, `anon_access` / `anon_exposure`, conformance; heavy-jsonb fix | written; Alex runs |
| S3 | `_shared/platform-read.ts` plus node tests | — |
| S3b | Wire the helper into `platform.ts` (meta) and `mcp/index.ts` (NOTE) | — (files claimed) |
| S4 | `get_records`; deploy | S2, S3b, db:deploy |
| S5 | Search and paging migration; search_items returns `status` and takes the status filter; `(select auth.uid())` in the items, intents, contexts and notes policies; GIN index on `executions.item_ids`; search_items and get_items timed before and after; `search_items` rewired | S3b, db:deploy |
| S6 | Alfred list tools on the helper (get_items, get_intents and the rest) | S3b |
| S7 | `memberships` include on get_items, get_intents and get_records | S6 |
| S8 | Other apps' `get_*` tools, one file per sub-step, plus `get_groups` (`tools/groups.ts`) gaining offset, ids, archived and `memberships`; Warren Buffet last | S3b |
| S9 | Update `mcp-platform/SKILL.md` and `technical-spec-platform-layer.md`; search `.claude/skills/` for the changed tools and old limits and list the edits needed; run the full test suites | S8 |
