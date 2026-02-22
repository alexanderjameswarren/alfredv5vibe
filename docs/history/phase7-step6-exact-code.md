# Step 6: Build MCP Edge Function — EXACT CODE

**DO NOT search the web. All the information you need is in this file.**

## File 1: `supabase/functions/mcp/deno.json`

Create this file with exactly this content:

```json
{
  "imports": {
    "@hono/mcp": "npm:@hono/mcp@^0.1.1",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.24.3",
    "hono": "npm:hono@^4.9.2",
    "zod": "npm:zod@^4.1.13"
  }
}
```

## File 2: `supabase/functions/_shared/alfred-tools/supabase-client.ts`

```typescript
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Create a Supabase client that acts on behalf of an authenticated user.
 * Pass the user's access token so RLS policies are enforced.
 */
export function createUserClient(accessToken?: string): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

  const options: Record<string, unknown> = {};
  if (accessToken) {
    options.global = {
      headers: { Authorization: `Bearer ${accessToken}` },
    };
  }

  return createClient(supabaseUrl, supabaseAnonKey, options);
}

/**
 * Create a Supabase client with service role key (bypasses RLS).
 * Used by ai-enrich for internal operations.
 */
export function createServiceClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(supabaseUrl, serviceRoleKey);
}
```

## File 3: `supabase/functions/_shared/alfred-tools/types.ts`

```typescript
export interface Context {
  id: string;
  name: string;
  description: string | null;
  keywords: string | null;
  shared: boolean;
  pinned: boolean;
  created_at: number;
  user_id: string | null;
  tags: string[];
}

export interface Item {
  id: string;
  name: string;
  description: string | null;
  context_id: string | null;
  elements: unknown[];
  is_capture_target: boolean;
  created_at: number;
  archived: boolean;
  user_id: string | null;
  tags: string[];
}

export interface Intent {
  id: string;
  text: string;
  created_at: number;
  is_intention: boolean;
  is_item: boolean;
  archived: boolean;
  item_id: string | null;
  context_id: string | null;
  recurrence: string;
  user_id: string | null;
  tags: string[];
  collection_id: string | null;
}

export interface Event {
  id: string;
  intent_id: string;
  time: string; // date as string
  item_ids: string[];
  context_id: string | null;
  archived: boolean;
  created_at: number;
  text: string | null;
  user_id: string | null;
  collection_id: string | null;
}

export interface Execution {
  id: string;
  event_id: string;
  intent_id: string;
  context_id: string | null;
  item_ids: string[];
  started_at: number;
  closed_at: number | null;
  status: string;
  outcome: string | null;
  progress: unknown[];
  notes: string | null;
  elements: unknown[];
  user_id: string | null;
  collection_id: string | null;
  completed_item_ids: string[];
}

export interface InboxItem {
  id: string;
  created_at: number;
  archived: boolean;
  triaged_at: number | null;
  captured_text: string;
  suggested_context_id: string | null;
  suggest_item: boolean;
  suggested_item_text: string | null;
  suggested_item_description: string | null;
  suggested_item_elements: unknown[] | null;
  suggest_intent: boolean;
  suggested_intent_text: string | null;
  suggested_intent_recurrence: string | null;
  suggest_event: boolean;
  suggested_event_date: string | null;
  user_id: string | null;
}

export interface ItemCollection {
  id: string;
  user_id: string;
  name: string;
  context_id: string | null;
  shared: boolean;
  is_capture_target: boolean;
  items: unknown[];
  created_at: string;
}

export interface ToolResult {
  data?: unknown;
  error?: string;
}
```

## File 4: `supabase/functions/_shared/alfred-tools/tool-handlers.ts`

