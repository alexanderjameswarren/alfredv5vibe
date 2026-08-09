// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

import { clampLimit, defineTool, envelope } from "../_shared/platform.ts";
import {
  createSamSongTool,
  appendSamMeasuresTool,
} from "../_shared/tools/sam-authoring.ts";
import {
  getItems,
  searchItems,
  getExecutionHistory,
  getIntents,
  getEvents,
  getCollections,
  getInbox,
  getTags,
  updateInboxItem,
  getDatabaseSchema,
  getSamSongs,
  getSamSessions,
  getSamSnippets,
  getSamSongMeasures,
  getSamLyricWorkspace,
  placeSamLyrics,
  updateSamSongMeasures,
  loadSamLyrics,
} from "../_shared/alfred-tools/tool-handlers.ts";

// ---------------------------------------------------------------------------
// Platform-layer migrated tools (Block 2 — get_contexts + create_inbox_item)
//
// External payload contract per docs/technical-spec-platform-layer.md § Tool
// house style: `envelope` is INTERNAL between handler and defineTool; the
// model sees `envelope.data` directly (bare array / object). meta stays
// internal except for `truncated`, which the wrapper surfaces as an extra
// NOTE block above the data because the model can't infer it.
// ---------------------------------------------------------------------------

const getContextsTool = defineTool({
  name: "get_contexts",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const shared = args.shared as boolean | undefined;
    // get_contexts has no exposed limit knob — the manifest stays stable —
    // but we apply the platform ceiling defensively per the invariant "no
    // list query returns unbounded rows". clampLimit(50) resolves to 50
    // (the hard cap). In practice contexts count is far below this.
    const LIMIT = clampLimit(50);
    let query = ctx.db
      .from("contexts")
      .select("id, name, description, keywords, shared, pinned, tags, created_at")
      .order("pinned", { ascending: false })
      .order("name")
      .limit(LIMIT);
    if (shared !== undefined) query = query.eq("shared", shared);
    const { data, error } = await query;
    if (error) throw new Error(`get_contexts: ${error.message}`);
    const rows = data ?? [];
    return envelope(rows, {
      limit_applied: LIMIT,
      truncated: rows.length >= LIMIT,
    });
  },
});

const checkPlatformConformanceTool = defineTool({
  name: "check_platform_conformance",
  // Read tool — no gate. Calls the public SECURITY DEFINER wrapper for
  // platform.check_conformance() (the `platform` schema itself isn't
  // reachable via PostgREST). Return shape is whatever the SQL function
  // yields; we pass it through unchanged so the model sees the same text
  // a psql user would see.
  tier: 1,
  handler: async (_args: Record<string, unknown>, ctx) => {
    const { data, error } = await ctx.db.rpc("platform_check_conformance");
    if (error) throw new Error(`check_platform_conformance: ${error.message}`);
    return data;
  },
});

const getPlatformContractTool = defineTool({
  name: "get_platform_contract",
  // Read tool — no gate. Public wrapper for the full contract snapshot:
  // rules for new tables and tools, registry of platform-managed tables,
  // and a live conformance report. Read this first when designing.
  tier: 1,
  handler: async (_args: Record<string, unknown>, ctx) => {
    const { data, error } = await ctx.db.rpc("get_platform_contract");
    if (error) throw new Error(`get_platform_contract: ${error.message}`);
    return data;
  },
});

