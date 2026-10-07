# Warren Buffet — Progress

Project code: `warren_buffet-w7b`
Spec: `docs/technical-spec-warren_buffet-w7b.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 0 | Probe folder `tools/warren-buffet/`, `.env` ignored, root `.gitignore` safety net, SimpleFIN claimed and verified (13 accounts across Wells Fargo, City National Bank, Schwab) | done | Pushed from main |
| 1 | Read-only plan: scheduling, Edge Function layout, MCP structure, platform app values, inbox convention, Alfred.jsx split status, file list, claims check | done | Six spec fixes approved and written into §6.2, §6.5, §7, §8 |
| 2 | Migration: `wb_accounts`, `wb_balance_snapshots`, `wb_holding_snapshots`, `wb_transactions`, policies, views; conformance CONFORMANT | done | `089_wb_phase1_tables.sql` applied 2026-10-06 (088 taken by restructure_p1-h4nz); verification passed; CONFORMANT, 49 tables |
| 3 | `wb-sync` Edge Function; Alex sets secrets; manual run verified | done | v3 deployed and verified 2026-10-07. v1: context lookup 500 (trim + stage fix in v2). v2 runs: 13 accounts, 13 snapshots, 20 holdings, 365 txns, no duplicates, cards sign -1; marked partial by the 45-day notice. v3 classifies date-range notices by pattern and counts updates by changed field. Awaiting an ok run. |
| 4 | Daily schedule, `platform_schedules` row, error-to-inbox path | not started | |
| 5 | Phase 1 MCP tools | not started | |
| 6 | Roles, owners, display names, manual accounts (in claude.ai) | not started | |
| 7 | Money section UI | not started | |
| 8 | Spreadsheet history backfill (in claude.ai) | not started | |
| 9 | Phase 1 review and Phase 2 steps | not started | |

## Log

- Step 0: folder and probe set up; first SimpleFIN pull confirmed balances for all accounts, transactions for active ones, and holdings with cost basis for both Wells Fargo brokerage accounts and Schwab. SimpleFIN returns at most 90 days of history per request.
- Step 1 (2026-10-06): scheduling is pg_cron + pg_net with a shared-secret header (mirror `notify-dispatch`, migration 033). Edge Functions use `Deno.env.get` and `createServiceClient`, with a `verify_jwt` entry in `config.toml`. MCP tools use `defineTool` in `_shared/tools/`, registered in `mcp/index.ts`; mirror `get_reminders` / `update_reminder`. The live app check is `dj, sam, alfred, workshop, ken`, enforced in the DB, in `VALID_APP` and in four zod enums; the repo's `000_RECONSTRUCTED` file has drifted (no `ken`). System inbox items are inserted directly with the service role (pattern: `clip-capture`) as `source_type = 'task'`. Next migration on this branch: 088. The UI goes in `src/money/`, with nav in `AppChrome.jsx` `NAV_ITEMS` and routes in `viewPaths.js`; there is no chart library, so the chart will be inline SVG. The Money context is confirmed shared. Claims check was clean. Approved fixes: `WB_SYNC_SECRET` header, `record_wb_balance` tier 2, cron `0 13 * * *` UTC, a snapshot pre-read that skips non-sync rows, net-worth carry-forward, and app `warren_buffet`, added to the check constraints in Step 2.
- Step 2 (2026-10-06): migration 089 applied by Alex. It creates four `wb_` tables with owner-OR-shared-context policies identical to `intents_access`, plus `wb_account_latest` and `wb_net_worth_daily` (security_invoker). Net worth carries balances forward; a closed account stops at its last snapshot, and a history_rollup counts only inside its window, never when `active_until` is null. `warren_buffet` is now in both app checks. Verification query passed; conformance is CONFORMANT, 49 tables. It was renumbered from 088 because another thread claimed that number first.
- Step 3 (2026-10-06/07): `wb-sync` deployed (v3), with secrets set by Alex and `verify_jwt` off. Without the secret, a POST gets the function's own 401. v1 returned a 500 because the context lookup found no row (fixed in v2 by trimming env values, plus `stage` fields and separate error and not-found paths). v2's runs were correct but marked partial by SimpleFIN's 45-day "recommended range" notice; v3 classifies date-range messages as notices by pattern and counts `transactions_updated` only on real field changes. Results on v2: 13 accounts, 13 snapshots, 20 holdings, 365 transactions, no duplicates, both credit cards sign -1, so the sign rule holds. Results on v3: run 1 ok on the 89-day window (2026-07-10 to 2026-10-07), 22 new, 0 updated, 358 unchanged, the 45-day text in `simplefin_notices`, 0 errors. Run 2 ok with `covered_from` 2026-09-27 (10 days before run 1), 0 new, 0 updated, 63 unchanged. No duplicate transactions or snapshots; 387 transactions in total. Core tests 30/30.
