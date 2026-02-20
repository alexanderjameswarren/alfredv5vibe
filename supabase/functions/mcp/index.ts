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
