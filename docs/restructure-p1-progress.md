# Restructure Phase 1 — progress

Spec: https://claude.ai/code/artifact/5aa5a63b-5d22-48a3-8c9a-dc1bc524f908
Worktree / owner: `restructure_p1-h4nz`

| Step | What | Status |
|---|---|---|
| 1 | Read-only plan | done 2026-10-06 |
| 2 | Migration: status, status_changed_at, is_reference, suggested_status, guard, activation triggers, platform_search_items | done: 088 applied 2026-10-06, verified, CONFORMANT (45 tables) |
| 3 | MCP and alfred-enrich skill | mcp deployed 2026-10-06; status fields live in get_inbox / get_items / get_intents; write and filter tests pending; skill re-upload pending |
| 4 | Inbox status | — |
| 5 | Status control, events sheet, recurrence and close changes, toast | — |
| 6 | Filter chips with counts | — |
| 7 | Archived view per context | — |

## Step 2 (2026-10-06)
Migration `088_restructure_p1_status.sql`, run by Alex. Verified: items 396
active / 59 closed, intents 61 active / 132 closed, someday and background 0,
inbox 472 rows all someday, mismatches 0, `updated_at` untouched by the backfill
(only Alex's Water Plants edit), triggers `items_status_guard`,
`intents_status_guard`, `events_status_activate`, `executions_status_activate`
enabled beside `set_updated_at`, `platform_search_items` five arguments with
the same ACL. `check_platform_conformance` CONFORMANT (45 tables).

## Decisions (2026-10-06)
- Backfill: live rows active, archived rows closed. Closed does not archive: status is lifecycle, archived is visibility.
- Scheduling or executing a background record makes it active. Never closed.
- Chips: someday and active on by default; every chip shows its count, on or off.
- One `suggested_status` for both the item and the intention.
- Closing archives past-due and future live events.
- No gating on Do Today or Run Now: auto-flip with a "Moved to active" toast.
- Event and execution writes stay in the browser; the triggers are a safety net.
- MemoriesScreen is left alone.
- Backfill pauses set_updated_at around the archived-rows UPDATE; archived rows take updated_at as status_changed_at.
- No "recurring is active by construction" trigger: the event trigger is the one mechanism.
- platform_search_items keeps its exact ACL (PUBLIC, anon, authenticated, service_role); dropping anon is a separate change.
