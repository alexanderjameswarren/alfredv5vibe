# Warren Buffet Phase 2 — Progress

Project code: `warren_buffet_p2-m4t`
Spec: `docs/technical-spec-warren_buffet_p2-m4t.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 1 | Read-only plan: wb-sync and wb_ tools as built, Money UI structure, migration number, conformance, claims check, spec conflicts | done | 2026-10-09. Fixes 4a–4f and 9.1–9.9 approved and written into spec §3–§6 and §8 |
| 2 | Migration A: merchants, tag groups, tags, splits, split tags, rules, new transaction columns, triggers, `wb_process_transactions`, review/spending/cash-flow views | done | `103_wb_phase2_tables.sql` applied 2026-10-09; `104_wb_phase2_tests.sql` 69/69, every check true; CONFORMANT, 58 tables |
| 3 | wb-sync calls processing; one-time reprocess; verify transfer pairs, investment kinds, cleaned descriptions | done | 2026-10-09: wb-sync v5 processes new, changed and unprocessed rows. 105/106/107 applied; 394/394 processed, 16 genuine pairs, 0 candidates, no split mismatches |
| 4 | Phase 2 MCP tools (except subscriptions); deploy; verify in a fresh chat | done | 2026-10-10: 18 tools plus the get_wb_transactions extension; 108 applied, 109 all checks true; CONFORMANT, 58 tables. mcp v146. claude.ai verification 10/10, plus the plain split refusal. 110 removed the test rule and tag |
| 5 | Starter taxonomy, merchants and rules (in claude.ai) | done | 2026-10-11: taxonomy, merchants and rules set up in claude.ai; review queue at 0. Follow-up (tag exclusions, 114/115) done |
| 6 | UI: Transactions, transaction detail with "always do this", Review, Spending | done 2026-10-11 | Plan approved 2026-10-11 (decisions A–D). 6a: SQL for "always do this" plus `wb_transactions.notes`, 117 applied 2026-10-11 (CONFORMANT, 60 tables), 118 24/24. 6b (UI) verified by Alex: all 26 steps passed on desktop, a phone-sized window, his real phone and as Elise. 6c: tool wrapper, `excluded_tags` and WB_MANUAL; mcp v147 deployed, and the fresh-thread check passed |
| 7 | Migration B + tools: subscriptions, price history, monthly detection | in progress | Plan approved 2026-10-11 (D1–D6). 7a: 120 applied 2026-10-12 (conformant), 121 39/39. 7b (wb-sync detection) in progress |
| 8 | Subscriptions seeding (in claude.ai), then Subscriptions tab UI | not started | |
| 9 | Phase 2 review and Phase 3 steps | not started | |
| 10 | Rule health: `wb_rule_health` view, `get_wb_rule_health` tool, weekly claude.ai cleanup task that files one inbox item | not started | Added 2026-10-09. Also: a bulk-create tool for tags, merchants and rules (Step 5 hit the 60-calls-per-5-minutes limit creating them one call at a time) |

## Carried from Phase 1

- Elise's current 401(k) balance still to be entered.
- Guard bug for chat prompts with run tags: https://alfredv5vibe.vercel.app/ce6c2190-526d-4eca-ad6c-1e08dc1e7b2e

## Log

- Step 1 (2026-10-09): Phase 1 is built as specified. wb-sync's transaction pre-read already separates new from changed rows; processing will be called after the upsert, which will need to return ids. Tools live in `_shared/tools/warren-buffet.ts`, and the UI is `src/money/` with routes in `viewPaths.js`. The live database has 4 wb_ tables, 2 views and one function (`wb_touch_updated_at`), with no Phase 2 objects; conformance is CONFORMANT, 52 tables. The next free migration is 103 (drive_mix-v7r holds 101 and 102), to be confirmed after gitsync. Claims check: `mcp/index.ts` and `index.test.mjs`, which Step 4 needs, are held by drive_mix-v7r. Approved: `wb_process_transactions` as security invoker; exclusivity via copied `group_id` and `group_exclusive`; a deferred split-sum check, with the amount following a single split and `split_mismatch` for multi-split rows; default splits that copy owner and context; `tag_names text[]` in reads; `wb_transactions` stays unaudited; `merchant_source`; rule re-runs that replace rule tags and recompute `hit_count`; posted rows only for pairing and tagging; manual and claude rows never paired; unmatched payment phrases go to `transfer_candidate`; kind precedence; `fee` counted as spending in both views; the `get_wb_transactions` extension in Step 4. SQL tests chosen over a TS mirror. The Phase 1 docs moved to `docs/history/`.
- Step 2 (2026-10-09): migration 103 applied by Alex. It creates six audited tables: `wb_merchants`, `wb_tag_groups`, `wb_tags`, `wb_rules`, `wb_splits` and `wb_split_tags`. All six have intents-style policies. It adds ten columns to `wb_transactions` and nine triggers: default split, deferred split sum, amount follow, owner copy, exclusive-group fill and push, tag parent and cycle checks, and rule tag check. It adds `wb_clean_description`, the phrase, kind, match, pair-decision and rule-match helpers, `wb_process_transactions` (security invoker) and three security_invoker views. Four tag groups are seeded, and all 394 transactions got a default split. Nothing is processed yet. Read-only test file 104: 69/69 tests, and every check true (one split per transaction equal to its amount, 394 = 394, nothing processed, no split tags, policies match intents, RLS on, views invoker, no wb_ security definer, anon blocked). The review queue holds `no_kind` = 394 only. Conformance is CONFORMANT, 58 tables. Before Alex ran it, the SQL ran in PGlite, which caught two bugs: the backfill's deferred events blocked `register_table`'s ALTER, and an ambiguous `r` alias. The Phase 0 probe log, accidentally overwritten in `docs/history/progress-warren_buffet-w7b.md`, was restored into that file's Step 0 entry.
- Step 3 (2026-10-09): wb-sync v5 deployed with verify_jwt off; a POST without the secret gets the function's own 401. The upsert now returns ids. New, changed and never-processed rows go to `wb_process_transactions` in chunks of 100. Run details carry `transactions_processed`, `processing` counts and any `processing_errors`, which never change the run status. Core tests: 41.
  - `105_wb_phase2_reprocess_all.sql`: 394/394 in 4 batches, 16 pairs and 1 candidate.
  - The candidate was false: a Venmo payment whose payee "Transfer to Venmo" matched a transfer phrase. `107_wb_phase2_cleaning_p2p_fix.sql` adds `wb_is_p2p_phrase`, so payments to people (Venmo, Zelle, Visa Direct, PayPal, Cash App) fall through to spend or income and pair only on a unique household match. It also strips phone numbers in more shapes, help URLs, letter-digit codes, masked digits with lot numbers, and dates. With a merchant, it now drops only the trailing state code (the old one-word-city rule ate merchant words).
  - 104 was extended to 85 cases: 85/85.
  - After 107, 105 re-run: 394/394, 0 new pairs, 0 candidates.
  - 106: unprocessed 0. Kinds: spend 284, transfer 32, investment 55, income 12, interest 9, refund 2. The 16 pairs are all genuine and symmetric: the tax-savings and mortgage-savings transfers, five card payments, and two CNB-to-checking transfers. Investment accounts are all `investment`. The review queue holds `missing_required_tag` 298 only, and there are no split mismatches.
  - A sync invoke returned ok, transactions_processed 0, processing_errors 0.
  - Known leftover, accepted: some fund descriptions keep a trailing lot number (e.g. "… FDS 180"); investment rows are not categorized.
- Step 4 plan (2026-10-09), approved:
  - The tool table: 18 new tools plus the get_wb_transactions extension. The plan said 17; that was a miscount.
  - A Step 4 migration with `wb_rules.created_from_transaction_id`, `wb_split_tags.replaced_rule_id`, view `wb_transaction_list`, and the invoker functions `wb_rule_preview`, `wb_replace_splits`, `wb_set_transfer_pair` and `wb_apply_tags`.
  - `tag_wb_transactions` is tier 2 with a hard cap of 25. The names `get_wb_rule_preview` and `create_wb_rule_from_transaction` (tier 3 with propose) are agreed.
  - Spec §6.1 ("Always do this") and Step 10 (rule health) were added the same day.
- Step 4 (2026-10-09/10):
  - `108_wb_phase2_step4_tool_support.sql` applied by Alex. It adds `wb_rules.created_from_transaction_id`, `wb_split_tags.replaced_rule_id`, view `wb_transaction_list`, and the invoker functions `wb_rule_preview`, `wb_replace_splits`, `wb_set_transfer_pair` and `wb_apply_tags`. Tested in PGlite first.
  - 109: all 10 checks true; needs_review 301, equal to the queue; preview_kind_spend 287; preview_transfer_phrase 48, not too narrow. Conformance CONFORMANT, 58 tables.
  - mcp v145 deployed with verify_jwt off; an unauthenticated POST gets the function's own 401.
  - claude.ai verification passed 10/10:
    - all 18 tools are present, and get_wb_transactions has the new fields and no raw;
    - the review queue holds 301, missing_required_tag only; tag groups are seeded, with no tags, merchants or rules;
    - spending is negative, and cash flow has 4 rows;
    - the preview on a real PetSmart transaction proposed merchant "Petsmart", pattern "petsmart", count 12, not too narrow;
    - create_wb_rule_from_transaction returned a 3-step proposal and was not confirmed;
    - the write round trip was clean, and all 11 refusals refused and changed nothing;
    - cleanup left the test tag and rule inactive and unused.
  - Fix: the split refusal had passed through the raw database error, with amounts and internals. v146 maps every known database refusal in the Phase 2 tools to a plain sentence. A fresh chat confirmed "split_wb_transaction: Split amounts must add up to the transaction amount. Nothing was changed." with no amounts or code.
  - `110_wb_phase2_step4_test_cleanup.sql` deleted the ZZ test rule and tag.
  - Tests: functions 629, CLI 174.
  - Two app tests fail on 2026-10-10 only because they look for today's date: `PreviousExecutions.test.jsx` and `StatusEventsSheet.test.jsx`, from restructure_p1-h4nz. Not ours; Alfred item 49958c85.
  - Known limit, accepted: a bare hand removal of a rule tag returns on reprocess. Fixed by the Step 5 follow-up below.
- Step 5 (2026-10-11, claude.ai):
  - The starter taxonomy (Category with parents, Who, Tax, Label), merchants and rules were set up through the tools, and the review queue is at 0.
  - The Newmans rule's notes record that the standing price is rising (the amount is in the rule's notes, not here), to go into subscription price history at Step 7, and that the Oct 8 charge was a one-off service call.
  - Creating tags, merchants and rules one call at a time hit the 60-calls-per-5-minutes limit, so a bulk-create tool is noted under Step 10.
- Step 5 follow-up (2026-10-11), bug: manual tag removals did not survive a reprocess. **Done.**
  - Found in claude.ai during Step 5. tag_wb_transactions removed a tag (source manual) and reported success, but the next wb_process_transactions put the rule's tag back. The same happened after a single-transaction reprocess and after a manual split, and nothing recorded the removal.
  - Repro: transaction bcc82c61-9703-47e8-92e7-c6b473a8ecbf (a one-off, Oct 8). Remove the Subscription label, reprocess Oct 1–11, and Subscription is back.
  - Fix, `_pending_warren_buffet_p2-m4t_tag_exclusions.sql`:
    - new audited table `wb_tag_exclusions`, per transaction and tag, with the rule that had applied it, the source, who and when;
    - `wb_process_transactions` skips an excluded rule tag and still applies the rule's other tags;
    - `wb_apply_tags` writes an exclusion on removal and clears it when the tag is added back;
    - `wb_replace_splits` clears exclusions for tags it adds;
    - `wb_transaction_list.excluded_tags` shows them, and so does get_wb_transactions.
  - Tests: `_pending_warren_buffet_p2-m4t_tag_exclusions_tests.sql`, 13 checks with invented fixtures; it rolls itself back. All passed in PGlite.
  - Numbered after gitsync, with no drift (111–113 touch no wb_ object): `114_wb_phase2_tag_exclusions.sql` and `115_wb_phase2_tag_exclusions_tests.sql`.
  - Decision: removing a required Category tag stays allowed. It sends the transaction back into the review queue; the spec says so in §4.6a.
  - Ships as SQL only; the mcp function is not deployed in this step. The `excluded_tags` changes in `warren-buffet.ts` and `warren-buffet-p2.ts` stay uncommitted in this worktree and ship with Step 6. So does the WB_MANUAL description change in `mcp/index.ts`, which has to cover removals ("a tag removed by hand is never put back"); that one is not yet written, because the file was yielded to restructure_p3-x4n and drive_mix-v7r. Until then the deployed get_wb_transactions does not return `excluded_tags`, but the live tools already get the new behaviour, because the fix is in the database functions they call.
  - Result: 114 applied 2026-10-11, conformance passed. 115: all 13 checks true, rolled back.
  - Real-world check in claude.ai on bcc82c61: the Subscription label was removed by hand and 1 exclusion recorded; Oct 1–11 was reprocessed (60 transactions); the label stayed off, and the tags are Home Services and Household. The other Newmans visits keep Subscription.
  - Step 6 carries the uncommitted `excluded_tags` tool code, the WB_MANUAL wording, and the mcp deploy that ships them.
- Step 6 plan (2026-10-11), approved:
  - A: "always do this" becomes invoker SQL functions `wb_fix_plan` (read) and `wb_apply_fix` (write), with `wb_suggest_pattern`; the MCP tool becomes a thin wrapper, so one implementation serves the tool and the app.
  - B: `wb_transactions.notes` is added in the same 6a migration.
  - C: the Review one-tap actions are approved as planned.
  - D: verification on desktop, in a phone-sized window, as Elise, and once on Alex's real phone.
  - Sub-steps 6a (SQL), 6b (UI) and 6c (tools, WB_MANUAL wording, mcp deploy) go one at a time.
  - 6a: `_pending_warren_buffet_p2-m4t_step6_fix_functions.sql` and `_pending_…_step6_tests.sql`, 24 checks with invented fixtures; it rolls itself back. In PGlite: 24/24, 115 13/13, 104 85/85.
  - Numbered after gitsync, with no drift (116 touches no wb_ object): `117_wb_phase2_step6_fix_functions.sql` and `118_wb_phase2_step6_tests.sql`. 117 applied 2026-10-11; check_platform_conformance CONFORMANT, 60 tables. 118: all 24 checks true, rolled back.
  - 6b (2026-10-11): new Money tabs Transactions, Review and Spending, plus the transaction detail screen, all in `src/money/`, with routes in `viewPaths.js`.
    - Transactions: filters and 50 at a time.
    - Detail: kind; tags per group, with "removed by you" and undo; the split editor; transfer pair, unpair or find; notes; reviewed.
    - The "Always do this" sheet runs on `wb_fix_plan` / `wb_apply_fix`, defaults to updating the merchant's rule, and warns when too narrow.
    - Review: one-tap fixes. Spending: a month view expandable to children, and a 6-month cash-flow strip.
    - Account detail's transactions now come from `wb_transaction_list`.
    - Reads and writes go under RLS, with hand edits as `manual`. Database errors show as plain sentences (`plainError`).
    - Tests: app 2334/2334, CLI 174/174, `CI=true npm run build` compiled.
    - Verified by Alex on 2026-10-11: all 26 test steps passed, on desktop, in a phone-sized window, on his real phone and as Elise. That includes a tag removed by hand staying removed after a reload, with a working undo.
  - 6c (2026-10-11):
    - `create_wb_rule_from_transaction` is now a thin wrapper over `wb_fix_plan` / `wb_apply_fix`. Its parameters and envelope are unchanged, and database refusals go through `dbError`.
    - `get_wb_transactions` returns `excluded_tags`.
    - WB_MANUAL says a tag removed by hand or by Claude is never put back by rules, and adding it back by hand clears that.
    - Tests: functions 628/628, CLI 174/174, app 2334/2334.
    - After gitsync there was no drift, since nothing in supabase/ came in. mcp was deployed as v147; an unauthenticated POST gets a 401.
  - The fresh-thread check passed on v147:
    - 113 tools.
    - `excluded_tags` on bcc82c61 lists Subscription, linked to its rule.
    - The `create_wb_rule_from_transaction` dry run returned `confirmation_required`: existing merchant, 3 past matches, not too narrow, a warning to update the existing rule, and an empty pattern because the merchant already exists.
    - No writes.
- Step 7 plan (2026-10-11), approved:
  - D1: `wb_merchants.not_subscription`, set when a detection is dismissed.
  - D2: `wb_transactions.subscription_source`; claude and manual links are never overwritten.
  - D3: exact cents, plus a per-subscription `amount_tolerance` (default 0), used for linking and for `price_change`.
  - D4: missing charges live in `wb_subscription_overview`, not the review queue.
  - D5: detection runs in wb-sync after processing. It needs 3 or more charges 26–35 days apart, each within 10% of their median.
  - D6: the Review tab labels and "Record new price" are part of Step 7.
  - Sub-steps go one at a time: 7a SQL, 7b wb-sync, 7c tools, 7d Review tab.
  - 7a: `_pending_warren_buffet_p2-m4t_step7_subscriptions.sql` and `_pending_…_step7_tests.sql` (39 checks, invented fixtures, rolled back).
    - PGlite: 39/39. 118 24/24, 115 13/13 and 104 85/85 still pass.
    - Beyond the plan: helpers `wb_subscription_price_on` and `wb_refresh_subscriptions`; price source `claude` alongside detected and manual; `subscription_*` columns in `wb_transaction_list`. Alex approved these on 2026-10-12.
    - After gitsync (2026-10-12) there was no drift: 119 touches no wb_ object. The 7a db items were claimed, and the files numbered `120_wb_phase2_step7_subscriptions.sql` and `121_wb_phase2_step7_tests.sql`. PGlite still passes.
    - Spec Step 8 now records the old-price rule: seeding records both prices.
    - Alex ran both on 2026-10-12: 120 conformant, with no failures; 121 39/39, rolled back.
  - 7b (2026-10-12): wb-sync calls `wb_detect_subscriptions` after processing.
    - Like processing errors, a detection error is recorded on the run (`detection_error`) and never changes its status.
    - Run details gain `detection {created, linked}` and `processing.subscriptions_linked`.
    - A run with no accounts (including a simulated one) skips detection.
    - Tests: functions 637/637, CLI 174/174. `deno check` passes. Not yet deployed.