const createInboxItemTool = defineTool({
  name: "create_inbox_item",
  // Tier 1: the inbox IS the human-approval gateway. This write appends to
  // a staging table that affects nothing until triaged in the Alfred UI.
  // Gating it would mean confirming a capture in order to queue it for
  // confirmation.
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const record = {
      id: crypto.randomUUID(),
      archived: false,
      triaged_at: null,
      captured_text: args.captured_text as string,
      // ctx.userId comes from a local JWT decode — unverified, but RLS is
      // the real gate. Same value the old handler round-tripped auth.getUser()
      // for; the DB also has DEFAULT auth.uid() on this column since 00b.
      user_id: ctx.userId,
      // Server-set for every MCP capture. NOT caller-provided — not in the
      // input schema. Matches historical behavior from every version of
      // this tool: MCP-sourced, opaque metadata, AI-enriched-at-creation.
      source_type: "mcp",
      source_metadata: {},
      ai_status: "enriched",
      suggested_context_id: (args.suggested_context_id as string) || null,
      suggest_item: (args.suggest_item as boolean) || false,
      suggested_item_text: (args.suggested_item_text as string) || null,
      suggested_item_description: (args.suggested_item_description as string) || null,
      suggested_item_elements: (args.suggested_item_elements as unknown[]) || null,
      suggested_item_id: (args.suggested_item_id as string) || null,
      suggest_intent: (args.suggest_intent as boolean) || false,
      suggested_intent_text: (args.suggested_intent_text as string) || null,
      suggested_intent_recurrence: (args.suggested_intent_recurrence as string) || null,
      suggest_event: (args.suggest_event as boolean) || false,
      suggested_event_date: (args.suggested_event_date as string) || null,
      suggested_tags: (args.suggested_tags as string[]) || [],
      suggested_collection_id: (args.suggested_collection_id as string) || null,
      ai_confidence: (args.ai_confidence as number) ?? null,
      ai_reasoning: (args.ai_reasoning as string) || null,
    };
    const { data, error } = await ctx.db
      .from("inbox")
      .insert(record)
      .select()
      .single();
    if (error) throw new Error(`create_inbox_item: ${error.message}`);
    return data; // defineTool wraps in envelope; MCP wrapper unwraps for the model.
  },
});

// ---------------------------------------------------------------------------
// Block 6 — remaining Alfred + SAM tools routed through defineTool.
// Reads are tier 1, writes are tier 2. Most handlers thin-delegate to the
// existing tool-handlers.ts implementations (still exported for ai-enrich).
// get_items and get_inbox rewrite inline to add exposed `limit` + real
// truncation via a count query — the "N of M" NOTE relies on that count.
// ---------------------------------------------------------------------------

const getItemsTool = defineTool({
  name: "get_items",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    // All filtering (including jsonb `?|` any-of-tags) runs in Postgres
    // via public.platform_search_items — the RPC returns
    // { rows, total } from a single snapshot, so the truncation NOTE
    // math is atomic. `elements` is intentionally excluded from the
    // list shape (heavy jsonb; loaded on demand through a single-item
    // path). See supabase migration adding platform_search_items.
    const contextId  = args.context_id  as string   | undefined;
    const searchText = args.search_text as string   | undefined;
    const tags       = args.tags        as string[] | undefined;
    const LIMIT      = clampLimit(args.limit as number | undefined);

    const { data, error } = await ctx.db.rpc("platform_search_items", {
      p_context_id:  contextId  ?? null,
      p_search_text: searchText ?? null,
      p_tags:        tags && tags.length > 0 ? tags : null,
      p_limit:       LIMIT,
    });
    if (error) throw new Error(`get_items: ${error.message}`);

    const rows  = (data?.rows as unknown[]) ?? [];
    const total = (data?.total as number) ?? rows.length;
    return envelope(rows, {
      limit_applied: LIMIT,
      truncated: total > rows.length,
      total,
    });
  },
});

const searchItemsTool = defineTool({
  name: "search_items",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await searchItems(ctx.db, { query: args.query as string });
    if (result.error) throw new Error(`search_items: ${result.error}`);
    return result.data;
  },
});

const getExecutionHistoryTool = defineTool({
  name: "get_execution_history",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getExecutionHistory(ctx.db, {
      intent_id: args.intent_id as string | undefined,
      context_id: args.context_id as string | undefined,
      date_from: args.date_from as string | undefined,
      date_to: args.date_to as string | undefined,
      limit: clampLimit(args.limit as number | undefined),
    });
    if (result.error) throw new Error(`get_execution_history: ${result.error}`);
    return result.data;
  },
});

const getIntentsTool = defineTool({
  name: "get_intents",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getIntents(ctx.db, {
      context_id: args.context_id as string | undefined,
      search_text: args.search_text as string | undefined,
      tags: args.tags as string[] | undefined,
      include_archived: args.include_archived as boolean | undefined,
      recurring_only: args.recurring_only as boolean | undefined,
      limit: clampLimit(args.limit as number | undefined),
    });
    if (result.error) throw new Error(`get_intents: ${result.error}`);
    return result.data;
  },
});

