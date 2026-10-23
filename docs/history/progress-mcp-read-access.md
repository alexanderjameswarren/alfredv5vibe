# Progress: MCP read access

Project code: mcp_read_gaps-t8k
Spec: docs/history/technical-spec-mcp-read-access.md

## Status: Complete (2026-10-23). Migrations 160–164 run; mcp v165 deployed and tested live.

Database steps follow the just-in-time pattern: gitsync, then a drift check,
then claim the db: items at that step. The `_pending_` migration is numbered
after the sync. Alex runs the SQL, conformance must return CONFORMANT, and
Checkpoint releases the db: claims.

### Steps

- [x] Plan (read-only): run mcp_read_gaps-t8k-s1-k7dq
- [x] Claim: 38 free files and folders in one command. No db: items yet.
- [x] S1. Spec and progress docs
- [x] S2. Read-settings migration `160_mcp_read_settings.sql`: run, CONFORMANT, checkpointed
- [x] S2b. Anon privileges (intentions mvleha5g3w4i21aovjn and mvjx48agc7a04lgc1ne) plus the heavy-jsonb fix: `161_mcp_anon_privileges.sql` run, CONFORMANT, checkpointed
- [x] S2c. Explicit grants for new tables and views: `162_mcp_explicit_table_grants.sql` run, CONFORMANT, checkpointed with the skill
- [x] S3. `_shared/platform-read.ts` and node tests
- [x] S3b. Wire the helper into `platform.ts` (`readSettings`, `readTable`) and `mcp/index.ts` (NOTE via `truncationNote`)
- [x] S4. get_records built, tested and deployed
- [x] S5. `163_mcp_search_and_policies.sql` run; search_items rewired; timed before and after. S5b: `164_mcp_search_set_based_notes.sql` run (search 5 ms)
- [x] S6. Alfred list tools on the helper (folded into S8a)
- [x] S7. memberships include on get_items, search_items, get_intents and get_records
- [x] S8a. get_contexts, get_items, search_items, get_intents, get_events, get_collections, get_inbox and get_groups on the shared read
- [x] S8b. 22 row-list tools on readTable, with per-tool fullText columns; view-backed and computed tools left as they are (see the spec)
- [x] Deploy: mcp v165, verify_jwt false
- [x] S9. Skills updated (mcp-platform, alfred-enrich, job-search, drive-mix); full suites green
- [x] Live test in a fresh Claude thread: passed

### Before S2: live column widths

Run this before S2 so the 1,000-byte heavy threshold is set from real data:

```sql
select json_build_object(
  'jsonb_and_text_widths', (select coalesce(json_agg(t), '[]'::json) from (
    select s.tablename, s.attname, c.data_type, s.avg_width
      from pg_stats s
      join information_schema.columns c
        on c.table_schema = s.schemaname and c.table_name = s.tablename and c.column_name = s.attname
     where s.schemaname = 'public' and c.data_type in ('jsonb', 'text') and s.avg_width > 200
     order by s.avg_width desc) t)
) as result;
```

### Notes

- 2026-10-23 Claim: 38 free paths claimed. These are held elsewhere and not
  claimed:
  - by restructure_p5-h7m: `platform.ts`, `alfred-tools/` and
    `mcp-platform/SKILL.md`;
  - by warren_buffet_p3-q5k: `mcp/index.ts`, `mcp/index.test.mjs`,
    `warren-buffet*.ts` and db:deploy.
- 2026-10-23 Two migrations are numbered 150:
  `150_restructure_p5_shared_group_types.sql` and
  `150_wb_phase3_step9a_action_items.sql`. Reported to Alex.
- 2026-10-23 S1 written. S3 written: `platform-read.ts` has no imports, and its
  16 node tests pass. The full CLI suite passes 239/239. The app suite failed 1
  of 2882 on the first run (flaky, and it touches no file here) and passed
  2882/2882 on the rerun.
- 2026-10-23 Decisions confirmed (run mcp_read_gaps-t8k-s3-r8vc), recorded as
  spec decisions 9–11:
  - restructure_p5-h7m builds get_groups; this thread moves it onto the helper
    in S8;
  - match_key, artist_key and key_signature are cleared;
  - S5 adds the `(select auth.uid())` policy rewrite, the GIN index on
    executions.item_ids, and before/after timings.
  S2 and every later step still wait on both threads.
