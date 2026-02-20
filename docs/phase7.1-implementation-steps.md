# Phase 7.1 Implementation Steps: Inbox Schema Migration + MCP Write Tool

**Reference**: phase7.1-progress.md for status tracking
**Reference**: Alfred_Phase7_Implementation_Plan_v3.md for full architecture context

---

## Step 1: Run Inbox Schema Migration

### What to do (HUMAN — run in Supabase SQL Editor):

Copy and paste this entire SQL block into the Supabase SQL Editor and run it:

```sql
-- Phase 7.1: Add AI suggestion and source tracking columns to inbox table

-- AI suggestion: tags
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS suggested_tags jsonb DEFAULT '[]'::jsonb;

-- AI suggestion: link to an EXISTING item (e.g., "make that recipe tonight")
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS suggested_item_id text;

-- AI suggestion: link to an EXISTING collection (e.g., "add to grocery list")
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS suggested_collection_id text;

-- Source tracking: how this inbox record was created
-- Values: 'manual' (default), 'email', 'mcp'
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'manual';

-- Source tracking: metadata about the source (email headers, MCP context, etc.)
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS source_metadata jsonb DEFAULT '{}'::jsonb;

-- AI enrichment status
-- Values: 'not_started' (default), 'in_progress', 'enriched'
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS ai_status text DEFAULT 'not_started';

-- AI enrichment: confidence score 0.00 to 1.00
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS ai_confidence decimal(3,2);

-- AI enrichment: explanation of why Claude made these suggestions
ALTER TABLE public.inbox
ADD COLUMN IF NOT EXISTS ai_reasoning text;
```

### Verification:
- [ ] SQL runs without errors
- [ ] In Supabase Table Editor, the `inbox` table now shows the new columns
- [ ] Existing inbox records still have their data intact (new columns show defaults)

---

## Step 2: Verify RLS Policies on Inbox

### What to do (HUMAN — run in Supabase SQL Editor):

First, check what RLS policies already exist on inbox:

```sql
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'inbox';
```

You need policies that allow:
- **SELECT**: Users can read their own inbox items (user_id matches auth.uid() or shared contexts)
- **INSERT**: Users can insert inbox items where user_id matches auth.uid()
- **UPDATE**: Users can update their own inbox items
- **DELETE**: Users can delete their own inbox items

If INSERT policy is missing or doesn't cover MCP writes, run this:

```sql
-- Allow authenticated users to insert inbox items for themselves
-- (This is needed for MCP create_inbox_item tool)
CREATE POLICY IF NOT EXISTS "Users can insert own inbox items"
ON public.inbox
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid()::text);
```

**NOTE**: If you already have a working INSERT policy (e.g., from the Alfred UI capture flow), you may not need to add one. The key is that the policy allows inserts where `user_id` matches the authenticated user. Check the output of the first query.

### Verification:
- [ ] SELECT query shows policies for inbox
- [ ] There is an INSERT policy that checks user_id = auth.uid()
- [ ] Test: existing capture flow in Alfred UI still works (not broken by migration)

---

## Step 3: Add createInboxItem Handler to Shared Tool Library

### What to do (CLAUDE CLI):

**DO NOT search the web. All the information you need is in this file.**

Add the `createInboxItem` function to `supabase/functions/_shared/alfred-tools/tool-handlers.ts`.

Add this function after the existing `getTags` function:

