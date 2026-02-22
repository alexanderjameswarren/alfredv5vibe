# Phase 7.0 Implementation Steps: MCP Server Foundation

**Reference**: phase7-progress.md for status tracking
**Reference**: Alfred_Phase7_Implementation_Plan_v3.md for full architecture context

---

## Step 4: Install Supabase CLI & Initialize Edge Functions

### What to do (HUMAN — terminal commands):

```bash
# Install Supabase CLI if not already installed
brew install supabase/tap/supabase
# OR: npm install -g supabase

# Verify installation
supabase --version

# Navigate to your Alfred project root
cd /path/to/alfred-v5

# Initialize Supabase in the project (if not already done)
# This creates a supabase/ directory with config.toml
supabase init

# Link to your existing Supabase project
# Find your project ref in Supabase Dashboard → Project Settings → General
supabase link --project-ref <your-project-ref>

# Create the MCP Edge Function
supabase functions new mcp

# Install Docker if not already installed (required for local Supabase dev)
# https://docs.docker.com/get-docker/
```

### Verification:
- [ ] `supabase --version` returns a version number
- [ ] `supabase/` directory exists in your project root
- [ ] `supabase/functions/mcp/index.ts` exists (auto-generated placeholder)
- [ ] Docker is running

---

## Step 5: Create Shared Tool Library

### What to do (CLAUDE CLI):

Create the shared tool library that both the MCP server and ai-enrich will import.

**File structure to create:**
```
supabase/functions/_shared/alfred-tools/
├── supabase-client.ts    -- Shared Supabase client factory
├── tool-definitions.ts   -- Tool schemas (name, description, input schema)
├── tool-handlers.ts      -- Actual DB query functions
└── types.ts              -- Shared TypeScript types
```

**supabase-client.ts requirements:**
- Create a function that accepts an access token and returns a Supabase client
- Use `jsr:@supabase/supabase-js@2`
- Client should use the SUPABASE_URL and SUPABASE_ANON_KEY from Deno.env
- When an access token is provided, set it as the Authorization header so RLS applies for that user
- Export a `createServiceClient()` function that uses SUPABASE_SERVICE_ROLE_KEY (for ai-enrich internal use later)

**types.ts requirements:**
- Define TypeScript interfaces matching the database schema for: Context, Item, Intent, Event, Execution, InboxItem, ItemCollection
- Use the actual column names and types from the database (see schema reference below)

**tool-definitions.ts requirements:**
- Export an array of tool definitions, each with: name, description, inputSchema
- These will be used by both MCP (as registerTool schemas) and ai-enrich (as Claude API tool definitions)
- Tools to define:

1. `get_contexts` - List all contexts for the authenticated user
   - Input: none (optional `shared` boolean filter)
   - Returns: Array of contexts with id, name, description, keywords, tags, shared, pinned

2. `get_items` - Get items, optionally filtered by context_id and/or tags
   - Input: optional context_id (string), optional tags (string array), optional search_text (string)
   - Only returns non-archived items
   - Returns: Array of items with id, name, description, context_id, elements, tags, is_capture_target

3. `search_items` - Full-text search across item names and descriptions
   - Input: query (string, required)
   - Only returns non-archived items
   - Returns: Array of matching items with context name included

4. `get_execution_history` - Get executions with optional filters
   - Input: optional intent_id (string), optional context_id (string), optional date_from (string YYYY-MM-DD), optional date_to (string YYYY-MM-DD), optional limit (number, default 20)
   - Joins to intents and events for full context
   - Returns: Array of {execution_id, intent_text, event_date, started_at, closed_at, status, outcome, item_ids, context_id}

5. `get_collections` - List item_collections, optionally filtered by context_id
   - Input: optional context_id (string)
   - Returns: Array of {id, name, context_id, items, shared}

6. `get_inbox` - List non-archived, non-triaged inbox items
   - Input: optional ai_status filter (string: 'not_started' | 'in_progress' | 'enriched')
   - Returns: Array of inbox records with all fields including suggested_* columns

7. `get_tags` - Get all unique tags used across items and intents
   - Input: none
   - Returns: Array of {tag: string, count: number} sorted by count descending

**tool-handlers.ts requirements:**
- Export a handler function for each tool that accepts (supabaseClient, params) and returns the query result
- Use the Supabase client from supabase-client.ts
- For `search_items`: use Supabase's `.ilike()` or `.or()` with `name.ilike.%query%,description.ilike.%query%`
- For `get_tags`: query items and intents tables, extract tags from the jsonb arrays, aggregate and count
- For `get_execution_history`: join executions → intents (via intent_id), and events (via event_id) to get event.time (the date)
- All handlers should handle errors gracefully and return `{ error: string }` on failure
- All queries should be scoped to the authenticated user via RLS (the Supabase client handles this)

### Database Schema Reference (for Claude CLI):

**contexts**: id(text PK), name(text), description(text), keywords(text), shared(boolean), pinned(boolean), created_at(bigint), user_id(text), tags(jsonb default '[]')

