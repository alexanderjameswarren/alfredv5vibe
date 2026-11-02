# Warren Buffet Phase 4: progress

Spec: [technical-spec-warren_buffet_p4-r6d.md](technical-spec-warren_buffet_p4-r6d.md). Its privacy rule applies to this file: no amounts, descriptions, payees, order items or account numbers.

`db:` items are claimed just in time at their step, after gitsync and a drift check, and released at Checkpoint.

**Status: finished 2026-11-02. Every step is done.** Results are in Step 8j and Step 9; open follow-ups are at the end of Step 9. A status inside a step below is what was true when that step was written; a later step says how it closed.

## Steps

### Step 2: spec, progress, claims. Done
Database: none.

19 files and folders claimed. `supabase/functions/mcp/index.ts` and `index.test.mjs` are not claimed; see Step 8.

### Step 3: interval rule, tests, help (P4-D1)
Database: `db:table:wb_rule_health_all`, `db:table:wb_rule_health`.

Scope:
- create: supabase/migrations/_pending_warren_buffet_p4-r6d_interval_rule.sql, supabase/tests/warren_buffet_p4/
- update: src/money/helpText.js, src/money/helpText.test.js, src/money/ruleNumbers.js
- delete: none
- deploy: none
- SQL: wb_rule_health_all, wb_rule_health

Status: done. Migration `190_interval_rule.sql` is live and checkpointed (main ea156b5).

Choices inside P4-D1: "too few" is fewer than 3 linked charges (the same minimum as detection). Linked charges exclude pending rows, refunds and cancelled subscriptions.

Two-week bucket (s3b): gaps of 11 to 17 days count as two weeks. Recorded in P4-D1 in Step 4.

### Step 4: source marker and every skip (P4-D4)
Database: `db:table:wb_transactions`, `db:table:wb_accounts`, `db:table:wb_review_queue`, `db:table:wb_transaction_list`, `db:table:wb_rule_health_all`, `db:table:wb_rule_health`, `db:fn:wb_process_transactions`, `db:fn:wb_suggest_planned_matches`, `db:fn:wb_planned_start_from_history`, `db:fn:wb_action_items`.

Scope:
- create: supabase/migrations/_pending_warren_buffet_p4-r6d_history_source.sql, supabase/tests/warren_buffet_p4/
- update: none
- delete: none
- deploy: none
- SQL: wb_transactions, wb_accounts, wb_review_queue, wb_transaction_list, wb_rule_health_all, wb_rule_health, wb_process_transactions, wb_suggest_planned_matches, wb_planned_start_from_history, wb_action_items, plus the tables the test fixtures name: wb_merchants, wb_rules, wb_subscriptions, wb_planned_items, wb_planned_matches

Status: done. Migration `191_history_source.sql` is live and checkpointed (main 408f9ca). All seven test runs passed.

Choices inside P4-D4: `wb_process_transactions` is unchanged, since suggestions are filtered inside `wb_suggest_planned_matches`. `new_recurring` points at the newest synced charge. Imported refunds do not pair with synced fees. `wb_action_items` stays authenticated only, as 158 set it.

Decided in Step 5: imported rows reach transfer pairing, the subscription link and refresh, and detection on purpose (P4-D9).

### Step 5: import script, parsers, invented-data tests, dry run with counts and a boundary check (P4-D2, D3, D5)
Database: none.

Scope:
- create: tools/warren-buffet/import/
- update: docs/technical-spec-warren_buffet_p4-r6d.md
- delete: none
- deploy: none
- SQL: none

Status: done; the real runs are in Step 6. Script and 13 tests written; tests pass.

Choices: the script is Node, per the spec's import section. The dry run writes nothing anywhere, so the proof of a clean run is a code it prints, tied to the file bytes and cutoffs, which `--write --confirm <code>` recomputes. `--only` picks files, because after one file is imported a dry run of all files is no longer clean. The closed CNB account the rows name is the one ending 6900.

### Step 6: Alex runs the Wells Fargo import, Elise's small file first, then CNB; verify
Database: data only, `db:table:wb_transactions`.

Scope:
- create: none
- update: none
- delete: none
- deploy: none
- SQL: wb_transactions, wb_accounts

