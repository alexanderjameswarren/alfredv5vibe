# Phase 7.0 Progress: MCP Server Foundation

**Started**: 2026-02-19
**Last Updated**: 2026-02-19
**Status**: 🟡 In Progress

---

## Steps

| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Enable OAuth 2.1 Server in Supabase | ✅ Complete | Enabled, auth path set to /oauth/consent |
| 2 | Configure OAuth redirect URLs | ✅ Complete | Added claude.ai and claude.com callback URLs |
| 3 | Enable Dynamic Client Registration | ✅ Complete | Toggle enabled in OAuth Server settings |
| 4 | Install Supabase CLI & initialize Edge Functions | ⬜ Not Started | |
| 5 | Create shared tool library (_shared/alfred-tools/) | ⬜ Not Started | |
| 6 | Build MCP Edge Function with read-only tools | ⬜ Not Started | |
| 7 | Test MCP server locally with MCP Inspector | ⬜ Not Started | |
| 8 | Build OAuth consent page (/oauth/consent) | ⬜ Not Started | |
| 9 | Deploy MCP function to production | ⬜ Not Started | |
| 10 | Connect Claude.ai as custom connector | ⬜ Not Started | |
| 11 | Verify both users can query Alfred data | ⬜ Not Started | |

---

## Notes & Decisions

- Transport: Streamable HTTP (not SSE)
- Auth: Supabase OAuth 2.1 with Dynamic Client Registration
- MCP framework: Official MCP TypeScript SDK + Hono
- Starting authless (--no-verify-jwt) for local dev, adding OAuth for production
- Consent page is a React SPA route on the existing Vercel app
