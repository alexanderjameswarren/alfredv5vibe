# Phase 7.2 Implementation Steps: AI Enrichment Edge Function (Agentic)

**Reference**: phase7.2-progress.md for status tracking
**Reference**: Alfred_Phase7_Implementation_Plan_v3.md for full architecture context

---

## Step 1: Store Anthropic API Key in Supabase Vault

### What to do (HUMAN — Supabase Dashboard):

1. Go to your Supabase Dashboard
2. Navigate to **Project Settings → Edge Functions**
3. Under **Edge Function Secrets**, add a new secret:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key (starts with `sk-ant-`)
4. Save

Alternative method via CLI:
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
```

### Verification:
- [ ] Secret is saved (shows in dashboard or `supabase secrets list` shows it)
- [ ] You can access it via `Deno.env.get("ANTHROPIC_API_KEY")` in Edge Functions

---

## Step 2: Create ai-enrich Edge Function Scaffold

### What to do (CLAUDE CLI):

**DO NOT search the web. All the information you need is in this file.**

First, create the Edge Function:

**HUMAN runs**: `supabase functions new ai-enrich`

Then create the dependency file:

**File: `supabase/functions/ai-enrich/deno.json`**

```json
{
  "imports": {
    "@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@latest"
  }
}
```

**File: `supabase/functions/ai-enrich/index.ts`** (initial scaffold — will be filled in Steps 3-6):

```typescript
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import Anthropic from "@anthropic-ai/sdk";
import { createUserClient, createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  getContexts,
  getItems,
  searchItems,
  getExecutionHistory,
  getCollections,
  getInbox,
  getTags,
} from "../_shared/alfred-tools/tool-handlers.ts";

// Will be implemented in subsequent steps
console.log("ai-enrich scaffold loaded");

Deno.serve(async (req) => {
  return new Response("ai-enrich not yet implemented", { status: 501 });
});
```

### Verification:
- [ ] `supabase/functions/ai-enrich/index.ts` exists
- [ ] `supabase/functions/ai-enrich/deno.json` exists with Anthropic SDK dependency
- [ ] Imports resolve without errors

---

## Step 3: Build Agentic Loop with Claude API tool_use

### What to do (CLAUDE CLI):

**DO NOT search the web. All the information you need is in this file.**

Replace the contents of `supabase/functions/ai-enrich/index.ts` with the full implementation below. This is the core agentic loop.

```typescript
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import Anthropic from "@anthropic-ai/sdk";
import { createUserClient, createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  getContexts,
  getItems,
  searchItems,
  getExecutionHistory,
  getCollections,
  getTags,
} from "../_shared/alfred-tools/tool-handlers.ts";
import type { ToolResult } from "../_shared/alfred-tools/types.ts";

// --- Constants ---
const MAX_TOOL_CALLS = 10;
const SONNET_MODEL = "claude-sonnet-4-20250514";
const OPUS_MODEL = "claude-opus-4-0-20250115";