Status: done. Alex ran both writes; each reported "Processing chunks failed: 0". The check query matched: `imported_total` 2999, `imported_unprocessed` 0, all three `imported_in_*` counts 0, synced rows unchanged, review queue unchanged (`missing_required_tag` 23, `planned_match` 1, `price_change` 1). `imported_with_no_tag` 832. By kind: spend 2515, transfer 267, income 116, interest 66, refund 26, fee 9. Both `db:` claims released in Step 7.

### Step 7: folded into Step 8
Stopped at its conflict check, with nothing built or deployed: the tools need `supabase/functions/mcp/index.ts`, which switchboard2-h8r held. Alex dropped `as_of` (P4-D6) and moved the source filter to Step 8b. Since 408f9ca, main had gained only `192_reads.sql`.

### Step 8a: Amazon reader and match test (P4-D7)
Database: none; the match test only reads.

Scope:
- create: tools/warren-buffet/import/
- update: docs/technical-spec-warren_buffet_p4-r6d.md
- delete: none
- deploy: none
- SQL: none

Status: done. Alex's run wrote nothing: 293 charges; 0-3 days one 233 (80%), many 0, none 60; 0-7 days one 232, many 2, none 59. Shipments 344, no charge 109 (25 part gift card); 9 predate card history. Whole Foods check 0.

Choices are in P4-D7. `history_import.mjs` now exports `rest`, so the match test shares it.

### Step 8b: order tables, item writer and read tool (P4-D6, D7)
Database: `db:table:wb_orders`, `db:table:wb_order_items`, `db:table:wb_order_matches`, `db:table:wb_transactions`; none claimed yet.

Status: stopped at a plan guard block on the SQL test script; finished in 8b2. Written here: `amazon_import.mjs` with tests, the reader's unit price and site, `get_wb_order_items`, and the source filter. `supabase/functions/mcp/index.ts` and its test are claimed.

`supabase/functions/mcp/tables.test.mjs` fails until the migration has run and the schema snapshot is refreshed, because it looks for the new tables there.

### Step 8b2: refunds, test script, numbering
Database: `db:table:wb_orders`, `db:table:wb_order_items`, `db:table:wb_order_matches`, `db:table:wb_transactions`, `db:fn:wb_order_matches_check`, all claimed.

Status: done. `193_orders.sql` is live: conformant true, failures []. `3_orders_tests.sql` failed one case, fixed in Step 8c; nothing was left behind.

Refunds name an order, not an item. On the real files, 21 refunds on in-range orders: 14 placed on an item, 7 not placed. Choices are in P4-D7. Added beyond the prompt: the `wb_order_matches_check` trigger, so the SQL tests can prove the zero-total rule. Leaving both charges unmatched when two claim one shipment is the writer's rule, tested in `amazon_import.test.mjs`; the SQL test proves the database refuses the second.

### Step 8c: refund check fix
Database: `db:table:wb_order_items`, already claimed.

Scope:
- create: supabase/migrations/
- update: supabase/tests/warren_buffet_p4/3_orders_tests.sql
- delete: none
- deploy: none
- SQL: wb_order_items

Status: done. 194 is live (conformant true, failures []), and the test script passed with rows_left_behind 0. The test was right. In 193, a `refund_date` with no `refunded_amount` made the check NULL, which passes. The reverse was already refused. The writer always sets both or neither, and the table had no real rows, so no data is affected.

### Step 8d: deploy mcp and the real write (was 8b3)
Database: `db:deploy`, data in the three order tables. Run the dry run, then the write, then one live read of each tool.

Status: `mcp` deployed from this worktree with the fixed description; `db:deploy` released. The source filter responds live: an invalid value is refused by the new schema, and `history_import` reports 2999 rows. `get_wb_order_items` is not confirmed: this session's tool list predates the deploy. `tables.test.mjs` fails until Checkpoint regenerates the snapshot; the snapshot isn't in scope.

The write is not run, and its sequence has not been given: `amazon_import.mjs` sends items and matches with `return=minimal`, whose empty reply makes the shared `rest` helper throw after the first chunk. The test's fake always returned a body, so it missed this. Needs Step 8d2.

