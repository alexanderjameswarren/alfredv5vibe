/**
 * Tool definitions for Alfred MCP server.
 * Used by both the MCP Edge Function and ai-enrich.
 * Each tool has: name, description, inputSchema (JSON Schema).
 */

export const toolDefinitions = [
  {
    name: "get_contexts",
    description:
      "List all contexts for the authenticated user. Contexts are top-level organizational categories (e.g., 'Recipes', 'Home Maintenance').",
    inputSchema: {
      type: "object" as const,
      properties: {
        shared: {
          type: "boolean",
          description: "If provided, filter to only shared or only private contexts",
        },
      },
    },
  },
  {
    name: "get_items",
    description:
      "Get items (non-archived), optionally filtered by context_id, tags, or search text. Items are the core entities within contexts (e.g., recipes, tasks, projects).",
    inputSchema: {
      type: "object" as const,
      properties: {
        context_id: {
          type: "string",
          description: "Filter items to a specific context",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter items that have ALL of these tags",
        },
        search_text: {
          type: "string",
          description: "Search text to match against item name or description",
        },
      },
    },
  },
  {
    name: "search_items",
    description:
      "Full-text search across item names and descriptions. Returns matching non-archived items with their context name included.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query to match against item names and descriptions",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_execution_history",
    description:
      "Get execution history with optional filters. Executions track when intents/events were carried out (e.g., when a recipe was cooked, when a task was completed).",
    inputSchema: {
      type: "object" as const,
      properties: {
        intent_id: {
          type: "string",
          description: "Filter to executions for a specific intent",
        },
        context_id: {
          type: "string",
          description: "Filter to executions within a specific context",
        },
        date_from: {
          type: "string",
          description: "Start date filter (YYYY-MM-DD)",
        },
        date_to: {
          type: "string",
          description: "End date filter (YYYY-MM-DD)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default 20)",
        },
      },
    },
  },
  {
    name: "get_collections",
    description:
      "List item collections, optionally filtered by context_id. Collections are named groups of items within a context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        context_id: {
          type: "string",
          description: "Filter collections to a specific context",
        },
      },
    },
  },
  {
    name: "get_inbox",
    description:
      "List non-archived, non-triaged inbox items. Inbox items are captured text that hasn't been organized yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        ai_status: {
          type: "string",
          enum: ["not_started", "in_progress", "enriched"],
          description: "Filter by AI enrichment status",
        },
      },
    },
  },
  {
    name: "get_tags",
    description:
      "Get all unique tags used across items and intents, with usage counts. Useful for understanding the tag taxonomy.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
] as const;