```typescript
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ToolResult } from "./types.ts";

export async function getContexts(
  client: SupabaseClient,
  params: { shared?: boolean }
): Promise<ToolResult> {
  try {
    let query = client
      .from("contexts")
      .select("id, name, description, keywords, shared, pinned, tags, created_at")
      .order("pinned", { ascending: false })
      .order("name");

    if (params.shared !== undefined) {
      query = query.eq("shared", params.shared);
    }

    const { data, error } = await query;
    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getItems(
  client: SupabaseClient,
  params: { context_id?: string; tags?: string[]; search_text?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("items")
      .select("id, name, description, context_id, elements, tags, is_capture_target, created_at")
      .eq("archived", false)
      .order("name");

    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }

    if (params.search_text) {
      query = query.or(
        `name.ilike.%${params.search_text}%,description.ilike.%${params.search_text}%`
      );
    }

    // Tag filtering: items.tags is a jsonb array. We filter client-side for simplicity.
    const { data, error } = await query;
    if (error) return { error: error.message };

    let results = data || [];
    if (params.tags && params.tags.length > 0) {
      results = results.filter((item: { tags: string[] }) =>
        params.tags!.some((tag) => item.tags.includes(tag))
      );
    }

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function searchItems(
  client: SupabaseClient,
  params: { query: string }
): Promise<ToolResult> {
  try {
    const { data: items, error } = await client
      .from("items")
      .select("id, name, description, context_id, elements, tags, is_capture_target")
      .eq("archived", false)
      .or(
        `name.ilike.%${params.query}%,description.ilike.%${params.query}%`
      )
      .order("name")
      .limit(20);

    if (error) return { error: error.message };

    // Fetch context names for the results
    const contextIds = [...new Set((items || []).map((i: { context_id: string | null }) => i.context_id).filter(Boolean))];
    let contextMap: Record<string, string> = {};

    if (contextIds.length > 0) {
      const { data: contexts } = await client
        .from("contexts")
        .select("id, name")
        .in("id", contextIds);
      if (contexts) {
        contextMap = Object.fromEntries(contexts.map((c: { id: string; name: string }) => [c.id, c.name]));
      }
    }

    const results = (items || []).map((item: { context_id: string | null; [key: string]: unknown }) => ({
      ...item,
      context_name: item.context_id ? contextMap[item.context_id] || null : null,
    }));

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getExecutionHistory(
  client: SupabaseClient,
  params: {
    intent_id?: string;
    context_id?: string;
    date_from?: string;
    date_to?: string;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    const limit = params.limit || 20;

    let query = client
      .from("executions")
      .select("id, event_id, intent_id, context_id, item_ids, started_at, closed_at, status, outcome, completed_item_ids")
      .order("started_at", { ascending: false })
      .limit(limit);

    if (params.intent_id) {
      query = query.eq("intent_id", params.intent_id);
    }
    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }

    const { data: executions, error } = await query;
    if (error) return { error: error.message };
    if (!executions || executions.length === 0) return { data: [] };

    // Fetch related intents for text
    const intentIds = [...new Set(executions.map((e: { intent_id: string }) => e.intent_id))];
    const { data: intents } = await client
      .from("intents")
      .select("id, text, item_id")
      .in("id", intentIds);
    const intentMap = Object.fromEntries(
      (intents || []).map((i: { id: string; text: string; item_id: string | null }) => [i.id, i])
    );

    // Fetch related events for dates
    const eventIds = [...new Set(executions.map((e: { event_id: string }) => e.event_id))];
    const { data: events } = await client
      .from("events")
      .select("id, time")
      .in("id", eventIds);
    const eventMap = Object.fromEntries(
      (events || []).map((e: { id: string; time: string }) => [e.id, e])
    );

    let results = executions.map((exec: {
      id: string;
      event_id: string;
      intent_id: string;
      context_id: string | null;
      item_ids: string[];
      started_at: number;
      closed_at: number | null;
      status: string;
      outcome: string | null;
      completed_item_ids: string[];
    }) => ({
      execution_id: exec.id,
      intent_text: intentMap[exec.intent_id]?.text || null,
      intent_item_id: intentMap[exec.intent_id]?.item_id || null,
      event_date: eventMap[exec.event_id]?.time || null,
      started_at: exec.started_at,
      closed_at: exec.closed_at,
      status: exec.status,
      outcome: exec.outcome,
      item_ids: exec.item_ids,
      context_id: exec.context_id,
    }));

    // Date filtering (event.time is a date field)
    if (params.date_from) {
      results = results.filter((r: { event_date: string | null }) =>
        r.event_date && r.event_date >= params.date_from!
      );
    }
    if (params.date_to) {
      results = results.filter((r: { event_date: string | null }) =>
        r.event_date && r.event_date <= params.date_to!
      );
    }

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getCollections(
  client: SupabaseClient,
  params: { context_id?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("item_collections")
      .select("id, name, context_id, items, shared, is_capture_target")
      .order("name");

    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }

    const { data, error } = await query;
    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getInbox(
  client: SupabaseClient,
  params: { ai_status?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("inbox")
      .select("*")
      .eq("archived", false)
      .is("triaged_at", null)
      .order("created_at", { ascending: false });

    // ai_status filtering will be added in Phase 7.1 when column exists
    // For now, return all non-archived, non-triaged inbox items

    const { data, error } = await query;
    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getTags(
  client: SupabaseClient,
  _params: Record<string, never>
): Promise<ToolResult> {
  try {
    // Get tags from items
    const { data: items } = await client
      .from("items")
      .select("tags")
      .eq("archived", false);

    // Get tags from intents
    const { data: intents } = await client
      .from("intents")
      .select("tags")
      .eq("archived", false);

    // Aggregate all tags and count occurrences
    const tagCounts: Record<string, number> = {};

    for (const item of items || []) {
      for (const tag of (item.tags as string[]) || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    for (const intent of intents || []) {
      for (const tag of (intent.tags as string[]) || []) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    // Sort by count descending
    const result = Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    return { data: result };
  } catch (e) {
    return { error: String(e) };
  }
}
```