Expected from the real files: Amazon shipments 346, items 676; Whole Foods shipments 162, items 2248; refunds 21, placed 14, not placed 7; charges 293. Matches are 233 minus any charges two claim on one shipment.

Alex ran the checkpoint with `--release-db`: migrations, tool files, `mcp`, the history and Amazon reader files, spec and progress.

Closed: the write ran in Step 8e.

### Step 8e: fix the writer's empty reply, then the real write (proposed as 8d2)
Database: `db:table:wb_orders`, `db:table:wb_order_items`, `db:table:wb_order_matches`, `db:table:wb_transactions`, data only.

Scope:
- create: none
- update: tools/warren-buffet/import/amazon_import.mjs, tools/warren-buffet/import/amazon_import.test.mjs
- delete: none
- deploy: none
- SQL: wb_orders, wb_order_items, wb_order_matches, wb_transactions, wb_accounts

Status: done. Writer fixed, with a test whose fake database replies empty as PostgREST does. Alex ran the write and checkpoint: 508 shipments, 2924 items, 233 matches, 14 refunds placed.

### Step 8f: item tags and splitting Amazon charges (P4-D10)
Status: stopped at a plan guard block; the SQL is not written. Written: `set_wb_order_item_tags`, `split_wb_order_charges` with tests, registration, help line, P4-D10. Refused: the `_pending_` migration, because its draft used a temporary table not in the SQL list. Also out of scope, so not tried: the `wb_process_transactions` change, whose body updates `wb_rules`; the test script, whose fixtures insert into `wb_accounts` and `wb_orders`; and deleting the `_pending_` file. No `db:` items claimed, nothing numbered, no SQL run. The tools call functions that don't exist yet, so they can't deploy until the migration has run.

Closed: the SQL was finished in Step 8g.

### Step 8g: the split migration and test
Database: `db:table:wb_order_items`, `wb_order_matches`, `wb_transactions`, `wb_splits`, `wb_split_tags`, `wb_tags`, `wb_rules`, `wb_accounts`, `wb_orders`, `db:fn:wb_process_transactions`, `wb_set_order_item_tags`, `wb_order_split_state`, `wb_split_order_charges`, all claimed.

Status: done. `195_item_splits.sql` and `4_item_splits_tests.sql` written, `_pending_` deleted. `wb_process_transactions` differs from the live one only in the `from_order` guards and one comment, checked by diff against main's snapshot.

The project skip is tested with a real project id inside the rolled-back transaction; a planned match reads the same condition but isn't exercised, since `wb_projects` and `wb_planned_matches` fixtures aren't in scope. Two charges claiming one shipment stays a writer rule.

Alex ran both: `195_item_splits.sql` is live (conformant true, failures []), and `4_item_splits_tests.sql` passed (ALL PASSED, rolled back, rows_left_behind 0).

### Step 8h: queue the regression scripts
Database: none claimed here; the Step 8g `db:` claims were still held, waiting on Checkpoint.

Status: done. All eight queued with `--test`; none refused. Action ids, in order:
- `115_wb_phase2_tag_exclusions_tests.sql`: 7faa5955-075b-47db-a943-54fd12d39b24
- `118_wb_phase2_step6_tests.sql`: de79131f-0943-42c6-9907-7091043343ee
- `121_wb_phase2_step7_tests.sql`: fabd8f7d-cd56-4637-9725-eccf59319c99
- `123_wb_phase2_step7d_tests.sql`: 3f4c956c-fe08-4692-8ddb-fed98b4cc365
- `125_wb_phase2_step8_tests.sql`: 8c0f1091-04b5-4c18-8eeb-d06536d16c10
- `128_wb_phase2_step10_rule_health_tests.sql`: a0b3c308-83b3-4ea1-a9aa-ca367d1fbb88
- `132_wb_phase2_step10_acks_tests.sql`: c9a3378b-551d-4dc3-a17f-f5d3c77bb605
- `136_wb_phase3_step4_tests.sql`: d8386489-34f3-483e-b0ec-d5e9fabf5b4e

All eight passed per Alex: 184 checks, all_passed true each.