```typescript
export async function createInboxItem(
  client: SupabaseClient,
  params: {
    captured_text: string;
    source_type?: string;
    source_metadata?: Record<string, unknown>;
    suggested_context_id?: string;
    suggest_item?: boolean;
    suggested_item_text?: string;
    suggested_item_description?: string;
    suggested_item_elements?: unknown[];
    suggested_item_id?: string;
    suggest_intent?: boolean;
    suggested_intent_text?: string;
    suggested_intent_recurrence?: string;
    suggest_event?: boolean;
    suggested_event_date?: string;
    suggested_tags?: string[];
    suggested_collection_id?: string;
    ai_status?: string;
    ai_confidence?: number;
    ai_reasoning?: string;
  }
): Promise<ToolResult> {
  try {
    // Get the authenticated user's ID
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user) {
      return { error: "Could not identify authenticated user" };
    }

    const record = {
      id: crypto.randomUUID(),
      created_at: Date.now(),
      archived: false,
      triaged_at: null,
      captured_text: params.captured_text,
      user_id: user.id,
      // Source tracking
      source_type: params.source_type || "mcp",
      source_metadata: params.source_metadata || {},
      // AI suggestions
      suggested_context_id: params.suggested_context_id || null,
      suggest_item: params.suggest_item || false,
      suggested_item_text: params.suggested_item_text || null,
      suggested_item_description: params.suggested_item_description || null,
      suggested_item_elements: params.suggested_item_elements || null,
      suggested_item_id: params.suggested_item_id || null,
      suggest_intent: params.suggest_intent || false,
      suggested_intent_text: params.suggested_intent_text || null,
      suggested_intent_recurrence: params.suggested_intent_recurrence || null,
      suggest_event: params.suggest_event || false,
      suggested_event_date: params.suggested_event_date || null,
      suggested_tags: params.suggested_tags || [],
      suggested_collection_id: params.suggested_collection_id || null,
      // AI enrichment status
      ai_status: params.ai_status || "enriched",
      ai_confidence: params.ai_confidence ?? null,
      ai_reasoning: params.ai_reasoning || null,
    };

    const { data, error } = await client
      .from("inbox")
      .insert(record)
      .select()
      .single();

    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}
```

Also add the import for `createInboxItem` in the exports if tool-handlers.ts uses explicit exports. Make sure it's accessible from the MCP index.ts.

### Verification:
- [ ] `createInboxItem` function exists in tool-handlers.ts
- [ ] Function generates a UUID for id, uses Date.now() for created_at
- [ ] Function gets user.id from the authenticated client
- [ ] Function defaults source_type to 'mcp' and ai_status to 'enriched'
- [ ] TypeScript compiles without errors

---

## Step 4: Register create_inbox_item Tool in MCP Server

### What to do (CLAUDE CLI):

**DO NOT search the web. All the information you need is in this file.**

In `supabase/functions/mcp/index.ts`, make two changes:

**Change 1**: Add `createInboxItem` to the imports from tool-handlers:

```typescript
import {
  getContexts,
  getItems,
  searchItems,
  getExecutionHistory,
  getCollections,
  getInbox,
  getTags,
  createInboxItem,  // ADD THIS
} from "../_shared/alfred-tools/tool-handlers.ts";
```

**Change 2**: Add the tool registration inside the `createMcpServer` function, after the `get_tags` registration and before `return server;`:

```typescript
  server.registerTool(
    "create_inbox_item",
    {
      title: "Create Inbox Item",
      description:
        "Create a new item in Alfred's inbox with pre-filled AI suggestions. Use this when the user wants to capture something to Alfred — a task, recipe, reminder, grocery item, etc. The inbox item will appear in Alfred's UI for the user to review and approve. You should use the read tools (get_contexts, search_items, get_tags, get_collections) FIRST to look up the correct context_id, item_id, collection_id, and tags before creating the inbox item.",
      inputSchema: {
        captured_text: z.string().describe("The raw text being captured — what the user said or wants to remember"),
        suggested_context_id: z.string().optional().describe("ID of an existing context to suggest (use get_contexts to find the right one)"),
        suggest_item: z.boolean().optional().describe("Should this become a reusable Item? (true for recipes, checklists, reference material)"),
        suggested_item_text: z.string().optional().describe("Suggested name for the new item"),
        suggested_item_description: z.string().optional().describe("Suggested description for the new item"),
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array (steps, ingredients, checklist items)"),
        suggested_item_id: z.string().optional().describe("ID of an EXISTING item to link to (use search_items to find it). Use this when referencing a known item like 'make chicken tikka tonight'"),
        suggest_intent: z.boolean().optional().describe("Should this become an Intention/task? (true for action items, to-dos)"),
        suggested_intent_text: z.string().optional().describe("Suggested text for the intention (what the user intends to do)"),
        suggested_intent_recurrence: z.string().optional().describe("Recurrence pattern: 'once', 'daily', 'weekly', 'monthly', 'yearly'"),
        suggest_event: z.boolean().optional().describe("Is there a specific date associated? (true if user mentions a date/time)"),
        suggested_event_date: z.string().optional().describe("Suggested date in YYYY-MM-DD format. Resolve relative dates like 'tomorrow', 'next Tuesday' to absolute dates."),
        suggested_tags: z.array(z.string()).optional().describe("Suggested tags — use get_tags first to match existing taxonomy. Lowercase, underscore-separated."),
        suggested_collection_id: z.string().optional().describe("ID of an existing collection to add to (use get_collections to find it). E.g., grocery list."),
        ai_confidence: z.number().optional().describe("Your confidence in these suggestions, 0.0 to 1.0"),
        ai_reasoning: z.string().optional().describe("Brief explanation of why you made these suggestions"),
      },
    },
    async (params) => {
      const client = createUserClient(token);
      const result = await createInboxItem(client, {
        ...params,
        source_type: "mcp",
        ai_status: "enriched",
      });

      if (result.error) {
        return {
          content: [{ type: "text" as const, text: `Error creating inbox item: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Inbox item created successfully. The user can review and approve it in Alfred.\n\n${JSON.stringify(result.data, null, 2)}` }],
      };
    }
  );
```