**items**: id(text PK), name(text), description(text), context_id(text), elements(jsonb default '[]'), is_capture_target(boolean), created_at(bigint), archived(boolean), user_id(text), tags(jsonb default '[]')

**intents**: id(text PK), text(text), created_at(bigint), is_intention(boolean), is_item(boolean), archived(boolean), item_id(text), context_id(text), recurrence(text default 'once'), user_id(text), tags(jsonb default '[]'), collection_id(text)

**events**: id(text PK), intent_id(text), time(date), item_ids(jsonb default '[]'), context_id(text), archived(boolean), created_at(bigint), text(text), user_id(text), collection_id(text)

**executions**: id(text PK), event_id(text), intent_id(text), context_id(text), item_ids(jsonb default '[]'), started_at(bigint), closed_at(bigint), status(text), outcome(text), progress(jsonb default '[]'), notes(text), elements(jsonb default '[]'), user_id(text), collection_id(text), completed_item_ids(jsonb default '[]')

**inbox**: id(text PK), created_at(bigint), archived(boolean), triaged_at(bigint), captured_text(text), suggested_context_id(text), suggest_item(boolean), suggested_item_text(text), suggested_item_description(text), suggested_item_elements(jsonb), suggest_intent(boolean), suggested_intent_text(text), suggested_intent_recurrence(text), suggest_event(boolean), suggested_event_date(text), user_id(text)
NOTE: New columns will be added in Phase 7.1: suggested_tags, suggested_item_id, suggested_collection_id, source_type, source_metadata, ai_status, ai_confidence, ai_reasoning

**item_collections**: id(text PK), user_id(text), name(text), context_id(text), shared(boolean), is_capture_target(boolean), items(jsonb default '[]'), created_at(timestamptz)

### Verification:
- [ ] All 4 files exist in supabase/functions/_shared/alfred-tools/
- [ ] TypeScript compiles without errors
- [ ] Tool definitions array has 7 tools
- [ ] Each tool has a matching handler function

---

## Step 6: Build MCP Edge Function with Read-Only Tools

"Read docs/phase7-step6-exact-code.md. Create all 5 files exactly as specified. Do NOT search the web — everything you need is in the file. After creating the files, tell me what commands to run to test."
---

## Step 7: Test MCP Server Locally

### What to do (HUMAN — terminal commands):

```bash
# Terminal 1: Start Supabase local stack (requires Docker)
cd /path/to/alfred-v5
supabase start

# Terminal 2: Serve the MCP function locally
supabase functions serve --no-verify-jwt mcp

# Terminal 3: Test with MCP Inspector
npx -y @modelcontextprotocol/inspector
```

In the MCP Inspector UI:
1. Enter endpoint URL: `http://localhost:54321/functions/v1/mcp`
2. Select transport: `Streamable HTTP`
3. Click Connect
4. You should see all 7 tools listed
5. Test `get_contexts` — should return your contexts
6. Test `search_items` with a query like "chicken" — should return matching items
7. Test `get_tags` — should return tag list with counts

**Troubleshooting:**
- If "connection refused": make sure `supabase start` completed and Docker is running
- If tools return empty arrays: your local Supabase may not have your production data. You can test against production by setting env vars:
  ```bash
  supabase functions serve --no-verify-jwt --env-file .env.local mcp
  ```
  Where `.env.local` contains:
  ```
  SUPABASE_URL=https://<your-project-ref>.supabase.co
  SUPABASE_ANON_KEY=<your-anon-key>
  SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
  ```

### Verification:
- [ ] MCP Inspector connects successfully
- [ ] All 7 tools appear in the tool list
- [ ] At least one tool returns real data from your database
- [ ] No errors in the function serve terminal

---

## Step 8: Build OAuth Consent Page

### What to do (CLAUDE CLI):

Build a new route in the existing Alfred React app at `/oauth/consent`. This page handles the OAuth authorization flow when Claude.ai (or any MCP client) connects.

