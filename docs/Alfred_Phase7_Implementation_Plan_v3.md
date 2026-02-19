# Alfred Phase 7: MCP + Email Capture — Implementation Plan v3

## The Core Mental Model

**The Inbox is the universal gateway. Claude enriches, humans approve.**

Every piece of data entering Alfred — whether typed manually, forwarded via email, or created by Claude through MCP — lands in the `inbox` table first. Claude's job is to fill in the `suggested_*` columns so the user can review and click "Save" rather than manually organizing everything.

Three capture paths, one processing pipeline:
1. **Manual capture**: User types/pastes into Alfred → inbox record created → AI enrichment triggered
2. **Email capture**: Email forwarded → Postmark webhook → inbox record created → AI enrichment triggered
3. **MCP capture**: User tells Claude.ai "add milk to groceries" → Claude creates inbox record with suggestions pre-filled (already enriched)

The human-in-the-middle pattern means Claude never directly writes to `items`, `intents`, or `events`. It only writes to `inbox` with suggestions.

---

## Two Separate Claude Integrations (Shared Tool Library)

This is an important distinction:

| | MCP Server | AI Enrichment Function |
|---|---|---|
| **What** | Edge Function exposing tools to Claude.ai | Edge Function that calls Claude API with tool_use |
| **Direction** | Claude.ai → calls Alfred's tools | Alfred → calls Claude API, Claude calls tools back |
| **Purpose** | Conversational access ("what's for dinner?") | Automatic suggestion generation on inbox records |
| **Auth** | OAuth 2.1 (user's identity flows through) | Anthropic API key (stored in Supabase Vault) |
| **Data access** | Shared tool library queries DB via Supabase client | Same shared tool library, same DB queries |
| **How Claude uses tools** | Claude.ai invokes tools via MCP protocol | Claude API invokes tools via tool_use, ai-enrich executes them in a loop |

They do NOT talk to each other. Both use the **same shared tool library** to query the same database.

### Shared Tool Library Architecture

```
/functions/_shared/alfred-tools/
├── tool-definitions.ts    -- Tool schemas (used by MCP + Claude API tool_use)
├── tool-handlers.ts       -- Actual DB query logic (get_contexts, search_items, etc.)
└── supabase-client.ts     -- Shared Supabase client setup

/functions/v1/mcp/
└── index.ts               -- MCP transport layer, imports from alfred-tools

/functions/v1/ai-enrich/
└── index.ts               -- Agentic loop, imports from alfred-tools
```

The tool functions are written ONCE. The MCP server wraps them in MCP protocol. The ai-enrich function passes them as `tools` to the Claude API and executes them in a loop when Claude calls them back. This means any new tool you add automatically becomes available to both Claude.ai conversations AND the enrichment pipeline.

---

## Schema Changes

### New columns on `inbox` table:

```sql
-- AI suggestion metadata
ALTER TABLE inbox ADD COLUMN suggested_tags jsonb DEFAULT '[]'::jsonb;
ALTER TABLE inbox ADD COLUMN suggested_item_id text;             -- link to EXISTING item
ALTER TABLE inbox ADD COLUMN suggested_collection_id text;       -- link to EXISTING collection

-- Source tracking
ALTER TABLE inbox ADD COLUMN source_type text DEFAULT 'manual';  -- 'manual' | 'email' | 'mcp'
ALTER TABLE inbox ADD COLUMN source_metadata jsonb DEFAULT '{}'::jsonb;

-- AI enrichment status
ALTER TABLE inbox ADD COLUMN ai_status text DEFAULT 'not_started';  -- 'not_started' | 'in_progress' | 'enriched'
ALTER TABLE inbox ADD COLUMN ai_confidence decimal(3,2);
ALTER TABLE inbox ADD COLUMN ai_reasoning text;
```

### Existing columns (already in place):
- `suggest_item`, `suggested_item_text`, `suggested_item_description`, `suggested_item_elements`
- `suggest_intent`, `suggested_intent_text`, `suggested_intent_recurrence`
- `suggest_event`, `suggested_event_date`
- `suggested_context_id`
- `captured_text`, `user_id`, `created_at`, `archived`, `triaged_at`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude.ai                               │
│               (you + wife, separate OAuth sessions)          │
│                                                              │
│  "Suggest something for dinner I haven't made in a while"   │
│  "Tell Alfred to make that tonight"                         │
│  "What's on my grocery list?"                               │
└──────────────┬───────────────────────────────────────────────┘
               │ MCP (Streamable HTTP + OAuth 2.1)
               ▼
┌──────────────────────────────────────────────────────────────┐
│              Supabase Edge Functions                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           _shared/alfred-tools/                          ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐  ││
│  │  │ tool-         │ │ tool-         │ │ supabase-      │  ││
│  │  │ definitions.ts│ │ handlers.ts   │ │ client.ts      │  ││
│  │  │ (schemas)     │ │ (DB queries)  │ │ (connection)   │  ││
│  │  └──────┬────────┘ └──────┬────────┘ └───────┬────────┘  ││
│  │         │                 │                   │           ││
│  └─────────┼─────────────────┼───────────────────┼──────────┘│
│            │                 │                   │            │
│       ┌────┴─────┐     ┌────┴─────┐             │            │
│       │ IMPORTED  │     │ IMPORTED  │             │            │
│       │ BY BOTH   │     │ BY BOTH   │             │            │
│       ▼          ▼     ▼          ▼              ▼            │
│  /functions/v1/mcp     /functions/v1/ai-enrich                │
│  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │ MCP Server        │  │ Agentic Enrichment               │  │
│  │                   │  │                                  │  │
│  │ Wraps tools in    │  │ 1. Receives inbox_id + user_id   │  │
│  │ MCP protocol for  │  │ 2. Sets ai_status='in_progress'  │  │
│  │ Claude.ai to call │  │ 3. Calls Claude API with:        │  │
│  │                   │  │    - System prompt (role + rules) │  │
│  │ Also exposes:     │  │    - tools[] (same tool schemas)  │  │
│  │ • create_inbox_   │  │    - Inbox record as user message │  │
│  │   item (write)    │  │ 4. LOOP: Claude calls tools →     │  │
│  │                   │  │    ai-enrich executes handlers →   │  │
│  │                   │  │    returns results → Claude thinks │  │
│  │                   │  │    → calls more tools or finishes  │  │
│  │                   │  │ 5. Claude returns final JSON with  │  │
│  │                   │  │    all suggested_* fields          │  │
│  │                   │  │ 6. Updates inbox, ai_status=       │  │
│  │                   │  │    'enriched'                      │  │
│  └──────────────────┘  └──────────────────────────────────┘  │
│                                                              │
│  /functions/v1/email-capture                                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Postmark webhook → insert inbox → call ai-enrich       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Supabase Auth (OAuth 2.1) + PostgreSQL (with RLS)     │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────┐
│ Gmail Filter  │──→ Postmark ──→ /email-capture ──→ inbox ──→ /ai-enrich
└──────────────┘

┌──────────────────────┐
│ Alfred React App      │──→ Supabase client ──→ Same DB
│ (Vercel)              │
│                       │    Manual capture ──→ inbox ──→ /ai-enrich (button)
│ Inbox UI shows:       │
│ • ai_status badge     │    User edits text ──→ clicks "Re-enrich" ──→ /ai-enrich
│ • suggested_* fields  │
│ • "Save" to approve   │    User approves ──→ creates items/intents/events
│ • "Re-enrich" button  │
└──────────────────────┘
```

---

## MCP Tool Definitions

### Read Tools

| Tool | Description | Returns |
|------|-------------|---------|
| `get_contexts` | List all contexts for the authenticated user | Array of {id, name, description, keywords, tags, shared, pinned} |
| `get_items` | Get items, optionally filtered by context_id and/or tags. Only returns non-archived items. | Array of {id, name, description, context_id, elements, tags, is_capture_target} |
| `search_items` | Full-text search across item names and descriptions | Array of matching items with context info |
| `get_execution_history` | Get executions, optionally filtered by intent_id, context_id, or date range. Joins to intent and event for full context. | Array of {execution_id, intent_text, event_date, started_at, closed_at, status, item_ids} |
| `get_collections` | List item_collections, optionally filtered by context_id | Array of {id, name, context_id, items, shared} |
| `get_inbox` | List non-archived inbox items, optionally filtered by ai_status | Array of inbox records with all suggested_* fields |
| `get_tags` | Get all unique tags used across items and intents for the user | Array of tag strings with usage counts |

### Write Tools

| Tool | Description | Key fields |
|------|-------------|------------|
| `create_inbox_item` | Create a new inbox record with pre-filled suggestions. Claude.ai uses this when the user says "tell Alfred to..." | captured_text (required), source_type='mcp', all suggested_* fields, ai_status='enriched' |

---

## AI Enrichment: Agentic Loop Design

The ai-enrich function doesn't stuff everything into one prompt. Instead, it gives Claude **tools** (the same ones as MCP) and lets Claude decide what to query. This is implemented using the Claude API's native `tool_use` feature.

### How the loop works:

```
ai-enrich receives: inbox_id, user_id
         │
         ▼
┌─ INITIAL CALL TO CLAUDE API ──────────────────────────┐
│  system: "You are Alfred's AI assistant. Analyze the   │
│   inbox record and use the provided tools to search    │
│   the user's data. When ready, call submit_suggestions │
│   with your final recommendations."                    │
│                                                        │
│  tools: [                                              │
│    get_contexts,        // same handlers as MCP        │
│    get_items,           // filtered by context/tags    │
│    search_items,        // full-text search            │
│    get_execution_history,                              │
│    get_collections,                                    │
│    get_tags,                                           │
│    fetch_url,           // special: fetch URL content  │
│    submit_suggestions   // terminal tool (see below)   │
│  ]                                                     │
│                                                        │
│  user message: "Analyze this inbox record:             │
│    captured_text: 'https://example.com/tikka-masala'   │
│    source_type: 'manual'                               │
│    current date: 2026-02-19"                           │
└────────────────────┬───────────────────────────────────┘
                     │
                     ▼
         Claude thinks, calls tools...
                     │
    ┌────────────────┼────────────────────┐
    ▼                ▼                    ▼
 fetch_url(      get_contexts()     search_items(
  "https://       → returns all       "tikka masala")
  example.com/    contexts            → no match
  tikka-masala")                      (new recipe)
  → returns       
  recipe HTML     
    │                │                    │
    └────────────────┼────────────────────┘
                     ▼
         Claude thinks again...
         "This is a new recipe. The Recipes context
          exists. Let me check existing tags..."
                     │
                     ▼
              get_tags()
              → returns ["dinner", "recipe", "indian", ...]
                     │
                     ▼
         Claude calls terminal tool:
         submit_suggestions({
           suggested_context_id: "ctx_recipes",
           suggest_item: true,
           suggested_item_text: "Chicken Tikka Masala",
           suggested_item_description: "Classic Indian curry...",
           suggested_item_elements: [
             { type: "ingredient", text: "500g chicken..." },
             { type: "step", text: "Marinate chicken..." },
             ...
           ],
           suggest_intent: false,
           suggested_tags: ["recipe", "dinner", "indian"],
           ai_confidence: 0.95,
           ai_reasoning: "URL contains a recipe. Parsed into
             structured elements. No existing match found.
             Assigned to Recipes context."
         })
                     │
                     ▼
         ai-enrich writes suggestions to inbox record
         sets ai_status = 'enriched'
```

### The `submit_suggestions` terminal tool

This is a special tool that only exists in the ai-enrich context (not in MCP). When Claude calls it, the loop ends and ai-enrich writes the suggestions to the DB. Its schema matches the `suggested_*` columns on the inbox table:

```typescript
{
  name: "submit_suggestions",
  description: "Submit your final suggestions for this inbox record. Call this when you have enough information to make recommendations.",
  input_schema: {
    type: "object",
    properties: {
      suggested_context_id: { type: "string", description: "ID of an existing context" },
      suggest_item: { type: "boolean" },
      suggested_item_text: { type: "string" },
      suggested_item_description: { type: "string" },
      suggested_item_elements: { type: "array", description: "Structured elements (steps, ingredients, etc.)" },
      suggested_item_id: { type: "string", description: "ID of an EXISTING item to link to" },
      suggest_intent: { type: "boolean" },
      suggested_intent_text: { type: "string" },
      suggested_intent_recurrence: { type: "string", enum: ["once", "daily", "weekly", "monthly", "yearly"] },
      suggest_event: { type: "boolean" },
      suggested_event_date: { type: "string", description: "YYYY-MM-DD format" },
      suggested_tags: { type: "array", items: { type: "string" } },
      suggested_collection_id: { type: "string", description: "ID of an existing collection" },
      ai_confidence: { type: "number", minimum: 0, maximum: 1 },
      ai_reasoning: { type: "string" }
    }
  }
}
```

### System prompt for ai-enrich

The system prompt is lean — it describes Claude's role and the rules, but does NOT pre-load all user data. Claude fetches what it needs via tools:

```
You are Alfred's AI assistant analyzing an inbox capture for a GTD household
management system. Your job is to suggest how this capture should be organized.

USE THE PROVIDED TOOLS to search the user's existing data before making suggestions.
Do not guess — look up contexts, items, tags, and collections to make informed
recommendations.

RULES:
1. Always call get_contexts first to understand the user's organizational structure
2. Search for existing items before suggesting a new one (avoid duplicates)
3. If the captured text looks like a URL, call fetch_url to get the page content
4. Prefer existing contexts, tags, and items over creating new ones
5. For date references like "tomorrow" or "next Tuesday", resolve to YYYY-MM-DD
6. You can suggest BOTH an item and an intent (e.g., recipe item + "cook tonight" intent)
7. Set ai_confidence lower when you're uncertain
8. When done, call submit_suggestions with your final recommendations
9. Tags should be lowercase, underscore-separated
10. For recipes: parse into structured elements with type "ingredient" and "step"

IMPORTANT: The user will review and approve your suggestions before anything is
created. Suggest generously — it's easier for them to remove a suggestion than
to add a missing one.
```

### Loop safeguards

- **Max iterations**: Cap at 10 tool calls to prevent runaway loops
- **Timeout**: Edge Function timeout (~150s on paid plan) serves as a hard stop
- **Error handling**: If Claude API fails mid-loop, set ai_status back to 'not_started' so user can retry
- **Cost awareness**: Each loop iteration is an API call. Typical enrichment should be 3-5 tool calls. Log call counts for monitoring.

---

## Implementation Phases

### Phase 7.0: MCP Server Foundation (Read-Only)
**Goal**: Working MCP server that Claude.ai can connect to and query Alfred's data.

**Steps**:
1. Enable OAuth 2.1 Server in Supabase dashboard
2. Build authorization consent page on Vercel app (`/oauth/authorize`)
3. Install Supabase CLI, run `supabase init` and `supabase functions new mcp`
4. Scaffold MCP Edge Function with official MCP TypeScript SDK + `WebStandardStreamableHTTPServerTransport`
5. Implement all 7 read tools (get_contexts, get_items, search_items, get_execution_history, get_collections, get_inbox, get_tags)
6. Deploy: `supabase functions deploy mcp --no-verify-jwt` (authless first for testing)
7. Test with MCP Inspector locally
8. Switch to OAuth 2.1 token validation
9. Add as custom connector in Claude.ai (Settings → Connectors → Add custom connector)
10. Verify both users can connect and query their data

**Success criteria**: Ask Claude.ai *"what recipes do I have?"* and *"when did I last make chicken tikka masala?"* — get real answers from your DB.

---

### Phase 7.1: Inbox Schema Migration + MCP Write Tool
**Goal**: Claude.ai can create pre-enriched inbox records.

**Steps**:
1. Run schema migration (add new columns to `inbox`)
2. Update RLS policies on `inbox` to allow inserts from authenticated users
3. Add `create_inbox_item` write tool to MCP server
4. Deploy updated MCP function
5. Test: Tell Claude.ai *"tell Alfred to make chicken tikka masala tonight"* → verify inbox record appears in DB with correct suggestions

**Success criteria**: Inbox record created via MCP with `ai_status = 'enriched'` and all suggestion fields populated.

---

### Phase 7.2: AI Enrichment Edge Function (Agentic)
**Goal**: Non-MCP inbox records (manual capture, email) get Claude-powered suggestions via an agentic tool-use loop.

**Steps**:
1. Store Anthropic API key in Supabase Vault secrets
2. Create `/functions/v1/ai-enrich` Edge Function
3. Import shared tool library from `_shared/alfred-tools/`
4. Implement the agentic loop:
   - Accept inbox record ID + user_id
   - Set `ai_status = 'in_progress'`
   - Build initial Claude API call with system prompt + tool definitions + inbox record
   - Loop: when Claude returns `tool_use` blocks, execute the tool handlers, return results, call Claude again
   - When Claude calls `submit_suggestions`, write to DB and set `ai_status = 'enriched'`
5. Add `fetch_url` tool (only available in ai-enrich, not MCP) for recipe/URL parsing
6. Add `submit_suggestions` terminal tool (only in ai-enrich)
7. Safeguards: max 10 tool calls, timeout handling, error recovery (reset to `not_started`)
8. Deploy and test:
   - Simple text capture: "Call plumber about leak" → Claude calls get_contexts, get_tags, submits suggestions
   - Recipe URL: Claude calls fetch_url, get_contexts, search_items, get_tags, submits with parsed elements
   - Existing item reference: "Make chicken tikka tonight" → Claude calls search_items, finds match, submits with suggested_item_id

**Success criteria**: Create inbox record manually → call ai-enrich → Claude makes 3-5 tool calls → suggestions appear on inbox record. Recipe URL gets parsed into structured elements.

---

### Phase 7.3: Email Capture (Postmark)
**Goal**: Forward emails into Alfred's inbox with AI enrichment.

**Steps**:
1. Set up Postmark account, configure inbound email processing
2. Configure Gmail filter: `youremail+alfred@domain.com` → Postmark inbound address
3. Create `/functions/v1/email-capture` Edge Function:
   - Validate Postmark webhook signature
   - Extract: from, to, subject, text body, messageId, date
   - Map sender email → user_id
   - Insert inbox record with `source_type = 'email'`, `source_metadata`, `ai_status = 'not_started'`
   - Call ai-enrich function for the new record
4. Deploy and test end-to-end

**Success criteria**: Forward email → appears in Alfred inbox with AI suggestions within 30 seconds.

---

### Phase 7.4: Alfred UI Updates
**Goal**: Surface AI enrichment status and suggestions in the Inbox UI.

**Steps**:
1. Show `ai_status` badge on each inbox item:
   - 🔘 Not Started (grey)
   - ⏳ In Progress (yellow/animated)
   - ✅ Enriched (green)
2. Pre-fill triage form with `suggested_*` fields when user opens an inbox item
3. Show `ai_confidence` indicator and `ai_reasoning` as expandable tooltip
4. Add "Re-enrich" button that:
   - Resets `ai_status` to `'not_started'`
   - Calls `/functions/v1/ai-enrich`
   - User can edit `captured_text` first, then re-enrich
5. Source type indicators (✏️ manual, 📧 email, 🤖 MCP)
6. Handle `suggested_item_id` — when present, show link to the existing item
7. Handle `suggested_collection_id` — when present, show the collection name

**Success criteria**: The re-enrich workflow — capture "Call bill about AI project tomorrow" → Claude suggests ActBlue → edit to "Call Bill at Team Impact tomorrow about AI workflow tool" → click Re-enrich → Claude now correctly suggests Team Impact context and links to AI Workflow Tool item.

---

## Phase Summary & Dependencies

```
Phase 7.0: MCP Read-Only Server
  ├── Supabase OAuth 2.1 setup
  ├── First Edge Function ever (learning curve here)
  ├── 7 read tools
  └── Claude.ai connector setup
       │
Phase 7.1: MCP Write + Schema Migration ──── depends on 7.0
  ├── inbox schema migration (new columns)
  ├── create_inbox_item write tool
  └── Pre-enriched inbox records from Claude.ai
       │
       ├──────────────────────────────┐
       │                              │
Phase 7.2: AI Enrichment         Phase 7.4: Alfred UI Updates
  ├── Anthropic API key in Vault    ├── ai_status badges
  ├── ai-enrich Edge Function       ├── Pre-filled triage forms
  ├── URL fetching + parsing        ├── Re-enrich button
  └── Claude API integration        └── Source type indicators
       │                              
Phase 7.3: Email Capture ──────────── depends on 7.2
  ├── Postmark setup
  ├── email-capture Edge Function
  ├── Gmail filter
  └── Feeds into ai-enrich pipeline
```

7.2 and 7.4 can run in parallel after 7.1.

---

## What's NOT in Phase 7

- **Direct writes to items/intents/events from MCP** — always through inbox
- **Automatic enrichment trigger** — manual button for now, automatic trigger on roadmap
- **AI Tag Intelligence** (relationships, aliases, bulk cleanup) — Phase 8, after this is stable
- **Google Drive / Calendar integration** — Phase 9+
- **Auto-Sequencer** — Phase 10+
- **get_schema tool** — not needed; MCP tool descriptions communicate the interface

---

## Recommended Starting Point

**Phase 7.0, Step 1**: Enable OAuth 2.1 Server in Supabase dashboard, then share your codebase so we can scaffold the consent page and first Edge Function together.
