# Warren Buffet Phase 3 — Progress

Project code: `warren_buffet_p3-q5k`. Spec: `docs/technical-spec-warren_buffet_p3-q5k.md`.
No amounts in this file. The safety floor is never written into the repo.

| step | what | status |
|---|---|---|
| 1 | Read-only plan | done, 2026-10-14 |
| 2 | Migration C: tables, `wb_splits.project_id`, `wb_replace_splits` | done, 2026-10-14 (133 applied, 134 41/41) |
| 3 | Help for Phase 2 (and Phase 1) screens | done, 2026-10-14 (app-tested by Alex; checkpointed b6e42a8) |
| 4 | Processing and match suggestions | done, 2026-10-17 (135 applied, 136 35/35; 4b app-tested by Alex) |
| 5 | Views and projection | done, 2026-10-19 (137 applied, 138 42/42; live batches 1–5 passed) |
| 6 | MCP tools. **Any other thread must run gitsync before deploying mcp, or the WB Phase 3 tools disappear from live (A31)** | done, 2026-10-19: live on **mcp v155** (134 tools); fresh-thread batches 1–3, the re-check and the cleanup all passed |
| 7 | Seeding in claude.ai. **Notes:** give every planned item a merchant wherever possible, because items with no merchant are never suggested; and **re-run processing once after seeding** (`reprocess_wb_transactions`), so suggestions are made for existing payments (A19). **Known double count until then:** a past payment for something that later becomes a planned item stays in the burn rate until it is confirmed as a match | done, 2026-10-19 (in claude.ai; see log) |
| 8a | Plan tab database (spec §3.8; decisions A34–A41) | done, 2026-10-19 (140 applied, 141 48/48; live CONFORMANT, 68 tables) |
| 8b | **Tools first (A42, A43).** New tools: project summary, missed dates, mark not needed, unconfirm (tier 2, `paid_not_covered`). Changed: the free cash what-if (tier 1, writes nothing), `backdated_from`, `project_names`, `over_matched`. Needs `mcp/index.ts`. **Live mcp must still be v155 before deploying; if higher, stop and ask** | done, 2026-10-20: live on **mcp v157** (138 tools), with the tolerance fix (A45; 143 applied, 144 24/24); re-check and fresh-thread batches passed |
| 8c | Planning skill `.claude/skills/wb-planning/SKILL.md` (A44); scripted planning conversation in a fresh thread. **Notes from 8b:** (a) for bills whose amount varies (fuel, utilities), suggest a wider amount_tolerance before backdating, or only some payments qualify; (b) when backdating moves the due day, tell Alex the new day | done, 2026-10-20 (all six fresh-thread tests passed; two fixes to the skill, see log) |
| 8d | Slimmer app (A44, A46, A47): 8d-1 the delete function; 8d-2 the Plan overview (read-only missed dates); 8d-3 project detail; 8d-4 item detail (Remove match, Delete item); 8d-5 the full Review card; 8d-6 the single-part project picker; help. **No add or edit forms, and no split-editor picker** | 8d-1 done 2026-10-21 (146 applied, tests 12/12); 8d-2 and 8d-3 tested 2026-10-21; 8d-4 done 2026-10-22 (fixes re-tested); 8d-5 and 8d-6 tested 2026-10-22. **8d done 2026-10-22, live** (merge 4bd3d97; the live Plan tab matches local testing) |
| 9 | Overview numbers, plus Action Items and Dropping below the floor (A49). Data first, then mockups in claude.ai, then the UI | 9a and 9b done 2026-10-23: 150 and 151 applied (live tests 40/40 and 21/21; A51); 9c done (mcp v159, fresh-thread check passed); 9d built (moneyApi reads, unit-tested); 9e live 2026-10-23 (A52, A53; checkpoint 1d583db, merged as ffeb7cc); 9f done 2026-10-23 (mcp v160, fresh-thread check passed). **Step 9 done** |
| 10 | Weekly cleanup prompt, **plus the `never_fires` fix (spec A16)**: flag a rule when its last match is older than about 1.5× its expected interval, and give a new rule that long before its first match is due; update `rule_health.never_fires` help and `ruleNumbers.js` with it; **and count a hand change to a rule-set project as an often_overridden override** (redefines `wb_rule_health_all`, with A15 comments). **Done when** the planned-items section lists every overdue unmatched one-off **and every missed date of a recurring planned item** as unmatched (A25), because the projection does not count those. **Also check (not a bug):** in the step 6 fresh thread, July 2026's burn `subscription_excluded` was much smaller than Aug and Sep. The likely cause is that older subscription charges were never linked. Check the links and relink if needed. **Also: a sync encoding check.** A SimpleFIN account name arrives as "VISA SIGNATURE�� CARD", with the ® garbled (found 2026-10-23); find where wb-sync decodes it | not started |
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

### Step 3 (2026-10-14, run tags `warren_buffet_p3-q5k-s3-p4jx` plan, `-s3-w2hd` build)
- Plan approved: Phase 1 screens included; Spending and transaction detail kept; Keep watching folded into review.new_recurring and subscription.status.watching; Review soon (30 days) explained in subscription.next_expected; inline notes kept.
- Built:
  - `src/money/helpText.js`: 35 entries, 7 of them reserved (the 6 rule_health entries per A9, plus review.planned_match).
  - `src/money/HelpButton.jsx`: the "?" button and HelpSheet, with an optional live working block.
  - `src/money/ruleNumbers.js`: JS mirrors of the numbers that live only in SQL.
  - "?" buttons on Review, Subscriptions, Subscription detail, Transactions, Transaction detail, Always do this, Spending, Overview, Net worth and Accounts.