- 2026-10-23 S2 (run mcp_read_gaps-t8k-s5-n3qd).
  - restructure_p5-h7m and warren_buffet_p3-q5k have Finished, and gitsync has
    run. A re-check found nothing held by any other thread, so 16 more files
    were claimed, plus the S2 db: items (registry, conformance_failures,
    register_table, set_read_settings, check_conformance,
    platform_read_settings, get_platform_contract). db:deploy is not needed for
    S2.
  - Drift check: no synced migration touches the registry, register_table or
    the conformance views, and none registers a table.
  - The duplicate numbers are NOT renumbered: two 150s, and now two 153s too
    (`153_restructure_p5_closed_reason_rules.sql`,
    `153_wb_phase3_step9e_overview_cash_flow.sql`). Reported, not fixed.
  - Migration 160 was written directly under its number; no `_pending_` file
    was ever created.
  - `deno check` cannot resolve the edge-runtime types without
    `deno install`. VS Code shows 0 type errors in platform.ts, mcp/index.ts and
    platform-read.ts. S2 changes no TypeScript.
- 2026-10-23 S2 result (Alex):
  - 160 ran CONFORMANT, with 72 tables visible and the 4 expected
    non-default tables. Alex checkpointed it.
  - heavy_columns came back empty. Cause: pg_stats records TOASTed values at
    pointer size. Fixed in 161.
  - Checkpoint left the 7 S2 db: claims held. Released at the start of S2b.
- 2026-10-23 S2b (run mcp_read_gaps-t8k-s6-h5tx):
  - Written: `161_mcp_anon_privileges.sql`, Rule 2b in
    `.claude/skills/mcp-platform/SKILL.md`, and the pointer in
    `.claude/CLAUDE.md`.
  - No function is kept for anon. allowed_emails loses its anon SELECT.
  - wb_subscription_overview was already security_invoker.
  - The run aborts if authenticated or service_role would lose any grant.
- 2026-10-23 S2b result (Alex):
  - 161 ran CONFORMANT. anon reaches nothing, and the heavy columns are
    correct.
  - Alex checked the app signed in: Home, Inbox and Money load. MCP reads and
    writes work.
  - Checkpoint a8919b2 is merged in main (851f2cf). It again left the 7 db:
    claims held; I released them.
- 2026-10-23 S2c and S4 (run mcp_read_gaps-t8k-s7-b2kf).
  - **Migration 162** adds `platform.grant_table(regclass)`. It grants
    select, insert, update and delete to authenticated and service_role (select
    only for a materialized view), grants usage on the table's own sequences,
    and strips anon and PUBLIC.
    - register_table calls it.
    - 162 applies it to every registered table and every public view.
    - The run aborts if any of those still lacks a grant.
  - **Local test.** `supabase db reset` cannot run:
    - versions 122, 150 and 153 are each used twice;
    - `config.toml` has no project_id or [db] section;
    - the original tables predate the migrations folder.
    Instead I used a throwaway `supabase/postgres:17.6.1.063` container: the
    schema snapshot, then `supabase/tests/mcp_read_gaps/1_local_seed_registry.sql`,
    then 158–162, then `2_local_grants_test.sql`, which revokes all default
    table grants as Supabase will from 2026-10-30.
    - Every migration applied, and the result was CONFORMANT.
    - 35/35 checks passed: authenticated inserted, read, updated and deleted
      through RLS on a newly registered table and view; anon was refused on
      tables, views and get_platform_contract; anon_exposure was empty.
    - Negative control: an unregistered table under the same defaults gave
      authenticated no SELECT.
  - **S4:**
    - `platform.ts` gains `readSettings` and `readTable`, and `EnvelopeMeta`
      gains `next_offset` and `notes`.
    - The NOTE in `mcp/index.ts` comes from `truncationNote`. Existing tools'
      text is unchanged.
    - `get_records` is in `tools/records.ts` and registered; 141 tools in all.
    - 7 tests in `records.test.mjs`.
    - Test harnesses that copy the real platform.ts now copy
      platform-read.ts too: index.test, sam-measure-stats.test and
      sam-plans.test. **sam-snippets.test.mjs needs the same one line but is
      not claimed by this thread**, so it fails until Alex approves the edit.
  - Tests: 701/702 edge, 239/239 CLI, 3019/3019 app. 0 type errors in VS Code
    diagnostics. `deno check` still can't resolve edge-runtime types without
    `deno install`.
