# Phase 7.2 Progress: AI Enrichment Edge Function (Agentic)

**Started**: 2026-02-20
**Last Updated**: 2026-02-20
**Status**: 🟡 In Progress

---

## Steps

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Store Anthropic API key in Supabase Vault | ✅ Complete | Secret stored via Dashboard |
| 2 | Create ai-enrich Edge Function scaffold | ✅ Complete | deno.json + function created |
| 3 | Build agentic loop with Claude API tool_use | ✅ Complete | Full implementation in index.ts |
| 4 | Add fetch_url tool (ai-enrich only) | ✅ Complete | Included in Step 3 |
| 5 | Add submit_suggestions terminal tool | ✅ Complete | Included in Step 3 |
| 6 | Build system prompt (Sonnet first-pass + Opus re-enrich) | ✅ Complete | Included in Step 3 |
| 7 | Deploy ai-enrich function | ✅ Complete | Terminal command |
| 8 | Test first-pass enrichment (Sonnet) | ⬜ Not Started | Manual — curl or Alfred UI |
| 9 | Test re-enrichment (Opus) | ⬜ Not Started | Manual — edit + re-enrich |



---

## Notes & Decisions

-UNABLE TO COMPLETE BECAUSE WE NEED BUTTONS IN THE UI.  ADDING AS PHASE 7.2.1

- Auth: Alfred UI passes user's JWT → ai-enrich creates user-scoped client → RLS enforced
- Service role used ONLY for updating inbox ai_status/suggestions (user's own record)
- Shared tool handlers reused from MCP — same library, RLS works identically
- Model selection: ai_status='not_started' → Sonnet, ai_status='enriched'/'re_enriched' → Opus
- Re-enrich Opus prompt includes previous suggestions so it can reason about what changed
- ai_status flow: not_started → enriched (Sonnet) → re_enriched (Opus) → re_enriched (Opus again)
- fetch_url strips HTML to plain text (recipe sites are bloated)
- Max 10 tool calls per loop, Edge Function timeout as hard stop
- On error: reset ai_status to 'not_started' so user can retry