// --- Tool Definitions for Claude API ---
// These match the shared tool handlers but are formatted for Claude API tool_use
const SHARED_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_contexts",
    description:
      "List all GTD contexts (areas of focus) for the user. Contexts organize items, intents, and events. Examples: 'Home', 'Work - ActBlue', 'Recipes', 'Health'.",
    input_schema: {
      type: "object" as const,
      properties: {
        shared: { type: "boolean", description: "Filter by shared status" },
      },
    },
  },
  {
    name: "get_items",
    description:
      "Get items (reusable reference material like recipes, checklists, project notes). Can filter by context and tags. Only returns non-archived items.",
    input_schema: {
      type: "object" as const,
      properties: {
        context_id: { type: "string", description: "Filter by context ID" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by tags (items matching ANY of these tags)",
        },
        search_text: { type: "string", description: "Search item names and descriptions" },
      },
    },
  },
  {
    name: "search_items",
    description:
      "Full-text search across all item names and descriptions. Returns matching items with their context names.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_execution_history",
    description:
      "Get execution history showing when intents were acted on. Use to find when a recipe was last cooked, when a workout was done, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        intent_id: { type: "string", description: "Filter by specific intent ID" },
        context_id: { type: "string", description: "Filter by context ID" },
        date_from: { type: "string", description: "Start date filter (YYYY-MM-DD)" },
        date_to: { type: "string", description: "End date filter (YYYY-MM-DD)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "get_collections",
    description:
      "List item collections (like grocery lists, packing lists). Can filter by context.",
    input_schema: {
      type: "object" as const,
      properties: {
        context_id: { type: "string", description: "Filter by context ID" },
      },
    },
  },
  {
    name: "get_tags",
    description:
      "Get all unique tags used across items and intents, with usage counts.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch the content of a URL and return it as plain text (HTML stripped). Use this when the captured text is or contains a URL, especially for recipe pages.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "submit_suggestions",
    description:
      "Submit your final suggestions for this inbox record. Call this when you have enough information to make recommendations. This ends the enrichment process.",
    input_schema: {
      type: "object" as const,
      properties: {
        suggested_context_id: { type: "string", description: "ID of an existing context" },
        suggest_item: { type: "boolean", description: "Should this become a reusable Item?" },
        suggested_item_text: { type: "string", description: "Name for the item" },
        suggested_item_description: { type: "string", description: "Description for the item" },
        suggested_item_elements: {
          type: "array",
          description: "Structured elements (steps, ingredients, checklist items). Each element: {type: 'ingredient'|'step'|'header'|'bullet', text: '...'}",
        },
        suggested_item_id: { type: "string", description: "ID of an EXISTING item to link to" },
        suggest_intent: { type: "boolean", description: "Should this become an Intention/task?" },
        suggested_intent_text: { type: "string", description: "Text for the intention" },
        suggested_intent_recurrence: {
          type: "string",
          enum: ["once", "daily", "weekly", "monthly", "yearly"],
          description: "Recurrence pattern",
        },
        suggest_event: { type: "boolean", description: "Is there a specific date?" },
        suggested_event_date: { type: "string", description: "Date in YYYY-MM-DD format" },
        suggested_tags: {
          type: "array",
          items: { type: "string" },
          description: "Suggested tags (lowercase, underscore-separated)",
        },
        suggested_collection_id: { type: "string", description: "ID of an existing collection" },
        ai_confidence: { type: "number", description: "Confidence score 0.0-1.0" },
        ai_reasoning: { type: "string", description: "Brief explanation of suggestions" },
      },
      required: ["ai_confidence", "ai_reasoning"],
    },
  },
];

// --- Tool Execution ---

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  userClient: ReturnType<typeof createUserClient>
): Promise<string> {
  let result: ToolResult;

  switch (toolName) {
    case "get_contexts":
      result = await getContexts(userClient, toolInput as { shared?: boolean });
      break;
    case "get_items":
      result = await getItems(userClient, toolInput as { context_id?: string; tags?: string[]; search_text?: string });
      break;
    case "search_items":
      result = await searchItems(userClient, toolInput as { query: string });
      break;
    case "get_execution_history":
      result = await getExecutionHistory(userClient, toolInput as {
        intent_id?: string; context_id?: string; date_from?: string; date_to?: string; limit?: number;
      });
      break;
    case "get_collections":
      result = await getCollections(userClient, toolInput as { context_id?: string });
      break;
    case "get_tags":
      result = await getTags(userClient, {});
      break;
    case "fetch_url":
      result = await fetchUrl(toolInput as { url: string });
      break;
    default:
      result = { error: `Unknown tool: ${toolName}` };
  }

  return JSON.stringify(result.data || { error: result.error }, null, 2);
}

// --- fetch_url implementation ---

async function fetchUrl(params: { url: string }): Promise<ToolResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const response = await fetch(params.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Alfred/1.0 (Recipe Parser)",
        "Accept": "text/html,text/plain",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const html = await response.text();
    const plainText = stripHtml(html);

    // Truncate to ~8000 chars to avoid blowing up the prompt
    const truncated = plainText.length > 8000
      ? plainText.substring(0, 8000) + "\n\n[Content truncated...]"
      : plainText;

    return { data: truncated };
  } catch (e) {
    return { error: `Failed to fetch URL: ${String(e)}` };
  }
}