### Verification:
- [ ] `createInboxItem` is imported in index.ts
- [ ] `create_inbox_item` tool is registered in createMcpServer function
- [ ] Tool description tells Claude to use read tools first to look up IDs
- [ ] Tool handler passes source_type='mcp' and ai_status='enriched'
- [ ] TypeScript compiles without errors

---

## Step 5: Deploy Updated MCP Function

### What to do (HUMAN — terminal commands):

```bash
# Deploy the updated MCP function
supabase functions deploy --no-verify-jwt mcp
```

### Verification:
- [ ] Deployment succeeds without errors
- [ ] Function is updated in Supabase Dashboard → Edge Functions

---

## Step 6: Test Write Tool from Claude.ai

### What to do (HUMAN — in Claude.ai):

Open a new conversation in Claude.ai with the Alfred connector enabled.

**Test 1 — Simple capture:**
> "Tell Alfred I need to call the plumber tomorrow"

Expected behavior: Claude should call `get_contexts` to find the right context (probably Home), call `get_tags` to check existing tags, then call `create_inbox_item` with:
- captured_text: "Call the plumber tomorrow"
- suggest_intent: true
- suggested_intent_text: "Call the plumber"
- suggest_event: true
- suggested_event_date: "2026-02-21" (tomorrow's date)
- suggested_context_id: (your Home context ID)

**Test 2 — Existing item reference:**
> "Tell Alfred to make [name of a recipe you have] tonight"

Expected behavior: Claude calls `search_items` to find the recipe, `get_contexts` for the recipe context, then `create_inbox_item` with:
- suggested_item_id pointing to the existing recipe
- suggest_intent: true
- suggest_event: true with today's date

**Test 3 — Collection reference:**
> "Tell Alfred to add milk and eggs to my grocery list"

Expected behavior: Claude calls `get_collections` to find the grocery list, then creates inbox item(s) with `suggested_collection_id`.

**After each test**, check the `inbox` table in Supabase Table Editor:
- New record(s) should appear with `source_type = 'mcp'`
- `ai_status` should be `'enriched'`
- `suggested_*` fields should be populated
- `user_id` should match your auth user ID

### Verification:
- [ ] Test 1: Inbox record appears with intent + event suggestions
- [ ] Test 2: Inbox record appears with suggested_item_id linking to existing recipe
- [ ] Test 3: Inbox record appears with suggested_collection_id
- [ ] All records have source_type='mcp' and ai_status='enriched'
- [ ] user_id is correctly set on all records

---

## Completion

When all steps are verified:
1. Update phase7.1-progress.md — mark all steps as ✅ Complete
2. Update the overall status to ✅ Complete
3. Proceed to Phase 7.2: AI Enrichment Edge Function (Agentic)