const getEventsTool = defineTool({
  name: "get_events",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getEvents(ctx.db, {
      date_from: args.date_from as string | undefined,
      date_to: args.date_to as string | undefined,
      context_id: args.context_id as string | undefined,
      intent_id: args.intent_id as string | undefined,
      include_archived: args.include_archived as boolean | undefined,
      limit: clampLimit(args.limit as number | undefined),
    });
    if (result.error) throw new Error(`get_events: ${result.error}`);
    return result.data;
  },
});

const getCollectionsTool = defineTool({
  name: "get_collections",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getCollections(ctx.db, {
      context_id: args.context_id as string | undefined,
    });
    if (result.error) throw new Error(`get_collections: ${result.error}`);
    return result.data;
  },
});

const getInboxTool = defineTool({
  name: "get_inbox",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const aiStatus = args.ai_status as string | undefined;
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db.from("inbox")
      .select(
        "id, captured_text, source_type, source_metadata, suggested_context_id, suggest_item, suggested_item_text, suggested_item_description, suggested_item_elements, suggested_item_id, suggest_intent, suggested_intent_text, suggested_intent_recurrence, suggest_event, suggested_event_date, suggested_tags, suggested_collection_id, ai_status, ai_confidence, ai_reasoning, created_at"
      )
      .eq("archived", false)
      .is("triaged_at", null)
      .order("created_at", { ascending: false });
    if (aiStatus) q = q.eq("ai_status", aiStatus);

    const { data, error } = await q.limit(LIMIT);
    if (error) throw new Error(`get_inbox: ${error.message}`);
    const rows = data ?? [];

    let truncated = false;
    let total: number | undefined;
    if (rows.length >= LIMIT) {
      let cq = ctx.db.from("inbox")
        .select("id", { count: "exact", head: true })
        .eq("archived", false)
        .is("triaged_at", null);
      if (aiStatus) cq = cq.eq("ai_status", aiStatus);
      const { count, error: countErr } = await cq;
      if (!countErr && typeof count === "number") {
        total = count;
        truncated = count > rows.length;
      } else {
        truncated = true;
      }
    }

    return envelope(rows, {
      limit_applied: LIMIT,
      truncated,
      total,
    });
  },
});

const getTagsTool = defineTool({
  name: "get_tags",
  tier: 1,
  handler: async (_args: Record<string, unknown>, ctx) => {
    const result = await getTags(ctx.db, {});
    if (result.error) throw new Error(`get_tags: ${result.error}`);
    return result.data;
  },
});

const updateInboxItemTool = defineTool({
  name: "update_inbox_item",
  // Tier 2: updates existing rows. Audited via trigger. Rollback available
  // through platform.rollback_audit_entry() if a bad enrichment lands.
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await updateInboxItem(ctx.db, {
      inbox_id: args.inbox_id as string,
      ai_confidence: args.ai_confidence as number,
      ai_reasoning: args.ai_reasoning as string,
      ai_status: args.ai_status as "enriched" | "re_enriched" | undefined,
      suggested_context_id: args.suggested_context_id as string | undefined,
      suggest_item: args.suggest_item as boolean | undefined,
      suggested_item_text: args.suggested_item_text as string | undefined,
      suggested_item_description: args.suggested_item_description as string | undefined,
      suggested_item_elements: args.suggested_item_elements as unknown[] | undefined,
      suggested_item_id: args.suggested_item_id as string | undefined,
      suggest_intent: args.suggest_intent as boolean | undefined,
      suggested_intent_text: args.suggested_intent_text as string | undefined,
      suggested_intent_recurrence: args.suggested_intent_recurrence as
        | "once" | "daily" | "weekly" | "monthly" | "yearly" | undefined,
      suggest_event: args.suggest_event as boolean | undefined,
      suggested_event_date: args.suggested_event_date as string | undefined,
      suggested_tags: args.suggested_tags as string[] | undefined,
      suggested_collection_id: args.suggested_collection_id as string | undefined,
    });
    if (result.error) throw new Error(`update_inbox_item: ${result.error}`);
    return result.data;
  },
});

const getDatabaseSchemaTool = defineTool({
  name: "get_database_schema",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getDatabaseSchema(ctx.db, {
      table_name: args.table_name as string | undefined,
    });
    if (result.error) throw new Error(`get_database_schema: ${result.error}`);
    return result.data;
  },
});