## File 5: `supabase/functions/mcp/index.ts`

This is the MCP server entry point. It uses Hono + @hono/mcp.

```typescript
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

import { createUserClient } from "../_shared/alfred-tools/supabase-client.ts";
import {
  getContexts,
  getItems,
  searchItems,
  getExecutionHistory,
  getCollections,
  getInbox,
  getTags,
} from "../_shared/alfred-tools/tool-handlers.ts";

const app = new Hono().basePath("/mcp");

// Create MCP server
const server = new McpServer({
  name: "alfred-mcp",
  version: "0.1.0",
});

// --- Register Tools ---

server.registerTool(
  "get_contexts",
  {
    title: "Get Contexts",
    description:
      "List all GTD contexts (areas of focus) for the user. Contexts organize items, intents, and events. Examples: 'Home', 'Work - ActBlue', 'Recipes', 'Health'.",
    inputSchema: {
      shared: z.boolean().optional().describe("Filter by shared status"),
    },
  },
  async ({ shared }) => {
    const client = createUserClient(); // TODO: pass auth token in Phase 7.0 step 8+
    const result = await getContexts(client, { shared });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "get_items",
  {
    title: "Get Items",
    description:
      "Get items (reusable reference material like recipes, checklists, project notes). Can filter by context and tags. Items have elements (steps, ingredients, etc.).",
    inputSchema: {
      context_id: z.string().optional().describe("Filter by context ID"),
      tags: z.array(z.string()).optional().describe("Filter by tags (items matching ANY of these tags)"),
      search_text: z.string().optional().describe("Search item names and descriptions"),
    },
  },
  async ({ context_id, tags, search_text }) => {
    const client = createUserClient();
    const result = await getItems(client, { context_id, tags, search_text });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "search_items",
  {
    title: "Search Items",
    description:
      "Full-text search across all item names and descriptions. Returns matching items with their context names. Use this to find specific items like recipes, checklists, or project references.",
    inputSchema: {
      query: z.string().describe("Search query to match against item names and descriptions"),
    },
  },
  async ({ query }) => {
    const client = createUserClient();
    const result = await searchItems(client, { query });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "get_execution_history",
  {
    title: "Get Execution History",
    description:
      "Get execution history showing when intents were acted on. Use this to find when a recipe was last cooked, when a workout was done, etc. Can filter by intent, context, or date range.",
    inputSchema: {
      intent_id: z.string().optional().describe("Filter by specific intent ID"),
      context_id: z.string().optional().describe("Filter by context ID"),
      date_from: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
      limit: z.number().optional().describe("Max results to return (default 20)"),
    },
  },
  async ({ intent_id, context_id, date_from, date_to, limit }) => {
    const client = createUserClient();
    const result = await getExecutionHistory(client, {
      intent_id,
      context_id,
      date_from,
      date_to,
      limit,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "get_collections",
  {
    title: "Get Collections",
    description:
      "List item collections (like grocery lists, packing lists). Collections group items together and can be shared. Can filter by context.",
    inputSchema: {
      context_id: z.string().optional().describe("Filter by context ID"),
    },
  },
  async ({ context_id }) => {
    const client = createUserClient();
    const result = await getCollections(client, { context_id });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "get_inbox",
  {
    title: "Get Inbox",
    description:
      "Get pending inbox items that haven't been triaged yet. The inbox is a universal capture bucket where thoughts, emails, and tasks land before being organized into contexts.",
    inputSchema: {
      ai_status: z
        .string()
        .optional()
        .describe("Filter by AI enrichment status: 'not_started', 'in_progress', or 'enriched'"),
    },
  },
  async ({ ai_status }) => {
    const client = createUserClient();
    const result = await getInbox(client, { ai_status });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

server.registerTool(
  "get_tags",
  {
    title: "Get Tags",
    description:
      "Get all unique tags used across items and intents, with usage counts. Useful for understanding the user's taxonomy and suggesting consistent tags.",
    inputSchema: {},
  },
  async () => {
    const client = createUserClient();
    const result = await getTags(client, {});
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
    };
  }
);

// --- Mount MCP on Hono ---

app.all("/", async (c) => {
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Serve
Deno.serve(app.fetch);
```

## After creating all files

Tell the user to run these commands to test:

```bash
# Terminal 1: Serve the function locally
supabase functions serve --no-verify-jwt mcp

# Terminal 2: Test with MCP Inspector
npx -y @modelcontextprotocol/inspector
# Enter URL: http://localhost:54321/functions/v1/mcp
# Transport: Streamable HTTP
```

## Verification checklist:
- [ ] All 5 files created
- [ ] `supabase functions serve --no-verify-jwt mcp` starts without errors
- [ ] MCP Inspector connects and shows 7 tools
- [ ] Calling `get_contexts` returns data (or empty array if local DB has no data)
