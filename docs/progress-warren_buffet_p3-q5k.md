# Warren Buffet Phase 3 — Progress

Project code: `warren_buffet_p3-q5k`. Spec: `docs/technical-spec-warren_buffet_p3-q5k.md`.
No amounts in this file. The safety floor is never written into the repo.

| step | what | status |
|---|---|---|
| 1 | Read-only plan | done, 2026-10-14 |
| 2 | Migration C: tables, `wb_splits.project_id`, `wb_replace_splits` | done, 2026-10-14 (133 applied, 134 41/41) |
| 3 | Help for Phase 2 (and Phase 1) screens | built; tests and build pass; awaiting Alex's app test |
| 4 | Processing and match suggestions | not started |
| 5 | Views and projection | not started |
| 6 | MCP tools | not started |
| 7 | Seeding in claude.ai | not started |
| 8 | Plan tab UI | not started |
| 9 | Overview numbers | not started |
| 10 | Weekly cleanup prompt, **plus the `never_fires` fix (spec A16)**: flag a rule when its last match is older than about 1.5× its expected interval, and give a new rule that long before its first match is due; update `rule_health.never_fires` help and `ruleNumbers.js` with it | not started |
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