const getSamSongsTool = defineTool({
  name: "get_sam_songs",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getSamSongs(ctx.db, {
      search_text: args.search_text as string | undefined,
    });
    if (result.error) throw new Error(`get_sam_songs: ${result.error}`);
    return result.data;
  },
});

const getSamSessionsTool = defineTool({
  name: "get_sam_sessions",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getSamSessions(ctx.db, {
      song_id: args.song_id as string | undefined,
      snippet_id: args.snippet_id as string | undefined,
      date_from: args.date_from as string | undefined,
      date_to: args.date_to as string | undefined,
      limit: clampLimit(args.limit as number | undefined),
    });
    if (result.error) throw new Error(`get_sam_sessions: ${result.error}`);
    return result.data;
  },
});

const getSamSnippetsTool = defineTool({
  name: "get_sam_snippets",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getSamSnippets(ctx.db, {
      song_id: args.song_id as string | undefined,
      search_text: args.search_text as string | undefined,
    });
    if (result.error) throw new Error(`get_sam_snippets: ${result.error}`);
    return result.data;
  },
});

const getSamSongMeasuresTool = defineTool({
  name: "get_sam_song_measures",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getSamSongMeasures(ctx.db, {
      song_id: args.song_id as string,
      start_measure: args.start_measure as number | undefined,
      end_measure: args.end_measure as number | undefined,
    });
    if (result.error) throw new Error(`get_sam_song_measures: ${result.error}`);
    return result.data;
  },
});

const getSamLyricWorkspaceTool = defineTool({
  name: "get_sam_lyric_workspace",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await getSamLyricWorkspace(ctx.db, {
      song_id: args.song_id as string,
      batch_size: args.batch_size as number | undefined,
    });
    if (result.error) throw new Error(`get_sam_lyric_workspace: ${result.error}`);
    return result.data;
  },
});

const placeSamLyricsTool = defineTool({
  name: "place_sam_lyrics",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await placeSamLyrics(ctx.db, {
      song_id: args.song_id as string,
      starting_word_order: args.starting_word_order as number,
      placements: args.placements as number[][],
    });
    if (result.error) throw new Error(`place_sam_lyrics: ${result.error}`);
    return result.data;
  },
});

const updateSamSongMeasuresTool = defineTool({
  name: "update_sam_song_measures",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await updateSamSongMeasures(ctx.db, {
      song_id: args.song_id as string,
      updates: args.updates as { measure_num: number; chord?: string; section?: string; audio_offset_ms?: number }[],
    });
    if (result.error) throw new Error(`update_sam_song_measures: ${result.error}`);
    return result.data;
  },
});

const loadSamLyricsTool = defineTool({
  name: "load_sam_lyrics",
  // Tier 2: with replace=true this is destructive of prior workspace state.
  // Audited via trigger; rollback via platform.rollback_audit_entry().
  // Not tier 3 because forcing `confirmed: true` on every routine lyric load
  // would break the workflow — audit-then-rollback is the safer default here.
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const result = await loadSamLyrics(ctx.db, {
      song_id: args.song_id as string,
      syllables: args.syllables as string[],
      replace: args.replace as boolean | undefined,
    });
    if (result.error) throw new Error(`load_sam_lyrics: ${result.error}`);
    return result.data;
  },
});

// MCP-side glue: platform tools return `(args, Request) => envelope`. The MCP
// SDK's registerTool callback gives us args and a closured token. Wrap the
// token in a synthetic Request so createContext's header extraction still
// works, then unwrap the envelope for the model per the "external = bare"
// rule. Two error classes reach the model verbatim: guardrail denials
// (terminal, do-not-retry — from enforceBudget) and operational failures
// (retryable — from the handler's own throws). Neither is rewritten.