### Step 8i: confirm, release, deploy
Status: done. The ten files reached main in dda30b1, merged by 5854c84. No `db:` claims were left to release. `mcp` deployed from this worktree, and the deploy claim is released. The CLI session could not confirm the two tools live; Step 8j used them in chat.

### Step 8j: tag in chat, run the splits
Ran in chat with the two new tools. Nothing built or deployed.

Status: done.

All 2924 order items tagged, none left.

| Amazon (676) | Items |
|---|---|
| Groceries | 171 |
| Household Goods | 145 |
| Pet Food & Supplies | 80 |
| Toiletries & Beauty | 53 |
| Electronics & Computer Hardware | 46 |
| Clothing | 44 |
| Furnishings & Design | 18 |
| Hobbies & Games | 17 |
| Garden & Outdoor | 17 |
| Supplements | 16 |
| Hair & Grooming | 14 |
| Holiday & Seasonal Decor | 12 |
| Pharmacy | 10 |
| Home Maintenance | 8 |
| Fitness Gear | 7 |
| Vision | 6 |
| Gifts | 5 |
| Office Supplies | 5 |
| Car Accessories | 2 |

| Whole Foods (2248) | Items |
|---|---|
| Groceries | 2232 |
| Garden & Outdoor | 6 |
| Hair & Grooming | 5 |
| Household Goods | 3 |
| Supplements | 2 |

Nine new Category tags, by group:
- Technology: Electronics & Computer Hardware
- Fitness & Personal Care: Toiletries & Beauty, Fitness Gear
- Home: Holiday & Seasonal Decor, Garden & Outdoor, Home Maintenance
- Entertainment: Hobbies & Games
- Transportation: Car Accessories
- Shopping: Office Supplies

Alex's decisions: cleaning supplies go to Household Goods, so Cleaning is only for the cleaning service. Items that read as baby goods but are for the dog go to Pet Food & Supplies.

`split_wb_order_charges`: 233 charges split, 0 skipped, 0 failed. A check found 0 transactions whose splits don't sum to the charge.

Lessons:
- The split tool has no preview.
- Amazon's department labels were unreliable, so tagging went by product name.
- The read-only role can't see `wb_order_matches`.

### Step 9: results, follow-ups, Finish
Database: none.

**Burn-rate comparison (P4-D8),** after the CNB fixes below: the 12-month median (Nov 2025 to Oct 2026) is about 1.3 times the 3-month window, and every month since June 2026 sits between about 0.8 and 1.4 times it. Decision: keep the 3-month window. Figures are in the chat, per the privacy rule.

**Done in chat on CNB rows:**
- Relabelled: five transfers to Wells Fargo paired, the CD paired as a transfer, the May payouts set as transfers, and six CD interest rows set as interest.
- One CNB check put on the bathroom claim project and confirmed against its named record.

**Open follow-ups:**
- Elise's Amazon export: not imported; the buyer column holds the place.
- Digital Content Orders: the later pass in P4-D7.
- Delete the history files from `tools/` in the main checkout, per the privacy rule. An Alfred intention tracks this.
- Order-item tools for the chat skill: `get_wb_order_items`, `set_wb_order_item_tags` and `split_wb_order_charges` aren't in it yet.

## Timing log

| Step | Run tag | Phase | Start | End | Duration |
|---|---|---|---|---|---|
| 1 | s1-p3qz | Plan | 12:08:41 | 12:12:37 | 3:56 |
| 2 | s2-m7xd | Claim refused | 06:06:55 | 06:07:19 | 0:24 |
| 2 | s2b-q4jn | Claims, reservations, spec, progress | 06:09:25 | 06:10:26 | 1:01 |
| 3 | s3-v8nc | Reading and writing, test script refused | 06:12:37 | 06:15:00 | 2:23 |
| 3 | s3-v8nc | Help tests | 06:15:00 | 06:15:07 | 0:07 |
| 3 | s3b-h2tw | Drift check, bucket, test script, numbering | 06:18:28 | 06:21:24 | 2:56 |
| 3 | s3b-h2tw | Help tests | 06:21:24 | 06:21:27 | 0:03 |
