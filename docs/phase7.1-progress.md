# Phase 7.1 Progress: Inbox Schema Migration + MCP Write Tool

**Started**: 2026-02-20
**Last Updated**: 2026-02-20
**Status**: 🟡 In Progress

---

## Steps

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Run inbox schema migration (add new columns) | ⬜ Not Started | SQL — run in Supabase SQL Editor |
| 2 | Verify RLS policies on inbox allow inserts | ⬜ Not Started | SQL — check/update in Supabase SQL Editor |
| 3 | Add createInboxItem handler to shared tool library | ⬜ Not Started | Claude CLI |
| 4 | Register create_inbox_item tool in MCP server | ⬜ Not Started | Claude CLI |
| 5 | Deploy updated MCP function | ⬜ Not Started | Terminal command |
| 6 | Test write tool from Claude.ai | ⬜ Not Started | Manual verification |

---

## Notes & Decisions

- Auth token wiring already handled in 7.0 — createMcpServer(token) pattern works correctly
- suggested_item_elements already exists on inbox — recipe parsing will be populated by 7.2 (ai-enrich)
- create_inbox_item is the ONLY write tool — all writes go through inbox, never directly to items/intents/events
- MCP-created inbox records set source_type='mcp' and ai_status='enriched' since Claude.ai already did the thinking
