# Warren Buffet — Progress

Project code: `warren_buffet-w7b`
Spec: `docs/technical-spec-warren_buffet-w7b.md`

Rule: one step at a time. The CLI finishes a step, records it here, reports, and stops for Alex.

| step | description | status | notes |
|---|---|---|---|
| 0 | Probe folder `tools/warren-buffet/`, `.env` ignored, root `.gitignore` safety net, SimpleFIN claimed and verified (13 accounts across Wells Fargo, City National Bank, Schwab) | done | Pushed from main |
| 1 | Read-only plan: scheduling, Edge Function layout, MCP structure, platform app values, inbox convention, Alfred.jsx split status, file list, claims check | not started | |
| 2 | Migration: `wb_accounts`, `wb_balance_snapshots`, `wb_holding_snapshots`, `wb_transactions`, policies, views; conformance CONFORMANT | not started | |
| 3 | `wb-sync` Edge Function; Alex sets secrets; manual run verified | not started | |
| 4 | Daily schedule, `platform_schedules` row, error-to-inbox path | not started | |
| 5 | Phase 1 MCP tools | not started | |
| 6 | Roles, owners, display names, manual accounts (in claude.ai) | not started | |
| 7 | Money section UI | not started | |
| 8 | Spreadsheet history backfill (in claude.ai) | not started | |
| 9 | Phase 1 review and Phase 2 steps | not started | |

## Log

- Step 0: folder and probe set up; first SimpleFIN pull confirmed balances for all accounts, transactions for active ones, and holdings with cost basis for both Wells Fargo brokerage accounts and Schwab. SimpleFIN returns at most 90 days of history per request.