**Important context about Alfred's app structure:**
- Alfred is a React SPA deployed on Vercel
- It uses React Router for routing
- It uses Supabase JS client for auth (@supabase/supabase-js)
- Existing auth uses Google OAuth with an email allowlist
- Follow existing styling patterns (teal color palette #a2d8c8 family, Tailwind CSS)

**Route: `/oauth/consent`**

**Requirements:**
1. Extract `authorization_id` from URL query parameters
2. Check if user is authenticated using existing Supabase auth session
3. If not authenticated, redirect to login page (preserve authorization_id in state/URL)
4. If authenticated, call `supabase.auth.oauth.getAuthorizationDetails(authorization_id)`
5. Display consent screen showing:
   - The name of the requesting application (e.g., "Claude")
   - The redirect URI
   - Any requested scopes
   - "Approve" and "Deny" buttons
6. On Approve: call `supabase.auth.oauth.approveAuthorization(authorization_id)` → redirect to `data.redirect_to`
7. On Deny: call `supabase.auth.oauth.denyAuthorization(authorization_id)` → redirect to `data.redirect_to`

**Note on supabase-js version:**
The `supabase.auth.oauth.getAuthorizationDetails()`, `.approveAuthorization()`, and `.denyAuthorization()` methods are available in @supabase/supabase-js v2.49+ (the OAuth 2.1 server methods). Check the current version in package.json and upgrade if needed:
```bash
npm install @supabase/supabase-js@latest
```

**Styling:**
- Match existing Alfred UI patterns
- Simple centered card layout
- Show app icon/name prominently
- Clear Approve (teal/green) and Deny (grey/red) buttons
- Loading state while fetching authorization details
- Error state for invalid/expired authorization_id

**Error handling:**
- Missing authorization_id → show error message
- Invalid/expired authorization_id → show error with "return to app" link
- Network errors → show retry option
- User not in allowlist → they won't be able to authenticate, which is correct

### Verification:
- [ ] Route `/oauth/consent` exists in the React app
- [ ] Page shows loading state, then consent form or error
- [ ] Approve and Deny buttons are wired up to supabase.auth.oauth methods
- [ ] Page redirects correctly after approve/deny
- [ ] Styling matches existing Alfred UI patterns

---

## Step 9: Deploy MCP Function to Production

### What to do (HUMAN — terminal commands):

```bash
# Deploy the MCP Edge Function
# --no-verify-jwt is needed because MCP auth is handled at the application level
# (OAuth 2.1 tokens are validated by the Supabase client, not the Edge Function gateway)
supabase functions deploy --no-verify-jwt mcp
```

**Also deploy the Alfred app with the new consent page:**
```bash
# If using Vercel auto-deploy on git push:
git add .
git commit -m "Phase 7.0: Add OAuth consent page and MCP Edge Function"
git push
```

### Verification:
- [ ] Edge Function deployment succeeds
- [ ] Function is visible in Supabase Dashboard → Edge Functions
- [ ] `https://<project-ref>.supabase.co/functions/v1/mcp` responds (may return error without auth, that's OK)
- [ ] `https://alfredv5vibe.vercel.app/oauth/consent` loads (shows error about missing authorization_id, that's expected)

---

## Step 10: Connect Claude.ai as Custom Connector

### What to do (HUMAN — in Claude.ai):

1. Go to [claude.ai](https://claude.ai)
2. Navigate to **Settings → Connectors**
3. Scroll to bottom, click **"Add custom connector"**
4. Enter the MCP server URL: `https://<your-project-ref>.supabase.co/functions/v1/mcp`
5. Click **"Add"**
6. Claude.ai will initiate the OAuth flow:
   - It will discover your Supabase OAuth endpoints automatically
   - It will redirect you to `https://alfredv5vibe.vercel.app/oauth/consent`
   - You should see the consent page with "Claude" as the requesting app
   - Click **"Approve"**
7. You should be redirected back to Claude.ai with the connector now showing as connected

**Repeat for your wife's account** — she needs to add the same connector URL and go through the OAuth flow with her Google account.

**Troubleshooting:**
- If OAuth discovery fails: verify `https://<project-ref>.supabase.co/.well-known/oauth-authorization-server/auth/v1` returns valid JSON (try in browser)
- If consent page shows error: check browser console, verify supabase-js version supports OAuth methods
- If redirect back to Claude.ai fails: verify the callback URL `https://claude.ai/api/mcp/auth_callback` is in your Supabase redirect URLs

### Verification:
- [ ] Connector appears in Claude.ai Settings → Connectors as "Connected"
- [ ] No errors during the OAuth flow

---

## Step 11: Verify Both Users Can Query Alfred Data

### What to do (HUMAN — in Claude.ai):

Start a new conversation in Claude.ai. You should see the Alfred MCP tools available in the "Search and tools" menu.

**Test these prompts:**

1. "What contexts do I have in Alfred?"
   - Expected: Claude calls `get_contexts`, returns your context list

2. "Search my items for 'chicken'"
   - Expected: Claude calls `search_items`, returns matching items

3. "What tags are being used in Alfred?"
   - Expected: Claude calls `get_tags`, returns tag list with counts

4. "Show me my inbox"
   - Expected: Claude calls `get_inbox`, returns pending inbox items

5. "When was the last time I made [recipe name]?"
   - Expected: Claude calls `search_items` to find the item, then `get_execution_history` to find when it was executed

**Test with your wife's account too** — she should see the same tools but data scoped to her user (plus shared contexts).

### Verification:
- [ ] Claude.ai shows Alfred MCP tools in the tools menu
- [ ] At least 3 of the 5 test prompts return correct data
- [ ] Your wife can connect and see appropriate data (her own + shared)
- [ ] RLS is working: you don't see each other's private data

---

## Completion

When all steps are verified:
1. Update phase7-progress.md — mark all steps as ✅ Complete
2. Update the overall status to ✅ Complete
3. Proceed to Phase 7.1: Inbox Schema Migration + MCP Write Tool