- Live working on:
  - the monthly total (counted, and not counted with reasons);
  - Overdue (each subscription's last and expected dates);
  - Next expected (last charge, interval, review date);
  - Spending by category (total and uncategorized).
- Number drift: `helpText.test.js` checks every number in the wording against the JS constant. For SQL-only numbers it also reads the newest migration defining `wb_transfer_match`, `wb_detect_subscriptions`, `wb_subscription_overview` and `wb_rule_health_all` and checks the value there.
  - JS constants carry "update the help" comments. `findPairCandidates` now uses `TRANSFER_WINDOW_DAYS`, and `monthlyEquivalent` uses `WEEKS_PER_YEAR` and `MONTHS_PER_YEAR`.
  - **SQL comments not added:** those migrations (103, 120, 124, 131) are not claimed. This is waiting for Alex.
- **Bug found (not fixed, per Alex):** rule health `never_fires` flags a rule with `hit_count = 0` once it is 14 days old. That means "never matched anything", not "no match in 14 days". A monthly rule made for a merchant with no past charge is flagged from day 14 until its first charge arrives (up to about day 35), because only subscriptions billed every 3 months or more are exempt. A rule that matched once long ago is never flagged. The wording describes the real behaviour.
- Tests: app 2542/2542 (150 suites), CLI 224/224; the production build compiled successfully.

### Step 3 fixes (2026-10-14, run tag `warren_buffet_p3-q5k-s3-h6tz`)
- App test passed. There were two layout fixes:
  - **The "?" now sits inline after the last word of each title** and wraps with it. `HelpAfter` and `HelpTitle` in `HelpButton.jsx` do this. The icon is 24px with an invisible 44px tap box. The pattern is used on every titled "?".
  - **The help panel scrolls.** The header is fixed, the body scrolls, the height is capped at 85dvh (85vh as a fallback), and the bottom padding is 1.5rem plus the safe-area inset.
- Decisions:
  - SQL comments go in the next migration that redefines each object (spec A15).
  - `never_fires` is fixed in step 10 (spec A16; added to the step 10 row above).
- Live working was added to four more entries:
  - `review.price_change`: each charge, the expected price and the tolerance, from `getSubscriptions`, loaded only when the panel opens.
  - `review.new_recurring`: the linked charge dates, from `getSubscriptionDetail`.
  - `spending.cash_flow`: six-month totals, the months that ran negative, and the unprocessed count.
  - `transaction.kind`: who set it, and the rule's name, from the new `getKindRule`. That reads `wb_transactions.matched_rule_ids` and `wb_rules`, and takes the last matched rule that sets a kind, because later rules overwrite.
- Note: the cash-flow working cannot split In or Out by kind without new database work. `wb_cash_flow_monthly` has only income, spending, net and unprocessed.

### Step 3 panel fix (2026-10-14, run tag `warren_buffet_p3-q5k-s3-r9bq`)
- **Cause, confirmed in the code:** `HelpSheet` was rendered as a child of `HelpButton`, which sits inside `HelpAfter`'s `whitespace-nowrap` span. Every line of the panel inherited nowrap and ran off the right edge. The bottom-sheet variant (`items-end`, plus the safe-area padding) caused the floating look.
- **Fix:**
  - `HelpSheet` now renders through `createPortal` into `document.body`. The "?" stays inline.
  - There is one layout at every width: a card with a 16px gutter on each side, at most 480px wide, placed at 10vh from the top. Its height is capped at 80dvh, with 80vh as a fallback. The title row is fixed and the body scrolls vertically only, with `overflow-x: hidden`, `white-space: normal` and `overflow-wrap: anywhere`.
  - The bottom sheet is gone. ✕, Esc and the backdrop all still close it.
  - The backdrop stops click propagation, because React events bubble through a portal.
- **Tests:** two new ones. One checks that the open panel is a child of `document.body` and not inside the title. The other checks that clicks inside the panel do not reach the title's ancestors.
- **Headless check:** a static copy of the open panel was run with the built CSS and the real wording in headless Chrome, inside a 375px iframe.
  - The panel body's scrollWidth is 341, equal to its clientWidth of 341.
  - The card runs from left 16 to right 359, with its top at 70 (10vh).
  - The document's scrollWidth is 375.
- **Results:** app 2546/2546 (the SAM test passed this run), CLI 224/224, and the build compiled successfully.

### Step 4 (2026-10-16, run tags `warren_buffet_p3-q5k-s4-d5lw` plan, `-s4-n8rc` 4a)
- Plan approved, with A17–A21 in the spec. `wb_planned_occurrences` moved from step 5 to step 4 (spec §3.7).
- **Wording for 4b**, from Alex's fixes:
  - `review.planned_match`, "What to do": "If only part of this payment is for the planned item, lower the amount before confirming."
  - "What's left out" includes "payments for less than the planned amount (match those by hand once the planning tools arrive)".
  - No default numbers (A21).
- 4a drafted as `supabase/migrations/_pending_warren_buffet_p3-q5k_match_suggestions.sql`, with these changes:
  - `wb_rules.set_project_id`;
  - `wb_splits.project_source`, with a fill trigger (no source means manual);
  - `wb_planned_occurrences`, `wb_suggest_planned_matches` and `wb_confirm_planned_match`;
  - `wb_replace_splits`, now with project_source;
  - `wb_process_transactions`: 5c rule projects, then suggestions over the posted ids it processed; the result gains `rule_projects` and `matches_suggested`;
  - `wb_review_queue`: `planned_match`, plus planned_* columns at the end for the Review group and its working;
  - `wb_transaction_list.needs_review`.
- The suggestion function keeps its candidate pairs in a jsonb variable, not a temp table, so it needs no TEMP privilege.
- Tests: `_pending_…_match_suggestions_tests.sql`, 35 checks with invented fixtures; it rolls itself back.
- PGlite: 35/35, and the regressions all pass: 115, 118, 121, 123, 125, 128, 130, 132 and 134.
  - PGlite caught a problem along the way: the new "project needs a source" check broke direct project writes, including 134's. The fill trigger fixes it.
  - Known edge: deleting a project leaves `project_source` at manual on its splits, so no rule sets a project there again. Tools only soft-delete, so this should be rare.
- Waiting for Alex's gitsync before the drift check, the db: claims and numbering.

### Step 4a numbered (2026-10-17, run tag `warren_buffet_p3-q5k-s4-q2jf`)
- gitsync was a clean fast-forward (7a575cf..75c099d), 31 files: the email-capture fix and restructure-p4 UI work.
  - The step 4 plan had said only email-capture would come in. That was wrong: it compared from b1dc642, not from this worktree's HEAD.
- **Drift check: none.**
  - No migration came in, nothing touching wb_ objects, and nothing under `src/money/`.
  - Money imports only `EditCard` and `UnderlineTabs` from `src/shared/` (neither changed) and nothing from `src/utils/recurrence*`.
  - The folder still ended at 134.
- Claimed the 11 db: items and the two numbered paths.
- Numbered the files `135_wb_phase3_step4_match_suggestions.sql` and `136_wb_phase3_step4_tests.sql`. The diff against the `_pending_` files shows only header changes. Both `_pending_` files are deleted.
- PGlite: 136 passes 35/35, and 115, 118, 121, 123, 125, 128, 130, 132 and 134 all still pass.
- Waiting for Alex to run 135 and then 136.

### Step 4a verified, 4b built (2026-10-17, run tag `warren_buffet_p3-q5k-s4-g6vt`)
- Alex ran 135 (conformant true, failures []) and 136 (35/35, rolled back).
- **Verified on live** with the Alfred tools:
  - `check_platform_conformance` is CONFORMANT, 67 tables.
  - `wb_splits.project_source` is there, with its check constraint. `wb_rules.set_project_id` is there, with on delete set null.
  - `get_wb_review_queue` still returns the queue through the redefined view.
  - The schema tool cannot read views or function bodies. The live 136 run covers those: `result_counts_projects` and `result_counts_suggestions` read the new process result keys, and the queue and list checks read the new view columns.
- **4a done.** 135 and 136 are marked applied.
- **4b built:**
  - `REVIEW_LABELS` and `REVIEW_ORDER` gain `planned_match`, "Suggested match", placed after "Looks like a transfer".
  - `moneyApi`: the queue reads the planned_* columns. New `confirmPlannedMatch(id, amount?)` and `rejectPlannedMatch(id)`, both through `wb_confirm_planned_match`. Plain sentences for the over-amount, already-decided and zero refusals.
  - Review: each suggestion shows "The app suggests this pays: <item>, due <date>, planned <amount>" under the payment, with Confirm, "Lower amount…" (amount box, then "Confirm amount") and "Not this one". There is no "Mark reviewed" on these rows.
  - The "?" has live working: planned against paid, the amount gap against the tolerance, and the days apart against the window.
  - `review.planned_match` is no longer reserved, and carries Alex's two wording fixes.
  - Tests: 3 in `ReviewScreen.test.jsx` and 3 in `moneyApi.test.js`. `helpText.test.js` now requires the entry, because it is in `REVIEW_ORDER`.
- Results: app 2616/2616 (157 suites), CLI 224/224, and the build compiled successfully.

### Step 4 done (2026-10-17, run tag `warren_buffet_p3-q5k-s4-b3ys`)
- Alex's app test passed, using a temporary planned item: the suggestion, the help working, the review chip, Not this one (not suggested again), Lower amount, Confirm, and the cleanup. The temporary item and its matches were deleted.
- Wording: under "What's left out" in `review.planned_match`, the text is now "payments for less than the planned amount, beyond its tolerance (match those by hand once the planning tools arrive)".
- Money tests 102/102; the build compiled successfully.
- **Step 4 done.** Checkpoint: 135, 136, the app files and the docs, with `--release-db`.

### Step 5 (2026-10-17, run tags `warren_buffet_p3-q5k-s5-k7mf` plan, `-s5-c4wr` 5a)
- Plan approved with A22–A28 in the spec. Step 3 is marked done.
- **5a drafted** as `supabase/migrations/_pending_warren_buffet_p3-q5k_projection.sql`. Everything in it is new; nothing is redefined:
  - `wb_monthly_equivalent`;
  - `wb_subscription_occurrences` and the `wb_subscription_outflows` view;
  - `wb_burn_rate_on` and the `wb_burn_rate` view;
  - the `wb_true_cost` view;
  - `wb_cash_projection` and `wb_free_cash`.
- A15 comments at birth: the 52 and 12 in `wb_monthly_equivalent`, and the 3 months in `wb_burn_rate_on`.
- **Tests:** `_pending_…_projection_tests.sql`, 42 checks. The dates are in 2031, so real data stays out of the burn months, and everything else is measured as a change caused by the fixtures.
- **PGlite:** 42/42. All earlier test files still pass: 115, 118, 121, 123, 125, 128, 130, 132, 134 and 136.
- **App:**
  - Six reserved help entries (A22). The burn rate wording has Alex's fix: "Spending and fees, less refunds…".
  - `BURN_MONTHS` in `ruleNumbers.js`.
  - `helpText.test.js` checks the new numbers against the SQL, and has an A12 test. That test checks the source of `wb_monthly_equivalent` against `WEEKS_PER_YEAR` and `MONTHS_PER_YEAR`, and runs the same five cases the SQL tests run. The SQL lookup now includes `_pending_` files, which count as the newest.
  - Money tests 103/103; the build compiled successfully.
- **One choice to confirm:** a subscription charge 0–7 days late also counts on day 1 (A24).
- Waiting for Alex's gitsync.

### Step 5a numbered (2026-10-17, run tag `warren_buffet_p3-q5k-s5-y8kd`)
- gitsync was a clean fast-forward (0e2fd0c..714fd23), 23 restructure-p4 files.
- **Drift check: none.**
  - Nothing came in under `supabase/` or `src/money/`, and no wb_ objects.
  - `EditCard` and `UnderlineTabs`, the only shared files Money imports, are unchanged.
  - The folder still ended at 136.
- A24 confirmed by Alex: a charge 0–7 days late counts on day 1.
- Claimed the 8 db: items and the two numbered paths.
- Numbered the files `137_wb_phase3_step5_projection.sql` and `138_wb_phase3_step5_tests.sql`. The diff against `_pending_` shows only header changes. Both `_pending_` files are deleted.
- PGlite: 138 passes 42/42, and all 10 earlier test files still pass. `helpText.test.js` passes 7/7 against the numbered SQL.
- Waiting for Alex to run 137, then 138.

### Step 5a verified (2026-10-17, run tag `warren_buffet_p3-q5k-s5-f3nb`)
- Alex ran 137 (conformant true, failures []) and 138 (42/42, rolled back; `precondition_no_real_2031_spending` true).
- `check_platform_conformance`: CONFORMANT, 67 tables.
- The live 138 run exercised every new function and `wb_true_cost`. The live read check (batch 1) exercises `wb_burn_rate` and `wb_subscription_outflows`.
- **5a done.** 137 and 138 are marked applied.
- The live tests (batches 1–5: read check, a temporary bill, the same bill as a draft, a temporary recurring income, then cleanup) went to Alex.

### Step 5 done (2026-10-19, run tag `warren_buffet_p3-q5k-s5-w6pa`)
All five live batches passed (Alex):
- **Batch 1, read check:**
  - The burn median and mean are correct for Jul–Sep 2026.
  - The start balance is spending cash minus credit owed.
  - The daily burn is the median × 12 ÷ 365.
  - The subscription monthly figure matches the Subscriptions tab.
  - The low point is on the last day, and equals the start minus 365 days of burn minus a year of subscriptions.
  - `floor_missing` is true.
- **Batch 2:** a one-off bill 14 days out lowered free cash by exactly its amount, on its due date.
- **Batch 3:** as a draft, the bill dropped out of free cash and stayed in free cash with drafts.
- **Batch 4:** a monthly income gave 12 dates, each on the same day of the month. Free cash rose by exactly 12 times the amount. `expected_income_monthly` equalled the amount, and `net_monthly` moved by it.
- **Batch 5:** the cleanup returned every value to batch 1.

**Step 5 done.** Checkpoint: 137, 138, the help and number files, and the docs, with `--release-db`.

### Step 6a (2026-10-19, run tags `warren_buffet_p3-q5k-s6-j4tz` plan, `-s6-p9xe` build)
- Plan approved, with A29–A33 in the spec.
- **Built:**
  - `supabase/functions/_shared/tools/warren-buffet-p3.ts`, 13 tools:
    - get_wb_projects, get_wb_planned_items, get_wb_planned_matches, get_wb_settings, get_wb_free_cash, get_wb_true_cost (with burn months), get_wb_cash_projection (event days and the low point only);
    - upsert_wb_project, upsert_wb_planned_item (then `wb_suggest_planned_matches`);
    - create_wb_planned_match (**tier 3**: propose and handler share `matchPlan`, then confirm through `wb_confirm_planned_match`, and delete the row if that refuses);
    - update_wb_planned_match (tier 2, through `wb_confirm_planned_match`);
    - set_wb_transaction_project (at most 25, single-split only);
    - update_wb_settings (tier 3; the proposal shows current against proposed).
  - `warren-buffet-p2.ts`:
    - the review queue accepts `planned_match` and returns the planned_* columns;
    - rules take `set_project_id`, which counts as a rule action, and `get_wb_rules` names the project;
    - `split_wb_transaction` passes `project_id` per part, but only when given;
    - plain sentences for the Phase 3 refusals.
  - `mcp/index.ts`: 13 registrations, plus the changed queue, rule and split schemas. The tool count goes from 121 to 134.
- **Tests:**
  - `warren-buffet-p3.test.mjs`, 12 tests: tiers, draft flags and remaining amounts, event days and truncation, suggestions after a write, the propose fields and every refusal, confirm-or-clean-up, single-split projects, and the settings proposal writing nothing.
  - `index.test.mjs`: the count is 134. There is a P3 schema-versus-handler and tier test, and a description test, including no `$` amounts in any WB description.
  - Results: functions 733/733, CLI 224/224.
- **`deno check` not run yet:** the claims guard blocked my command, because it piped the output through `tee` into a temp file. That counts as a shell write, and the guard read it as one under the unclaimed `supabase/functions/mcp`. As the rules say, I stopped and asked Alex rather than running it another way.
- **deno check (2026-10-19, run tag `warren_buffet_p3-q5k-s6-b2kw`):**
  - Run from the worktree root, without `--config`, Deno picks up the root `package.json` and fails before checking anything. Every run below therefore uses `--config supabase/functions/mcp/deno.json`, with `--no-lock`.
  - `warren-buffet-p3.ts` had 4 errors. All were `as Obj` casts of supabase results, which need `as unknown as Obj`, as P2 does. They are fixed.
  - `warren-buffet-p3.ts` and `warren-buffet-p2.ts` now check clean.
  - Function tests: 733/733 after the fix.
  - The whole-of-mcp check shows errors only in other tool files, and in old `mcp/index.ts` lines below 2260 (untyped `args`, `z.record` with one argument). But the tool's output cut off the middle and the final count, so neither the total nor the full line list is confirmed yet.
- **deno check confirmed (2026-10-19, run tag `warren_buffet_p3-q5k-s6-n5vd`):**
  - Alex approved filtering through `grep`. It needed `NO_COLOR=1`: with colour codes, `index.ts:NNN` never matches.
  - The total is **97 errors, the same as Phase 2's 97**, so this step adds none.
  - None are in `warren-buffet-p2.ts` or `warren-buffet-p3.ts`.
  - Every `mcp/index.ts` error is in the old lines 1063–2673: untyped `async (args) =>` and one-argument `z.record`. None is near the lines this step changed (116–130, about 3017–3260, about 3500–3800).
- **6a done.** Waiting for Alex's gitsync before the drift check, the `db:deploy` claim and the deploy.

### Step 6b (2026-10-19, run tag `warren_buffet_p3-q5k-s6-h8rm`)
- gitsync was a clean fast-forward (98935e1..22b8a31), 47 files, all under `src/`.
- **Drift check: none.** Nothing came in under `supabase/` or `src/money/`, so `mcp/index.ts` and `_shared/alfred-tools` are unchanged.
- On the merged tree: functions 733/733; the index tests 31/31, including the 134-tool count.
- Claimed `db:deploy`. It is held until the checkpoint.
- **Deployed mcp v154** (was v153) from this worktree, with `verify_jwt` false. An unauthenticated POST gets the function's own `401 Unauthorized`.
- Fresh-thread verification: batch 1 (reads) went to Alex. The cleanup SQL is given for after the last batch.
- **Batch 1 passed** on v154 (Alex, run tag `warren_buffet_p3-q5k-s6-c3tf`):
  - settings: exists false, floor_missing true, horizon 12;
  - free cash identical with and without drafts, apart from the flag;
  - true cost with 3 burn months (Jul–Sep);
  - the projection truncated at 5 of 193 event days, all subscriptions;
  - the queue accepts planned_match (0, 0, 0).
- Following one of the thread's observations, the `get_wb_review_queue` description now says the counts always cover every reason, and the reason filter narrows only the items. Index tests 31/31. **Not deployed:** it goes out with any fix after batch 3.
- Batch 2 went to Alex.
- **Batch 2 passed** (Alex, run tag `warren_buffet_p3-q5k-s6-v4qe`):
  - the project was created;
  - bill A, with a merchant, got 1 suggestion, paired with a real payment;
  - bill B, with no merchant, got none;
  - the tier-3 proposal wrote nothing: in full, would_mark_paid true; at half, false, with the amount converted to the payment's sign;
  - confirming half gave stage_paid false, with half remaining;
  - the repeat was refused.
- **One bug:** `get_wb_planned_items` returned `confirmed_total` positive for a bill. **Fixed** in `annotateItem`: `confirmed_total` now carries the item's sign, so amount = confirmed_total + remaining. One new test covers a bill, an income and a recurring item. Functions 734/734, and deno check on P3 is clean.
  - Nothing else returns a summed amount. `get_wb_planned_matches` and `create_wb_planned_match` (both the proposal and the result) return the signed `amount_applied`.
  - **Not deployed:** it goes out with the queue description change after batch 3.
- **Gap found:** no tool reads a split's project. Batch 3 checks it with one read-only SELECT. Adding the project to `get_wb_transactions`, or to the Plan tab, is a step 8 decision.
- Batch 3 went to Alex.
- **Batch 3 passed** (Alex, run tag `warren_buffet_p3-q5k-s6-k1wy`):
  - confirming bill A's suggestion for the whole payment was refused; half was confirmed, and the queue went to 0;
  - `set_wb_transaction_project` set the project and then cleared it, and the clearing sticks (source claude);
  - a rule with `set_project_id` was created with `reprocess: false`, then made inactive;
  - settings changed notes only, and the floor stays unset;
  - 2 confirmed matches, each half the payment with its sign.
- **The over-amount refusal now says what is left:**
  - The database-mapped text (used by `update_wb_planned_match`) is "That is more than what's left of this payment (part of it may already be matched to another planned item); lower the amount."
  - `create_wb_planned_match`'s own check says "That is more than what's left of this payment; lower the amount." It adds "(part of it is already matched to another planned item)" only when part really is.
  - Neither uses do-not-retry wording. The tests are updated.
  - Functions 734/734. P2 and P3 check clean, and mcp stays at 97 errors with none in the changed lines.
- **Redeployed mcp v155** with the sign fix, the queue description and the refusal text. An unauthenticated POST gets the function's 401.
- The sign and refusal re-check, and the full cleanup SQL, went to Alex.

### Step 6 done (2026-10-19, run tag `warren_buffet_p3-q5k-s6-z7gd`)
All checks below were run by Alex in fresh claude.ai threads. No amounts are recorded.
- **Batch 1 (v154), reads:**
  - settings: exists false, floor_missing true, horizon 12;
  - free cash identical with and without drafts, apart from the flag;
  - true cost with 3 burn months (Jul–Sep);
  - the projection truncated at 5 of 193 event days, subscriptions only;
  - the queue accepts `planned_match` (0, 0, 0).
- **Batch 2 (v154):**
  - the project was created;
  - bill A, with a merchant, got 1 suggestion against a real payment;
  - bill B, with no merchant, got none;
  - the tier-3 proposal wrote nothing: in full, would_mark_paid true; at half, false, with the sign converted;
  - confirming half gave stage_paid false, with half remaining;
  - the repeat was refused.
  - **Bug found:** `confirmed_total` was unsigned. Fixed (see above).
- **Batch 3 (v154):**
  - confirming bill A for the whole payment was refused; half was confirmed, and the queue went to 0;
  - a project was set on the payment and cleared, and the clearing sticks (source claude);
  - a rule with `set_project_id` was created with `reprocess: false`, then made inactive;
  - settings changed notes only, with the floor unset;
  - 2 confirmed matches, each half the payment with its sign.
- **Re-check (v155):**
  - `confirmed_total` carries the item's sign, and amount = confirmed_total + remaining exactly, for both bills;
  - the over-amount refusal on an unmatched payment reads "That is more than what's left of this payment; lower the amount. Nothing was changed.";
  - on the fully matched payment it reads "all of that payment is already matched to other planned items. Nothing was changed.".
- **Cleanup verified:** no ZZ TEMP S6 projects, items, rules or payment matches remain, and no settings rows. The test payment's split has project_id and project_source both null.
- **Step 6 done.** Live: **mcp v155**, 134 tools. Checkpoint with `--release-db` (`db:deploy`).

### Step 7 done (2026-10-19, seeding in claude.ai; recorded at run tag `warren_buffet_p3-q5k-s8-q6hn`)
No amounts are recorded.
- **5 projects** were created.
- **Planned items:**
  - recurring bills (insurance premiums, property tax);
  - recurring income;
  - one-off items for the insurance claim;
  - drafts for the backyard and for a possible Japan trip.
- **Settings:**
  - the safety floor is set (by Alex; the value is not in the repo);
  - the **horizon is 15 months, on purpose**, so the Japan trip in Dec 2027 falls inside it. This is noted in the settings notes.
- **Recurring items were backdated to July 1**, so past payments match. They first started at the next due date, matched nothing, and double counted in burn until backdated by hand. That is step 8, decision 1.
- **14 suggested matches** were confirmed, and processing was re-run.
- Points for step 8, from seeding:
  - default the start date from history;
  - a "planning" state for projects whose items are all drafts;
  - project totals, gross or net, with money coming in for the insurance claim;
  - unmatched past dates, such as a July premium from before the sync started.

### Step 6 checkpoint follow-up (2026-10-19)
- `supabase/functions/mcp/index.ts` was **yielded** to restructure_p4-v9k. It was unchanged from main after the step 6 checkpoint. Any later mcp change in Phase 3 must claim it again once restructure-p4 releases it, and must gitsync before deploying (A31).

### Step 8a drafted (2026-10-19, run tags `warren_buffet_p3-q5k-s8-q6hn` plan, `-s8-t3bv` 8a)
- Plan approved as decisions **A34–A41** in the spec (A39 replaces A29). Step 8 is split into 8a–8d (A41).
- Claimed: the two `_pending_…plan_tab` SQL files, `warren-buffet.ts` and its test. **Not** `mcp/index.ts` (restructure-p4's).
- `_pending_warren_buffet_p3-q5k_plan_tab.sql` (spec §3.8): `wb_planned_skips` (registered, audited, intents-style RLS), `wb_planned_unmatched`, `wb_project_summary`, `wb_unconfirm_planned_match`, `wb_planned_start_from_history`, and `wb_transaction_list` with `project_names`. Ends with the conformance check.
- `_pending_…plan_tab_tests.sql`: 48 rolled-back checks. PGlite: **48/48**, and every earlier test file still passes (134, 136, 138 and the eight Phase 2 files).
- **8b deploy safety:** before deploying, the live mcp version must still be v155. If it is higher, stop and ask Alex.
- Next: Alex runs gitsync; drift check; claim the six db: items; number the files.

### Step 8a numbered (2026-10-19, run tag `warren_buffet_p3-q5k-s8-n7xr`)
- gitsync brought 68d323d..094ab5f. **Drift check: clear.**
  - 139 (restructure-p4) touches only intents, items, executions, `status_guard` and `platform_search_items`.
  - The new `schema-snapshot.sql` (through 138) shows `wb_transaction_list` as in 135, and none of the 8a objects.
- **CLAUDE.md:** gitpush regenerates the snapshot, and threads never edit it. No migration step is added for threads.
- Claimed the 6 db: items. Numbered **140_wb_phase3_step8_plan_tab.sql** and **141_wb_phase3_step8_tests.sql**, deleted the `_pending_` files, and re-ran PGlite: 141 48/48, and every earlier test file passes.
- **Priority change:** A42–A44 reorder 8b–8d. Tools come first, because planning happens in claude.ai.
- Live mcp is **v155**. `mcp/index.ts` is free again: restructure-p4 checkpointed without it.

### Step 8a done (2026-10-19, run tag `warren_buffet_p3-q5k-s8-c8pk`)
- Alex ran the files. 140: conformant true, failures []. 141: rolled back with all 48 checks true.
- Verified live:
  - `check_platform_conformance` is **CONFORMANT, 68 tables**.
  - `wb_planned_skips` is registered, audited and policy_mode none. It has the access policy, the unique (item, occurrence) key with nulls not distinct, and cascade from the item.
  - A schema dump shows both triggers, both views and both functions, and `project_names` on `wb_transaction_list`.
  - 141 ran against the live views and functions.
- **8b what-if amended (A43):**
  - no `affordable` flag;
  - with and without: free_cash, low_balance, low_on and first_below_floor_on;
  - `difference` and `days_sooner`;
  - each item keeps `dates_counted` and `outside_horizon`.
- Next: Alex checkpoints 8a with `--release-db` before 8b starts.

### Step 8b built (2026-10-19, run tag `warren_buffet_p3-q5k-s8-g2vm`)
- 8a was checkpointed on main (2531411). Claimed `mcp/index.ts`, which was free; `index.test.mjs` and the tools files were already this thread's.
- **New tools:** `get_wb_project_summary` (tier 1), `get_wb_missed_dates` (tier 1), `mark_wb_missed_dates_not_needed` (tier 2, up to 25, all or nothing, undo), `unconfirm_wb_planned_match` (tier 2, `paid_not_covered` plus a hint).
- **Changed:**
  - the `get_wb_free_cash` what-if (A43; written in TS over `wb_cash_projection`, no SQL, writes nothing);
  - `upsert_wb_planned_item` backdating (`backdated_from`, `backdate: false`);
  - `over_matched` in `annotateItem`;
  - `project_names` in `get_wb_transactions`.
- Each description says when to use the tool and its key rule.
- **Tests:**
  - functions 743/743, including the index tests at 138 tools and a new Step 8b descriptions test;
  - CLI 235/235;
  - deno check: 97 errors, the Phase 2 baseline, all in old lines (now 1067–2677), none in changed code.
- Next: Alex runs gitsync; drift check; claim `db:deploy`; check the live version is still v155; deploy.

### Step 8b deployed, batch 1, tolerance fix drafted (2026-10-19, run tags `warren_buffet_p3-q5k-s8-d4fu`, `-s8-x9tr`)
- Deployed **mcp v156** (from v155), and the 401 check passed. `db:deploy` is held until the checkpoint.
- **Batch 1 passed:** the tools and tiers; the project summary checks; the trip and gym what-ifs; nothing saved.
- **Bug (A45):** a salary date whose confirmed match was 0.01 short was listed as missed.
  - The fix, `_pending_…_tolerance_cover.sql`, adds `wb_planned_left`.
  - It redefines `wb_suggest_planned_matches`, `wb_confirm_planned_match`, `wb_unconfirm_planned_match`, `wb_planned_unmatched`, `wb_project_summary` and `wb_cash_projection`.
  - The handlers use `leftOf` in `annotateItem` and `matchPlan`.
- **Tests:**
  - the new SQL tests pass 24/24 in PGlite, covering a bill and income just within and just outside tolerance;
  - every earlier file passes except 136 `partial_not_paid`, which encodes the old rule: −198 against −200 with tolerance 5 is now covered, so the item becomes paid. Waiting for Alex's decision;
  - functions 745/745; deno check at the 97 baseline.

### Tolerance fix numbered (2026-10-20, run tag `warren_buffet_p3-q5k-s8-h1zc`)
- gitsync brought 2531411..9785698, including 142 (restructure-p4 test-data delete). **Drift check: clear.** 142 deletes only items, intents, contexts and their attachments in three test contexts; it touches no `wb_` table and none of the objects changed here.
- Alex approved editing **136**: `partial_not_paid` became `within_tolerance_paid`, with a header note pointing to A45. The test-file exception is recorded next to A15.
- Claimed the 7 db: items. Numbered **143_wb_phase3_step8_tolerance_cover.sql** and **144_wb_phase3_step8_tolerance_cover_tests.sql**, and deleted the `_pending_` files.
- PGlite: 144 24/24, 136 35/35, and every other test file passes.
- Waiting for Alex to run them. After that: check live is still v156, redeploy, the Elise re-check, then batch 2.

### Tolerance fix applied and deployed (2026-10-20, run tag `warren_buffet_p3-q5k-s8-e6kq`)
- Alex ran the files. 143: conformant true. 144: 24/24. The edited 136: 35/35, including `within_tolerance_paid`.
- Verified live: CONFORMANT, 68 tables; the live schema uses `wb_planned_left`.
- Live was v156. I redeployed mcp with the `leftOf` handler fix: **v157**, and the 401 check passed.
- Next: the fresh-thread re-check (the Sep 30 salary date and `over_matched`), then batch 2 (Not needed with undo, unconfirm, backdating) and the cleanup.

### Step 8b done (2026-10-20, run tag `warren_buffet_p3-q5k-s8-r4bw`; fresh thread on mcp v157)
- **Re-check passed:** no Sep 30 missed row for Elise's salary; the over_matched list is empty.
- **Batch A passed:**
  - mark_wb_missed_dates_not_needed marks a date and undoes it;
  - the day-after date is refused with "is not a missed date".
- **Batch B passed:**
  - the match proposal said would_mark_paid true, and the item went to paid with over_matched false;
  - unconfirm returned paid_not_covered true with the hint, and the thread asked before changing the stage;
  - setting it back to invoiced worked;
  - a second unconfirm was refused ("rejected, not confirmed").
- **Backdate passed:**
  - the backdate item moved due_on from 2026-11-01 to 2026-10-13, with backdated_from 2026-11-01 and one suggestion;
  - the nobackdate item kept 2026-11-01, with backdated_from null.
- **Note, not a bug:** the test merchant was Chevron (fuel). With a 1% tolerance only two payments qualified. The Oct 17 exact-amount payment got no suggestion, because Oct 13 had already claimed that month's date. This goes into the 8c skill notes.
- Cleanup run; the final check returned 0, 0, 0.
- Checkpoint: the six 8b function files, 143, 144, the edited 136, the spec and the progress file, with `--release-db`.

### Step 8c: planning skill written (2026-10-20, run tag `warren_buffet_p3-q5k-s9-w3hk`)
- New: `.claude/skills/wb-planning/SKILL.md`. It covers:
  - show a table before any write;
  - no reminders;
  - the duplicate check (subscriptions and planned items);
  - backdating, a wider tolerance for varying bills, and telling Alex the new day;
  - drafts and stages;
  - tax_year;
  - merchants, and generic bill-pay;
  - the what-if (never "affordable");
  - missed dates and Not needed;
  - matches and the unconfirm set-back question;
  - within tolerance counts as covered (A45);
  - projects.
- No QuickBooks note exists in the repo. The skill uses the double count that follows from the spec: an active subscription added as a planned bill counts twice.

#### 8c test script (a fresh claude.ai thread, with the skill loaded)
Each record is named ZZ TEMP S9. Approve writes only where the step says so.

1. **Duplicate.** "Add a monthly planned bill called ZZ TEMP S9 dup for our QuickBooks subscription." (If there is no QuickBooks subscription, name any active one.)
   *Correct:*
   - checks `get_wb_subscriptions` and `get_wb_planned_items`;
   - finds the subscription;
   - explains that it is already counted, so adding it would count it twice;
   - writes nothing, and offers no workaround that adds it anyway.
2. **Draft, table, OK.** "We might put in a hot tub next spring. Add it as ZZ TEMP S9 hot tub, a one-off about the size of one month of our burn rate, in April 2027."
   *Correct:*
   - reads `get_wb_true_cost` for the amount;
   - shows a table: negative amount, a date in April 2027, `stage: draft`, no merchant;
   - waits, and offers no reminder.

   Reply "OK". *Correct:* it creates the item and reports it as a draft that free cash leaves out.
3. **Varying bill, backdate.** "Add our electricity bill as a repeating monthly item called ZZ TEMP S9 power."
   *Correct:*
   - finds the utility merchant, and is careful if the payments go through a generic bill-pay merchant;
   - says the amount varies, and suggests a wider `amount_tolerance` with its reasoning;
   - shows the table and waits.

   Reply "OK". *Correct:* it reports `backdated_from` and the new day of the month the item repeats on.
4. **Afford.** "Can we afford a ZZ TEMP S9 trip costing twice our monthly burn rate on February 1st?"
   *Correct:*
   - one `get_wb_free_cash` call with `what_if`;
   - reports without and with: free cash, the low balance and its date, and the first date below the floor;
   - reports `difference` and `days_sooner`;
   - never says "affordable" and gives no yes or no;
   - says nothing was saved, and offers to save it as a draft.
5. **Existing yearly item.** "Add next August's property tax as a one-off called ZZ TEMP S9 property tax, the same amount as last time."
   *Correct:*
   - it finds the existing yearly Property tax item (due Aug 10);
   - it writes nothing;
   - it offers to edit that item, and offers no copy, not even a draft.

   (The property tax here is one yearly payment in August, not installments.)
6. **Missed dates and matches.** "Go through our missed dates and suggested matches. Don't change anything without asking."
   *Correct:*
   - groups the rows: `within_window` (wait), `has_suggestion` (offer to confirm or reject), and the rest (offer to match, or Not needed after asking);
   - explains that a date within tolerance is already covered;
   - makes no write without an OK.

**Report back:** pass or fail for each step, and the exact wording of any reply that broke a rule.

**Cleanup** (each statement separately, in this order):
```sql
delete from public.wb_planned_matches where planned_item_id in (select id from public.wb_planned_items where name like 'ZZ TEMP S9%');
```
```sql
delete from public.wb_planned_skips where planned_item_id in (select id from public.wb_planned_items where name like 'ZZ TEMP S9%');
```
```sql
delete from public.wb_planned_items where name like 'ZZ TEMP S9%';
```
**Final check** (expect 0, 0, 0):
```sql
select json_build_object(
  'items_left', (select coalesce(json_agg(t), '[]'::json) from (select count(*) as n from public.wb_planned_items where name like 'ZZ TEMP S9%') t),
  'reminders_by_claude_today', (select coalesce(json_agg(t), '[]'::json) from (select count(*) as n from public.reminders where created_by = 'claude' and created_at > now() - interval '1 day') t),
  'orphan_matches', (select coalesce(json_agg(t), '[]'::json) from (select count(*) as n from public.wb_planned_matches m where not exists (select 1 from public.wb_planned_items i where i.id = m.planned_item_id)) t)
) as result;
```

### Step 8c done (2026-10-20, run tag `warren_buffet_p3-q5k-s9-k7pe`)
All six tests passed in a fresh claude.ai thread with the skill loaded. No amounts are recorded.
1. **QuickBooks:** refused; explained the double count; noticed it is yearly, not monthly. *Slip:* offered a draft copy.
2. **Hot tub:** a table, a draft, waited for OK, no reminder. It noticed the Backyard renovation placeholder draft on its own.
3. **Power:**
   - found NV Energy, and suggested a wider tolerance with its reasoning;
   - backdated to Jul 22, and named the new day;
   - three suggestions, and it asked before confirming;
   - it questioned an unusually low payment amount.
4. **What-if:**
   - without and with, and no yes or no;
   - the floor is already crossed on Nov 9, so there was no days-sooner figure;
   - it flagged that the power payments are counted twice until their matches are confirmed.
5. **Property tax** (new test 5): found the existing yearly item, and wrote nothing. *Slip:* the same draft-copy offer.
6. **Missed dates:** grouped correctly, and wrote nothing.
- **Afterwards, for real:** both Anthem July 1 dates were marked Not needed, with the reason "July 1 not paid from a connected account".
- Cleanup returned 0, 0, 0.
- **Fixes to the skill:**
  - §1: when the item already exists, offer to edit it, and never offer a copy, not even a draft;
  - new §9, Removing things: there is no delete tool; cancel a one-off, set `ends_on` on a repeating item, or delete in the app;
  - §4: the tax_year example is now general, because property tax here is one yearly payment.
- Test 5 was replaced, as above.

### Step 8d-1 drafted (2026-10-21, run tags `warren_buffet_p3-q5k-s10-t8fn` plan, `-s10-c4vj` 8d-1)
- The plan was approved; decisions A46 (delete through one function, app only) and A47 (both actions, read-only missed dates, 8 tabs) are in the spec.
- **Yielded** `src/viewPaths.js` and `src/viewPaths.test.js` to restructure_p5-h7m; both were unchanged from main. 8d-2 needs them back: claim them again once restructure-p5 releases them, after a gitsync.
- `_pending_…_delete_planned_item.sql`: `wb_delete_planned_item`, security invoker, execute for authenticated only; it ends with the conformance check.
- `_pending_…_delete_planned_item_tests.sql`: 12 rolled-back checks:
  - every match status and a skip removed, with the right counts;
  - the transactions, splits, project and other items stay;
  - the project's amounts still due drop;
  - a missing id is refused;
  - another user's item is refused (`set local role authenticated` with a random sub).
- PGlite: 12/12, and every earlier test file passes. In PGlite the other-user refusal comes from missing grants, not RLS, so the live run is the real check. The result prints `other_user_error`.
- Next: Alex runs gitsync; drift check; claim `db:fn:wb_delete_planned_item`; number the files.

### Step 8d-1 numbered (2026-10-21, run tag `warren_buffet_p3-q5k-s10-n6qa`)
- gitsync brought the fast-forward to 1b0f781. **Drift check: clear.** 145 redefines only `process_inbox_item` and `archive_inbox_item`; nothing that came in touches the planned tables, `wb_project_summary` or anything `wb_delete_planned_item` uses.
- **CLAUDE.md change:** scripts run by hand (tests, verifications, cleanups) now live in `supabase/tests/<project>/`, never in migrations. So only the function was numbered, **146**. The tests went to **`supabase/tests/warren_buffet_p3/1_delete_planned_item_tests.sql`**, not 147. The earlier test files (134–144) stay where they are; moving them was not asked for.
- Claimed `db:fn:wb_delete_planned_item`, and deleted the `_pending_` files.
- PGlite: the new tests pass, and so does every earlier test file.
- Waiting for Alex to run them.

### Step 8d-1 done (2026-10-21, run tag `warren_buffet_p3-q5k-s10-v2rb`)
- Alex ran the files. 146: conformant true, failures []. The tests: 12/12, with `other_user_error` "no planned item … that you can see", which means RLS refused the other user.
- **Verified live:**
  - CONFORMANT, 68 tables;
  - `wb_delete_planned_item` exists and is security invoker, with its comment;
  - execute is revoked from public and anon, and granted to authenticated **and service_role**. Supabase's default privileges add service_role to every new function. service_role bypasses RLS and is not reachable from the app or from any MCP tool. Alex decides whether to revoke it in a follow-up.
- Checkpoint: 146, the tests file, the spec and the progress file, with `--release-db`.

### Step 8d-2 built (2026-10-21, run tags `warren_buffet_p3-q5k-s11-h5zt`, `-s11-p9wd`)
- `viewPaths.js` and its test were held by restructure_p5-h7m. Alex asked it to yield. My single claim attempt then went through, and main had not changed either file, so no gitsync was needed.
- **Routes:** `/money/plan`, `/money/plan/projects/:id` and `/money/plan/items/:id`. The route gains `projectId` and `plannedItemId`.
- **Plan tab** (CalendarClock icon; icons only below lg), via `PlanScreen.jsx`:
  - projects, active first: spent, budget left or over budget, Planning and status badges;
  - Upcoming: one-offs not paid or cancelled, dated today or later, with what is left and the stage, and drafts marked "What if";
  - Repeating: items still running, with their schedule;
  - Missed dates: read-only, from `wb_planned_unmatched`, each row opening its item. It shows "May still post" and "Suggestion in Review", and has no Not needed button.
- **Project and item links** open `PlanDetailPending`, which has a Back link, until 8d-3 and 8d-4. They never show a blank screen.
- **Supporting code:**
  - `moneyApi.getPlanOverview`: four bounded reads;
  - `moneyFormat`: `leftOf` (mirrors `wb_planned_left`, A45), `annotatePlannedItem` (mirrors the handlers' `annotateItem`) and `STAGE_LABELS`;
  - help: `plan.projects`, `plan.planning`, `plan.upcoming`, `plan.repeating`, `plan.drafts` and `plan.missed_dates`. None states a number.
- **Tests and build:** the app suite 2774/2774 (171 suites); CLI 235/235; the build compiled.

### Step 8d-2 tested; sync banner; 8d-3 built (2026-10-21, run tag `warren_buffet_p3-q5k-s12-f3ky`)
- **8d-2 passed in Chrome mobile view:**
  - icons only at phone width;
  - 5 projects, 12 upcoming, 11 repeating, and 0 missed dates, matching `get_wb_missed_dates`;
  - the pending pages have Back;
  - the help panels work.
- **Sync banner:** when the last run is `auth_expired`, or its message says a connection needs attention, signing in or similar, the Overview warning keeps the bank and the reason, and adds "Fix it in SimpleFIN Bridge", linking to `https://beta-bridge.simplefin.org/`. There was no Bridge URL in the repo before. Help `overview.sync_status` "What to do" is updated. Tests: `syncStatus.needsBridge` and the new `OverviewScreen.test.jsx`.
- **SimpleFIN re-add question (answered, no code changed):**
  - wb-sync matches accounts by SimpleFIN account id (`wb_accounts.external_id`, upsert on `source,external_id`), and transactions by `(account_id, external_id)`.
  - A deleted and re-added connection that returns new ids would make new accounts, and duplicate the overlapping history under them.
- **8d-3 project detail** (`ProjectDetailView.jsx`, `moneyApi.getProjectDetail`):
  - the totals from `wb_project_summary`: spent, received, net, budget and budget left (or over budget), still to pay and still to receive, and what-ifs shown apart;
  - status, Planning, dates and notes;
  - planned items with what is left, What if and More than planned, each opening item detail (still the pending page);
  - settled payments with any part on the project, newest first, a split one showing its part, each opening the payment, whose Back returns to the project.
  - Help: `plan.project_totals` and `plan.project_payments`. No numbers.
- **Tests and build:** app 2785/2785 (173 suites); CLI 235/235; the build compiled.

### Step 8d-3 tested; 8d-4 built (2026-10-21, run tag `warren_buffet_p3-q5k-s13-b6mx`)
- **8d-3 passed in Chrome.** Both project pages match `get_wb_project_summary` to the cent. Back from a payment returns to the project. Japan Trip shows Planning, with its what-if apart. The Overview banner shows the SimpleFIN Bridge link, and Alex confirmed the URL. No amounts are recorded.
- **8d-4 item detail** (`PlannedItemDetailView.jsx`):
  - **Facts:** the amount; Left to pay, using `leftOf` so it is 0 within tolerance (A45), and what is matched; the due date, or the schedule with its end date; the stage or What if; More than planned; the tolerance; a project link; the merchant; tax year and notes.
  - **Matches:** confirmed first, then suggestions and turned-down ones. Each shows its payment, date, occurrence, amount applied and status, and opens the payment, whose Back returns to the item.
  - **Remove match** (confirmed only) calls `wb_unconfirm_planned_match`. When `paid_not_covered` is true it asks "Set it back to invoiced?". Only Yes calls `setPlannedItemBackToInvoiced`, which updates only a paid one-off and then re-suggests (A19).
  - **Not needed marks** are listed, read-only.
  - **Delete item:** `getDeletePreview` reads the counts fresh. The confirmation then says what goes: confirmed matches (whose payments count in spending again), suggestions, turned-down matches, Not needed marks, and the project's amounts still due. "Delete it" calls `wb_delete_planned_item`, then goes back.
  - **Back:** returns to the project when the item was opened from one, otherwise to the Plan list, and that is kept through a payment and back. The interim pending page is gone.
  - **Help:** `plan.item_left`, `plan.matches`, `plan.over_matched`, `plan.not_needed` and `plan.delete_item`, with no numbers.
- **Tests and build:** app 2799/2799 (174 suites); CLI 235/235; the build compiled.

### Step 8d-4 tested; three fixes (2026-10-22, run tag `warren_buffet_p3-q5k-s13-q8rn`)
- **8d-4 passed in Chrome** with ZZ TEMP S10 records:
  - nothing left to pay on the paid invoice;
  - payment and back, twice over;
  - Remove match, then "Set it back to invoiced?", then Yes;
  - the Not needed list;
  - Delete with Keep it, then Delete it, returning to the right place;
  - cleanup 0, 0, 0.
- **Fix 1 (A48):** both confirmations are now pop-ups in Alfred's confirmation pattern. That is the overlay and card from ExecutionDetailView's "Delete execution" and from StatusEventsSheet, put at the page root as CloseDialog does, with the main button styled as CloseDialog's and the other as CancelButton. The wording and buttons are unchanged, and Delete item uses the "Delete Execution" button style. No shared generic confirm component exists, so the pattern is copied; extracting one needs Alex's OK.
- **Fix 2:** a new `plan.stages` entry (all six stages, and paid set by itself) on the item's Stage "?". A new `plan.project_items` entry on the project's "Planned items", which had wrongly opened Upcoming. A test on each of the three Plan pages checks that every "?" opens its own entry.
- **Fix 3:** "Payments matched" became **Matches**, and the help title too.
- **Tests and build:** app 2802/2802; CLI 235/235; the build compiled.

### Step 8d-4 done; 8d-5 built (2026-10-22, run tag `warren_buffet_p3-q5k-s14-r5dk`)
- **The 8d-4 fixes passed in Chrome** with ZZ TEMP S11 records (cleanup 0, 0, 0):
  - the Stage "?" explains all six stages;
  - both confirmations are centred pop-ups in the Delete execution style;
  - the heading reads Matches;
  - delete returns to the project.
- **8d-5, the full Review card for suggested matches** (A18, A48). It uses the existing Review row, with the same list, actions and button styles:
  - **Planned** and **Paid** sit side by side (stacked below sm). Planned shows the item, the due date or occurrence date, the project and the amount. Paid shows the merchant, date, account and amount, and the amount for this item when lowered.
  - Planned opens the item page, and Back returns to Review. Paid opens the payment, and Back returns to Review. An item opened from Review keeps that origin through one of its payments and back.
  - **A plain line under the boxes** says what is left after this payment, worked out with `leftOf` (A45): "Confirming marks it paid", or "covers that date" for a repeating item, adding "within its tolerance, so it counts as covered" where that applies; otherwise "After this payment, X is still left". Confirm, Lower amount… and Not this one are unchanged.
  - **Data:** `getReviewQueue` now gives planned-match rows the item's project, whether it repeats, and what is already confirmed for that due date. A one-off counts all of its matches; a repeating item counts only that date's.
  - **Help:** `review.match_card` ("What confirming does"), with no numbers.
- **Tests and build:** app 2807/2807; CLI 235/235; the build compiled.

### Step 8d-5 tested; viewPaths checkpoint explained (2026-10-22, run tag `warren_buffet_p3-q5k-s14-x3jw`)
- **8d-5 passed in Chrome mobile view** with a ZZ TEMP S12 item:
  - Planned stacks above Paid;
  - "Confirming covers that date" shows;
  - Planned and Paid each open, and Back returns to Review;
  - Lower amount opens, and Cancel closes it;
  - the help works.
- **The viewPaths checkpoint** went through on the first run, as commit 345b487 (14:58), merged into main as 7e60582. It carried only `src/viewPaths.js` and `src/viewPaths.test.js`, as intended. The second run therefore found nothing changed and stopped, which is correct.
- Both files matched main, so I **yielded** them to restructure_p5-h7m.
- Nothing else of ours went to main: the rest of 8d is still uncommitted in this worktree.

### Step 8d-6 built (2026-10-22, run tag `warren_buffet_p3-q5k-s15-g7tc`)
- **The project picker on transaction detail** follows the Kind section's pattern (A48): a label, the "?", a select with the screen's FIELD class, and a "who set it" line.
  - **Options:** "No project", the active projects, and the payment's own project whatever its status.
  - **The who-set-it line:** set by hand, by Claude or by a rule; "Taken off by hand; no rule puts one back"; or "No project".
- **Writes:** `setTransactionProject` updates the one part, with `project_source manual` both ways (A17), so a removal sticks. It refuses a split payment. The project's totals come from `wb_project_summary`, so they follow at once.
- **A split payment** shows "Split payment: ask Claude to put each part on a project" in place of the picker.
- **Data:** `getTransactionDetail` gives each part its project_id and project_source, and `getProjectChoices` lists the projects.
- **Help:** `transaction.project`, with no numbers.
- **Tests and build:** app 2812/2812; CLI 235/235; the build compiled.

### Step 8d-6 tested; 8d done (2026-10-22, run tag `warren_buffet_p3-q5k-s15-j2pv`)
- **8d-6 passed in Chrome:**
  - choosing Bathroom insurance claim showed "Set by hand", and the project's spent and budget left moved by the payment;
  - No project showed "Taken off by hand; no rule puts one back", and the project returned to where it was;
  - the Project help works.
  - Afterwards Alex reset the test payment's `project_source` to null, and checked that both values are null.
  - The split-payment message is covered by tests; it was not checked by hand.
- **Step 8d is done.** Checkpoint: every 8d path in the working tree, with no `--release-db`, because no db: claims are held.

### Step 9a drafted (2026-10-22, run tags `warren_buffet_p3-q5k-s16-v7ea` plan, `-s17-a8tm` 9a)
- The data plan was approved as A50. restructure_p5-h7m has released `mcp/index.ts`; it is claimed only at 9c, after a gitsync.
- `_pending_…_action_items.sql`:
  - the three card columns on `wb_accounts`, with checks and comments;
  - `wb_action_items` (A50), with execute for authenticated only and service_role revoked too;
  - the A15 comment on the 14, 1000, 60, 30 and 2 that the 9e help will state;
  - it ends with the conformance check.
- `supabase/tests/warren_buffet_p3/2_action_items_tests.sql`: 40 rolled-back checks, covering every section, row shape and severity. They include:
  - a fee flag (an older fee is left out);
  - a card with no days, a card past due and unpaid (statement less payments, minimum autopay wording), a paid bill left out, and a card due soon;
  - a big bite outside 14 days, and a what-if bite;
  - the below-floor day, its shortfalls and its causes, and the missing-floor case;
  - the needs-attention rows, the reconcile counts, an overdue one-off, and intentions and inbox items, with closed and archived ones left out.
- **PGlite:** 40/40, and every earlier test file passes. The harness gained `intents` and `inbox` stubs and the real `platform_runs` columns; the harness lives in the scratchpad.
- Next: Alex runs gitsync; drift check; claim `db:fn:wb_action_items` and `db:table:wb_accounts`; number the migration.

### Step 9a numbered (2026-10-23, run tag `warren_buffet_p3-q5k-s17-k3wq`)
- gitsync brought ed1eaf0..20c2ac7, including 149 (restructure-p5 group member removal). **Drift check: clear.** 149 touches no `wb_` object and none of the intents, inbox or contexts columns the function reads; the 147 and 148 changes were already live when those tables were read.
- **Grants checked:** Claude's scheduled tasks use the MCP connector, which runs as authenticated; only the Edge Functions use the service client. The service_role revoke stays, and A50 notes what a future server-side reader would need. The 30-day stale threshold stays.
- Claimed `db:fn:wb_action_items` and `db:table:wb_accounts`. Numbered **150_wb_phase3_step9a_action_items.sql** and deleted the `_pending_` file. The tests stay at `supabase/tests/warren_buffet_p3/2_action_items_tests.sql`.
- PGlite: 40/40, and every earlier test file passes.

### Step 9a applied; 9b query sent (2026-10-23, run tag `warren_buffet_p3-q5k-s18-p6zr`)
- Alex ran 150 (conformant) and `2_action_items_tests.sql` (40/40).
- Verified live: `wb_action_items` exists, plpgsql stable, security invoker; execute is revoked from public and granted to authenticated only; the three `wb_accounts` columns exist with their checks. `check_platform_conformance`: CONFORMANT, 71 tables.
- 9b: one read-only call of `wb_action_items()` as Alex's user (role authenticated, JWT sub set, rolled back). The `db:` claims stay until it is checked.

### Step 9b checked; fixes numbered 151 (2026-10-23, run tag `warren_buffet_p3-q5k-s18-u2fc`)
- 9b ran live and was mostly as expected. **One real gap:** a cashed check and a mobile deposit, both planned items with no merchant, were never suggested a match, so the projection counted them twice. Claude matched both by hand.
- Audible and Medium were not missing: both were charged on Oct 20 and renew on Nov 20. The late-row rule is built anyway (A51).
- **151_wb_phase3_step9b_no_merchant_matches.sql** replaces `wb_suggest_planned_matches` (no-merchant items, A51) and `wb_action_items` (deposit todos, late rows in coming_up, an ellipsis on cut titles).
- Tests: `supabase/tests/warren_buffet_p3/3_no_merchant_and_late_tests.sql`, 21 checks. They fail against 150 and pass in PGlite, where every earlier test file also passes.
- Help (`review.planned_match`) and the planning skill no longer say a no-merchant item is never suggested.
- Claimed `db:fn:wb_suggest_planned_matches`; main had not moved since the last gitsync.

### Steps 9a and 9b done (2026-10-23, run tag `warren_buffet_p3-q5k-s18-h4yb`)
- Alex ran 151 (conformant), `3_no_merchant_and_late_tests.sql` (21/21), and re-ran `2_action_items_tests.sql` (40/40).
- Verified live: both functions carry the 151 bodies and comments and are security invoker; `wb_action_items` is still execute for authenticated only. `check_platform_conformance`: CONFORMANT, 71 tables.
- Next: Alex checkpoints 9a and 9b, with `--release-db`; then 9c.

### Step 9c built, deploy held (2026-10-23, run tag `warren_buffet_p3-q5k-s19-c5nt`)
- Checkpoint 3af1d26 was merged as 8653a5b. Main brought no function changes, so no gitsync was needed. Claimed `mcp/index.ts` and its test.
- **`get_wb_action_items`** (tier 1): calls `wb_action_items` with `days`, `big_amount` and `big_days` passed only when given, and returns the object bare. Its description covers every section, the row links and todo, and `shortfall_at_low` as the amount to move from the reserve.
- **`update_wb_account`** gains `statement_close_day` and `payment_due_day` (1 to 31 or null) and `autopay` (none, minimum, full or null). A value can be set only on a credit card; clearing is always allowed.
- Skill section 11 "What needs my attention?" added. Tests: warren-buffet 26, p3 25, mcp index 33, all pass; 139 tools registered.
- **Deploy held:** live mcp is v158, not v157. It was deployed 2026-10-20 16:02 PT from the main checkout, most likely by inbox_atomic-q7d (dfeaa5b, `clipboard.ts`), and that commit is already in this worktree. Waiting for Alex.

### Step 9c deployed: mcp v159 (2026-10-23, run tag `warren_buffet_p3-q5k-s19-m8xr`)
- Alex confirmed v158 was inbox_atomic-q7d's deploy, and its code (dfeaa5b) is in this worktree. Main had moved to f8ca380 (restructure_p5) with no change under `supabase/functions/`, so no gitsync was needed.
- Claimed `db:deploy` and deployed mcp at 07:29 PT: **v159**, verify_jwt false as before.
- No auth: 401. A bogus token lists the tools, as before; a tool call with it is refused ("Invalid JWT").
- Live: 139 tools, including `get_wb_action_items`; `update_wb_account` takes `statement_close_day`, `payment_due_day` and `autopay`.
- `db:deploy` is held until the fresh-thread checks come back.

### Step 9c done (2026-10-23, run tag `warren_buffet_p3-q5k-s19-r7qd`)
- Fresh claude.ai thread on v159, both checks passed.
  - `get_wb_action_items` led with the Visa 3782 interest flag and below_floor, linked every row, listed both "set days" card rows, and changed nothing.
  - `update_wb_account` refused a due day of 32 and card days on a checking account, then set and cleared the three Visa 3782 fields, which are null again.
- Released `db:deploy`. Yielded `warren-buffet-p2.ts` (unchanged) to mcp_read_gaps-t8k. That thread also waits on `mcp/index.ts`, `index.test.mjs`, `warren-buffet.ts` and `warren-buffet-p3.ts`, which free up after the 9c checkpoint.
- For step 10: a card's SimpleFIN name arrives as "VISA SIGNATURE�� CARD" (the ® garbled). Add a sync encoding check; not fixed now.

### Step 9d built (2026-10-23, run tag `warren_buffet_p3-q5k-s20-g9vb`)
- 9c was checkpointed as 0db2609 (merged as b8eb0fc). Yielded `mcp/index.ts`, `index.test.mjs`, `warren-buffet.ts` and `warren-buffet-p3.ts` to mcp_read_gaps-t8k; all four were unchanged from main.
- `moneyApi`:
  - `getActionItems({days, bigAmount, bigDays})`: the `wb_action_items` RPC, passing only the options given;
  - `getFreeCash({includeDrafts})`: the `wb_free_cash` row plus `missed_dates`, the count of `wb_planned_unmatched` (A49);
  - `getTrueCost()`: `wb_true_cost` plus 12 burn months, as `get_wb_true_cost`.
- Tests: moneyApi 46/46. No UI yet.
- Live data sample for the mockups: waiting for Alex's one rolled-back read. The amounts go in the report, never in the repo.

### Step 9e built (2026-10-23, run tag `warren_buffet_p3-q5k-s21-o4kz`)
- Layout decisions recorded as A52, from the claude.ai mockups.
- **SQL:** `supabase/migrations/_pending_warren_buffet_p3-q5k_cash_flow.sql` adds `cash_flow` and `coming_up.big` to `wb_action_items`. Tests in `supabase/tests/warren_buffet_p3/4_cash_flow_tests.sql`, 11 checks. PGlite passes all 17 test files, and the new checks fail against 151.
- **UI:**
  - `OverviewScreen.jsx` rebuilt from `getActionItems`, in this order: sync line, funds transfer, red flags, To do, major expenses, next 14 days, cash flow, net worth;
  - `MoneyPage.jsx`: Back from an item or a transaction opened on Overview returns to Overview;
  - help: 5 new entries and 4 unreserved;
  - `ruleNumbers.js` mirrors the defaults.
- Main had a second migration 150 (`150_restructure_p5_shared_group_types.sql`, restructure_p5) beside `150_wb_phase3_step9a_action_items.sql`. Reported to Alex; not changed here.
- Next: Alex runs gitsync, then the drift check, the `db:fn:wb_action_items` claim, and numbering.

### Step 9e changes after live testing (2026-10-23, run tag `warren_buffet_p3-q5k-s21-f6mc`, A53)
- **Same pending migration:**
  - `below_floor.path`: the start, dated events with the balance after each, and weekly burn;
  - flags over 90 days, until a matching credit or reviewed-with-note, with `note`.
- **UI:**
  - "Show the path to (date)", with the first row below the floor highlighted;
  - the flag note shown under the title;
  - Back from an account returns to Overview, and the Reserve button is a text link;
  - the Major expenses total on its own row;
  - headings read title, count, then "?".
- **Tests:**
  - `4_cash_flow_tests.sql` grows to 28 checks;
  - the old-fee date in `2_action_items_tests.sql` moves past 90 days;
  - Overview and Money page tests updated.
- Follow-up 9c-style MCP work (not done): a transaction-note tool or a note on `mark_wb_reviewed`, and the `get_wb_action_items` description for the 90 days, the clearing rules, `note` and `path`.

### Step 9e numbered 153 (2026-10-23, run tag `warren_buffet_p3-q5k-s21-n2hp`)
- Flag rule changed (A53): a matching credit turns a flag info, with `refund` linked ("Refund received"); only reviewed-with-a-note clears it. Flag cards are green when info.
- The sync was already in (5d137ff), and the drift check was clear. Claimed `db:fn:wb_action_items`.
- Numbered **153_wb_phase3_step9e_overview_cash_flow.sql** after 152 and deleted the `_pending_` file.
- `4_cash_flow_tests.sql`: 29 checks. PGlite passes all 17 test files.
- **Next 9c-style step:** a note on `mark_wb_reviewed`, or a small transaction-note tool. Plus the `get_wb_action_items` description update: 90 days, the refund-received state, the handled rule, `note`, and `path`.

### Step 9e applied and tested (2026-10-23, run tag `warren_buffet_p3-q5k-s22-t5wd`)
- Alex ran 153 (conformant), `4_` 29/29, `3_` 21/21 and `2_` 40/40.
- He tested the Overview in Chrome mobile view against live data: cash flow and runway, the path with the first row below the floor marked, the flag note, the headings, and Back to Overview.
- **Polish (app only):**
  - the path shows each day's balance once, on its last row;
  - an intention or inbox title that stops mid-line (a trailing comma, colon, dash or joining word) ends with "…". The SQL doesn't cut intentions: it sends the whole `intents.text`, and the longer text is probably in `description`. An exact rule would need a "has more" flag from SQL.
- Released `db:fn:wb_action_items`.

### Step 9e live; 9f built (2026-10-23, run tag `warren_buffet_p3-q5k-s23-q1ve`)
- 9e was checkpointed as 1d583db, merged as ffeb7cc, and is live on the site.
- **9f:** `mark_wb_reviewed` gains `note`.
  - It applies to exactly one transaction, only while marking it reviewed, and is added on a new line after any existing note, so nothing is lost. Up to 2000 characters.
  - It stays on `mark_wb_reviewed` rather than a new tool: one optional argument, and refused for a batch.
  - Without a note, the tool behaves as before.
- The `get_wb_action_items` description now covers: flags over 90 days, the refund-to-info state, the handled rule, `note`, `path`, `cash_flow` and `big`. The skill's section 11 says how to close a fee flag.
- Tests: p2 41, mcp index 34, p3 25, warren-buffet 26. Still 139 tools.
- Deployed mcp **v160** over v159 (mine) at 10:18 PT. No auth: 401. Live: 139 tools, with `note` on `mark_wb_reviewed` and the new description. `db:deploy` is held until the fresh-thread check.

### Step 9f done; step 9 complete (2026-10-23, run tag `warren_buffet_p3-q5k-s23-x8gu`)
- Fresh claude.ai thread on v160:
  - `get_wb_action_items` led with the Visa 3782 interest flag (red, note shown, no refund), then below_floor on Nov 9 and cash_flow with its runway;
  - `mark_wb_reviewed` refused a note with two ids, and refused one with reviewed false. Nothing was written.
- Released `db:deploy`.

## Later

### Shared confirm component (outside this project)
- Extract one shared confirm component into `src/shared/`, and use it in Money and in the execution delete. Today the Money item page copies the pattern from ExecutionDetailView's "Delete execution" (A48).

### Phase 3b (or later): Wells Fargo CSV history import
- **Goal:** import about 25 months of Wells Fargo history from CSV downloads. SimpleFIN only ever returns the last 90 days.
- **Files:** 6 in all.
  - 4 bank accounts, back to Sep 2024.
  - 2 credit cards, back to Nov 2024.
  - Columns: DATE, DESCRIPTION, AMOUNT (signed), CHECK #, STATUS.
  - There is no account column and no transaction ID, so **the file name identifies the account**.
- **The design must cover:**
  - **A source marker on imported rows**, so they are never confused with synced ones and can be found, re-run or removed as a set.
  - **A per-account cutoff:** only rows dated **before that account's first synced transaction** are imported, so nothing overlaps or doubles with the sync.
  - **Each account's earliest history date** is recorded, so reports know how far back each account's data goes.
  - **Imported rows run through the normal processing and rules**, so known merchants are tagged and new merchants land in Review.
- **Open questions for the design:**
  - Each row needs a stable external id. One option is a hash of account, date, amount, description and the occurrence number within the file.
  - How STATUS values map to pending and posted.
  - CHECK # goes into memo or notes.
- No amounts belong in this note or in the import code's tests.