- 2026-10-23 S2c result (Alex): 162 ran CONFORMANT. anon reaches nothing;
  72 tables and 14 views are granted. Checkpointed with the skill using
  --release-db. The local-rebuild problem is logged as an Alfred bug and not
  fixed here.
- 2026-10-23 S5, S7 and S8a (run mcp_read_gaps-t8k-s8-q9rn).
  - **Migration 163:**
    - platform_search_items matches each word separately in the name, the
      description or notes. Words are split on spaces and punctuation, and
      `%`, `_` and `\` are literal.
    - It sorts name matches first and gains p_offset, p_archived and
      p_no_context.
    - It is security invoker, with no user_id filter.
    - The items, intents, contexts and notes policies use
      `(select auth.uid())`.
    - It adds the GIN index `idx_executions_item_ids` and explicit grants.
  - **Local check:** snapshot, then 158–163, gave CONFORMANT.
    `4_local_search_test.sql` passed 8/8, as an authenticated user:
    - word order, name matches first, and RLS (own and shared rows, not
      another user's private rows);
    - the status filter, archived=only, note bodies searched;
    - `%` and `_` literal, punctuation ignored, no_context, offset.
  - **Timing file:** `3_search_timing.sql`. Each query runs 3 times with
    EXPLAIN ANALYZE, as the user who owns the most items. Smoke-tested
    locally.
  - **Code:**
    - `platform.ts`: readTable gains `order`, `omit` and `fullText`; new
      `requireSettings` and `finishRead`.
    - `platform-read.ts`: shapeRows takes `fullText`.
    - `records.ts`: the shared includes (context names, intent text, notes,
      memberships), `readItems` and `withCollectionMembers`.
    - `groups.ts`: readTable.
    - `index.ts`: 8 tools moved, plus one `readOptions()` schema helper.
  - **Tests:** 740/740 edge (sam-snippets fixed), 239/239 CLI, 3019/3019 app.
    `deno check platform-read.ts` is clean. VS Code shows 0 diagnostics on
    the changed files, but whether the Deno server analyses them is
    unconfirmed.
- 2026-10-23 163 result (Alex):
  - CONFORMANT, search_finds_style_item true, policies_with_bare_uid [],
    function_is_invoker true, GIN index created. Checkpointed with
    --release-db.
  - Live timings, minimum of three runs, before → after 163:

    | query | before | after |
    |---|---|---|
    | search, four words | 18.45 | 49.00 ms |
    | search, one common word | 25.16 | 95.37 ms |
    | list, no search | 1.45 | 3.95 ms |
    | items page | 0.86 | 0.61 ms |
    | intents page | 0.36 | 0.29 ms |
    | notes search | 0.97 | 0.93 ms |
    | executions by item_ids | 0.43 | 0.46 ms |

- 2026-10-23 S5b, run mcp_read_gaps-t8k-s9-c3ly.
  - **Cause, from EXPLAIN on a local copy at live scale:** the notes arm was a
    correlated subquery, so notes were rescanned for every item and every
    word, and under RLS each note row also ran the notes policy. On the same
    four-word search:

    | variant | time |
    |---|---|
    | 163 as it is | 416 ms |
    | 163 with RLS off | 213 ms |
    | 163 without the notes arm | 1 ms |
    | set-based notes | 7 ms |

  - **Migration 164** finds each word's notes once and maps them to items.
    Locally: four words 487 → 7 ms, one word 160 → 4 ms, with identical
    totals, and `4_local_search_test.sql` passes 8/8. No trigram index is
    needed. The timing file gains a notes-heavy query.
- 2026-10-23 164 result (Alex): CONFORMANT, search_finds_style_item true,
  function_is_invoker true. Checkpointed with --release-db (5bb4a67, merged
  at fdf9bdb).
  - Live timings, minimum ms, 163 → 164 (pre-163 in brackets):

    | query | pre-163 | 163 | 164 |
    |---|---|---|---|
    | search, four words | 18.45 | 49.00 | 5.37 |
    | search, one common word | 25.16 | 95.37 | 5.10 |
    | search, two words mostly in notes | — | — | 4.77 |
    | list, no search | 1.45 | 3.95 | 3.60 |
    | items page | 0.86 | 0.61 | 0.60 |
    | intents page | 0.36 | 0.29 | 0.27 |
    | notes search | 0.97 | 0.93 | 0.89 |
    | executions by item_ids | 0.43 | 0.46 | 0.45 |

  - Search is now 3–5 times faster than before 163, with RLS deciding.
- 2026-10-23 S8b, in progress. **Stopped:** the claims guard blocked a
  read-only grep/sed/awk command on `supabase/functions/mcp/index.ts` as an
  mv/cp write.
  - Converted to readTable, with the columns kept whole:
    - get_apps (description);
    - get_platform_runs (details, error_message);
    - get_platform_schedules (notes);
    - get_drive_mix_songs;
    - get_dj_artists (notes);
    - get_job_applications (notes, next_action);
    - get_ken_areas (description);
    - get_ken_items (prompt, ground_truth; tricky_fragments left out);
    - get_ken_misconceptions (note);
    - get_reminders (text);
    - get_wb_merchants (notes), get_wb_rules (notes, match),
      get_wb_projects (notes), get_wb_planned_items (notes);
    - get_wb_holdings;
    - get_sam_goals (notes);
    - get_sam_practice_plans (day_note, internal_notes,
      review_instructions, review_note);
    - get_sam_songs (measures left out; was unbounded, now 50 per page);
    - get_sam_sessions (settings, summary; events left out);
    - get_sam_passes;
    - get_sam_snippets (notes, settings; was unbounded, now 50 per page).
  - Not done:
    - the index.ts registrations, which add offset and ids to those schemas;
    - the clipboard.test harness;
    - S9 (skills).
  - Edge tests: 732/736. The 4 failures are those pending items.
- 2026-10-23 S8b done and S9 started (run mcp_read_gaps-t8k-s10-m4ze).
  - The index.ts schemas advertise the shared options on all 22 tools, and
    clipboard.test is fixed. The parity tests count the shared options for
    readTable tools (`addSharedRead`).
  - The mcp-platform skill has the new read rules.
  - **Stopped:** the claims guard blocked editing
    `.claude/skills/alfred-enrich/SKILL.md`, which is unclaimed. job-search
    and drive-mix also need edits and are unclaimed too. Not deployed.
  - Tests: edge 741/741, CLI 239/239, app 3019/3019. VS Code shows 0
    diagnostics. A full `deno check` is not possible without `deno install`.
- 2026-10-23 S9 and deploy (run mcp_read_gaps-t8k-s11-w7tp).
  - Alex approved claiming the alfred-enrich, job-search and drive-mix skills;
    the paging and search_items edits are made.
  - Tests:
    - Edge: the first run gave 736/737, with one test file failing to load.
      Six reruns all gave 741/741, so the failure was a one-off that never
      came back.
    - CLI 239/239, app 3019/3019.
  - **Deployed:** `supabase functions deploy mcp --no-verify-jwt` made mcp
    v165, ACTIVE, with verify_jwt false. db:deploy was claimed and released.
  - Live checks:
    - search_items "style consistency design contract" now finds the item,
      with status and context_name.
    - get_intents returns description, and its NOTE reads "2 of 55. Next
      page: offset=2".
- 2026-10-23 Live testing in a fresh Claude thread (Alex, run
  mcp_read_gaps-t8k-s12-f6hv). Passed:
  1. search_items found the style item, with its status.
  2. get_intents paged correctly with offset.
  3. get_intents by ids returned the description.
  4. get_items by id included elements, notes and memberships.
  5. get_records on push_subscriptions returned no secret columns.
  6. get_records on items previewed long text and left out elements, with a
     note explaining both.
  7. get_groups returned an empty list without error; the table is empty,
     and Alex accepted that as working.

  A row owned by another user appeared. It is in the shared Shopping context,
  which is correct under RLS.
  **Project complete.** Both docs moved to docs/history/ for gitpush Finish.