function stripHtml(html: string): string {
  // Remove script and style tags and their content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&#x2F;/g, "/");
  text = text.replace(/&#\d+;/g, ""); // remaining numeric entities
  // Collapse whitespace
  text = text.replace(/\s+/g, " ");
  // Collapse multiple newlines
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// --- System Prompts ---

const SYSTEM_PROMPT_BASE = `You are Alfred's AI assistant analyzing an inbox capture for a GTD household management system. Your job is to suggest how this capture should be organized.

USE THE PROVIDED TOOLS to search the user's existing data before making suggestions. Do not guess — look up contexts, items, tags, and collections to make informed recommendations.

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
11. For items with multiple steps/components, use elements with type "step", "header", "bullet", or "ingredient"

IMPORTANT: The user will review and approve your suggestions before anything is created. Suggest generously — it's easier for them to remove a suggestion than to add a missing one.`;

const SYSTEM_PROMPT_RE_ENRICH_SUFFIX = `

CONTEXT: This is a RE-ENRICHMENT. The user reviewed the previous AI suggestions and was not satisfied. They may have edited the captured text to provide more clarity. Below are the previous suggestions that were made. Pay close attention to what the user may have changed in the captured text and why the original suggestions may have been wrong. Provide improved suggestions.

PREVIOUS SUGGESTIONS:
`;

// --- Build user message ---

function buildUserMessage(
  inboxRecord: Record<string, unknown>,
  currentDate: string
): string {
  return `Analyze this inbox record and suggest how to organize it:

Captured text: "${inboxRecord.captured_text}"
Source type: ${inboxRecord.source_type || "manual"}
Current date: ${currentDate}

Call the tools to search the user's data, then call submit_suggestions with your recommendations.`;
}

function buildPreviousSuggestions(inboxRecord: Record<string, unknown>): string {
  const suggestions: Record<string, unknown> = {};
  const fields = [
    "suggested_context_id", "suggest_item", "suggested_item_text",
    "suggested_item_description", "suggested_item_elements", "suggested_item_id",
    "suggest_intent", "suggested_intent_text", "suggested_intent_recurrence",
    "suggest_event", "suggested_event_date", "suggested_tags",
    "suggested_collection_id", "ai_confidence", "ai_reasoning",
  ];
  for (const field of fields) {
    if (inboxRecord[field] !== null && inboxRecord[field] !== undefined) {
      suggestions[field] = inboxRecord[field];
    }
  }
  return JSON.stringify(suggestions, null, 2);
}

// --- Main Handler ---

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Parse request body
  let inboxId: string;
  try {
    const body = await req.json();
    inboxId = body.inbox_id;
    if (!inboxId) throw new Error("missing inbox_id");
  } catch (e) {
    return new Response(JSON.stringify({ error: "Request body must include inbox_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Extract user's auth token from request
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const userToken = authHeader.slice(7);

  // Create clients
  const userClient = createUserClient(userToken);  // For tool queries (RLS enforced)
  const serviceClient = createServiceClient();       // For updating inbox record

  // Verify user and get user ID
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: "Invalid auth token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fetch the inbox record (using service client to ensure we can read it)
  const { data: inboxRecord, error: fetchError } = await serviceClient
    .from("inbox")
    .select("*")
    .eq("id", inboxId)
    .eq("user_id", user.id)
    .single();

  if (fetchError || !inboxRecord) {
    return new Response(JSON.stringify({ error: "Inbox record not found or access denied" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Determine model based on current ai_status
  const isReEnrich = inboxRecord.ai_status === "enriched" || inboxRecord.ai_status === "re_enriched";
  const model = isReEnrich ? OPUS_MODEL : SONNET_MODEL;
  const targetStatus = isReEnrich ? "re_enriched" : "enriched";

  // Set ai_status to in_progress
  await serviceClient
    .from("inbox")
    .update({ ai_status: "in_progress" })
    .eq("id", inboxId);

  try {
    // Build the system prompt
    let systemPrompt = SYSTEM_PROMPT_BASE;
    if (isReEnrich) {
      systemPrompt += SYSTEM_PROMPT_RE_ENRICH_SUFFIX + buildPreviousSuggestions(inboxRecord);
    }

    // Build the current date string
    const today = new Date().toISOString().split("T")[0];

    // Initialize the Anthropic client
    const anthropic = new Anthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    // Initial message to Claude
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: buildUserMessage(inboxRecord, today) },
    ];

    // Agentic loop
    let toolCallCount = 0;
    let suggestions: Record<string, unknown> | null = null;

    while (toolCallCount < MAX_TOOL_CALLS) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: SHARED_TOOLS,
        messages,
      });

      // Check if Claude wants to use tools
      if (response.stop_reason === "tool_use") {
        // Process each tool use block
        const assistantContent = response.content;
        messages.push({ role: "assistant", content: assistantContent });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of assistantContent) {
          if (block.type === "tool_use") {
            toolCallCount++;

            // Check for terminal tool
            if (block.name === "submit_suggestions") {
              suggestions = block.input as Record<string, unknown>;
              // Still need to add a tool_result to satisfy the API
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: "Suggestions received. Enrichment complete.",
              });
              break;
            }

            // Execute the tool
            console.log(`[ai-enrich] Tool call ${toolCallCount}: ${block.name}`);
            const toolOutput = await executeTool(
              block.name,
              block.input as Record<string, unknown>,
              userClient
            );

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: toolOutput,
            });
          }
        }

        messages.push({ role: "user", content: toolResults });

        // If we got suggestions from submit_suggestions, break out
        if (suggestions) break;
      } else {
        // Claude finished without calling submit_suggestions
        // Try to extract any useful text response
        console.log("[ai-enrich] Claude finished without calling submit_suggestions");
        break;
      }
    }

    if (toolCallCount >= MAX_TOOL_CALLS && !suggestions) {
      console.log("[ai-enrich] Hit max tool calls without getting suggestions");
    }

    // Write suggestions to inbox record
    if (suggestions) {
      const updateData: Record<string, unknown> = {
        ai_status: targetStatus,
        ai_confidence: suggestions.ai_confidence ?? null,
        ai_reasoning: suggestions.ai_reasoning ?? null,
        suggested_context_id: suggestions.suggested_context_id ?? null,
        suggest_item: suggestions.suggest_item ?? false,
        suggested_item_text: suggestions.suggested_item_text ?? null,
        suggested_item_description: suggestions.suggested_item_description ?? null,
        suggested_item_elements: suggestions.suggested_item_elements ?? null,
        suggested_item_id: suggestions.suggested_item_id ?? null,
        suggest_intent: suggestions.suggest_intent ?? false,
        suggested_intent_text: suggestions.suggested_intent_text ?? null,
        suggested_intent_recurrence: suggestions.suggested_intent_recurrence ?? null,
        suggest_event: suggestions.suggest_event ?? false,
        suggested_event_date: suggestions.suggested_event_date ?? null,
        suggested_tags: suggestions.suggested_tags ?? [],
        suggested_collection_id: suggestions.suggested_collection_id ?? null,
      };

      await serviceClient
        .from("inbox")
        .update(updateData)
        .eq("id", inboxId);

      console.log(`[ai-enrich] Enrichment complete. Model: ${model}, Tool calls: ${toolCallCount}, Status: ${targetStatus}`);

      return new Response(JSON.stringify({
        success: true,
        model,
        tool_calls: toolCallCount,
        status: targetStatus,
        suggestions: updateData,
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      // No suggestions — reset to previous status so user can retry
      await serviceClient
        .from("inbox")
        .update({ ai_status: "not_started" })
        .eq("id", inboxId);

      return new Response(JSON.stringify({
        success: false,
        error: "AI did not produce suggestions",
        model,
        tool_calls: toolCallCount,
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  } catch (e) {
    console.error("[ai-enrich] Error:", e);

    // Reset ai_status on error so user can retry
    await serviceClient
      .from("inbox")
      .update({ ai_status: "not_started" })
      .eq("id", inboxId);

    return new Response(JSON.stringify({
      success: false,
      error: String(e),
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
});
```

### Key design notes for Claude CLI:
- The entire implementation is in this one file — Steps 3, 4, 5, and 6 are all here
- `userClient` (with JWT token) is used for all tool queries → RLS enforced
- `serviceClient` is used ONLY for reading/updating the inbox record itself
- `submit_suggestions` is a "terminal tool" — when Claude calls it, the loop breaks
- Model selection: `ai_status` of `not_started` → Sonnet, `enriched` or `re_enriched` → Opus
- Re-enrich includes previous suggestions in the system prompt
- fetch_url strips HTML, truncates to 8000 chars
- CORS headers included for Alfred UI button calls
- Errors reset `ai_status` to `not_started` for retry

### Verification:
- [ ] `supabase/functions/ai-enrich/index.ts` contains the full implementation
- [ ] `supabase/functions/ai-enrich/deno.json` has Anthropic SDK dependency
- [ ] Imports resolve without errors
- [ ] TypeScript compiles without errors

---

## Step 4-5-6: Included in Step 3

Steps 4 (fetch_url), 5 (submit_suggestions), and 6 (system prompts) are all included in the Step 3 code above. This avoids Claude CLI needing to do incremental edits — the entire function is one complete file.

Update progress: mark Steps 4, 5, and 6 as ✅ Complete when Step 3 is done.

---

## Step 7: Deploy ai-enrich Function

### What to do (HUMAN — terminal commands):

```bash
# Deploy the ai-enrich Edge Function
# Note: NOT using --no-verify-jwt here because we want the auth header
# Actually, we DO need --no-verify-jwt because we handle auth ourselves
# (the Edge Function gateway JWT check uses Supabase JWT, but we pass it through)
supabase functions deploy --no-verify-jwt ai-enrich
```

### Verification:
- [ ] Deployment succeeds without errors
- [ ] Function is visible in Supabase Dashboard → Edge Functions
- [ ] `ANTHROPIC_API_KEY` secret is accessible to the function

---

## Step 8: Test First-Pass Enrichment (Sonnet)

### What to do (HUMAN — test via curl or Alfred UI):

First, create a test inbox record. You can do this via the Alfred UI capture, or insert directly:

**Option A: Via Alfred UI** — type something into the inbox capture (e.g., "Buy chicken and rice for dinner tomorrow")

**Option B: Via Supabase SQL Editor**:
```sql
INSERT INTO public.inbox (id, created_at, archived, captured_text, user_id, source_type, ai_status)
VALUES (
  gen_random_uuid()::text,
  extract(epoch from now()) * 1000,
  false,
  'Buy chicken and rice for dinner tomorrow',
  'YOUR_USER_ID_HERE',
  'manual',
  'not_started'
);
```

Then call ai-enrich. Get your Supabase access token from the Alfred app (browser dev tools → Application → Local Storage → look for `sb-` key → `access_token`):

```bash
curl -X POST \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/ai-enrich \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"inbox_id": "THE_INBOX_RECORD_ID"}'
```

### Expected response:
```json
{
  "success": true,
  "model": "claude-sonnet-4-20250514",
  "tool_calls": 3,
  "status": "enriched",
  "suggestions": {
    "ai_status": "enriched",
    "suggested_context_id": "...",
    "suggest_intent": true,
    "suggested_intent_text": "Buy chicken and rice",
    "suggest_event": true,
    "suggested_event_date": "2026-02-21",
    "suggested_tags": ["grocery", "dinner"],
    "ai_confidence": 0.85,
    "ai_reasoning": "..."
  }
}
```

### Check the database:
- In Supabase Table Editor, find the inbox record
- `ai_status` should be `'enriched'`
- `suggested_*` fields should be populated
- `ai_reasoning` should explain why Claude made these suggestions

### Verification:
- [ ] curl returns success with model=sonnet
- [ ] Inbox record in DB shows ai_status='enriched'
- [ ] suggested_* fields are populated with sensible values
- [ ] ai_reasoning explains the suggestions
- [ ] Tool call count is reasonable (2-5 calls)

---

## Step 9: Test Re-Enrichment (Opus)

### What to do (HUMAN):

Using the same inbox record from Step 8 (which now has `ai_status = 'enriched'`):

1. Optionally edit the `captured_text` in the DB to simulate user correction:
```sql
UPDATE public.inbox
SET captured_text = 'Buy chicken thighs and jasmine rice at Trader Joes for chicken tikka masala tomorrow night'
WHERE id = 'THE_INBOX_RECORD_ID';
```

2. Call ai-enrich again with the same inbox_id:
```bash
curl -X POST \
  https://YOUR_PROJECT_REF.supabase.co/functions/v1/ai-enrich \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"inbox_id": "THE_INBOX_RECORD_ID"}'
```

### Expected response:
```json
{
  "success": true,
  "model": "claude-opus-4-0-20250115",
  "tool_calls": 5,
  "status": "re_enriched",
  "suggestions": {
    "ai_status": "re_enriched",
    "suggested_item_id": "...(ID of chicken tikka masala recipe if it exists)...",
    "suggest_intent": true,
    "suggested_intent_text": "Buy chicken thighs and jasmine rice at Trader Joes",
    "suggest_event": true,
    "suggested_event_date": "2026-02-21",
    "suggested_tags": ["grocery", "recipe", "dinner"],
    "ai_confidence": 0.92,
    "ai_reasoning": "Re-enrichment: User specified the recipe (chicken tikka masala) and store (Trader Joes). Found existing recipe item..."
  }
}
```

### Verification:
- [ ] curl returns success with model=opus (NOT sonnet)
- [ ] Inbox record shows ai_status='re_enriched'
- [ ] Opus made smarter suggestions than Sonnet's first pass
- [ ] ai_reasoning references the previous suggestions and explains improvements
- [ ] If chicken tikka masala exists as an item, suggested_item_id links to it

---

## Completion

When all steps are verified:
1. Update phase7.2-progress.md — mark all steps as ✅ Complete
2. Update the overall status to ✅ Complete
3. Proceed to Phase 7.3 (Email Capture) or Phase 7.4 (Alfred UI Updates)
