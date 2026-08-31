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
  recordDjPlaysTool,
  createPlatformRunTool,
  getPlatformRunsTool,
  updatePlatformRunTool,
  createPlatformScheduleTool,
  getPlatformSchedulesTool,
  dryRunDjPlaysTool,
  VALID_RUN_STATUS,
} from "../_shared/tools/dj-courier.ts";
import {
  recordDjPlaylistTool,
  createDjConcertTool,
} from "../_shared/tools/dj-playlists.ts";
import { getDjPlaysTool, getDjManagedPlaylistsTool } from "../_shared/tools/dj-reads.ts";
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
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array. Each element: {type: 'header'|'bullet'|'step', text: '...', collectable?: true}. For recipes use an 'Ingredients' header with one collectable bullet per ingredient, then a 'Steps' header with step elements."),
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
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array. Each element: {type: 'header'|'bullet'|'step', text: '...', collectable?: true}. Recipes: an 'Ingredients' header, one collectable bullet per ingredient, then a 'Steps' header with step elements. One purchasable product per ingredient bullet — split 'salt and pepper' into two."),
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

  // --- DJ courier (spec §2) -------------------------------------------------

  server.registerTool(
    "record_dj_plays",
    {
      title: "Record DJ Plays",
      description:
        "Write listening history to the durable record: upserts dj_tracks and inserts dj_plays in ONE call. Pass the plays exactly as `get_dj_history` returned them (mapping `artists` to an array of names and `album` to its name string) plus a top-level `poll_date` — the handler derives match_key, played_on and precision server-side so grouping stays identical across every import path. IMPORTANT: the poll can only write the PRECISE buckets 'Today' and 'Yesterday'; 'This week' and 'Last week' are REJECTED, because they resolve to a date relative to poll_date and that date moves every day, so the same play would re-insert under a new one. Read the coarse buckets for gap detection and import older history from Takeout, which carries real timestamps. dj_tracks is INSERT-ONLY: a re-poll of a known track changes nothing and can never clobber hand-curated canonical grouping. Deduping is a database guarantee, not arithmetic — the unique index on (user_id, track_id, played_on, occurrence, source) absorbs rows already held, so re-running the same sync inserts zero rows. Note occurrence will always be 1 from polling: YouTube's feed carries one entry per track per bucket, so repeats do not stack and play counts are NOT obtainable this way. Returns counts plus `canonical_links` for review. NOTE `albums_discarded` is a POLICY counter, not a filter-quality signal: the poll discards EVERY album unconditionally, so this simply equals the number of submitted plays that carried one. It tells you how much album data was dropped; it can never indicate whether the rule is working. Per-call cap 500 plays; over that the call is REJECTED rather than truncated, because a silently-dropped tail would be stamped as a successful run. Tier 1.",
      inputSchema: {
        plays: z
          .array(z.record(z.unknown()))
          .describe(
            "Array of plays. Each: video_id (required), title (required), artists (string[] — the FIRST is used for match_key, the rest are stored), album, duration_seconds, occurrence (default 1), and EITHER played_bucket ('Today'|'Yesterday'|'This week'|'Last week', needing poll_date) OR an explicit played_on (YYYY-MM-DD) + precision ('exact'|'day'|'week'|'fortnight') for Takeout/manual rows.",
          ),
        poll_date: z
          .string()
          .optional()
          .describe(
            "YYYY-MM-DD, the local date the poll ran. Required when any play uses played_bucket. Coarse buckets resolve against it: 'This week' → poll_date − 2 days, 'Last week' → − 9, skewed to the recent end of the bucket deliberately (spec §4.2).",
          ),
        source: z
          .enum(["poll", "takeout", "manual"])
          .optional()
          .describe("Provenance of these rows. Defaults to 'poll'. Part of the dedupe key."),
      },
    },
    async (args) => runToolForMcp(recordDjPlaysTool, args, token),
  );

  server.registerTool(
    "create_platform_run",
    {
      title: "Create Platform Run",
      description:
        "Stamp one attempted job run — scheduled or on-demand — in platform_runs. Append-only. Call this on EVERY run including failures: a poll that could not reach YouTube still writes status 'failed' or 'auth_expired', and that row is what staleness detection and the phase-6 failure tests read. Absence of a row is the only signal for both 'the task never fired' and 'it fired but could not reach Supabase', so a missing stamp is indistinguishable from a missing run. Tier 1.",
      inputSchema: {
        app: z.enum(["dj", "sam", "alfred", "workshop"]).describe("Which app this job belongs to."),
        job: z.string().describe("Job name, e.g. 'daily_history_sync'. Stable across runs — staleness queries group on it."),
        executor: z.enum(["workshop", "claude", "alfred"]).describe("Who actually ran it. Different executors fail in different ways."),
        status: RUN_STATUS
          .describe("'running' = OPEN: stamp this BEFORE the work starts so a task that dies mid-flight leaves a trace; only update_platform_run can move a run out of it, and an open run may not carry finished_at or coverage. 'partial' = ran and wrote something but not everything. 'auth_expired' is separate because it is the one status with a human remedy rather than a retry."),
        host: z.string().optional().describe("Which host ran it, e.g. 'desktop' or 'surface'."),
        started_at: z.string().optional().describe("ISO timestamp of when the run BEGAN. Pass this to get a real duration — record it before the work starts. Omitted, it defaults to the same instant as finished_at (duration zero), because a run whose start is unknown should not report a made-up interval."),
        finished_at: z.string().optional().describe("ISO timestamp. Defaults to now. Must not be earlier than started_at — the call is rejected if it is."),
        covered_from: z.string().optional().describe("YYYY-MM-DD — earliest date this run covered. Compared against the previous run to detect a lost window."),
        covered_to: z.string().optional().describe("YYYY-MM-DD — latest date this run covered."),
        details: z.record(z.unknown()).optional().describe("Free-form JSON receipt, e.g. row counts, page_full, buckets seen."),
        error_message: z.string().optional().describe("What broke, when status is not 'ok'."),
        notified_at: z.string().optional().describe("ISO timestamp set once the failure has been surfaced to the human. Stops one broken credential minting an identical inbox item every day."),
      },
    },
    async (args) => runToolForMcp(createPlatformRunTool, args, token),
  );

  server.registerTool(
    "get_platform_runs",
    {
      title: "Get Platform Runs",
      description:
        "Read the job run log, most recent first. The gap-detection read: call with app, job and status 'ok', limit 1 to get the newest successful run, then backfill anything between its covered_to and today. Also the staleness and failure-triage read. Tier 1.",
      inputSchema: {
        app: z.enum(["dj", "sam", "alfred", "workshop"]).optional().describe("Filter to one app."),
        job: z.string().optional().describe("Filter to one job name."),
        status: RUN_STATUS.optional().describe("Filter by outcome. Use 'ok' for gap detection; use 'running' to find ORPHANS - runs that opened and never closed because the task died mid-flight. Nothing closes those automatically."),
        unnotified_only: z.boolean().optional().describe("Only runs whose failure has not yet been surfaced (notified_at is null)."),
        limit: z.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getPlatformRunsTool, args, token),
  );

  server.registerTool(
    "record_dj_playlist",
    {
      title: "Record DJ Playlist",
      description:
        "Record a managed playlist and its membership: writes dj_playlists and dj_playlist_tracks in ONE call, resolving every video_id to a dj_tracks row server-side (creating tracks and canonical groupings as needed, via the same shared resolver record_dj_plays uses). Re-recording the same yt_playlist_id UPDATES it — that is how the yt_set_video_id cache gets refreshed, which any later move or remove depends on. A track may hold one row per ZONE, so the same song legitimately appears in both cram and body; twice in the same zone is rejected. Rendered YouTube order is every cram row by position, then every body row by position. Tier 2.",
      inputSchema: {
        yt_playlist_id: z.string().describe("YouTube's playlist id, from create_dj_playlist or get_dj_playlists."),
        name: z.string().describe("Playlist name."),
        kind: z.enum(["concert", "artist", "jazz", "discovery"]).describe("Only 'concert' has a setlist body and a cram block; the others are flat."),
        concert_id: z.string().optional().describe("UUID from create_dj_concert. Only allowed when kind is 'concert'."),
        description: z.string().optional().describe("Optional description."),
        cram_cap: z.number().optional().describe("Max songs in the cram block. Defaults to 8 — past roughly that, cram stops focusing attention and becomes the playlist again."),
        tracks: z
          .array(z.record(z.unknown()))
          .optional()
          .describe(
            "Membership. Each: video_id, title, artists (string[]), album, duration_seconds, role ('body'|'cram'), position (integer, ordering WITHIN the zone), yt_set_video_id (from a fresh contents read — a cache, refresh it), added_reason ('new_setlist'|'neglected'|'manual'|'import')."
          ),
      },
    },
    async (args) => runToolForMcp(recordDjPlaylistTool, args, token),
  );

  server.registerTool(
    "create_dj_concert",
    {
      title: "Create DJ Concert",
      description:
        "Create a concert row covering the whole pipeline from screening to attended. The artist is resolved BY NAME and created if unknown — dj_concerts.artist_id is NOT NULL with ON DELETE RESTRICT, so a concert cannot exist without one, and sequencing that is not the caller's problem. Leave ends_on null for a single night; fill it for a residency, where the run is starts_on..ends_on. Tier 2.",
      inputSchema: {
        artist_name: z.string().describe("Artist name. Matched exactly against dj_artists, created if absent."),
        artist_tags: z.array(z.string()).optional().describe("Only used when the artist is newly created. Era and genre descriptors for discovery, e.g. ['90s','alt-rock']."),
        starts_on: z.string().describe("YYYY-MM-DD. First (or only) night."),
        ends_on: z.string().optional().describe("YYYY-MM-DD. Null for a single night; set for a residency."),
        status: z
          .enum(["screening", "interested", "committed", "attended", "missed", "rejected"])
          .describe("screening = deciding. interested = want to, not committed. committed = going. attended = went. missed = did NOT go but still want to see them. rejected = not for me."),
        tour_name: z.string().optional().describe("e.g. 'WEEZER: The Gathering'."),
        venue_id: z.string().optional().describe("UUID of an existing dj_venues row. There is no venue-creation tool yet — put the location in `notes` until there is."),
        notes: z.string().optional().describe("Free text about this show."),
      },
    },
    async (args) => runToolForMcp(createDjConcertTool, args, token),
  );

  server.registerTool(
    "get_dj_plays",
    {
      title: "Get DJ Plays",
      description:
        "Read the durable listening record. Two modes. `plays` returns raw rows newest-first with each track inlined. `familiarity` returns one row per CANONICAL GROUP sorted LEAST FAMILIAR FIRST — which is cram order directly (spec §5). " +
        "⚠️ `distinct_days` is DISTINCT DAYS PLAYED, NOT a play count: YouTube's feed carries one entry per track per bucket, so repeats do not stack and true counts are unobtainable by polling (spec §5). `play_rows` is returned alongside so the difference stays visible. " +
        "ZERO-PLAY TRACKS COME BACK: when you pass `video_ids`, every id gets an entry, including ids unknown to dj_tracks entirely (`known_track: false`) — a never-played song belongs at the TOP of a cram list, and making the caller reconstruct the missing ones is exactly the logic that goes quietly wrong. `distinct_days: 0` is a FACT; `days_since_last: null` means NEVER — the null-vs-zero distinction is deliberate. " +
        "`familiarity` refuses to run unbounded: pass `video_ids` or a date range. It ERRORS rather than truncates above its scan cap, because a clamped aggregate returns a distinct_days that is wrong rather than short and the caller would sort by it. `estimated_days` counts days made only of coarse-bucket guesses — expected to be 0. Tier 1, read-only.",
      inputSchema: {
        mode: z.enum(["plays", "familiarity"]).optional().describe("Defaults to 'plays'."),
        video_ids: z.array(z.string()).optional().describe("YouTube video ids, max 50. Resolved to canonical groups server-side, so a play by any variant counts. In familiarity mode EVERY id passed gets an entry, zero-played ones included."),
        from_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
        to_date: z.string().optional().describe("YYYY-MM-DD, inclusive."),
        source: z.enum(["poll", "takeout", "manual"]).optional().describe("Filter by provenance. Only 'takeout' rows can express true repeat counts."),
        as_of: z.string().optional().describe("YYYY-MM-DD basis for days_since_last. Defaults to today UTC; pass the local date if that differs."),
        limit: z.number().optional().describe("Max rows (plays) or groups (familiarity, date-range form only — an enumerated video_ids subject always returns every entry). Default 20, cap 50."),
      },
    },
    async (args) => runToolForMcp(getDjPlaysTool, args, token),
  );

  server.registerTool(
    "get_dj_managed_playlists",
    {
      title: "Get DJ Managed Playlists",
      description:
        "Read the SUPABASE record of managed playlists and their membership. " +
        "⚠️ NOT the same as Workshop's `get_dj_playlists`, which reads YOUTUBE. These return plausible-but-different data, so choosing the wrong one is a wrong answer that looks right: use THIS to see what was recorded, and `get_dj_playlists` to see what YouTube currently holds. Diffing the two is how phase 7 detects drift. " +
        "`list` returns managed playlists with per-role `track_counts` and `cram_headroom` (cram_cap minus current cram rows) so a caller can decide whether anything may be added without a second call. " +
        "`tracks` returns one playlist's recorded membership including `rendered_position` — the 0-indexed order YouTube SHOULD show, being every cram row by position then every body row by position (spec §5). That is computed here so callers never reimplement the rule; compare it directly against `position` from a live contents read. " +
        "Note `position` is per-ZONE, so cram 1 and body 1 are different entries and one track may legitimately hold a row in each — that duplication is what lets a cram clear leave the setlist intact. " +
        "⚠️ `yt_set_video_id` is a CACHE: stale by default and reused across playlists for DIFFERENT songs. `counts.missing_set_video_id` tells you how many rows cannot be moved or removed without a fresh read. Tier 1, read-only.",
      inputSchema: {
        mode: z.enum(["list", "tracks"]).optional().describe("Defaults to 'list'."),
        yt_playlist_id: z.string().optional().describe("mode=tracks: YouTube's playlist id. Either this or playlist_id — Workshop only ever knows this one."),
        playlist_id: z.string().optional().describe("mode=tracks: the internal dj_playlists uuid."),
        kind: z.enum(["concert", "artist", "jazz", "discovery"]).optional().describe("mode=list: filter by kind."),
        concert_id: z.string().optional().describe("mode=list: filter to playlists linked to one concert."),
        limit: z.number().optional().describe("mode=list: max playlists (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getDjManagedPlaylistsTool, args, token),
  );

  server.registerTool(
    "update_platform_run",
    {
      title: "Update Platform Run",
      description:
        "CLOSE a run that is currently 'running', writing its outcome; or set `notified_at` on any run. THE RULE: a run that is OPEN can be closed, a run that is CLOSED cannot be rewritten. covered_from, covered_to, details and error_message are accepted ONLY on the transition out of 'running', and the guard is in the UPDATE's own WHERE clause so two writers cannot both win. app, job, executor and started_at are never editable — they are what the run IS. " +
        "A 'failed' or 'auth_expired' close is REFUSED without both `error_message` and `details.failure_kind`: a failure logged without its cause is indistinguishable from one that failed for no reason, and asking for it in a prompt was not enough (spec §11.11). " +
        "The field that genuinely must change after the fact is `notified_at`: it is set once a failure has actually been surfaced to the human, which is necessarily after the row exists, and it is what stops one broken credential minting an identical inbox item every day. Doing that by insert-order instead (notify first, stamp second) fails where it matters — if the stamp then fails, a notification exists describing a run with no row. " +
        "An id matching no run is an ERROR, not a silent no-op. Returns the full row plus a `changed` before/after, which is the only record of the edit since platform_runs is registered with audit off. Tier 2.",
      inputSchema: {
        id: z.string().describe("UUID of the run, from get_platform_runs."),
        status: RUN_STATUS.optional().describe("CLOSES a run that is currently 'running'. Cannot be set to 'running' — this tool closes runs, it cannot reopen one. 'partial' = ran and wrote something but not everything, what a run with an unfillable gap records."),
        notified_at: z.string().optional().describe("ISO timestamp: when this failure was surfaced to the human. Set it AFTER the inbox item exists. This is the ONE field settable on an already-closed run."),
        covered_from: z.string().optional().describe("YYYY-MM-DD, earliest day this run covered. Only accepted while CLOSING a running run."),
        covered_to: z.string().optional().describe("YYYY-MM-DD, latest day this run covered. Only accepted while CLOSING a running run."),
        details: z.record(z.any()).optional().describe("Free-form jsonb: by_bucket, page_full, artist_disagreements, orphaned_runs, manual, and failure_kind. REQUIRED to contain failure_kind when status is 'failed' or 'auth_expired'. Only accepted while CLOSING a running run."),
        error_message: z.string().optional().describe("The failure's own words, verbatim, plus the HTTP status if there was one. REQUIRED when status is 'failed' or 'auth_expired' — the write is refused without it. Only accepted while CLOSING a running run."),
      },
    },
    async (args) => runToolForMcp(updatePlatformRunTool, args, token),
  );

  server.registerTool(
    "create_platform_schedule",
    {
      title: "Create Platform Schedule",
      description:
        "Define what is SUPPOSED to run and how often. Stores the CADENCE, not materialised expected occurrences — materialising would need a job to create those rows, and that job could fail silently, which is the exact problem this table exists to detect (spec §4.5). Staleness is derived at read time by comparing the due occurrence against platform_runs. " +
        "Re-seeding the same (app, job) UPDATES its definition rather than duplicating: a schedule is a definition, unlike platform_runs which is an append-only log. " +
        "⚠️ `day_of_week` uses the POSTGRES convention where 0 = SUNDAY — not ISO, where 1 = Monday. Required for weekly, rejected for daily. Tier 2.",
      inputSchema: {
        app: z.enum(["dj", "sam", "alfred", "workshop"]).describe("Which app this job belongs to."),
        job: z.string().describe("Job name, matching the `job` used in create_platform_run — staleness queries join on it."),
        executor: z.enum(["workshop", "claude", "alfred"]).describe("Who is supposed to run it."),
        cadence: z.enum(["daily", "weekly"]).describe("How often."),
        day_of_week: z.number().optional().describe("0-6, POSTGRES convention where 0 = SUNDAY. Required for weekly, rejected for daily."),
        expected_by: z.string().optional().describe("HH:MM or HH:MM:SS. Defaults to 08:00."),
        grace_hours: z.number().optional().describe("How late before absence counts as a problem. Defaults to 6 — a job due at 08:00 should not alarm at 08:01. Set higher for a job on a machine that sleeps."),
        enabled: z.boolean().optional().describe("Defaults true. False suspends staleness checking WITHOUT deleting the definition, so a paused job neither alarms nor has to be reconstructed from memory later."),
        notes: z.string().optional().describe("Free text."),
      },
    },
    async (args) => runToolForMcp(createPlatformScheduleTool, args, token),
  );

  server.registerTool(
    "get_platform_schedules",
    {
      title: "Get Platform Schedules",
      description:
        "Read the cadence definitions — what is supposed to run. These are DEFINITIONS, not occurrences (spec §4.5). `day_of_week` uses the Postgres convention where 0 = SUNDAY. " +
        "⚠️ Staleness is deliberately NOT computed here: it needs the newest matching run from get_platform_runs AND a timezone to resolve `expected_by` against, and it must be reconciled against dj_plays rather than trusting the run log, which asserts coverage and cannot be audited against the data (spec §11.4). Tier 1, read-only.",
      inputSchema: {
        app: z.enum(["dj", "sam", "alfred", "workshop"]).optional().describe("Filter to one app."),
        job: z.string().optional().describe("Filter to one job name."),
        enabled: z.boolean().optional().describe("Filter to enabled or suspended definitions."),
        limit: z.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getPlatformSchedulesTool, args, token),
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

// ---------------------------------------------------------------------------
// Bulk Takeout import — an HTTP endpoint, deliberately NOT an MCP tool
// ---------------------------------------------------------------------------
//
// ~15,000 rows cannot pass through a model's context: pasting them costs a
// batch's worth of tokens each way, and it makes the model the transport, which
// can corrupt a title into an insert-only match_key. This endpoint takes the
// batch as a request body straight off disk, so the data never enters a model
// at all.
//
// ⚠️ IT CALLS THE SAME HANDLERS, NEVER REIMPLEMENTS THEM. That is the whole
// reason a direct PostgREST write was rejected: match_key and canonical
// grouping must have ONE implementation across every import path (spec §4.1).
// A second write path that re-derived anything would be that mistake wearing a
// different hat.
//
//   POST /mcp/import-takeout?mode=dry_run   -> predicts, writes nothing
//   POST /mcp/import-takeout?mode=confirm   -> writes, via record_dj_plays
//
// Per-batch dry-run-then-confirm is deliberate. A single call that imported all
// 15,185 rows would solve transport by removing the review gate that made
// transport tolerable — 31 confirmations is a keypress each, not a
// transcription risk each.
app.post("/import-takeout", async (c) => {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "Missing bearer token" }, 401);

  const mode = c.req.query("mode") ?? "dry_run";
  if (mode !== "dry_run" && mode !== "confirm") {
    return c.json({ error: "mode must be 'dry_run' or 'confirm'" }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch (e) {
    return c.json({ error: `body must be JSON: ${(e as Error).message}` }, 400);
  }
  if (!Array.isArray(body?.plays)) {
    return c.json({ error: "body must be { source, plays: [...] }" }, 400);
  }

  try {
    // Confirm goes through record_dj_plays itself — the same tool, the same
    // validation, the same tier gate, the same envelope.
    const tool = mode === "confirm" ? recordDjPlaysTool : dryRunDjPlaysTool;
    const result = await tool(body, c.req.raw);
    return c.json({ mode, ...(result.data as Record<string, unknown>) });
  } catch (e) {
    // Verbatim. A partial-batch failure carries its own committed-row counts
    // and must not be reworded on the way out.
    return c.json({ mode, error: (e as Error).message }, 500);
  }
});

// Serve
Deno.serve(app.fetch);
