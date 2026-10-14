# Warren Buffet Phase 3 — Progress

Project code: `warren_buffet_p3-q5k`. Spec: `docs/technical-spec-warren_buffet_p3-q5k.md`.
No amounts in this file. The safety floor is never written into the repo.

| step | what | status |
|---|---|---|
| 1 | Read-only plan | done, 2026-10-14 |
| 2 | Migration C: tables, `wb_splits.project_id`, `wb_replace_splits` | done, 2026-10-14 (133 applied, 134 41/41) |
| 3 | Help for Phase 2 screens | not started |
| 4 | Processing and match suggestions | not started |
| 5 | Views and projection | not started |
| 6 | MCP tools | not started |
| 7 | Seeding in claude.ai | not started |
| 8 | Plan tab UI | not started |
| 9 | Overview numbers | not started |
| 10 | Weekly cleanup prompt | not started |
| 11 | Phase 3 review | not started |

## Log

### Step 1 (2026-10-14, run tag `warren_buffet_p3-q5k-s1-h3m8`)
- The plan was approved with 13 amendments, A1–A13, now spec §2.2.
- Corrections made in the plan:
  - Subscription detection runs in wb-sync, not in processing.
  - The burn rate would have counted subscriptions twice (now A3).
  - Card balances were missing from the projection's start (now A4).

### Step 2 (2026-10-14, run tag `warren_buffet_p3-q5k-s2-v7c4`)
- Spec and progress written. All 19 planned files and folders claimed in one command, with `src/money/` claimed as a folder.
- Drafts:
  - `supabase/migrations/_pending_warren_buffet_p3-q5k_phase3_tables.sql`: four audited tables, `wb_splits.project_id` and `wb_replace_splits` (spec §3.6). It ends with `register_table` for each table and the conformance result.
  - `supabase/migrations/_pending_warren_buffet_p3-q5k_phase3_tables_tests.sql`: 37 checks with invented fixtures. It rolls itself back.
- PGlite:
  - The new tests pass 37/37.
  - The Phase 2 tests still pass: 115 13/13, 118 24/24, 121 39/39, 123 15/15, 125 22/22, 128 17/17, 130 17/17, 132 19/19.
  - PGlite caught a bug: two check constraints let a null stage or a null interval unit through as "unknown". This is fixed with explicit `is not null`.
- Next:
  1. Alex runs gitsync.
  2. Drift check.
  3. Claim the step 2 `db:` items.
  4. Number the files.
  5. Alex runs the migration, then the tests.

### Step 2, continued (2026-10-14, run tag `warren_buffet_p3-q5k-s2-m3qd`)
- gitsync was a clean fast-forward (4aa2882..3425c2c): 22 restructure-p4 UI and doc files.
- **Drift check: none.** No migration, nothing under `supabase/`, and nothing touching wb_ objects. The last migration is still 132.
- A14, from Alex: `wb_planned_items.is_draft`, default false, true only on recurring items. It is in the spec, with 3 new checks.
- Claimed six db: items: `db:table:wb_projects`, `wb_planned_items`, `wb_planned_matches`, `wb_settings` and `wb_splits`, plus `db:fn:wb_replace_splits`. Also claimed the two numbered paths.
- Numbered the files `133_wb_phase3_step2_tables.sql` and `134_wb_phase3_step2_tests.sql`. Both `_pending_` files are deleted.
- PGlite: 134 passes 41/41, and the Phase 2 tests still pass (115, 118, 121, 123, 125, 128, 130, 132).
- Waiting for Alex to run 133 then 134 in the SQL editor.

### Step 2, verified (2026-10-14, run tag `warren_buffet_p3-q5k-s2-t8wn`)
- Alex ran 133 (conformant true, failures []) and 134 (all_passed true, 41/41, rolled back).
- The CLI verified the live database through the Alfred tools.
  - `check_platform_conformance` is CONFORMANT, 67 tables: 63 before, plus 4.
  - `get_database_schema` on the four new tables and `wb_splits` shows:
    - every column, default, check constraint and FK action as specified, including `is_draft`, nulls-not-distinct uniqueness on matches, and restrict on split and planned item;
    - the indexes;
    - one intents-shaped policy each;
    - registry entries that are audited, with policy_mode none;
    - `wb_splits.project_id` with on delete set null.
- `wb_replace_splits` behaviour on live is covered by 134's resplit checks.
- **Step 2 done.** Checkpoint paths: 133, 134, the spec and the progress file, with `--release-db`.
