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
| 5 | Starter taxonomy, merchants and rules (in claude.ai) | not started | |
| 6 | UI: Transactions, transaction detail with "always do this", Review, Spending | not started | |
| 7 | Migration B + tools: subscriptions, price history, monthly detection | not started | |
| 8 | Subscriptions seeding (in claude.ai), then Subscriptions tab UI | not started | |
| 9 | Phase 2 review and Phase 3 steps | not started | |
| 10 | Rule health: `wb_rule_health` view, `get_wb_rule_health` tool, weekly claude.ai cleanup task that files one inbox item | not started | Added 2026-10-09 |

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
  - Known limit, accepted: a bare hand removal of a rule tag returns on reprocess.
