# Warren Buffet Phase 2 — Progress

Project code: `warren_buffet_p2-m4t`
Spec: `docs/technical-spec-warren_buffet_p2-m4t.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 1 | Read-only plan: wb-sync and wb_ tools as built, Money UI structure, migration number, conformance, claims check, spec conflicts | done | 2026-10-09. Fixes 4a–4f and 9.1–9.9 approved and written into spec §3–§6 and §8 |
| 2 | Migration A: merchants, tag groups, tags, splits, split tags, rules, new transaction columns, triggers, `wb_process_transactions`, review/spending/cash-flow views | done | `103_wb_phase2_tables.sql` applied 2026-10-09; `104_wb_phase2_tests.sql` 69/69, every check true; CONFORMANT, 58 tables |
| 3 | wb-sync calls processing; one-time reprocess; verify transfer pairs, investment kinds, cleaned descriptions | not started | |
| 4 | Phase 2 MCP tools (except subscriptions); deploy; verify in a fresh chat | not started | |
| 5 | Starter taxonomy, merchants and rules (in claude.ai) | not started | |
| 6 | UI: Transactions, transaction detail with "always do this", Review, Spending | not started | |
| 7 | Migration B + tools: subscriptions, price history, monthly detection | not started | |
| 8 | Subscriptions seeding (in claude.ai), then Subscriptions tab UI | not started | |
| 9 | Phase 2 review and Phase 3 steps | not started | |

## Carried from Phase 1

- Elise's current 401(k) balance still to be entered.
- Guard bug for chat prompts with run tags: https://alfredv5vibe.vercel.app/ce6c2190-526d-4eca-ad6c-1e08dc1e7b2e

## Log

- Step 1 (2026-10-09): Phase 1 is built as specified. wb-sync's transaction pre-read already separates new from changed rows; processing will be called after the upsert, which will need to return ids. Tools live in `_shared/tools/warren-buffet.ts`, and the UI is `src/money/` with routes in `viewPaths.js`. The live database has 4 wb_ tables, 2 views and one function (`wb_touch_updated_at`), with no Phase 2 objects; conformance is CONFORMANT, 52 tables. The next free migration is 103 (drive_mix-v7r holds 101 and 102), to be confirmed after gitsync. Claims check: `mcp/index.ts` and `index.test.mjs`, which Step 4 needs, are held by drive_mix-v7r. Approved: `wb_process_transactions` as security invoker; exclusivity via copied `group_id` and `group_exclusive`; a deferred split-sum check, with the amount following a single split and `split_mismatch` for multi-split rows; default splits that copy owner and context; `tag_names text[]` in reads; `wb_transactions` stays unaudited; `merchant_source`; rule re-runs that replace rule tags and recompute `hit_count`; posted rows only for pairing and tagging; manual and claude rows never paired; unmatched payment phrases go to `transfer_candidate`; kind precedence; `fee` counted as spending in both views; the `get_wb_transactions` extension in Step 4. SQL tests chosen over a TS mirror. The Phase 1 docs moved to `docs/history/`.
- Step 2 (2026-10-09): migration 103 applied by Alex. It creates six audited tables: `wb_merchants`, `wb_tag_groups`, `wb_tags`, `wb_rules`, `wb_splits` and `wb_split_tags`. All six have intents-style policies. It adds ten columns to `wb_transactions` and nine triggers: default split, deferred split sum, amount follow, owner copy, exclusive-group fill and push, tag parent and cycle checks, and rule tag check. It adds `wb_clean_description`, the phrase, kind, match, pair-decision and rule-match helpers, `wb_process_transactions` (security invoker) and three security_invoker views. Four tag groups are seeded, and all 394 transactions got a default split. Nothing is processed yet. Read-only test file 104: 69/69 tests, and every check true (one split per transaction equal to its amount, 394 = 394, nothing processed, no split tags, policies match intents, RLS on, views invoker, no wb_ security definer, anon blocked). The review queue holds `no_kind` = 394 only. Conformance is CONFORMANT, 58 tables. Before Alex ran it, the SQL ran in PGlite, which caught two bugs: the backfill's deferred events blocked `register_table`'s ALTER, and an ambiguous `r` alias. The Phase 0 probe log, accidentally overwritten in `docs/history/progress-warren_buffet-w7b.md`, was restored into that file's Step 0 entry.
