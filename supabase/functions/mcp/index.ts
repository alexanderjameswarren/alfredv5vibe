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
  createInboxItem,
} from "../_shared/alfred-tools/tool-handlers.ts";

const app = new Hono().basePath("/mcp");

// --- OAuth Protected Resource Metadata ---
// MCP clients (Claude.ai) discover this to know auth is required
app.get("/.well-known/oauth-protected-resource", (c) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  return c.json({
    resource: `${supabaseUrl}/functions/v1/mcp`,
    authorization_servers: [`${supabaseUrl}/auth/v1`],
    scopes_supported: [],
  });
});

// --- Helper: create an MCP server with user token baked into tool closures ---
function createMcpServer(token: string) {
  const server = new McpServer({
    name: "alfred-mcp",
    version: "0.1.0",
  });

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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
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
      const client = createUserClient(token);
      const result = await getTags(client, {});
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data || result.error, null, 2) }],
      };
    }
  );

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
    async ({ captured_text, suggested_context_id, suggest_item, suggested_item_text, suggested_item_description, suggested_item_elements, suggested_item_id, suggest_intent, suggested_intent_text, suggested_intent_recurrence, suggest_event, suggested_event_date, suggested_tags, suggested_collection_id, ai_confidence, ai_reasoning }: {
      captured_text: string;
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
      ai_confidence?: number;
      ai_reasoning?: string;
    }) => {
      const client = createUserClient(token);
      const result = await createInboxItem(client, {
        captured_text,
        suggested_context_id,
        suggest_item,
        suggested_item_text,
        suggested_item_description,
        suggested_item_elements,
        suggested_item_id,
        suggest_intent,
        suggested_intent_text,
        suggested_intent_recurrence,
        suggest_event,
        suggested_event_date,
        suggested_tags,
        suggested_collection_id,
        ai_confidence,
        ai_reasoning,
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

  return server;
}

// --- MCP endpoint with auth ---
app.all("/", async (c) => {
  const authHeader = c.req.header("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${supabaseUrl}/functions/v1/mcp/.well-known/oauth-protected-resource"`
    );
    return c.text("Unauthorized", 401);
  }

  const token = authHeader.slice(7);
  const server = createMcpServer(token);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

// Serve
Deno.serve(app.fetch);
