# Warren Buffet — Progress

Project code: `warren_buffet-w7b`
Spec: `docs/technical-spec-warren_buffet-w7b.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 0 | Probe folder `tools/warren-buffet/`, `.env` ignored, root `.gitignore` safety net, SimpleFIN claimed and verified (13 accounts across Wells Fargo, City National Bank, Schwab) | done | Pushed from main |
| 1 | Read-only plan: scheduling, Edge Function layout, MCP structure, platform app values, inbox convention, Alfred.jsx split status, file list, claims check | done | Six spec fixes approved and written into §6.2, §6.5, §7, §8 |
| 2 | Migration: `wb_accounts`, `wb_balance_snapshots`, `wb_holding_snapshots`, `wb_transactions`, policies, views; conformance CONFORMANT | done | `089_wb_phase1_tables.sql` applied 2026-10-06 (088 taken by restructure_p1-h4nz); verification passed; CONFORMANT, 49 tables |
| 3 | `wb-sync` Edge Function; Alex sets secrets; manual run verified | not started | |
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