function tokenAsRequest(token: string): Request {
  return new Request("https://mcp.local/", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

type PlatformResult = {
  data: unknown;
  meta: {
    count?: number;
    truncated?: boolean;
    limit_applied?: number;
    total?: number;
  };
};

async function runToolForMcp(
  fn: (args: Record<string, unknown>, req: Request) => Promise<PlatformResult>,
  args: Record<string, unknown>,
  token: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await fn(args, tokenAsRequest(token));
    const blocks: Array<{ type: "text"; text: string }> = [];
    if (result.meta?.truncated) {
      const shown = Array.isArray(result.data)
        ? result.data.length
        : (result.meta.limit_applied ?? "?");
      // "N of M" per the spec's "Tool house style" — M is the true row
      // count the handler measured with a separate count query. If the
      // handler couldn't compute it, fall back to a shape that still
      // signals the cut without claiming a false total.
      const total = result.meta.total;
      const ofClause = total !== undefined ? `of ${total}` : "(more available)";
      blocks.push({
        type: "text" as const,
        text:
          `NOTE: results truncated to ${shown} ${ofClause}. ` +
          `Narrow the query or request a specific subset.`,
      });
    }
    blocks.push({
      type: "text" as const,
      text: JSON.stringify(result.data, null, 2),
    });
    return { content: blocks };
  } catch (e) {
    // Verbatim message — do not decorate. Guardrail denials keep their
    // terminal wording; operational errors keep theirs. The client can
    // tell them apart from the text; we surface isError either way.
    return {
      isError: true,
      content: [
        { type: "text" as const, text: (e as Error).message },
      ],
    };
  }
}

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
    async ({ shared }) => runToolForMcp(getContextsTool, { shared }, token),
  );

  server.registerTool(
    "get_items",
    {
      title: "Get Items",
      description:
        "Get items (reusable reference material like recipes, checklists, project notes). Can filter by context and tags. Items have elements (steps, ingredients, etc.). Results are capped (default 20, max 50) — the response NOTE tells you when there's more. [v22]",
      inputSchema: {
        context_id: z.string().optional().describe("Filter by context ID"),
        tags: z.array(z.string()).optional().describe("Filter by tags (items matching ANY of these tags)"),
        search_text: z.string().optional().describe("Search item names and descriptions"),
        limit: z.number().optional().describe("Max results to return (default 20, hard cap 50)"),
      },
    },
    async (args) => runToolForMcp(getItemsTool, args, token),
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
    async (args) => runToolForMcp(searchItemsTool, args, token),
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
    async (args) => runToolForMcp(getExecutionHistoryTool, args, token),
  );

  server.registerTool(
    "get_intents",
    {
      title: "Get Intents",
      description:
        "List intentions and item-intents (GTD tasks/reusable actions). Use to see active intents for briefings, recurrence review, or context planning. Returns intent rows with resolved context name.",
      inputSchema: {
        context_id: z.string().optional().describe("Filter by context ID"),
        search_text: z.string().optional().describe("Search text to match against intent text (ILIKE)"),
        tags: z.array(z.string()).optional().describe("Filter intents that have ANY of these tags"),
        include_archived: z.boolean().optional().describe("Include archived intents (default false)"),
        recurring_only: z.boolean().optional().describe("Only return intents with a recurrence_config (default false)"),
        limit: z.number().optional().describe("Max results to return (default 50)"),
      },
    },
    async (args) => runToolForMcp(getIntentsTool, args, token),
  );

  server.registerTool(
    "get_events",
    {
      title: "Get Events",
      description:
        "List scheduled events (an intent placed on a date). Use for 'what's on today / this week' briefings. Returns events with resolved intent text and context name.",
      inputSchema: {
        date_from: z.string().optional().describe("Start date filter (YYYY-MM-DD, inclusive)"),
        date_to: z.string().optional().describe("End date filter (YYYY-MM-DD, inclusive)"),
        context_id: z.string().optional().describe("Filter by context ID"),
        intent_id: z.string().optional().describe("Filter by specific intent ID"),
        include_archived: z.boolean().optional().describe("Include archived events (default false)"),
        limit: z.number().optional().describe("Max results to return (default 50)"),
      },
    },
    async (args) => runToolForMcp(getEventsTool, args, token),
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
    async (args) => runToolForMcp(getCollectionsTool, args, token),
  );

  server.registerTool(
    "get_inbox",
    {
      title: "Get Inbox",
      description:
        "Get pending inbox items that haven't been triaged yet. The inbox is a universal capture bucket where thoughts, emails, and tasks land before being organized into contexts. Results are capped (default 20, max 50) — the response NOTE tells you when there's more.",
      inputSchema: {
        ai_status: z
          .string()
          .optional()
          .describe("Filter by AI enrichment status: 'not_started', 'in_progress', or 'enriched'"),
        limit: z.number().optional().describe("Max results to return (default 20, hard cap 50)"),
      },
    },
    async (args) => runToolForMcp(getInboxTool, args, token),
  );

  server.registerTool(
    "get_tags",
    {
      title: "Get Tags",
      description:
        "Get all unique tags used across items and intents, with usage counts. Useful for understanding the user's taxonomy and suggesting consistent tags.",
      inputSchema: {},
    },
    async () => runToolForMcp(getTagsTool, {}, token),
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
    async (args) => runToolForMcp(createInboxItemTool, args, token),
  );

  server.registerTool(
    "update_inbox_item",
    {
      title: "Update Inbox Item",
      description:
        "Update an inbox item with AI enrichment suggestions. Before calling this, read the alfred-enrich skill at /mnt/skills/user/alfred-enrich/SKILL.md and follow the enrichment methodology. Always use read tools (get_contexts, search_items, get_tags, get_collections) to research before writing suggestions. Required fields: inbox_id, ai_confidence, ai_reasoning.",
      inputSchema: {
        inbox_id: z.string().describe("ID of the inbox item to update"),
        ai_confidence: z.number().describe("Confidence score 0.0-1.0"),
        ai_reasoning: z.string().describe("Brief explanation of suggestions"),
        ai_status: z.enum(["enriched", "re_enriched"]).optional().describe("Set to 'enriched' for initial enrichment, 're_enriched' for re-enrichment"),
        suggested_context_id: z.string().optional().describe("ID of an existing context (use get_contexts to find it)"),
        suggest_item: z.boolean().optional().describe("Should this become a reusable Item? (true for recipes, checklists, reference material)"),
        suggested_item_text: z.string().optional().describe("Name for the new item"),
        suggested_item_description: z.string().optional().describe("Description for the new item"),
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array. Each element: {type: 'ingredient'|'step'|'header'|'bullet', text: '...'}"),
        suggested_item_id: z.string().optional().describe("ID of an EXISTING item to link to (use search_items to find it)"),
        suggest_intent: z.boolean().optional().describe("Should this become an Intention/task?"),
        suggested_intent_text: z.string().optional().describe("Text for the intention (what the user intends to do)"),
        suggested_intent_recurrence: z.enum(["once", "daily", "weekly", "monthly", "yearly"]).optional().describe("Recurrence pattern"),
        suggest_event: z.boolean().optional().describe("Is there a specific date associated?"),
        suggested_event_date: z.string().optional().describe("Date in YYYY-MM-DD format"),
        suggested_tags: z.array(z.string()).optional().describe("Suggested tags, lowercase, underscore-separated (use get_tags to match existing taxonomy)"),
        suggested_collection_id: z.string().optional().describe("ID of an existing collection (use get_collections to find it)"),
      },
    },
    async (args) => runToolForMcp(updateInboxItemTool, args, token),
  );

  server.registerTool(
    "get_database_schema",
    {
      title: "Get Database Schema",
      description:
        "Get schema information for Alfred's database tables including column names, types, defaults, and nullability. Use this to understand the data model before writing queries or making suggestions. Pass a specific table name or omit for all tables.",
      inputSchema: {
        table_name: z
          .string()
          .optional()
          .describe("Specific table name (e.g., 'items', 'intents', 'inbox') or omit for all public tables"),
      },
    },
    async (args) => runToolForMcp(getDatabaseSchemaTool, args, token),
  );

  server.registerTool(
    "check_platform_conformance",
    {
      title: "Check Platform Conformance",
      description:
        "Return the platform-layer conformance status — every registered public table checked against its declared platform contract (RLS enabled, correct grants, audit trigger attached, register_table entry present, etc.). Runs the platform.check_conformance() function via a public SECURITY DEFINER wrapper. Use this as the final step of any schema migration to confirm no drift was introduced.",
      inputSchema: {},
    },
    async () => runToolForMcp(checkPlatformConformanceTool, {}, token),
  );

  server.registerTool(
    "get_platform_contract",
    {
      title: "Get Platform Contract",
      description:
        "Returns the platform contract (rules for new tables and tools), the registry of platform-managed tables, and a live conformance report. Read this first before designing new tables or tools.",
      inputSchema: {},
    },
    async () => runToolForMcp(getPlatformContractTool, {}, token),
  );

  server.registerTool(
    "get_sam_songs",
    {
      title: "Get SAM Songs",
      description:
        "Get songs in the SAM music practice app. Returns song metadata (title, artist, key, BPM). Use search_text to find specific songs. Does not return measure data — use get_database_schema for full details if needed.",
      inputSchema: {
        search_text: z.string().optional().describe("Search song titles and artists"),
      },
    },
    async (args) => runToolForMcp(getSamSongsTool, args, token),
  );

  server.registerTool(
    "get_sam_sessions",
    {
      title: "Get SAM Practice Sessions",
      description:
        "Get practice sessions from the SAM music app. Sessions record when the user started and ended practicing a song or snippet plus a performance summary; elapsed time is derived from started_at and ended_at (there is no stored duration column). A session with ended_at NULL was abandoned mid-way and should not be counted toward practice totals. Returns most recent sessions first. Use date_from/date_to to filter by time period. Includes song and snippet titles in results.",
      inputSchema: {
        song_id: z.string().optional().describe("Filter by song ID"),
        snippet_id: z.string().optional().describe("Filter by snippet ID"),
        date_from: z
          .string()
          .optional()
          .describe("Start date filter (ISO 8601 format, e.g. 2025-01-01)"),
        date_to: z.string().optional().describe("End date filter (ISO 8601 format)"),
        limit: z.number().optional().describe("Max results to return (default 20)"),
      },
    },
    async (args) => runToolForMcp(getSamSessionsTool, args, token),
  );

  server.registerTool(
    "get_sam_snippets",
    {
      title: "Get SAM Snippets",
      description:
        "Get practice snippets (sections of songs) from the SAM music app. Snippets define a range of measures within a song for focused practice. Includes song titles in results.",
      inputSchema: {
        song_id: z.string().optional().describe("Filter by song ID"),
        search_text: z.string().optional().describe("Search snippet titles and notes"),
      },
    },
    async (args) => runToolForMcp(getSamSnippetsTool, args, token),
  );

  server.registerTool(
    "get_sam_song_measures",
    {
      title: "Get SAM Song Measures",
      description:
        "Read measures for a SAM song, with optional range filter. Returns measure notation (RH/LH events), metadata, any placed lyrics, and any placed RH fingerings (each with note_index, finger 1-5, and source 'manual'|'musicxml').",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        start_measure: z.number().optional().describe("First measure number to return (inclusive)"),
        end_measure: z.number().optional().describe("Last measure number to return (inclusive)"),
      },
    },
    async (args) => runToolForMcp(getSamSongMeasuresTool, args, token),
  );

  server.registerTool(
    "get_sam_lyric_workspace",
    {
      title: "Get SAM Lyric Workspace",
      description:
        "Get the current lyric placement workspace — returns the next block of measures that need lyrics and the next batch of unplaced syllables. Designed for the iterative lyric placement workflow.",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        batch_size: z.number().optional().describe("Number of measures to return (default 8)"),
      },
    },
    async (args) => runToolForMcp(getSamLyricWorkspaceTool, args, token),
  );

  server.registerTool(
    "place_sam_lyrics",
    {
      title: "Place SAM Lyrics",
      description:
        "Place syllables onto specific notes in a song. Validates monotonic ordering and RH index bounds. Triggers recompilation.",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        starting_word_order: z.number().describe("First word_order being placed (must be the next unplaced syllable)"),
        placements: z.array(z.array(z.number()).length(2)).describe("Array of [measure_num, rh_index] pairs"),
      },
    },
    async (args) => runToolForMcp(placeSamLyricsTool, args, token),
  );

  server.registerTool(
    "update_sam_song_measures",
    {
      title: "Update SAM Song Measures",
      description:
        "Update metadata fields on song measures. Can set chord, section, and audio_offset_ms. CANNOT modify rh, lh, or time_signature.",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        updates: z.array(z.object({
          measure_num: z.number().describe("Measure number to update"),
          chord: z.string().optional().describe("Chord symbol (e.g. 'Am', 'G7')"),
          section: z.string().optional().describe("Section label (e.g. 'Verse 1', 'Chorus')"),
          audio_offset_ms: z.number().optional().describe("Audio file timestamp for this measure (ms)"),
        })).describe("Array of measure updates"),
      },
    },
    async (args) => runToolForMcp(updateSamSongMeasuresTool, args, token),
  );

  server.registerTool(
    "load_sam_lyrics",
    {
      title: "Load SAM Lyrics",
      description:
        "Load pre-split syllables for a song. Inserts rows into sam_song_lyrics with word_order assigned. All rows start unplaced (measure_num and rh_index are NULL). Use replace=true to clear existing lyrics first.",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        syllables: z.array(z.string()).describe("Pre-split syllables in order, e.g. ['Nev-', 'er', 'mind']"),
        replace: z.boolean().optional().describe("If true, delete existing lyrics first (default false)"),
      },
    },
    async (args) => runToolForMcp(loadSamLyricsTool, args, token),
  );

  server.registerTool(
    "create_sam_song",
    {
      title: "Create SAM Song",
      description:
        "Create an empty SAM song row (no notation). Use this before append_sam_measures to lay down a song shell — title, artist, key, time signature, default BPM, and lineage (song_type, parent_song_id, difficulty_tier, generation_notes). This tool does NOT write any measures; call append_sam_measures afterward. Tier 3 — requires `confirmed: true` in args to actually write.",
      inputSchema: {
        title: z.string().describe("Song title (required)"),
        songType: z
          .enum(["original", "simplified", "drill"])
          .describe(
            "Kind of song. 'original' = standalone piece. 'simplified' = easier variant of a parent (parentSongId required). 'drill' = practice exercise; parent optional."
          ),
        artist: z.string().optional().describe("Composer or arranger. Optional."),
        parentSongId: z
          .string()
          .optional()
          .describe(
            "UUID of the parent song. Required when songType='simplified'; allowed for 'drill'; ignored for 'original'."
          ),
        difficultyTier: z
          .number()
          .int()
          .min(1)
          .max(9)
          .optional()
          .describe("1-9. Only meaningful when songType='simplified'."),
        generationNotes: z
          .record(z.unknown())
          .optional()
          .describe(
            "Free-form JSON receipt of how / why this song was generated. For human reading; not source for a build step."
          ),
        key: z.string().optional().describe("Key signature, e.g. 'C major', 'A minor'."),
        timeSignature: z
          .string()
          .optional()
          .describe("Song-level default in 'N/M' form, e.g. '4/4'. Per-measure timeSignature overrides."),
        defaultBpm: z.number().optional().describe("Default tempo. Defaults to 68."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Tier-3 gate. Set to true on the second call to actually write. Omit / false on the first call to see a proposal."),
      },
    },
    async (args) => runToolForMcp(createSamSongTool, args, token),
  );

  server.registerTool(
    "append_sam_measures",
    {
      title: "Append SAM Measures",
      description:
        "Append validated measures to an existing SAM song's sam_song_measures rows. Continues numbering from max(number) for that song; sets measures_edited_at (leaves measures_compiled_at NULL so the React app recompiles the blob from rows on next open). This is the ONLY MCP tool that writes rh/lh notation — update_sam_song_measures is metadata-only (chord, section, audio offset) and cannot touch notation. Each measure is validated against the shared JSON Schema (structural) plus midi/name agreement and duration-sum-per-hand (semantic); the entire batch is rejected on any failure. Per-call cap: 100 measures — larger batches are truncated with a NOTE. Tier 3 — requires `confirmed: true` in args to actually write.",
      inputSchema: {
        songId: z.string().describe("UUID of the song to append to."),
        measures: z
          .array(z.record(z.unknown()))
          .describe(
            "Array of Measure objects per docs/technical-spec-sam-drills-and-lineage.md §4: each has rh[], lh[], timeSignature {beats, beatType}, plus optional number, chord, section, audioOffsetMs. Voice events use VexFlow duration tokens (w/h/q/8/16/32 + optional 'd' per dot); notes have midi + name that must agree; [] on notes means a rest. No `beats[]` (legacy); no inline `lyric` (lyrics live in sam_song_lyrics)."
          ),
        confirmed: z
          .boolean()
          .optional()
          .describe("Tier-3 gate. Set to true on the second call to actually write. Omit / false on the first call to see a proposal."),
      },
    },
    async (args) => runToolForMcp(appendSamMeasuresTool, args, token),
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
