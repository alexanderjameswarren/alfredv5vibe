// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";

import { clampLimit, defineTool, envelope } from "../_shared/platform.ts";
import { normaliseTags } from "../_shared/tags.ts";
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
  recordDjPlaylistBulkTool,
  dryRunDjPlaylistTool,
  classifyRead,
  createDjConcertTool,
} from "../_shared/tools/dj-playlists.ts";
import { getDjPlaysTool, getDjManagedPlaylistsTool } from "../_shared/tools/dj-reads.ts";
import { getSamSongScoresTool } from "../_shared/tools/sam-song-scores.ts";
import {
  SAM_DATA_RULES,
  getSamPracticePlanTool,
  getSamPracticePlansTool,
  getSamPlanProgressTool,
  getSamGoalsTool,
  createSamPracticePlanTool,
  updateSamPlanReviewNoteTool,
  updateSamSongGoalTool,
  createSamGoalTool,
  updateSamGoalTool,
} from "../_shared/tools/sam-plans.ts";
import { createSamSnippetTool } from "../_shared/tools/sam-snippets.ts";
import { SAM_SCORING_RULES } from "../_shared/samScoringRules.ts";
import { getSamMeasureStatsTool } from "../_shared/tools/sam-measure-stats.ts";
import {
  getDjConcertsTool,
  updateDjConcertTool,
  recordDjFeedbackTool,
} from "../_shared/tools/dj-concerts.ts";
import { getDjArtistsTool, upsertDjArtistTool, recordDjArtistTagTool, getDjArtistTagsTool } from "../_shared/tools/dj-artists.ts";
import {
  JOB_VOCAB,
  VALID_JOB_EFFORT,
  VALID_JOB_FIT,
  VALID_JOB_STATUS,
  getJobApplicationsTool,
  createJobApplicationTool,
  updateJobApplicationTool,
  getJobApplicationSourcesTool,
} from "../_shared/tools/job-applications.ts";
import { recordDjAlbumTool, getDjAlbumsTool } from "../_shared/tools/dj-albums.ts";
import {
  CLIP_VOCAB,
  getRecentClipsTool,
  getClipSlicesTool,
  archiveInboxItemTool,
} from "../_shared/tools/clipboard.ts";
import {
  getKenQuizBatchTool,
  recordKenAttemptsTool,
  createKenAreaTool,
  updateKenAreaTool,
  createKenItemTool,
  getKenAreasTool,
  getKenItemsTool,
  getKenLyricFragmentsTool,
  getKenMisconceptionsTool,
  createKenMisconceptionTool,
  updateKenMisconceptionTool,
  proposeKenFactUpdateTool,
} from "../_shared/tools/ken.ts";
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
  getSamPasses,
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
      // No `tags` — see the note on the twin select in
      // _shared/alfred-tools/tool-handlers.ts. The column is dropped by
      // Migration A and selecting it afterwards is a hard PostgREST error.
      .select("id, name, description, keywords, shared, pinned, created_at")
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
      // Normalised, not stored verbatim — this tool's caller is a model. These
      // values reach items.tags / intents.tags unchanged on triage if the user
      // never opens the tag box. See _shared/tags.ts.
      suggested_tags: normaliseTags(args.suggested_tags),
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
    // All filtering (including any-of-tags, `tags && p_tags` since
    // items.tags became text[] in migration 039) runs in Postgres via
    // public.platform_search_items — the RPC returns { rows, total }
    // from a single snapshot, so the truncation NOTE math is atomic.
    // `elements` is intentionally excluded from the list shape (heavy
    // jsonb; loaded on demand through a single-item path).
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
    const sourceType = args.source_type as string | undefined;
    const LIMIT = clampLimit(args.limit as number | undefined);

    // A hand-typed column list: nothing type-checks it, so a renamed or dropped
    // column fails here at REQUEST time rather than at build time.
    //
    // `suggested_tags` went jsonb -> text[] in migration 062 and this line did
    // not change, because it never had to: the column kept its name, and
    // PostgREST serialises a text[] to the same JSON array of strings a jsonb
    // array produced. A rename or a drop would still break it. A retype did
    // not.
    let q = ctx.db.from("inbox")
      .select(
        "id, captured_text, source_type, source_metadata, suggested_context_id, suggest_item, suggested_item_text, suggested_item_description, suggested_item_elements, suggested_item_id, suggest_intent, suggested_intent_text, suggested_intent_recurrence, suggest_event, suggested_event_date, suggested_tags, suggested_collection_id, ai_status, ai_confidence, ai_reasoning, created_at"
      )
      .eq("archived", false)
      .is("triaged_at", null)
      .order("created_at", { ascending: false });
    if (aiStatus) q = q.eq("ai_status", aiStatus);
    // ⚠️ EVERY FILTER HERE MUST ALSO GO ON THE COUNT QUERY BELOW. The two are
    // hand-kept in step and nothing checks that they agree; a filter applied to
    // only one of them makes the "N of M" truncation NOTE quietly lie, which is
    // worse than no NOTE because the model believes it.
    if (sourceType) q = q.eq("source_type", sourceType);

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
      if (sourceType) cq = cq.eq("source_type", sourceType);
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
      plan_id: args.plan_id as string | undefined,
      plan_item_id: args.plan_item_id as string | undefined,
      limit: clampLimit(args.limit as number | undefined),
    });
    if (result.error) throw new Error(`get_sam_sessions: ${result.error}`);
    return result.data;
  },
});

// M5. Reads sam_passes so practice instructions ("at 60, four to six passes")
// can be checked from chat against what was actually played.
const getSamPassesTool = defineTool({
  name: "get_sam_passes",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);
    const result = await getSamPasses(ctx.db, {
      song_id: args.song_id as string | undefined,
      snippet_id: args.snippet_id as string | undefined,
      whole_song_only: args.whole_song_only as boolean | undefined,
      exclude_zero_note: args.exclude_zero_note as boolean | undefined,
      only_zero_note: args.only_zero_note as boolean | undefined,
      date_from: args.date_from as string | undefined,
      date_to: args.date_to as string | undefined,
      plan_id: args.plan_id as string | undefined,
      plan_item_id: args.plan_item_id as string | undefined,
      limit: LIMIT,
    });
    if (result.error) throw new Error(`get_sam_passes: ${result.error}`);
    const rows = (result.data ?? []) as unknown[];
    // A clamped result and a genuinely short one look identical to the reader,
    // and miscounting passes is precisely the failure this tool exists to
    // prevent — so the truncation flag matters more here than most places.
    return envelope(rows, {
      limit_applied: LIMIT,
      truncated: rows.length >= LIMIT,
    });
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

// ---------------------------------------------------------------------------
// MCP content blocks — text by default, images when a tool needs them
// ---------------------------------------------------------------------------
//
// Almost every tool's payload is JSON text, and the platform contract says so:
// the wrapper emits `envelope.data` and nothing else. That remains the default
// and the right shape for anything a model reads as data.
//
// SOME PAYLOADS ARE NOT DATA. A screenshot is the case that forced this. Claude
// in claude.ai cannot open a link that only appeared in a tool result, and a
// signed Storage link is far past the fetch tool's 250-character limit, so a
// picture has no way of reaching the model except as an MCP `image` content
// block. That is a capability MCP has always had and this wrapper did not model:
// the return type below pinned `type` to the literal `"text"`, so no tool COULD
// return one. Established by the clipboard spike on 2026-09-23 and kept as a
// permanent part of the wrapper (technical-spec-clipboard.md, decision 3).
//
// HOW A TOOL OPTS IN: return `{ __mcp_content: [...blocks] }` as the envelope
// data, and the wrapper emits those blocks verbatim instead of serialising the
// object. The envelope itself is unchanged — still `{ data, meta }` — so
// `defineTool`, the tier gate, the budget guard and the audit trail all behave
// identically. A tool doing this owns its own presentation and should put a
// text block FIRST describing what the images are; see
// `_shared/tools/clipboard.ts` for the house example.
//
// WHAT IT COSTS: exactly one property read. No other tool sets that key, so
// every text tool produces the bytes it always produced — the truncation NOTE,
// then `JSON.stringify(envelope.data, null, 2)`. The sentinel read is safely
// `undefined` for arrays, primitives and null, so the ordinary path cannot be
// entered by accident.
//
// WHY A SENTINEL RATHER THAN A SECOND WRAPPER: `runToolForMcp` is the single
// choke point every registered tool passes through, and the value of that is
// that there is only one of it. A parallel `runImageToolForMcp` would be a
// second place for the truncation NOTE and the verbatim-error rule to drift
// out of step.
//
// ⚠️ IMAGE BLOCKS ARE EXPENSIVE. base64 is 4/3 of the bytes and every block
// lands in the model's context whether or not it is looked at. A tool returning
// images must bound how many it sends and say what it left out — never return
// "all of them" from an unbounded set.
type McpBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Envelope-data key a tool sets to emit its own MCP content blocks instead of
 * having its data serialised as JSON text. See the note above.
 */
const MCP_CONTENT_KEY = "__mcp_content";

async function runToolForMcp(
  fn: (args: Record<string, unknown>, req: Request) => Promise<PlatformResult>,
  args: Record<string, unknown>,
  token: string,
): Promise<{ content: McpBlock[]; isError?: boolean }> {
  try {
    const result = await fn(args, tokenAsRequest(token));
    const blocks: McpBlock[] = [];
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
      // A separate block, but clients (claude.ai) join text blocks with no
      // separator, so the NOTE ran straight into the JSON ("subset.{"). The
      // trailing blank line keeps the joined text splittable; the JSON block
      // itself stays pure JSON.
      blocks.push({
        type: "text" as const,
        text:
          `NOTE: results truncated to ${shown} ${ofClause}. ` +
          `Narrow the query or request a specific subset.\n\n`,
      });
    }
    // Content-block passthrough, described above. Placed AFTER the truncation
    // NOTE so such a tool still gets one if it sets meta.truncated, and BEFORE
    // the JSON block so the sentinel object itself is never serialised.
    const ownBlocks = (result.data as Record<string, unknown> | null | undefined)
      ?.[MCP_CONTENT_KEY];
    if (Array.isArray(ownBlocks)) {
      return { content: [...blocks, ...(ownBlocks as McpBlock[])] };
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

// ONE list of run statuses, derived from the tool's own export so the two cannot
// drift. A hand-written copy of this enum lived here and was not updated when
// "running" was added, so the MCP layer rejected a valid status before the
// handler ever ran (spec 11.14).
//
// Defined HERE, above every use. `const` is not hoisted: declared after
// createMcpServer() it is still in the temporal dead zone when that function
// runs, which throws ReferenceError at first dispatch - a module that boots
// cleanly and dies on the first request.
const RUN_STATUS = z.enum(VALID_RUN_STATUS as [string, ...string[]]);

// Same argument as RUN_STATUS: derived from the tool module's own exports, which
// are themselves written to mirror the CHECK constraints, so the MCP layer can
// never reject a value the database accepts. Declared here, above every use —
// `const` is not hoisted.
const JOB_STATUS = z.enum(VALID_JOB_STATUS as [string, ...string[]]);
const JOB_FIT = z.enum(VALID_JOB_FIT as [string, ...string[]]);
const JOB_EFFORT = z.enum(VALID_JOB_EFFORT as [string, ...string[]]);

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
// Exported so index.test.mjs can EXECUTE the registration body. Nothing in
// production imports this module, so without the export the only thing that
// ever ran this code was a live request - which is how a ReferenceError in
// it reached production behind 125 green tests (spec 11.15).
export function createMcpServer(token: string) {
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
        "Get pending inbox items that haven't been triaged yet. The inbox is a universal capture bucket where thoughts, emails, and tasks land before being organized into contexts. Results are capped (default 20, max 50) — the response NOTE tells you when there's more. " +
        "Archived items are never returned; use get_recent_clips with include_archived to look at handled clips.",
      inputSchema: {
        ai_status: z
          .string()
          .optional()
          .describe(
            "Filter by AI enrichment status: 'not_started' (nothing has enriched it), 'in_progress' (ai-enrich is running), 'enriched' (first pass, Sonnet), or 're_enriched' (second pass, Opus).",
          ),
        source_type: z
          .string()
          .optional()
          .describe(
            "Filter by how the capture arrived: 'manual' (typed into the Alfred app), 'email' (forwarded to the capture address), 'mcp' (created by Claude with create_inbox_item), 'clipboard' (a page clipped by the Chrome extension), or 'cli' (a report pushed by the Claude CLI). For clipboard and cli items, get_recent_clips is the better tool — it returns the actual page text and links, which the inbox row does not carry.",
          ),
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
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array. Each element: {type: 'header'|'bullet'|'step', text: '...', collectable?: true, offsetMinutes?: number}. For recipes use an 'Ingredients' header with one collectable bullet per ingredient, then a 'Steps' header with step elements. Steps may carry offsetMinutes (a whole number of MINUTES to wait BEFORE that step, measured from when the PREVIOUS step is ticked off) — it turns the step into a timed push notification. Emit it in camelCase as offsetMinutes, never the snake_case offset_minutes. ONLY on 'step' elements, never a header or bullet. DEFAULT TO OMITTING IT: only when the captured text explicitly states a wait ('marinate 30 minutes' -> 30, 'every 6 hours' -> 360). Never infer one from steps merely being sequential, from a total time, or from a step that obviously takes a while but states no wait. If unsure, omit."),
        suggested_item_id: z.string().optional().describe("ID of an EXISTING item to link to (use search_items to find it). Use this when referencing a known item like 'make chicken tikka tonight'"),
        suggest_intent: z.boolean().optional().describe("Should this become an Intention/task? (true for action items, to-dos)"),
        suggested_intent_text: z.string().optional().describe("Suggested text for the intention (what the user intends to do)"),
        suggested_intent_recurrence: z.string().optional().describe("Recurrence pattern: 'once', 'daily', 'weekly', 'monthly', 'yearly'"),
        suggest_event: z.boolean().optional().describe("Is there a specific date associated? (true if user mentions a date/time)"),
        suggested_event_date: z.string().optional().describe("Suggested date in YYYY-MM-DD format. Resolve relative dates like 'tomorrow', 'next Tuesday' to absolute dates."),
        suggested_tags: z.array(z.string()).optional().describe("Suggested tags — use get_tags first to match existing taxonomy. Lowercase, spaces between words, no punctuation (e.g. \"whole foods\"). Normalised on save."),
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
        suggested_item_elements: z.array(z.unknown()).optional().describe("Structured elements array. Each element: {type: 'header'|'bullet'|'step', text: '...', collectable?: true, offsetMinutes?: number}. Recipes: an 'Ingredients' header, one collectable bullet per ingredient, then a 'Steps' header with step elements. One purchasable product per ingredient bullet — split 'salt and pepper' into two. Steps may carry offsetMinutes (a whole number of MINUTES to wait BEFORE that step, measured from when the PREVIOUS step is ticked off) — it turns the step into a timed push notification. Emit it in camelCase as offsetMinutes, never the snake_case offset_minutes. ONLY on 'step' elements, never a header or bullet. DEFAULT TO OMITTING IT: only when the captured text explicitly states a wait ('marinate 30 minutes' -> 30, 'every 6 hours' -> 360). Never infer one from steps merely being sequential, from a total time, or from a step that obviously takes a while but states no wait. If unsure, omit."),
        suggested_item_id: z.string().optional().describe("ID of an EXISTING item to link to (use search_items to find it)"),
        suggest_intent: z.boolean().optional().describe("Should this become an Intention/task?"),
        suggested_intent_text: z.string().optional().describe("Text for the intention (what the user intends to do)"),
        suggested_intent_recurrence: z.enum(["once", "daily", "weekly", "monthly", "yearly"]).optional().describe("Recurrence pattern"),
        suggest_event: z.boolean().optional().describe("Is there a specific date associated?"),
        suggested_event_date: z.string().optional().describe("Date in YYYY-MM-DD format"),
        suggested_tags: z.array(z.string()).optional().describe("Suggested tags: lowercase, spaces between words, no punctuation (e.g. \"whole foods\"). Normalised on save. Use get_tags to match existing taxonomy."),
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
        "Get songs in the SAM music practice app. Returns song metadata (title, artist, key, default_bpm, and the goal tempo). Use search_text to find specific songs. Does not return measure data — use get_database_schema for full details if needed. TEMPO FIELDS: default_bpm is the tempo the song loads at and drifts whenever practice tempo is saved — it is NOT the target. goal_bpm is the goal in tempo-box units (quarter notes per minute) and goal_playback_speed its paired speed percent; goal_effective_bpm = round(goal_bpm * goal_playback_speed / 100) is the goal tempo actually heard, directly comparable with sam_passes.effective_bpm. goal_set_at is when the goal was confirmed; NULL means the goal is a placeholder. " + SAM_DATA_RULES,
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
        "Get practice sessions from the SAM music app. Sessions record when the user started and ended practicing a song or snippet plus a performance summary; elapsed time is derived from started_at and ended_at (there is no stored duration column). A session with ended_at NULL was abandoned mid-way and should not be counted toward practice totals. Returns most recent sessions first. Use date_from/date_to to filter by time period. Includes song and snippet titles in results. plan_id / plan_item_id record the practice plan active when the session began and the item matching its range (null before plans existed); they are history only — plan progress comes from get_sam_plan_progress. The `summary` carries accuracyPercent and avgTimingDeltaMs, and `settings.windowMs` is the matching window they were scored at. " + SAM_SCORING_RULES + " " + SAM_DATA_RULES,
      inputSchema: {
        song_id: z.string().optional().describe("Filter by song ID"),
        snippet_id: z.string().optional().describe("Filter by snippet ID"),
        date_from: z
          .string()
          .optional()
          .describe("Start date filter (ISO 8601 format, e.g. 2025-01-01)"),
        date_to: z.string().optional().describe("End date filter (ISO 8601 format)"),
        plan_id: z.string().optional().describe("Only sessions recorded while this practice plan was active"),
        plan_item_id: z.string().optional().describe("Only sessions recorded against this plan item"),
        limit: z.number().optional().describe("Max results to return (default 20)"),
      },
    },
    async (args) => runToolForMcp(getSamSessionsTool, args, token),
  );

  server.registerTool(
    "get_sam_passes",
    {
      title: "Get SAM Passes",
      description:
        "Get completed playthroughs (passes) from the SAM music app. One row per complete playthrough of whatever range was loaded: snippet_id null means the whole song, otherwise that snippet. `bpm` is the score tempo at the instant the pass FINISHED; `effective_bpm` is what was actually heard (bpm scaled by playback_speed), so 60 at 80% reads 48. A NULL playback_speed means NOT RECORDED rather than 100: that column began recording when it was DEPLOYED, part-way through 2026-09-16, so passes from that day exist both with and without a value. effective_bpm is NULL wherever the speed is. `hits`, `misses` and `notes_played` record how the playthrough went, and `hand_mode` which hand was scored. IMPORTANT: `notes_played` 0 means nothing was played — a playback test — because a miss is raised on elapsed time without consulting MIDI, so a pass with no keyboard scores 0 hits and a full count of misses and is otherwise identical to playing badly. Use exclude_zero_note to drop test data rather than inferring it. `accuracy_percent` is NULL when unmeasurable and 0 when measured-and-all-wrong; never treat NULL as 0. NOTE ON THE FILTERS: notes_played has THREE states — a positive count (played), 0 (a playback test, nothing arrived), and NULL (never recorded). exclude_zero_note and only_zero_note are therefore NOT opposites and do NOT partition the result: rows with a NULL note count are returned by NEITHER, so the two filters together can account for a small fraction of the table. Call with no filter to see everything. A NULL does not mean the pass is from before 2026-09-16: notes_played began recording when it was DEPLOYED, part-way through that day, so passes from 2026-09-16 exist on both sides of the change and completed_at cannot be used to infer what a NULL should have been. The columns were deployed at different moments, so a pass can legitimately carry a playback_speed and still have no note count. Nothing writes a pass without a note count today — a NULL always means the row predates the column. Use this to check practice instructions of the form 'at 60, four to six passes'. Returns most recent passes first, with song and range titles. plan_id / plan_item_id record the practice plan active when the pass was recorded and the item matching its range; they are history only and are never rewritten — plan progress matches passes on song and snippet (get_sam_plan_progress), so a pass can count toward a plan it was not recorded under. " + SAM_SCORING_RULES + " " + SAM_DATA_RULES,
      inputSchema: {
        song_id: z.string().optional().describe("Filter by song ID"),
        snippet_id: z.string().optional().describe("Filter by snippet ID"),
        whole_song_only: z
          .boolean()
          .optional()
          .describe("Only whole-song passes (rows where snippet_id is null)"),
        exclude_zero_note: z
          .boolean()
          .optional()
          .describe(
            "Return ONLY passes known to have been played (notes_played > 0). This is the filter for dropping playback tests. It ALSO drops every pass whose note count was never recorded (notes_played NULL), because unrecorded is not the same as zero — so it can drop far more rows than there are playback tests. It is NOT the complement of only_zero_note: rows with a NULL note count are returned by NEITHER filter.",
          ),
        only_zero_note: z
          .boolean()
          .optional()
          .describe(
            "Return ONLY passes where notes_played is exactly 0 — playthroughs during which no MIDI note arrived. This is NOT the complement of exclude_zero_note, and NOT a way to audit what that filter drops: exclude_zero_note also drops every pass whose note count was never recorded (notes_played NULL), and those rows are returned by NEITHER filter. The two filters together can account for a small fraction of the table.",
          ),
        date_from: z.string().optional().describe("Start date filter (ISO 8601 format)"),
        date_to: z.string().optional().describe("End date filter (ISO 8601 format)"),
        plan_id: z.string().optional().describe("Only passes recorded while this practice plan was active"),
        plan_item_id: z.string().optional().describe("Only passes recorded against this plan item (history; progress does not use it)"),
        limit: z.number().optional().describe("Max results to return (default 20)"),
      },
    },
    async (args) => runToolForMcp(getSamPassesTool, args, token),
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
        "Read measures for a SAM song, with optional range filter. Returns measure notation (RH/LH events), metadata, any placed lyrics, and any placed RH fingerings (each with note_index, finger 1-5, and source 'manual'|'musicxml'). The `song` block carries `bpm` (default_bpm: the load tempo, not a target) and the goal tempo: goal_bpm, goal_playback_speed, goal_effective_bpm (the goal tempo actually heard) and goal_set_at (null = placeholder goal). " + SAM_DATA_RULES,
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        start_measure: z.number().optional().describe("First measure number to return (inclusive)"),
        end_measure: z.number().optional().describe("Last measure number to return (inclusive)"),
      },
    },
    async (args) => runToolForMcp(getSamSongMeasuresTool, args, token),
  );

  server.registerTool(
    "get_sam_song_scores",
    {
      title: "Get SAM Song Scores",
      description:
        "Per-measure difficulty scores for one SAM song at a tempo, plus a rollup (median, p90 and max per metric) and the flagged measures. The same analysis as the sam-tools CLI. " +
        "⚠️ THIS get_* TOOL WRITES. Before reading, it brings the song's stored scores up to date: when the notation changed since they were computed, it recomputes and replaces the song's sam_song_scores rows. Those rows are derived data (the table's comment says they are safe to delete and recompute) and the table is NOT audited, so the refresh leaves no audit trail. This breaks the get_ = read-only naming convention on purpose, so that stale scores are never returned. `scores.status` reports what happened: fresh (nothing written), recomputed, no-measures or cleared. " +
        "TEMPO: `bpm` (quarter notes per minute) if given, otherwise the song's goal tempo (goal_effective_bpm); `tempo.source` says which (argument | goal). It never falls back to default_bpm, the load tempo. notes_per_second, the per-beat rates and the flags depend on the tempo; the other metrics do not. " +
        "RANGE AND LIMIT: by default the whole requested range is analyzed, up to 200 measures (the longest song is 160). The limit is high because a truncated list says it is partial; a rollup over a fragment does not. If `limit` or the cap cuts the range, the response says so: a leading NOTE line, `range.truncated: true`, `range.measures_in_range` (the total), `range.analyzed` names the measures actually covered, `rollup.covers` says the rollup describes only those, and `range.note` gives the start_measure for the next call. " +
        "FLAGGED_ONLY: lists only the flagged measures in `rows`. The rollup still covers EVERY analyzed measure, not just the rows shown. `rows.filter` and `rows.note` label this. " +
        "Rows are lean: measure, notes_per_second, rh/lh_notes_per_beat, rh/lh_stack, rh/lh_stretch, rh/lh_jump, rhythm_variety, accidentals (null when the key is unknown), flags. Tier 1.",
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        start_measure: z.number().optional().describe("First measure number to analyze (inclusive). Omit to start at the beginning."),
        end_measure: z.number().optional().describe("Last measure number to analyze (inclusive). Omit to run to the end."),
        bpm: z.number().optional().describe("Tempo in quarter notes per minute. Omit to use the song's goal tempo (goal_effective_bpm). tempo.source says which was used."),
        limit: z.number().optional().describe("Max measures to analyze. Default: the whole requested range. Cap 200. A cut range is reported as truncated, and the rollup then covers only the analyzed measures."),
        flagged_only: z.boolean().optional().describe("Return only flagged measures in `rows`. The rollup still covers every analyzed measure. Default false."),
      },
    },
    async (args) => runToolForMcp(getSamSongScoresTool, args, token),
  );

  // ---- SAM practice plans and goals (practice plans spec §6) ----------------

  server.registerTool(
    "get_sam_practice_plan",
    {
      title: "Get SAM Practice Plan",
      description:
        "Read one practice plan in full — Claude's view, including internal_notes and review_instructions. Defaults to the ACTIVE plan; with no active plan it returns { plan: null } (not an error). Returns `plan` (every column: status, starts_on, ended_at, supersedes_plan_id, day_note, internal_notes, review_instructions, review_note, review_noted_at, timestamps), `songs` in position order (song_title, song_note, internal_notes, has_audio, default_bpm, goal_effective_bpm, goal_set_at) and `items` in checklist order (every item column plus song_title, snippet_title, start_measure, end_measure, hand_mode; a null snippet_id is \"Whole song\" with null range fields). Plans are never edited: a change is a new plan via create_sam_practice_plan. Tier 1. " + SAM_DATA_RULES,
      inputSchema: {
        plan_id: z.string().optional().describe("UUID of the plan. Omit for the active plan."),
      },
    },
    async (args) => runToolForMcp(getSamPracticePlanTool, args, token),
  );

  server.registerTool(
    "get_sam_practice_plans",
    {
      title: "Get SAM Practice Plans",
      description:
        "Plan history, newest first: plan headers (every plan column) without items. With song_id, only plans that contain that song, each with `song` (that song's plan-song row: song_note, internal_notes, position) and `items` (that song's items in the plan, with snippet title and measure range) — use this to answer how a song has gone across plans, together with get_sam_plan_progress per plan. Tier 1. " + SAM_DATA_RULES,
      inputSchema: {
        status: z.enum(["active", "superseded"]).optional().describe("Filter by plan status"),
        song_id: z.string().optional().describe("Only plans containing this song; attaches that song's notes and items"),
        limit: z.number().optional().describe("Max plans to return (default 20, max 50)"),
      },
    },
    async (args) => runToolForMcp(getSamPracticePlansTool, args, token),
  );

  server.registerTool(
    "get_sam_plan_progress",
    {
      title: "Get SAM Plan Progress",
      description:
        "Progress on a practice plan, computed by the database exactly as the app's checklist computes it. `items`: one row per plan item per Pacific day with at least one attempt — attempts, qualifying, best_accuracy, best_effective_bpm, last_completed_at — joined to the item's position, song_title, snippet_title and targets. An ATTEMPT is a pass on the item's exact song and snippet (null = whole song) with notes_played > 0; it QUALIFIES when effective_bpm >= target_effective_bpm and, unless Free Play, accuracy_percent >= accuracy_target. Matching ignores the plan_item_id stored on passes, so passes played under an earlier plan count if they fit. An item with no row for a day had no attempts that day (a skip — never a reason for concern on its own). `unplanned`: attempts per song, snippet and day that match no item in the plan (improvised practice). `range`: the dates actually read. Defaults: date_from = the plan's starts_on; date_to = today (Pacific) for an active plan, or the Pacific date it ended for a superseded one. At most 31 days: a longer range keeps the LATEST 31 and `range.capped` / `range.note` say so. Defaults to the active plan; no active plan returns { plan: null }. Tier 1. " + SAM_SCORING_RULES + " " + SAM_DATA_RULES,
      inputSchema: {
        plan_id: z.string().optional().describe("UUID of the plan. Omit for the active plan."),
        date_from: z.string().optional().describe("Pacific date YYYY-MM-DD. Default: the plan's starts_on."),
        date_to: z.string().optional().describe("Pacific date YYYY-MM-DD. Default: today (active plan) or the day the plan ended."),
      },
    },
    async (args) => runToolForMcp(getSamPlanProgressTool, args, token),
  );

  server.registerTool(
    "get_sam_goals",
    {
      title: "Get SAM Goals",
      description:
        "The learning goals list: songs to learn, techniques and chord progressions, each with a status (someday | active | done | dropped), optional song link (with song_title), notes and completed_at. Newest-updated first. Tier 1. " + SAM_DATA_RULES,
      inputSchema: {
        status: z.enum(["someday", "active", "done", "dropped"]).optional().describe("Filter by status"),
        kind: z.enum(["song", "technique", "progression"]).optional().describe("Filter by kind"),
        song_id: z.string().optional().describe("Only goals linked to this song"),
        limit: z.number().optional().describe("Max goals to return (default 50, max 50)"),
      },
    },
    async (args) => runToolForMcp(getSamGoalsTool, args, token),
  );

  server.registerTool(
    "create_sam_practice_plan",
    {
      title: "Create SAM Practice Plan",
      description:
        "Create a new practice plan in ONE call. Call ONLY after Alex has explicitly said yes to the plan in conversation. The new plan is active immediately and SUPERSEDES the current active plan (which stays readable in history). Plans are never edited; any change is a new plan. " +
        "Tier 3: the first call (without confirmed) writes nothing and returns a readable `proposal` (day note, review instructions, each song with its song note, each item with snippet and measure range, target heard tempo, passes, accuracy or Free Play, instruction, and which plan it supersedes) — show it to Alex, and call again with `confirmed: true` only after he approves. The whole plan is validated before the proposal and again by the database on confirm; any failure rejects the whole plan, and database refusals arrive as `validation error:` with the database's own message. On success returns the new plan as get_sam_practice_plan does. " +
        "RULES: every song and snippet must exist and not be archived, and each snippet must belong to its song. A song may appear once; put all its items under it. Items are checklist-ordered by array order; at most 20 items. Non-free-play items need target_bpm and accuracy_target (1-100). Free Play items must not have accuracy_target; their tempo defaults to the song's goal pair when omitted. TEMPO (§4): for a song WITH audio, target_bpm must equal the song's default_bpm and the target is expressed through target_playback_speed; for a song WITHOUT audio, target_playback_speed is 100 (or omitted) and target_bpm is the target. A pass counts only at or above the heard target tempo AND (unless Free Play) at or above the accuracy target. Use played measure numbers in all text. day_note and song_note are shown to Alex in the app; internal_notes and review_instructions are Claude-only. review_instructions tell the daily review job, in plain language, when to post a review note. " + SAM_DATA_RULES,
      inputSchema: {
        day_note: z.string().optional().describe("VISIBLE on the Sam tab: the day's goal in one short line."),
        internal_notes: z.string().optional().describe("Claude only: reasoning behind the plan."),
        review_instructions: z.string().describe("Required. Claude only: when the daily review job should post a review note."),
        songs: z
          .array(
            z.object({
              song_id: z.string().describe("UUID of the song"),
              song_note: z.string().optional().describe("VISIBLE in the player: the song goal, played measure numbers."),
              internal_notes: z.string().optional().describe("Claude only."),
              items: z
                .array(
                  z.object({
                    snippet_id: z.string().optional().describe("UUID of a snippet of this song. Omit for the whole song."),
                    is_free_play: z.boolean().optional().describe("Optional Free Play item: tempo target, no accuracy target. Default false."),
                    target_bpm: z.number().optional().describe("Tempo-box BPM. Required unless Free Play. Songs with audio: must equal default_bpm."),
                    target_playback_speed: z.number().optional().describe("Speed percent, default 100. Songs without audio: must be 100."),
                    target_passes: z.number().describe("Qualifying passes needed today."),
                    accuracy_target: z.number().optional().describe("1-100. Required unless Free Play; forbidden for Free Play."),
                    instruction: z.string().optional().describe("VISIBLE: one short line, e.g. 'Count out loud.'"),
                  }),
                )
                .optional()
                .describe("Checklist items for this song, in order. May be empty (song note only)."),
            }),
          )
          .describe("Songs in plan order, each with its items."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Tier-3 gate. Omit on the first call to get the proposal; set to true only after Alex approves it."),
      },
    },
    async (args) => runToolForMcp(createSamPracticePlanTool, args, token),
  );

  server.registerTool(
    "update_sam_plan_review_note",
    {
      title: "Update SAM Plan Review Note",
      description:
        "Write the review note on the ACTIVE practice plan, once, when its review_instructions are met — the signal that a plan conversation is due. Refuses a superseded plan. NEVER overwrites: if the plan already has a review note, nothing is written and the result is { already_noted: true, review_note, review_noted_at } with the existing note. Otherwise returns { already_noted: false, plan_id, review_note, review_noted_at }. Skipped items alone are never a reason for a note. Tier 2. " + SAM_DATA_RULES,
      inputSchema: {
        plan_id: z.string().describe("UUID of the active plan"),
        review_note: z.string().describe("The note: what was observed and why a new plan is due. Non-empty."),
      },
    },
    async (args) => runToolForMcp(updateSamPlanReviewNoteTool, args, token),
  );

  server.registerTool(
    "update_sam_song_goal",
    {
      title: "Update SAM Song Goal",
      description:
        "Set or confirm a song's goal tempo, always with Alex's agreement. Pass song_id plus EXACTLY ONE of: goal_bpm (songs WITHOUT audio only; speed is set to 100), goal_playback_speed (songs WITH audio only; goal_bpm is held at the song's default_bpm, the scroll-sync calibration), or confirm_only: true (mark the current goal as a real target, applying the same rule). The wrong field for the song's audio state is a validation error that says which field to use. Every write sets goal_set_at = now, which is what makes a goal confirmed; a goal with null goal_set_at is a placeholder. Tier 3: the first call (without confirmed) writes nothing and returns a `proposal` with the song title, current heard goal and whether it is a placeholder, and the new heard goal. Returns the updated song goal fields. " + SAM_DATA_RULES,
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        goal_bpm: z.number().optional().describe("New goal BPM. Songs without audio only."),
        goal_playback_speed: z.number().optional().describe("New goal speed percent. Songs with audio only."),
        confirm_only: z.boolean().optional().describe("true = confirm the current goal as a real target without changing it (beyond applying the audio rule)."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Tier-3 gate. Omit on the first call to get the proposal; set to true only after Alex approves it."),
      },
    },
    async (args) => runToolForMcp(updateSamSongGoalTool, args, token),
  );

  server.registerTool(
    "create_sam_goal",
    {
      title: "Create SAM Goal",
      description:
        "Add a learning goal: a song to learn, a technique, or a chord progression. Status defaults to someday; done sets completed_at. Returns the goal with song_title. Tier 1. " + SAM_DATA_RULES,
      inputSchema: {
        title: z.string().describe("e.g. 'Play Someone Like You start to finish'"),
        kind: z.enum(["song", "technique", "progression"]).describe("What kind of goal"),
        status: z.enum(["someday", "active", "done", "dropped"]).optional().describe("Default someday"),
        song_id: z.string().optional().describe("UUID of the song this goal is about"),
        notes: z.string().optional().describe("Free text"),
      },
    },
    async (args) => runToolForMcp(createSamGoalTool, args, token),
  );

  server.registerTool(
    "update_sam_goal",
    {
      title: "Update SAM Goal",
      description:
        "Change a learning goal: goal_id plus at least one of title, status, song_id (null unlinks), notes. Changing status to done sets completed_at; changing it away from done clears completed_at. There is no delete — use status dropped. Returns the goal with song_title. Tier 2. " + SAM_DATA_RULES,
      inputSchema: {
        goal_id: z.string().describe("UUID of the goal"),
        title: z.string().optional().describe("New title"),
        status: z.enum(["someday", "active", "done", "dropped"]).optional().describe("New status"),
        song_id: z.string().nullable().optional().describe("UUID of the song to link, or null to unlink"),
        notes: z.string().optional().describe("New notes (replaces the old)"),
      },
    },
    async (args) => runToolForMcp(updateSamGoalTool, args, token),
  );

  server.registerTool(
    "create_sam_snippet",
    {
      title: "Create SAM Snippet",
      description:
        "Find or create the SAM snippet for a measure range of one song, exactly as the app's Save New does, and return it. The returned `id` is the `snippet_id` to use in create_sam_practice_plan. " +
        "INTENDED FLOW: Alex approves a plan in conversation; Claude creates any snippets the plan needs with this tool; then Claude calls create_sam_practice_plan with their ids. " +
        "SAFE TO REPEAT, NEVER DUPLICATES: a snippet is its song + start_measure + end_measure + rest_measures + hand_mode. If a live snippet already matches, it is returned unchanged (created: false, restored: false); if only an archived one matches, it is restored with its original id and history (restored: true); only otherwise is a new one inserted (created: true). " +
        "MEASURE NUMBERS ARE PLAYED NUMBERS (repeats written out) — the numbers get_sam_song_measures and the score use; end_measure may not pass the song's last measure. " +
        "A new snippet gets the app's standard title (e.g. 'Measures 17-17 RH No Rest') and stores only its hand mode: tempo, timing window and chord grouping always come from the song's own defaults. " +
        "Refuses an archived or missing song, or a song with no measures. Tier 1. " + SAM_DATA_RULES,
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        start_measure: z.number().describe("First measure (played number), 1 or more"),
        end_measure: z.number().describe("Last measure (played number), not before start_measure and not past the song's last measure"),
        hand_mode: z.enum(["both", "lh", "rh"]).optional().describe("Which hand is scored. Default 'both'."),
        rest_measures: z.number().optional().describe("Silent measures between loop repetitions, 0 or more. Default 0."),
      },
    },
    async (args) => runToolForMcp(createSamSnippetTool, args, token),
  );

  server.registerTool(
    "get_sam_measure_stats",
    {
      title: "Get SAM Measure Stats",
      description:
        "Per-measure practice telemetry for one song: which measures are missed, whether they are played early or late, and what is being hit instead. Reads sam_session_events (one row per beat per attempt). " +
        "PER MEASURE: attempts (scored beats), TWO HIT RATES (below), counts of hit/miss/partial/extra, mean and median timing offset split into ENTRY and MID-PHRASE (below), how many sessions, Pacific days and LOOP ITERATIONS contributed (so heavy drilling on one bar is visible rather than silently dominating), and recurring wrong notes. Measure numbers are PLAYED numbers with the printed number (sam_song_measures.source_measure) alongside, since repeats make them differ. " +
        "⚠️ THREE HIT RATES, THREE DIFFERENT QUESTIONS, NEVER INTERCHANGEABLE. `hit_rate_all` = \"how did it go overall\", counting every loop iteration. `hit_rate_attempted` = \"how did it go when he played\", excluding `sat_out_iterations` — cycles where EVERY beat of the measure was a miss with nothing struck at all, which is what a loop left running while he resets his hands records. `hit_rate_settled` = \"IS THIS BAR HARD\", excluding the FIRST ATTEMPT OF EACH SITTING as well: a cold first run dominates the pooled average on a short snippet, which is why m26 read 78% off passes that actually ran 29, 94, 94, 100, 100, 100, 100. All three are true. weakest_measures ranks on hit_rate_settled where there are enough settled beats and on hit_rate_attempted otherwise, and every row says which under `ranked_on`. Never quote hit_rate_all without sat_out_iterations beside it. " +
        "WRONG NOTES come from `extra` rows (a keystroke that matched no beat) and from the pitches carried on `miss` rows (a wrong attempt AT a beat), counting ONLY pitches the beat did NOT expect — a failing chord records every key struck, the correct ones included, and those are the part he got right. THE UNIT IS THE PASS AND THE SITTING: each pitch carries `passes` (distinct session plus loop iteration), `sessions` and `days`, counted once per pitch per pass, so hammering one key is one occurrence and one fumble is never counted twice. A pitch is HEADLINED in recurring_wrong_notes only when it appears in at least 3 distinct passes AND at least 2 distinct SITTINGS — several passes can be one minute of drilling, so separate sittings are what make it a pattern rather than one bad run. Everything below that bar stays visible in each measure's `all_wrong_notes` with its raw counts. " +
        "TIED-OVER NOTES ARE NOT MISTAKES: a note tied into a bar is sounding but never struck, so the score never asks him to play it. Playing a snippet that begins mid-phrase he strikes those notes to place his hand — Autumn Leaves m15 listed D3 and F#3 in about 50 passes each on exactly this. Pitches tied into a bar (tie \"end\" OR \"both\", judged PER NOTE so a chord holding a tied note under a freshly struck one works) now count as expected: they are neither wrong notes nor extras, and are reported separately as `tied_in_strikes`. " +
        "⚠️ THE WRONG-NOTE LIST IS ONLY AS GOOD AS THESE RULES, and every pattern investigated so far has turned out to be a MEASUREMENT ARTEFACT rather than a real mistake. It depends on three fixes: (1) only pitches the beat did not expect are counted, so a failed chord no longer lists the notes he got right; (2) pitches tied into a bar are treated as expected; (3) the count is distinct passes AND distinct sittings, not rows. CHECK ANY PATTERN AGAINST THE SCORE before reporting it as a mistake. " +
        "ENTRY VERSUS MID-PHRASE TIMING: coming in after a rest or a loop restart is a different skill from playing inside a phrase, and the two run at very different offsets (live evidence: 120–225 ms late on entries, near zero mid-phrase), so mixing them corrupts both numbers. A beat is an ENTRY when it is the first struck beat of a pass or its previous struck beat sat two or more measures back. `most_late` and `most_early` rank on MID-PHRASE beats alone, because ranked on everything they simply find the bars he enters on. `most_early` is EMPTY when no measure had a positive mean offset, rather than showing the least late one. " +
        "MEASUREMENT FLOOR: offsets are quantised by the animation frame that reads the clock, about 17 ms at 60 Hz, so an interval spread or a difference between measures under roughly 20 ms is measurement noise and must not be reported as a finding. " +
        "⚠️ TIMING: MEAN OFFSET IS CALIBRATION PLUS ERROR — MIDI and audio latency, where the eye aims against the scrolling line, and genuine rushing, all added together. A constant offset shifts every note equally, so a large mean offset is NOT evidence of bad playing on its own. What isolates the error is `interval_ratio` (the gaps between struck notes against the gaps the score asks for: below 1 = genuinely faster than the tempo, above 1 = slower, and a constant offset cancels out) and `drift` (offset last third minus first third of a pass, which a constant offset cannot produce). Intervals are taken only between beats that were both struck, adjacent in the sequence — a miss breaks the chain — and inside one measure and one loop iteration, so no barline, repeat or time signature enters the arithmetic; sessions whose tempo moved mid-sitting are excluded and counted under `timing.skipped`. " +
        "SCOPE: sessions with no MIDI and zero-note sessions are excluded; `extra` rows never count toward attempts or hit rate; a snippet or measure-range filter also drops rows outside that range — because the rest measures a loop appends can take numbers belonging to real measures — and reports how many under `range.rows_outside_range`. The most recent 30 eligible sessions are read. " +
        "The session windows are reported, and the result says plainly when they differ — accuracy is not comparable across different matching windows. Tier 1, read-only. " + SAM_SCORING_RULES,
      inputSchema: {
        song_id: z.string().describe("UUID of the song"),
        start_measure: z.number().optional().describe("First measure (played number) to include"),
        end_measure: z.number().optional().describe("Last measure (played number) to include"),
        snippet_id: z.string().optional().describe("Only sessions practising this snippet, and only rows inside its measure range"),
        date_from: z.string().optional().describe("Pacific date YYYY-MM-DD, inclusive"),
        date_to: z.string().optional().describe("Pacific date YYYY-MM-DD, inclusive"),
        limit: z.number().optional().describe("Max measures returned (default 20, cap 50)"),
      },
    },
    async (args) => runToolForMcp(getSamMeasureStatsTool, args, token),
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
        "Create an empty SAM song row (no notation). Use this before append_sam_measures to lay down a song shell — title, artist, key, time signature, default BPM, goal tempo, and lineage (song_type, parent_song_id, difficulty_tier, generation_notes). GOAL TEMPO: pass goalBpm (and optionally goalPlaybackSpeed) only when a goal is actually known. When goalBpm is omitted, a simplified song inherits its parent's goal pair, and any other song gets goal_bpm = its default BPM (set by the database). This tool does NOT write any measures; call append_sam_measures afterward, and it cannot edit an existing song's goal. Tier 3 — requires `confirmed: true` in args to actually write.",
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
        goalBpm: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Goal tempo in tempo-box units (quarter notes per minute). Separate from defaultBpm, which is only the load tempo. Omit unless a goal is actually known: a simplified song then inherits its parent's goal, anything else gets its default BPM."
          ),
        goalPlaybackSpeed: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Playback speed percent paired with goalBpm (100 = full speed). Only used when goalBpm is given; defaults to 100."
          ),
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
        app: z.enum(["dj", "sam", "alfred", "workshop", "ken"]).describe("Which app this job belongs to."),
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
        app: z.enum(["dj", "sam", "alfred", "workshop", "ken"]).optional().describe("Filter to one app."),
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
        "Record a managed playlist and its membership: writes dj_playlists and dj_playlist_tracks in ONE call, resolving every video_id to a dj_tracks row server-side (creating tracks and canonical groupings as needed, via the same shared resolver record_dj_plays uses). Re-recording the same yt_playlist_id UPDATES it — that is how the yt_set_video_id cache gets refreshed, which any later move or remove depends on. A track may hold one row per ZONE, so the same song legitimately appears in both cram and body; twice in the same zone is rejected. Rendered YouTube order is every cram row by position, then every body row by position. " +
        "⚠️ OMITTING A FIELD AND PASSING IT AS NULL ARE DIFFERENT INSTRUCTIONS. Omit `concert_id` or `description` and the stored value is left ALONE; pass either explicitly as null to CLEAR it. Omit `tracks` (or send an empty array) and membership is left alone entirely — the response says `membership_mode: \"untouched\"` rather than reporting 0 rows written, because 'nothing to do' and 'nothing given' are different answers. " +
        "⚠️ MEMBERSHIP IS UPSERT-ONLY: NOTHING HERE EVER DELETES A ROW, so the recorded body can grow but never shrink. If a track was removed from the YouTube playlist, its row survives and the response reports it as `stale_rows` with a `stale_sample` — reported, never acted on, because silently dropping membership on a re-record is a destructive side effect and this is a tier-2 tool. Reconcile deliberately. Tier 2.",
      inputSchema: {
        yt_playlist_id: z.string().describe("YouTube's playlist id, from create_dj_playlist or get_dj_playlists."),
        name: z.string().describe("Playlist name."),
        kind: z.enum(["concert", "artist", "jazz", "discovery", "utility"]).describe("Only 'concert' has a setlist body and a cram block; the others are flat. `kind` decides how much of DJ applies: concert gets the weekly setlist diff and cram list; artist/jazz/discovery get engagement metrics and occasional proposals; utility gets metrics ONLY and is never proposed against — running, yoga, massage, sleep, party and soundtrack playlists. ⚠️ Do not file an activity playlist as 'discovery' to avoid picking: discovery is the category DJ uses to FIND NEW ARTISTS, and filling it with running playlists makes that signal wrong rather than weak."),
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
        "Create a concert row covering the whole pipeline from screening to attended. The artist is resolved BY NAME and created if unknown — dj_concerts.artist_id is NOT NULL with ON DELETE RESTRICT, so a concert cannot exist without one, and sequencing that is not the caller's problem. Leave ends_on null for a single night; fill it for a residency, where the run is starts_on..ends_on. " +
        "⚠️ A CONCERT ROW DOES NOT NEED A PLAYLIST, AND DOES NOT NEED A DATE. `starts_on` is optional: omit it for history whose date is lost, or for an undated 'screening' row, which is a standing watchlist entry — an act worth seeing whenever they tour. Only 'interested' and 'committed' require a date, because only those mean a specific show. Undated rows are inert for past/upcoming filters by construction, so they cannot land wrongly in either. Tier 2.",
      inputSchema: {
        artist_name: z.string().describe("Artist name. Matched exactly against dj_artists, created if absent."),
        artist_tags: z.array(z.string()).optional().describe("Only used when the artist is newly created. Era and genre descriptors for discovery, e.g. ['90s','alt-rock']."),
        starts_on: z.string().optional().describe("YYYY-MM-DD. First (or only) night. OPTIONAL: omit it for a show whose date is not known — either history whose date is lost, or an undated 'screening' row, which is a standing watchlist entry meaning an act worth seeing whenever they tour. ⚠️ NEVER pass an approximate date to fill the gap: once written, a guessed date is indistinguishable from a checked one, and undated rows are handled correctly everywhere by design."),
        ends_on: z.string().optional().describe("YYYY-MM-DD. Null for a single night; set for a residency."),
        status: z
          .enum(["screening", "interested", "committed", "attended", "missed", "rejected"])
          .describe("screening = deciding whether it is worth going — WITH a date that is a specific show, WITHOUT one it is a standing watchlist entry for an act worth seeing whenever they tour. interested = want to, not committed. committed = going. attended = went. missed = did NOT go but still want to see them. rejected = not for me. ⚠️ 'interested' and 'committed' both mean a SPECIFIC show and are REFUSED without `starts_on`; if you do not know the date, the accurate status is 'screening', not a guessed date."),
        tour_name: z.string().optional().describe("e.g. 'WEEZER: The Gathering'."),
        venue_id: z.string().optional().describe("UUID of an existing dj_venues row. There is no venue-creation tool yet — put the location in `notes` until there is."),
        notes: z.string().optional().describe("Free text about this show."),
      },
    },
    async (args) => runToolForMcp(createDjConcertTool, args, token),
  );

  server.registerTool(
    "get_dj_concerts",
    {
      title: "Get DJ Concerts",
      description:
        "Read concert rows — the pipeline from screening through to what happened. Three modes. `list` filters by status, artist, date range, or `undated: true`. `needs_status` returns shows whose date has PASSED while the status still says undecided (screening/interested/committed) — 'did you go?'. `undecided` returns UNDATED screening rows with their playlist engagement joined — 'still interested?'. " +
        "Each row carries `artist_name` joined in, `when` (past | upcoming | undated), `days_until`, and `decision_pending` so callers do not redo date maths. " +
        "🛑 THREE DIFFERENT QUESTIONS SHARE THE WORD 'screening' AND MERGING THEM IS THE DOCUMENTED FAILURE (§12.8). `needs_status`: the date passed, did you go. `undecided`: no date at all, a standing watchlist entry nobody ever ruled on — Oasis and Black Eyed Peas are the live cases, and neither appears in any other mode. `decision_pending: true`: a DATED screening row still AHEAD, which belongs in the upcoming-concerts section rather than the watchlist because it is a show he is probably going to. Smashing Pumpkins (2026-10-30, screening, 10 runs in 90 days) is that row, and the first weekly run got it wrong by reading it as a watchlist entry. " +
        "⚠️ `decision_pending` FIRES BEFORE THE DEADLINE AND `needs_status` ONLY AFTER IT. A screening row with a future date is answerable now and unanswerable later; without this field nothing raises it until the day it stops being a question. " +
        "⚠️ `undecided` APPLIES NO THRESHOLD, deliberately — the population is tiny and self-clearing (answering moves the row out of `screening`), so it is ordered by `quiet_for_days` rather than filtered by a cutoff nobody wrote down. " +
        "⚠️ `starts_on` MAY BE NULL, legitimately, in two shapes: a historical show whose date is lost, and an undated 'screening' row. Undated rows are neither past nor upcoming and are excluded from `needs_status` by construction — a watchlist entry is not a show you might have attended. Tier 1, read-only.",
      inputSchema: {
        mode: z.enum(["list", "needs_status", "undecided"]).optional().describe("Defaults to 'list'. 'needs_status' asks 'did you go?' about shows whose date has passed. 'undecided' asks 'still interested?' about undated screening rows, with playlist engagement joined."),
        status: z.union([z.string(), z.array(z.string())]).optional().describe("list: one status or several. screening | interested | committed | attended | missed | rejected."),
        artist_id: z.string().optional().describe("list: filter to one artist."),
        from_date: z.string().optional().describe("list: YYYY-MM-DD, inclusive, on starts_on."),
        to_date: z.string().optional().describe("list: YYYY-MM-DD, inclusive, on starts_on."),
        undated: z.boolean().optional().describe("list: return ONLY rows with no starts_on — the watchlist plus undated history."),
        reviewed_within_days: z.coerce.number().optional().describe("undecided: hide rows confirmed within this many days (default 90). ⚠️ NOT a threshold on interest — §14.17 records that filtering on went_quiet is what made Oasis invisible. This hides rows whose QUESTION HAS BEEN ANSWERED. A row with reviewed_on null has never been asked and always surfaces."),
        limit: z.coerce.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getDjConcertsTool, args, token),
  );

  server.registerTool(
    "update_dj_concert",
    {
      title: "Update DJ Concert",
      description:
        "Change an existing concert row: status, dates, tour name, notes, venue. " +
        "⚠️ THIS IS WHAT MAKES §12.8's SECTION 1 REAL. Until 2026-09-01 dj_concerts was write-once through MCP — every row was frozen at the status it was born with, so asking 'did you go?' had nowhere to put the answer. " +
        "Omitting a field leaves it alone; passing it as null clears it. Validity is judged on the RESULTING row, not the patch, because a status change and a date change can arrive in separate calls: 'interested' and 'committed' both mean a specific show and are refused without a `starts_on`. " +
        "⚠️ It will NOT create a row — a typo'd id that silently created a second concert is how a wrong date gets duplicated instead of corrected. " +
        "When a status becomes 'missed' the response carries `feedback_owed`: per the column comment, missed means did NOT go but STILL WANT to see them, and that want is a fact about the ARTIST, so it belongs in a dj_feedback row. This tool surfaces it rather than writing it — a second write smuggled into a status change is one nobody remembers happened. Tier 2.",
      inputSchema: {
        concert_id: z.string().describe("UUID of the concert to change. From get_dj_concerts."),
        status: z.enum(["screening", "interested", "committed", "attended", "missed", "rejected"]).optional().describe("screening = deciding, and undated it is a standing watchlist entry. interested = want to. committed = going. attended = went. missed = did NOT go but still want to see them. rejected = not for me."),
        reviewed: z.boolean().optional().describe("Stamp reviewed_on with today and change NOTHING else — how 'yes, still interested' is recorded for an undated screening row. It counts as a patch on its own, because confirming a watchlist entry is not a status change. The date is set server-side so a review cannot be back-dated to silence a row. After it, get_dj_concerts mode=undecided hides the row for 90 days."),
        starts_on: z.string().optional().describe("YYYY-MM-DD, or null to clear. Required by 'interested' and 'committed'."),
        ends_on: z.string().optional().describe("YYYY-MM-DD, or null. Set only for a residency."),
        tour_name: z.string().optional().describe("e.g. 'WEEZER: The Gathering'."),
        notes: z.string().optional().describe("Free text about this show. The place to put a venue until dj_venues has tools."),
        venue_id: z.string().optional().describe("UUID of an existing dj_venues row."),
      },
    },
    async (args) => runToolForMcp(updateDjConcertTool, args, token),
  );

  server.registerTool(
    "record_dj_feedback",
    {
      title: "Record DJ Feedback",
      description:
        "Append a stated preference about ONE subject — an artist, concert, album, track or venue. " +
        "⚠️ APPEND-ONLY: a changed opinion is a NEW row, never an edit. How Alex feels about something is the newest row, which is why dj_artists deliberately holds no stance column — there is exactly one place that truth lives. " +
        "`sentiment` is love | like | neutral | dislike | curious. 'curious' means WANTING MORE rather than having judged: it is the right one for an act missed live but still wanted, which is the case update_dj_concert flags as `feedback_owed` when a concert becomes 'missed'. " +
        "Exactly one subject id, and at least one of sentiment or note. Tier 1 — an append to an append-only log.",
      inputSchema: {
        artist_id: z.string().optional().describe("Subject: an artist. Exactly one subject."),
        concert_id: z.string().optional().describe("Subject: one night."),
        album_id: z.string().optional().describe("Subject: an album."),
        track_id: z.string().optional().describe("Subject: one track."),
        venue_id: z.string().optional().describe("Subject: a venue."),
        sentiment: z.enum(["love", "like", "neutral", "dislike", "curious"]).optional().describe("'curious' = wanting more rather than having judged."),
        note: z.string().optional().describe("Free text. Required if no sentiment."),
        occurred_on: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
        source: z.enum(["chat", "weekly_review", "manual", "import"]).optional().describe("Defaults to 'chat'."),
      },
    },
    async (args) => runToolForMcp(recordDjFeedbackTool, args, token),
  );

  server.registerTool(
    "get_dj_albums",
    {
      title: "Get DJ Albums",
      description:
        "Albums with 'how much of this have I heard' computed. The Jazz thread's memory: what has been suggested, accepted, heard, or declined. " +
        "🛑 COVERAGE IS A FRACTION, NEVER A BOOLEAN. Report `tracks_heard / tracks_playable`. Albums are 8-12 tracks and three may have been heard; '3 of 9' needs no caveat and 'unheard: false' needs a paragraph (spec 12.12). " +
        "⚠️ WHEN `tracks_total` EXCEEDS `tracks_playable`, SAY SO. The difference is region-blocked tracks that YouTube gives no videoId for — real tracks that can never match a play. Reporting '7 of 7' on an album whose total is 9 tells him it is finished when two were never checkable. `albums_partly_unmeasurable` counts these. " +
        "⚠️ COUNTS CANONICAL GROUPS, so a play of ANY upload counts: this measures the MUSIC, not the RECORD. It does NOT answer 'have I sat through this album as an album' and would answer that confidently and wrongly. " +
        "⚠️ `status` is QUEUE POSITION, not feeling (that is dj_feedback): proposed | queued | listening | known | dismissed. 'dismissed' means asked and answered NO and must never be proposed again. `suggested_on` is how a later session knows an album was already put forward — the canon lives in these rows, not in the model. Tier 1, read-only.",
      inputSchema: {
        status: z.enum(["proposed", "queued", "listening", "known", "dismissed"]).optional().describe("Filter by queue position. Omit for all."),
        tag: z.string().optional().describe("Filter to albums carrying this tag, e.g. 'canon' or 'latin-jazz'."),
        limit: z.coerce.number().optional().describe("Max albums (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getDjAlbumsTool, args, token),
  );

  server.registerTool(
    "record_dj_album",
    {
      title: "Record DJ Album",
      description:
        "Record an album and its track list — the Jazz thread's write. Upserts on `yt_album_id` where there is one. " +
        "🛑 THIS WRITE IS THE MEMORY AND IS NOT OPTIONAL. The canon is knowledge the MODEL holds, not something the listening history contains, so a later session can suggest the same album again unless this row exists. A session that suggests without recording has silently broken the thing. " +
        "⚠️ `status` is where the album sits in the QUEUE, never how Alex feels about it (that is record_dj_feedback): proposed | queued | listening | known | dismissed. RECORD A 'dismissed' WHEN HE SAYS NO — without it a declined album is indistinguishable from one never mentioned and comes back every week (spec 11.7). An album can legitimately be tags=['canon'] AND dismissed. " +
        "⚠️ PASS THE FULL TRACK LIST FROM get_dj_album, INCLUDING TRACKS WITH NO video_id. Those are region-blocked: real tracks that lengthen the record and can never match a play. They are stored, counted in `tracks_total` and excluded from `tracks_playable`, which is what keeps the coverage fraction honest — dropping them would make a short album look finished. " +
        "⚠️ Track ids resolve through the SAME shared resolver record_dj_plays uses, creating dj_tracks rows and canonical groupings, so a play of any upload counts toward hearing the album. Tier 2 — it updates existing rows.",
      inputSchema: {
        title: z.string().describe("Album title."),
        artist: z.string().optional().describe("Album artist as a DISPLAY STRING (joined, e.g. 'Miles Davis, John Coltrane'). NOT a foreign key — dj_artists holds mbid-keyed concert acts and jazz musicians do not belong in it (spec 14.1, 14.23)."),
        yt_album_id: z.string().optional().describe("YouTube browseId (MPREb_...), from get_dj_album/get_dj_library_albums. Omit for an album recorded from knowledge before it is resolved — several such rows may coexist."),
        release_year: z.coerce.number().optional().describe("Release year."),
        status: z.enum(["proposed", "queued", "listening", "known", "dismissed"]).optional().describe("🛑 OMIT IT unless the thread is actually SUGGESTING this album. Omitted, it is DERIVED from coverage after the track list is written: every playable track heard -> 'known', otherwise 'queued'. 'proposed' is NEVER derived, because it asserts that a conversation happened — a BOOKMARK was never proposed, it is Alex's own curation. Seeding bookmarks as 'proposed' would claim the thread asked about records it never mentioned, and it would then suggest him albums he already knows. `suggested_on` is stamped server-side when proposed, so a suggestion cannot be back-dated."),
        tags: z.array(z.string()).optional().describe("What KIND of album: 'canon', 'latin-jazz', 'hard-bop'. Category, not decision — the decision is `status`."),
        notes: z.string().optional().describe("Why it was suggested. Free text."),
        tracks: z.array(z.object({
          video_id: z.string().nullable().optional(),
          title: z.string().optional(),
          artist: z.string().nullable().optional(),
          duration_seconds: z.coerce.number().nullable().optional(),
          position: z.coerce.number().optional(),
        })).optional().describe("The full track list from get_dj_album, in order. INCLUDE tracks whose video_id is null."),
      },
    },
    async (args) => runToolForMcp(recordDjAlbumTool, args, token),
  );

  server.registerTool(
    "get_dj_artist_tags",
    {
      title: "Get DJ Artist Tags",
      description:
        "Review the artist tag list — the curated allowlist that Section 3 of the weekly item is built on. Filter by `tag`, `status` or `source`; omit all three to see everything. " +
        "🛑 THIS IS THE ONLY WAY TO SEE A REJECTION. `status: 'rejected'` means an artist was considered and DECLINED, kept on purpose so the weekly item stops proposing him (§11.7). Those rows exist for no reason other than to be read back, and until this tool they could not be — 'what did I already say no to?' had no answer outside the SQL editor. They sort first. " +
        "⚠️ IT IS A REVIEW SURFACE, NOT A LISTENING REPORT. It answers 'what is on the list and who put it there', never 'what am I playing' — that is get_dj_plays mode=artists. Keeping the two apart is why §14.19 happened once and not twice. " +
        "⚠️ `source: 'playlist'` rows are DERIVED (the artist is on a track in a playlist whose kind matches the tag — migration 013's artist arm, stored rather than recomputed) and can be re-derived safely. `source: 'manual'` rows are human judgements and nothing may overwrite them automatically. " +
        "⚠️ `artist` is the EXACT dj_tracks.artist string — a match key, not a display name, and NOT dj_artists (§14.1). " +
        "⚠️ COMPARE `returned` AGAINST `total`: the list is ordered and cut at the limit, so a short read drops the END of it rather than a sample. Tier 1, read-only.",
      inputSchema: {
        mode: z.enum(["list", "review"]).optional().describe("Defaults to 'list'. 🛑 'review' orders tags by HOW LITTLE EVIDENCE exists that the string names an act — distinct_tracks, distinct_playlists, play_rows, distinct_days — weakest first. It makes NO claim about which are real and inspects no text; it is an ordering for a human. Use it to find what the playlist seeds got wrong: they tagged 'Dec 29, 2023' and 'Cavendish Music' as jazz, both true as membership and false as claims about an act (spec 14.9)."),
        window_days: z.coerce.number().optional().describe("mode=review: play window for the evidence columns. Default 90."),
        tag: z.string().optional().describe("Filter to one tag, e.g. 'jazz'. Omit for all tags."),
        status: z.enum(["active", "rejected"]).optional().describe("Omit to see BOTH, which is usually what you want — reviewing a curated list means seeing what was declined as well as what was kept."),
        source: z.enum(["playlist", "manual"]).optional().describe("'playlist' = derived fact, re-derivable. 'manual' = human judgement, never overwritten automatically."),
        limit: z.coerce.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getDjArtistTagsTool, args, token),
  );

  server.registerTool(
    "record_dj_artist_tag",
    {
      title: "Record DJ Artist Tag",
      description:
        "Tag (or un-tag) an artist STRING for reporting. This is what makes the weekly item's Section 3 possible: it is `get_dj_plays mode=artists tag=jazz`, so an untagged artist is an invisible one. " +
        "🛑 THIS IS NOT dj_artists AND MUST NEVER BECOME A JOIN TO IT. `dj_artists.name` is an mbid-keyed concert-act IDENTITY (a null mbid means setlists cannot be read at all). `artist` here is a MATCH KEY: the EXACT dj_tracks.artist string, warts included — 'Eddie Higgins Trio', 'Oscar Peterson Trio', and at least one scraped channel byline reading 'Jazz and Blues Experience, 1.7M views' (§14.9). Copy the string verbatim from get_dj_plays mode=artists; the compare is exact and 'Eddie Higgins' matches nothing. " +
        "⚠️ AN UNKNOWN ARTIST STRING IS REFUSED AND NOTHING IS WRITTEN — not even the rows that would have matched. A partial write would look like a decision not to tag the rest. " +
        "🛑 status 'rejected' IS A DECISION, NOT A DELETION, AND YOU MUST RECORD ONE. When Alex says no to a proposed artist, write it with status='rejected' — otherwise the same name is proposed again next week and every week after, which is §11.7's flag that fires on the normal case and gets ignored. Absence means 'not yet asked'; it is the only state that does. " +
        "⚠️ `source` IS DERIVED SERVER-SIDE AND CANNOT BE PASSED. 'playlist' means the artist is on a track in a playlist whose kind matches the tag — a FACT, and the stored form of what migration 013's artist arm used to recompute. 'manual' means a human decided. A caller asserting provenance could launder a guess into a fact. " +
        "Nothing hard-deletes, so the audit log can reverse any of this. Tier 2 — it updates existing rows, and a curated allowlist that cannot be un-curated is not curated.",
      inputSchema: {
        artists: z.array(z.string()).optional().describe("Artist strings, EXACTLY as get_dj_plays mode=artists spells them. Max 50 in one call — the whole of a weekly proposal is one call and one approval."),
        artist: z.string().optional().describe("One artist string, if you prefer. Same rules as `artists`."),
        tag: z.string().optional().describe("Defaults to 'jazz'. A tag matching a dj_playlists.kind ('jazz') also drives the derivable/fact rule."),
        status: z.enum(["active", "rejected"]).optional().describe("Defaults to 'active'. 'rejected' records that the artist was CONSIDERED AND DECLINED, so the weekly item stops proposing him. Write one whenever Alex says no."),
        note: z.string().optional().describe("Why. Strongly encouraged on a rejection — 'scraped byline, not an artist' is the difference between a decision and a gap."),
      },
    },
    async (args) => runToolForMcp(recordDjArtistTagTool, args, token),
  );

  server.registerTool(
    "get_dj_plays",
    {
      title: "Get DJ Plays",
      description:
        "Read the durable listening record. Three modes. `plays` returns raw rows newest-first with each track inlined. `familiarity` returns one row per CANONICAL GROUP sorted LEAST FAMILIAR FIRST — which is cram order directly (spec §5). `artists` returns what was actually played, BY ARTIST, over a trailing window — the weekly review's Section 4 headline. " +
        "🛑 `artists` IS NOT AN ARTIST IDENTITY (spec §14.1). It groups dj_tracks.artist as an EXACT STRING: 'Oscar Peterson Trio' and 'Oscar Peterson' do not unify, collaborations appear under their full joined billing as one row, and at least one artist in the data reads 'Jazz and Blues Experience, 1.7M views' — a scraped channel byline that will appear looking like an artist. The response ships `gaps` saying so, and any report quoting these numbers must state it too. " +
        "⚠️ `distinct_days` is DISTINCT DAYS PLAYED, NOT a play count: YouTube's feed carries one entry per track per bucket, so repeats do not stack and true counts are unobtainable by polling (spec §5). `play_rows` is returned alongside so the difference stays visible. " +
        "ZERO-PLAY TRACKS COME BACK: when you pass `video_ids`, every id gets an entry, including ids unknown to dj_tracks entirely (`known_track: false`) — a never-played song belongs at the TOP of a cram list, and making the caller reconstruct the missing ones is exactly the logic that goes quietly wrong. `distinct_days: 0` is a FACT; `days_since_last: null` means NEVER — the null-vs-zero distinction is deliberate. " +
        "`familiarity` refuses to run unbounded: pass `video_ids` or a date range. It ERRORS rather than truncates above its scan cap, because a clamped aggregate returns a distinct_days that is wrong rather than short and the caller would sort by it. `estimated_days` counts days made only of coarse-bucket guesses — expected to be 0. Tier 1, read-only.",
      inputSchema: {
        mode: z.enum(["plays", "familiarity", "artists"]).optional().describe("Defaults to 'plays'. `artists` is the by-artist rollup — Section 4's headline, and NOT an identity (see the description)."),
        window_days: z.coerce.number().optional().describe("mode=artists: trailing window, default 90."),
        tag: z.string().optional().describe("mode=artists: filter to artists carrying this tag in dj_artist_tags (e.g. 'jazz'). Omit for every artist. `tags` and `untagged_in_result` are returned either way, so an untagged artist high in an unfiltered list is visible as the tag set being incomplete."),
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
        mode: z.enum(["list", "tracks", "engagement", "cram"]).optional().describe("Defaults to 'list'. `engagement` returns §12.9's listening metrics per playlist — BOTH `runs` (have I learned this set: the CONCERT metric) and `touch_days` (is this still in rotation: everything else). `cram` returns §12.10's least-familiar-first order for ONE concert playlist, plus whether the block is stale, COMPLETE, or working."),
        yt_playlist_id: z.string().optional().describe("mode=tracks: YouTube's playlist id. Either this or playlist_id — Workshop only ever knows this one."),
        playlist_id: z.string().optional().describe("mode=tracks: the internal dj_playlists uuid."),
        kind: z.enum(["concert", "artist", "jazz", "discovery", "utility"]).optional().describe("mode=list or mode=engagement: filter by kind. 'utility' playlists are recorded and measured but never proposed against."),
        playlist_ids: z.array(z.string()).optional().describe("mode=engagement: restrict to these internal playlist uuids."),
        window_days: z.coerce.number().optional().describe("mode=engagement: trailing window, default 90. The warm-then-cold split for `went_quiet` uses a fixed 30-day recent half."),
        as_of: z.string().optional().describe("mode=cram: YYYY-MM-DD basis for days_since_last. Defaults to today UTC."),
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
    "get_dj_artists",
    {
      title: "Get DJ Artists",
      description:
        "Read artist identity rows for the DJ app. `mbid` is the MusicBrainz id and it is what setlist.fm keys its queries on — an artist with mbid null CANNOT have setlists read at all, because name search matches the wrong band and get_dj_setlists refuses names outright. " +
        "Pass `missing_mbid: true` to find the gaps. ⚠️ An empty result for a name you expected means THE ARTIST ROW DOES NOT EXIST, not that it lacks an mbid — those need different fixes, so check `returned` before concluding anything. Tier 1, read-only.",
      inputSchema: {
        name: z.string().optional().describe("Exact artist name (case-insensitive). Omit to list."),
        missing_mbid: z.boolean().optional().describe("Only artists with no mbid — the ones setlist reads cannot reach."),
        limit: z.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getDjArtistsTool, args, token),
  );

  server.registerTool(
    "upsert_dj_artist",
    {
      title: "Upsert DJ Artist",
      description:
        "Create an artist row or update an existing one, matched on name. This is how `mbid` gets set, and without an mbid setlist.fm reads are impossible rather than merely degraded. " +
        "⚠️ CHANGING an mbid that is already set is REFUSED unless `replace_mbid: true`: one of the two is wrong, and silently taking the newer would repoint every future setlist read at a different band with nothing recording it. Setting one that was missing is routine and needs no flag. " +
        "A malformed mbid is rejected here rather than 404ing at setlist.fm, where it would read as 'this artist has no setlists' — a different and much more misleading answer. Tier 2: it can update an existing row.",
      inputSchema: {
        name: z.string().describe("Artist name. Matched case-insensitively; creates the row if absent."),
        mbid: z.string().optional().describe("MusicBrainz id, 8-4-4-4-12 hex. From musicbrainz.org, not guessed."),
        yt_channel_id: z.string().optional().describe("YouTube channel id, if known."),
        tags: z.array(z.string()).optional().describe("Free descriptors: era, genre, anything worth filtering on."),
        notes: z.string().optional().describe("Standing notes. NOT a stance or rating — those live in dj_feedback."),
        last_explored_at: z.string().optional().describe("YYYY-MM-DD: when a discovery pass last went deep on this artist."),
        replace_mbid: z.boolean().optional().describe("Required to overwrite an mbid that is already set. Verify against MusicBrainz first."),
      },
    },
    async (args) => runToolForMcp(upsertDjArtistTool, args, token),
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
        app: z.enum(["dj", "sam", "alfred", "workshop", "ken"]).describe("Which app this job belongs to."),
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
        app: z.enum(["dj", "sam", "alfred", "workshop", "ken"]).optional().describe("Filter to one app."),
        job: z.string().optional().describe("Filter to one job name."),
        enabled: z.boolean().optional().describe("Filter to enabled or suspended definitions."),
        limit: z.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getPlatformSchedulesTool, args, token),
  );

  // --- Ken -------------------------------------------------------------------
  // Handlers in _shared/tools/ken.ts. Each schema below advertises exactly the
  // args.* its handler reads — index.test.mjs checks that mechanically.

  server.registerTool(
    "get_ken_quiz_batch",
    {
      title: "Get Ken Quiz Batch",
      description:
        "Start or continue a quiz. Returns a weighted-random batch of askable Ken items PLUS their recent attempts and the active misconceptions touching them, in ONE call — enough for the next several questions with no further reads. Selection runs in Postgres (ken_select_batch), weighted by item priority and area priority; only active items are eligible. " +
        "Response: { items, attempts, misconceptions }. `attempts` are the most recent across the batch, capped at 5× the number of items overall — not a guaranteed five per item. `misconceptions` are the active ones touching the batch: anchored on a batch item on EITHER side of a confusion pair, or scoped only to a subtopic (no item) that a batch item sits in. Most recently updated first, capped at 50. ⚠️ A truncation NOTE on this tool always means the MISCONCEPTIONS list was cut (items and attempts never are); read the rest with get_ken_misconceptions by item_id or subtopic. " +
        "Items never carry tricky_fragments: call get_ken_lyric_fragments before quizzing a lyric item. Buffer results in the conversation and flush them with record_ken_attempts at natural seams, not after every question. Tier 1, read-only.",
      inputSchema: {
        area_id: z.string().optional().describe("Restrict the batch to one area (uuid from get_ken_areas). Omit to interleave across every area — the default, and usually right, because mixing cold topics in is the point."),
        mode: z.enum(["recall", "concept", "lyric", "procedure"]).optional().describe("Restrict to one mode. recall = hard facts said cold, graded near-exact. concept = vocabulary and fluency; you evaluate a free-text answer and the feedback is the teaching. lyric = fill-in-the-blank against Alex's OWN stored lyric text. procedure = a method run against an input you generate (e.g. Doomsday weekday); nothing is stored to compare against — compute the answer, never estimate."),
        limit: z.coerce.number().optional().describe("Items in the batch (default 20, cap 50). Attempts and misconceptions ride along for every item returned."),
      },
    },
    async (args) => runToolForMcp(getKenQuizBatchTool, args, token),
  );

  server.registerTool(
    "record_ken_attempts",
    {
      title: "Record Ken Attempts",
      description:
        "Flush buffered quiz results. One call appends a whole batch to ken_attempts and updates each item's mastery in place (via ken_record_attempts); returns the new mastery per item so you can see the move without a re-read. " +
        "Hold results in the conversation and flush at natural seams — a topic change, a pause, the batch running dry — NOT once per question. " +
        "⚠️ Max 50 attempts per call; over that the call is REJECTED and nothing is written, so flush more often rather than splitting after the fact. Tier 1 — an append plus own progress state.",
      inputSchema: {
        attempts: z.array(z.object({
          item_id: z.string().describe("uuid of the ken_items row that was asked."),
          result: z.enum(["hit", "partial", "miss"]).describe("hit = correct. partial = partly correct. miss = wrong, or no answer."),
          user_answer: z.string().optional().describe("What Alex actually answered. Worth keeping on a partial or miss: it is what lets a later session spot the SAME wrong answer recurring before it becomes a misconception."),
          ken_assessment: z.string().optional().describe("Your one-line judgement of the answer — what was right, what was confused. Shows up in get_ken_quiz_batch's attempts window for pattern-spotting."),
        })).describe("The buffered results, 1-50 per call, one entry per question asked."),
      },
    },
    async (args) => runToolForMcp(recordKenAttemptsTool, args, token),
  );

  server.registerTool(
    "create_ken_area",
    {
      title: "Create Ken Area",
      description:
        "Create a top-level subject area. FLAT BY DESIGN: an area holds items directly and ken_items.subtopic is the only sub-grouping — there are no nested areas, so never create an area to stand in for a subtopic. Check get_ken_areas first. Tier 1, additive.",
      inputSchema: {
        name: z.string().describe("Area name, e.g. 'Physics' or 'Music theory'."),
        description: z.string().optional().describe("What the area covers, in a sentence."),
        source_ref: z.string().optional().describe("The Alfred item id this area was seeded from (Alfred ids are text, not uuids). Omit for an area created directly in conversation. Unique per user — a second area with the same source_ref is REFUSED, which is what keeps the periodic Alfred seed check idempotent."),
        priority: z.coerce.number().optional().describe("Heat multiplier applied over every item in the area during quiz selection. Default 1.0; must be > 0. Lower it to cool a whole area — it can be cooled but never silenced, because the occasional ambush from a cold topic is the point of interleaving."),
      },
    },
    async (args) => runToolForMcp(createKenAreaTool, args, token),
  );

  server.registerTool(
    "update_ken_area",
    {
      title: "Update Ken Area",
      description:
        "Change an existing area: rename it, rewrite its description, re-heat it, or — the main reason this exists — set its source_ref. An area created in conversation has no source_ref, so the ken_seed_check job lists its Alfred seed as unseeded in every nudge until one is set here. " +
        "Omitting a field leaves it alone; passing description or source_ref as null clears it. An id matching no area is an error and nothing is written. Tier 2 — updates an existing row; audited and reversible.",
      inputSchema: {
        id: z.string().describe("uuid of the area, from get_ken_areas."),
        name: z.string().optional().describe("New area name."),
        description: z.string().nullable().optional().describe("New description, or null to clear it."),
        source_ref: z.string().nullable().optional().describe("The Alfred item id this area was seeded from — text like 'mtw2g9lb8cbs0xhsdij', NOT a uuid. Set it to link an area created in conversation to its seed; null unlinks it. Unique per user: an id already on another area is REFUSED."),
        priority: z.coerce.number().optional().describe("Heat multiplier over every item in the area during quiz selection; must be > 0. Lower it to cool the whole area — it can be cooled, never silenced."),
      },
    },
    async (args) => runToolForMcp(updateKenAreaTool, args, token),
  );

  server.registerTool(
    "create_ken_item",
    {
      title: "Create Ken Item",
      description:
        "Add one quizzable unit — a fact, concept, lyric line or procedure — to an area. Check get_ken_items first to avoid a near-duplicate. " +
        "Defaults are applied by this tool, not the database, and any of them can be overridden: `accuracy` is 'loose' for concept and 'strict' for recall, lyric and procedure; `volatility` is 'stable' on strict items and FORCED to null on loose ones. " +
        "⚠️ A strict recall item saved without a ground_truth is NOT ASKABLE — get_ken_quiz_batch skips it until it has one. Capture is deliberately friction-free; the strict guarantee is enforced at the point of asking. " +
        "⚠️ To change the answer of an EXISTING fact, do not create a second item — use propose_ken_fact_update, which keeps the old answer as history. Tier 1, additive.",
      inputSchema: {
        area_id: z.string().describe("uuid of the area, from get_ken_areas or create_ken_area."),
        mode: z.enum(["recall", "concept", "lyric", "procedure"]).describe("recall = a hard fact said cold, graded near-exact. concept = vocabulary and fluency; you evaluate free text and the feedback IS the teaching. lyric = fill-in-the-blank against Alex's OWN lyric text, stored in `prompt` — never reproduce lyrics from the web or from model memory. procedure = a method executed against an input you generate (Doomsday weekday, interval spelling, unit conversion); you invent the question and compute the answer, so there is nothing stored to compare against."),
        prompt: z.string().describe("The question or cue. For a lyric item, the lyric text itself, as Alex supplied it. For a procedure item, the method — the concrete question is generated fresh each time."),
        accuracy: z.enum(["strict", "loose"]).optional().describe("strict = you must be right: back every checkable claim with the stored ground_truth or a live search, never from memory alone (on a procedure: compute deterministically, never estimate). loose = directionally right is fine. Omit to take the mode default: loose for concept, strict for everything else."),
        volatility: z.enum(["stable", "volatile"]).optional().describe("Strict items only — IGNORED and stored as null when accuracy is loose. stable = true once and done (historical dates, settled science). volatile = the value drifts; store the last-known answer with verified_at so it can be re-checked on age ('as of March it was X — still current?'). Defaults to stable."),
        ground_truth: z.string().optional().describe("The verified answer for a strict item. Omit if not yet verified — the item is saved but not asked until it has one. IGNORED for mode=procedure, which has no stored answer by design."),
        verified_at: z.string().optional().describe("ISO timestamp of when ground_truth was checked. Pass it whenever you supply a verified answer, and always for a volatile fact — it is what re-checking on age reads."),
        subtopic: z.string().optional().describe("Free-text grouping within the area, e.g. 'wave mechanics'. The ONLY sub-grouping Ken has, and mastery rollups are derived by it — reuse an existing spelling (see get_ken_items) rather than coining a near-duplicate."),
        tags: z.array(z.string()).optional().describe("Cross-cutting labels. get_ken_items filters on them with any-of matching."),
        tricky_fragments: z.unknown().optional().describe("Lyric items only; leave it out everywhere else. JSON marking the mondegreen-prone words to blank — 'kiss the sky', not 'kiss this guy'. Heavy: never returned by list reads, fetched on demand with get_ken_lyric_fragments."),
        priority: z.coerce.number().optional().describe("Item heat within rotation. Default 1.0; must be > 0. Lower it to cool an item without hiding it — a cooled item still turns up occasionally, by design."),
      },
    },
    async (args) => runToolForMcp(createKenItemTool, args, token),
  );

  server.registerTool(
    "get_ken_areas",
    {
      title: "Get Ken Areas",
      description:
        "List Ken's subject areas — id, name, description, source_ref, priority — alphabetically. Use it to resolve an area_id. " +
        "To ask WHICH ALFRED SEEDS ALREADY HAVE AN AREA, pass their ids as `source_refs` rather than reading every area: only the linked areas come back, and an id with no area is simply absent — that absence is what 'unseeded' means. source_ref is unique per user, so a source_refs read can never return more areas than ids passed and never truncates. " +
        "Capped by `limit`; the response NOTE says so when it cuts. Tier 1, read-only.",
      inputSchema: {
        source_refs: z.array(z.string()).optional().describe("Alfred item ids — text like 'mtw2g9lb8cbs0xhsdij', NOT uuids. Returns only areas whose source_ref is one of these. Max 50; more is refused. An empty array is the same as omitting it."),
        limit: z.coerce.number().optional().describe("Max areas (cap 50). Defaults to the number of source_refs when those are passed, otherwise 20."),
      },
    },
    async (args) => runToolForMcp(getKenAreasTool, args, token),
  );

  server.registerTool(
    "get_ken_items",
    {
      title: "Get Ken Items",
      description:
        "Browse or search Ken items, newest first. ACTIVE items only unless `status` says otherwise; every filter is applied in Postgres before the limit. tricky_fragments is never included (use get_ken_lyric_fragments). " +
        "Use it to find an item_id, to check for an existing item before creating one, or to review what an area holds. To QUIZ, use get_ken_quiz_batch — it selects, and brings attempts and misconceptions along. Tier 1, read-only.",
      inputSchema: {
        area_id: z.string().optional().describe("Filter to one area (uuid)."),
        subtopic: z.string().optional().describe("Filter to one subtopic — exact match."),
        mode: z.enum(["recall", "concept", "lyric", "procedure"]).optional().describe("Filter to one mode."),
        tags: z.array(z.string()).optional().describe("Items carrying ANY of these tags."),
        search_text: z.string().optional().describe("Case-insensitive substring match on `prompt` only — not ground_truth, not subtopic."),
        status: z.enum(["active", "deprecated"]).optional().describe("Defaults to 'active'. 'deprecated' returns retired items, including superseded facts whose superseded_by points at the replacement — the history that lets Ken un-teach an old answer."),
        limit: z.coerce.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getKenItemsTool, args, token),
  );

  server.registerTool(
    "get_ken_lyric_fragments",
    {
      title: "Get Ken Lyric Fragments",
      description:
        "Lazy-load the one heavy column for a single item: returns { id, prompt, tricky_fragments }. Call it only when about to quiz a lyric item — quiz batches and list reads deliberately leave tricky_fragments out. An item_id matching no item is an error. Tier 1, read-only.",
      inputSchema: {
        item_id: z.string().describe("uuid of the lyric item."),
      },
    },
    async (args) => runToolForMcp(getKenLyricFragmentsTool, args, token),
  );

  server.registerTool(
    "get_ken_misconceptions",
    {
      title: "Get Ken Misconceptions",
      description:
        "Read curated misconceptions — durable, qualitative error patterns ('often conflates timbre and tone; the distinction is X') — most recently updated first. ACTIVE only unless `status` says otherwise. A misconception is scoped to an item, a confusion PAIR of items, or a subtopic. " +
        "`item_id` matches EITHER side of a confusion pair — misconceptions anchored on the item and ones where it is the related_item_id half. Tier 1, read-only.",
      inputSchema: {
        item_id: z.string().optional().describe("uuid. Misconceptions touching this item on EITHER side of a confusion pair (item_id or related_item_id)."),
        subtopic: z.string().optional().describe("Misconceptions scoped to this subtopic — exact match."),
        status: z.enum(["active", "resolved"]).optional().describe("Defaults to 'active'. 'resolved' = patterns that stopped recurring, kept as history."),
        limit: z.coerce.number().optional().describe("Max rows (default 20, cap 50)."),
      },
    },
    async (args) => runToolForMcp(getKenMisconceptionsTool, args, token),
  );

  server.registerTool(
    "create_ken_misconception",
    {
      title: "Create Ken Misconception",
      description:
        "Record a durable misconception: a specific, RECURRING, qualitative error pattern — the part a mastery score cannot capture. Write sparingly and deliberately, once a pattern has actually recurred (the attempts window in get_ken_quiz_batch is where you spot it); never buffer single misses here. Check get_ken_misconceptions first and update an existing pattern rather than duplicating it. " +
        "⚠️ SCOPE IS REQUIRED: pass item_id, subtopic, or both — the database refuses a misconception with neither. For a confusion between two items pass item_id AND related_item_id; the pair is the unit. Tier 1, additive.",
      inputSchema: {
        note: z.string().describe("The pattern and its correction, in a sentence or two — e.g. 'often conflates timbre and tone; the distinction is X'."),
        item_id: z.string().optional().describe("uuid of the item the error is about."),
        related_item_id: z.string().optional().describe("The OTHER item in a confusion pair. Must differ from item_id. If that item is later removed the misconception survives, because it is still true of the one that remains."),
        subtopic: z.string().optional().describe("Scope to a subtopic when the error spans several items rather than one."),
      },
    },
    async (args) => runToolForMcp(createKenMisconceptionTool, args, token),
  );

  server.registerTool(
    "update_ken_misconception",
    {
      title: "Update Ken Misconception",
      description:
        "Revise a misconception's note, or mark it resolved once it has stopped recurring (resolved rows drop out of quiz batches and default reads but are kept). Pass `note`, `status`, or both — with neither, the only effect is bumping updated_at. Scope (item_id, related_item_id, subtopic) cannot be changed here; create a new misconception and resolve the old one. An id matching no row is an error. Tier 2 — updates an existing row; audited and reversible.",
      inputSchema: {
        id: z.string().describe("uuid of the misconception, from get_ken_misconceptions or a quiz batch."),
        note: z.string().optional().describe("Replacement text. REPLACES the whole note — it does not append."),
        status: z.enum(["active", "resolved"]).optional().describe("'resolved' = no longer recurring. 'active' re-opens one that came back."),
      },
    },
    async (args) => runToolForMcp(updateKenMisconceptionTool, args, token),
  );

  server.registerTool(
    "propose_ken_fact_update",
    {
      title: "Propose Ken Fact Update",
      description:
        "Supersede the answer to a fact that has CHANGED — a volatile value drifted, or a stored answer was wrong. NEVER an overwrite: writes a NEW active item carrying the new ground_truth (area, subtopic, tags, mode, accuracy, volatility and priority copied from the old one), then flips the old item to 'deprecated' with superseded_by pointing at the replacement. The old row is the history that lets Ken actively un-teach a drilled-in wrong answer. " +
        "🛑 TIER 3 — TWO CALLS. The first call, without `confirmed`, writes NOTHING and returns a proposal. Show Alex the change — old answer, new answer, and your source — and only after he agrees, call again with the same arguments plus `confirmed: true`. " +
        "⚠️ The replacement starts with fresh mastery (it is not copied) and does NOT carry tricky_fragments. Refused if the item is already deprecated. Not for procedure items, which have no stored answer.",
      inputSchema: {
        item_id: z.string().describe("uuid of the CURRENT active item whose answer changed."),
        ground_truth: z.string().describe("The new, verified answer."),
        prompt: z.string().optional().describe("Replacement question text, only if the wording must change too. Omit to keep the old prompt."),
        verified_at: z.string().optional().describe("ISO timestamp of when the new answer was verified. Defaults to now — pass it only if the check happened earlier."),
        confirmed: z
          .boolean()
          .optional()
          .describe("Tier-3 gate. Set to true on the second call, after Alex has agreed, to actually write. Omit / false on the first call to see a proposal."),
      },
    },
    async (args) => runToolForMcp(proposeKenFactUpdateTool, args, token),
  );

  // --- Job search -----------------------------------------------------------
  // Every description here ends with JOB_VOCAB, the ONE copy of the status /
  // fit / effort vocabulary and the source-is-lowercase rule. Four paraphrases
  // would drift apart the first time a status is added.

  server.registerTool(
    "get_job_applications",
    {
      title: "Get Job Applications",
      description:
        "List Alex's job applications — one row per application, newest applied_on first (ties broken by when it was logged). Every filter is applied in the database before the limit, so the counts you get back are counts of everything that matched, not of the page. All parameters are optional; with none, this is the most recent 20 applications. Returns every column except user_id. " +
        "`open_only` excludes rejected, closed_no_response, withdrawn and passed — the four terminal statuses — leaving what is still live, which INCLUDES `considering` (a role not yet decided about is still an open loop). `overdue` returns applications whose next_action_due is BEFORE today in America/Los_Angeles; something due today is due, not overdue, and a row with no next_action_due is never overdue. `org` is a case-insensitive PARTIAL match ('acme' finds 'Acme Corporation'); `source` and `fit` are exact. Passing `open_only` together with an explicit `status` intersects them. Results are capped (default 20, hard cap 50) — the response NOTE tells you when there is more. Tier 1. " +
        JOB_VOCAB,
      inputSchema: {
        status: z
          .union([JOB_STATUS, z.array(JOB_STATUS)])
          .optional()
          .describe("One status, or an array of them (matches ANY of the listed statuses)."),
        source: z
          .string()
          .optional()
          .describe("Exact match on where the role was found. Lowercased before matching, so 'LinkedIn' and 'linkedin' behave identically."),
        org: z
          .string()
          .optional()
          .describe("Case-insensitive PARTIAL match on the organisation name."),
        fit: JOB_FIT.optional().describe("Exact match on how good a fit the role is."),
        open_only: z
          .boolean()
          .optional()
          .describe("true = only applications still live: excludes rejected, closed_no_response, withdrawn and passed. `considering` counts as live."),
        overdue: z
          .boolean()
          .optional()
          .describe("true = only applications whose next_action_due is before today (America/Los_Angeles). Rows with no due date are excluded."),
        limit: z.number().optional().describe("Max rows (default 20, hard cap 50)."),
      },
    },
    async (args) => runToolForMcp(getJobApplicationsTool, args, token),
  );

  server.registerTool(
    "create_job_application",
    {
      title: "Create Job Application",
      description:
        "Log ONE job application Alex has submitted — or, with status 'considering' or 'passed', ONE role he has seen but not applied to. org, role, source and fit are always required; everything else is optional. `applied_on` defaults to today in America/Los_Angeles — not the server's UTC date, so an application logged in the evening is still logged for today. `status` defaults to 'applied'. source, fit, effort and status are lowercased and trimmed before the write. " +
        "EFFORT IS CONDITIONALLY REQUIRED: pass `effort` for every status EXCEPT 'considering' and 'passed', where no application was written and effort should be omitted. Omitting it on any other status is refused and nothing is written. " +
        "DUPLICATE GUARD, UNCHANGED BY THE NEW STATUSES: if an application with the same org and role already exists (ignoring case) this writes NOTHING and returns an error naming that row's id, applied_on and status — use update_job_application on that id instead. Two rows for one application permanently distort that source's response rate. That includes a role already logged as 'considering': Alex deciding to apply to it is an UPDATE of that row to 'applied' (sending `effort` in the same call), never a second row. " +
        "DUPLICATES ARE LINKED, NOT DELETED. When Alex genuinely applied to the same job twice — through two different job boards, say — both rows stay and the later one carries `duplicate_of` pointing at the FIRST. The sources report then counts the application once while both sources keep their share of the story. NO CHAINS: a duplicate must point at a MAIN row (one whose own duplicate_of is null), and a row that other rows already point at cannot itself become a duplicate; both are refused with an explanation and nothing is written. " +
        "`posting_url` NEVER refuses anything. If another row already carries the same address, the response lists it in `posting_url_matches` and the row is still written — the same address can legitimately appear twice (a repost a year later, or a second deliberate application). Raise it with Alex and, if he says it is the same job, set duplicate_of on the later row. " +
        "Returns the inserted row plus `same_org_rows`: OTHER rows at what looks like the same organisation, matched case-insensitively as a partial match in either direction ('Acme' matches 'Acme Corporation' and vice versa), newest first, each with id, org, role, status and applied_on. Empty array when there are none. REPORT these to Alex when the array is non-empty — it means he has history with this org, which is context for the application and worth knowing before he chases it. Tier 1, no confirmation required. " +
        JOB_VOCAB,
      inputSchema: {
        org: z.string().describe("The organisation applied to. Stored as written — casing is preserved."),
        role: z.string().describe("The role title. Stored as written. If Alex applies to two roles at one org, the titles must differ or the duplicate guard will refuse the second."),
        source: z.string().describe("Where the role was found. Stored lowercase — REUSE an existing spelling (see get_job_application_sources) rather than inventing a new one."),
        fit: JOB_FIT.describe("How good a fit the role is: high | medium | low."),
        effort: JOB_EFFORT.optional().describe("How much work the application took: full (tailored CV and cover letter) | quick (light-touch submission). REQUIRED for every status except 'considering' and 'passed' — omit it for those two, where nothing was submitted."),
        applied_on: z.string().optional().describe("YYYY-MM-DD. Defaults to today in America/Los_Angeles. Pass it only to back-date an application logged late."),
        status: JOB_STATUS.optional().describe("Defaults to 'applied'. Pass another value when logging an application that has already moved on, or 'considering' / 'passed' for a role Alex has only looked at."),
        deadline: z.string().optional().describe("YYYY-MM-DD — the EMPLOYER's posted application deadline, if there was one. Not Alex's own follow-up date; that is next_action_due."),
        next_action: z.string().optional().describe("What Alex owes next. Omit when nothing is owed and he is just waiting — that is a real state, not an unknown one."),
        next_action_due: z.string().optional().describe("YYYY-MM-DD — when next_action is due. Only allowed alongside a next_action; sending it without one is refused."),
        notes: z.string().optional().describe("Free text about this application."),
        posting_url: z.string().optional().describe("Where the posting lives. Not unique and never a reason to refuse a write: if another row already has it, the response lists that row in posting_url_matches and this one is still created. Take it from a clipped page's url, or from the clip's links list for a posting on a job board."),
        duplicate_of: z.string().optional().describe("The UUID of the MAIN application this one duplicates — pass it when Alex applied to the SAME job twice and both applications are worth keeping. Doing so SKIPS the same-org-and-role duplicate guard, because passing it says the repeat is deliberate. Must point at a row whose own duplicate_of is null; chains are refused."),
      },
    },
    async (args) => runToolForMcp(createJobApplicationTool, args, token),
  );

  server.registerTool(
    "update_job_application",
    {
      title: "Update Job Application",
      description:
        "Change an existing job application — most often to move its status along as the pipeline progresses. `id` is required; pass at least one other field. An id matching no row is an error and nothing is written; this tool never creates a row. source, fit, effort and status are lowercased and trimmed, exactly as create does. " +
        "EFFORT: every status except 'considering' and 'passed' requires an effort. Moving a row OFF 'considering' or 'passed' therefore needs `effort` in the SAME call, because such a row has none stored — this is the normal way a role Alex was considering becomes one he applied to. Without it the write is refused, nothing changes, and the error says to send effort. A row that already has an effort stored needs no new one. " +
        "CLEARING: send an empty string or null for deadline, next_action, next_action_due or notes to clear it. Clearing next_action also clears next_action_due in the same write, because a due date with nothing due violates the table's check constraint. " +
        "NOTES: `notes` REPLACES the whole field. `append_note` instead adds a new line to whatever is already there, prefixed with today's date in America/Los_Angeles (e.g. \"2026-09-24: recruiter called\") — it never overwrites, and it is what you want for a running log. Sending both `notes` and `append_note` is an error. Returns the updated row. Tier 2 — audited and reversible. " +
        "DUPLICATES ARE LINKED, NOT DELETED. When Alex genuinely applied to the same job twice, both rows stay and the later one carries `duplicate_of` pointing at the FIRST, so the sources report counts the application once while both sources keep their share of the story. NO CHAINS: the target must be a MAIN row (its own duplicate_of null), and a row other rows already point at cannot itself become a duplicate; both are refused and nothing is written. Clear it with null to promote a duplicate back to a main row. " +
        JOB_VOCAB,
      inputSchema: {
        id: z.string().describe("uuid of the application, from get_job_applications."),
        applied_on: z.string().optional().describe("YYYY-MM-DD. Cannot be cleared."),
        org: z.string().optional().describe("Replacement organisation name. Cannot be cleared."),
        role: z.string().optional().describe("Replacement role title. Cannot be cleared."),
        source: z.string().optional().describe("Replacement source. Stored lowercase; reuse an existing spelling. Cannot be cleared."),
        fit: JOB_FIT.optional().describe("high | medium | low."),
        effort: JOB_EFFORT.optional().describe("full | quick."),
        status: JOB_STATUS.optional().describe("The pipeline move. This is the field that drives the response-rate report, so get it right. Moving OFF 'considering' or 'passed' to any applied status requires `effort` in the same call."),
        deadline: z.string().optional().describe("YYYY-MM-DD, or \"\" / null to clear. The employer's deadline."),
        next_action: z.string().optional().describe("What Alex owes next, or \"\" / null to clear. Clearing it also clears next_action_due."),
        next_action_due: z.string().optional().describe("YYYY-MM-DD, or \"\" / null to clear. Refused if the row would end up with a due date and no next_action."),
        notes: z.string().optional().describe("REPLACES the entire notes field. Use append_note to add to it instead. \"\" or null clears it."),
        append_note: z.string().optional().describe("Adds one dated line to the existing notes, never overwriting. Cannot be combined with `notes`."),
        posting_url: z.string().optional().describe("Where the posting lives. \"\" or null clears it. Not unique: if another row already has it, the response lists that row in posting_url_matches and the update still applies."),
        duplicate_of: z.string().optional().describe("Mark THIS row as a duplicate of the application with this UUID, so the sources report counts the pair once. Pass null or \"\" to unlink it and make it a main row again. NO CHAINS: the target must be a main row (its own duplicate_of null), and this row must not already be the main row for others — both are refused with an explanation and nothing is written."),
      },
    },
    async (args) => runToolForMcp(updateJobApplicationTool, args, token),
  );

  server.registerTool(
    "get_job_application_sources",
    {
      title: "Get Job Application Sources",
      description:
        "The 'which source actually converts' report: one entry per source, sorted by total descending. Each carries total; responded (status is screening, interview, rejected or offer — a rejection IS a response, because it means the application was read); response_rate (responded / total, to 2 decimal places); reached_interview (interview or offer); offers; and waiting (status 'applied', nothing heard yet). closed_no_response and withdrawn count towards `total` and towards nothing else, so responded + waiting need not equal total. " +
        "COUNTS DISTINCT APPLICATIONS ONLY, and removes two kinds of row before counting anything, each reported separately and each counted once. Rows with `duplicate_of` set (`duplicates_excluded`) are the SAME application logged twice: counting both would give one application two entries in `total` while only one of them can ever reach screening, which halves the response rate of whichever source lost the race. Rows with status 'considering' or 'passed' (`not_applied_excluded`) were never submitted — counting them would put roles Alex merely looked at into the denominator. " +
        "Use this before logging an application to see which source spellings already exist. `response_rate` means little at a small total — read it next to the count. Reads at most 2000 applications; if that cap is hit the response carries a truncation NOTE. Tier 1. " +
        JOB_VOCAB,
      inputSchema: {
        since: z
          .string()
          .optional()
          .describe("YYYY-MM-DD. Only count applications with applied_on on or after this date. Omit for all time."),
      },
    },
    async (args) => runToolForMcp(getJobApplicationSourcesTool, args, token),
  );

  // -------------------------------------------------------------------------
  // Alfred Clipboard — docs/technical-spec-clipboard.md § 4.2
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_recent_clips",
    {
      title: "Get Recent Clips",
      description:
        "Recently clipped web pages and pushed CLI reports, as TEXT. Call this whenever Alex says he clipped, saved or grabbed something, or that the CLI responded / replied / finished — it is the tool that answers 'I just clipped this'. " +
        "⚠️ WHEN ALEX SAYS THE CLI RESPONDED, MATCH THE RUN TAG. He often has two or three CLI sessions going at once, so the newest report is frequently not the one he means. Every CLI prompt this conversation issued began with a line 'Run tag: <tag>' — find that tag in the conversation and pass it as run_tag, which matches exactly. " +
        "If this conversation issued no tagged prompt, call with source 'cli' and look at what comes back: if there is exactly ONE unarchived report, use it; if there is more than one, DO NOT GUESS and do not assume the most recent — list them with their titles, run tags and times and ask which he means. Each report also carries repo and branch, which help when two runs have similar titles. " +
        "A CLI report whose run_tag is null carries no way of telling which conversation it belongs to, so treat it exactly like any other unmatched report: list it and ask, rather than assuming it is yours. " +
        "Returns per clip: id, source, url, title, captured_at, inbox_id, slice_count, run_tag, repo, branch, capture_mode, screenshot_note, links_truncated, page_width and page_height (the ORIGINAL page size in CSS pixels, before the extension scaled it to 1280 wide — so you never have to estimate how tall a page was), page_text and links, plus flags saying whether the stored text or screenshot is incomplete. NO IMAGES — get_clip_slices does that. " +
        "Newest first, default 5 (hard cap 50). Archived clips are excluded unless include_archived is true, so once you have handled a clip and archived its inbox item it stops coming back. " +
        "TWO KINDS OF SCREENSHOT, and capture_mode says which. 'visible' is the everyday one: a single photograph of what was ON SCREEN when Alex clipped, roughly one viewport, DELIBERATELY not the whole page and NOT a failure — screenshot_truncated is false for it because nothing went wrong. Never describe a visible clip as the full page, and never describe it as truncated or incomplete; say it shows the visible screen. 'full' means the whole page was photographed, which Alex triggers separately. Clips made before the two modes existed report 'full', which is correct — the visible mode did not exist then. " + "screenshot_truncated true means a FULL capture did not get the whole page. DO NOT GUESS WHY — screenshot_note says, in words, what the screenshot is and what went wrong if anything. Quote it rather than inventing a cause. A common one is a page whose content scrolls inside its own box, which no amount of capturing fixes. THE TEXT IS COMPLETE IN EVERY MODE, so answer from page_text and describe the picture for what it is. " +
        "links_truncated true means the page had more than 1,000 links and the rest were dropped at capture time — so if a listing seems missing from a big job board, say so rather than concluding it was not there. " +
        "Two response-only caps, each with its own flag: page_text is cut at 60,000 characters (page_text_truncated_in_response, with page_text_total_chars giving the real length) and links at 200 entries (links_truncated_in_response, with link_count). These are about the size of THIS reply; the separate text_truncated flag means the capture itself was cut short. Tier 1. " +
        CLIP_VOCAB,
      inputSchema: {
        limit: z.number().optional().describe("How many clips (default 5, hard cap 50)."),
        source: z
          .enum(["clipboard", "cli"])
          .optional()
          .describe("'clipboard' = a page captured by the Chrome extension. 'cli' = a report pushed by the Claude CLI. Omit for both. Use 'cli' when Alex says the CLI responded."),
        since_minutes: z
          .number()
          .optional()
          .describe("Only clips saved in the last N minutes. Measured on server arrival time, not the client's clock. Good for 'I just clipped two jobs' — try 30."),
        run_tag_prefix: z
          .string()
          .optional()
          .describe("Run tags STARTING WITH this text. A tag is <project>-<thread code>-<step>-<random>, so passing this conversation's own project-and-thread prefix (for example 'jobs-ax4') returns every report this thread has ever received, oldest to newest. Use it for 'what has the CLI told me in this conversation', where run_tag answers 'the one report from that prompt'. Cannot be combined with run_tag."),
        run_tag: z
          .string()
          .optional()
          .describe("Exact match on the run tag of a CLI report. Lowercase letters, digits and hyphens. Use the tag from the 'Run tag: <tag>' line of the prompt THIS conversation sent to the CLI — that is how you get the right report when several runs are in flight. Returns nothing if no report carries that tag, which means that run has not finished pushing yet."),
        include_archived: z
          .boolean()
          .optional()
          .describe("Default false. True also returns clips whose inbox item has been archived, i.e. ones already handled. Use it when Alex refers back to something from earlier."),
      },
    },
    async (args: Record<string, unknown>) => runToolForMcp(getRecentClipsTool, args, token),
  );

  server.registerTool(
    "get_clip_slices",
    {
      title: "Get Clip Slices",
      description:
        "The screenshot of one clip, as actual images. The page was sliced top to bottom in the browser: 1280px wide, each slice at most 900px tall, overlapping by 50px so a line of text sitting on a cut is whole in one of the two neighbours — expect a little repetition between consecutive slices. " +
        "Returns a text block naming the slices and their sizes, then the images in page order. It always begins with the clip's screenshot_note, which says what you are actually looking at — most often ONE photograph of the visible screen rather than the whole page. Read it before describing the images, and never call a visible-screen capture the full page. At most 8 per call; if you ask for more the reply says so and tells you the `from` value to continue at. " +
        "COSTS REAL CONTEXT — every image lands in the conversation whether or not you end up needing it. Read the clip's page_text from get_recent_clips first and come here only when the layout or the visuals matter, or when the text came out thin or garbled. A CLI report has no screenshot. Tier 1. " +
        CLIP_VOCAB,
      inputSchema: {
        clip_id: z.string().describe("The clip's id, from get_recent_clips."),
        from: z.number().optional().describe("First slice number, 1-based, matching the file names (slice-01.jpg is 1). Default 1."),
        to: z.number().optional().describe("Last slice number, inclusive. Default: the final slice, subject to the 8-per-call cap."),
      },
    },
    async (args: Record<string, unknown>) => runToolForMcp(getClipSlicesTool, args, token),
  );

  server.registerTool(
    "archive_inbox_item",
    {
      title: "Archive Inbox Item",
      description:
        "Hide a handled inbox item. Call this once you have DEALT WITH a clip or a CLI report — read it, answered it, filed what it needed — so it leaves Alex's inbox screen instead of sitting there looking unread. It disappears from the app live. " +
        "Records archive_reason 'processed', which is what distinguishes it in Alex's archive from an item he binned himself with the trash can ('discarded'). " +
        "Reversible in one call: pass archived: false to put it back, untriaged, with the reason cleared. Nothing is deleted either way, and the change is audited. " +
        "Takes the inbox_id, NOT the clip id — get_recent_clips returns both. Archiving does not touch the clip itself, which keeps its text and screenshot. Tier 2, no confirmation needed.",
      inputSchema: {
        inbox_id: z.string().describe("The inbox item's id, from get_recent_clips (field: inbox_id) or get_inbox (field: id). Not the clip id."),
        archived: z
          .boolean()
          .optional()
          .describe("Default true (hide it). Pass false to un-archive and return it to the inbox."),
      },
    },
    async (args: Record<string, unknown>) => runToolForMcp(archiveInboxItemTool, args, token),
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

// ---------------------------------------------------------------------------
// Bulk playlist import — an HTTP endpoint, deliberately NOT an MCP tool
// ---------------------------------------------------------------------------
//
// Phase 6b recorded 41 playlist rows and no membership. Filling ~1,500 tracks
// across 34 playlists by hand means round-tripping every title, artist and
// set_video_id through a conversation — roughly a quarter of a million tokens,
// and it makes the model the transport, which is how a video_id gets corrupted
// into a row that insert-only tables cannot take back.
//
// Same shape as /import-takeout, for the same reasons, and it CALLS THE SAME
// TOOLS rather than reimplementing them.
//
//   POST /mcp/import-playlist?mode=dry_run   -> predicts, writes nothing
//   POST /mcp/import-playlist?mode=confirm   -> writes, via record_dj_playlist
//
// ONE PLAYLIST PER CALL, dry-run then confirm. A single call that imported all
// 34 would solve transport by deleting the review gate that made transport
// tolerable.
//
// ⚠️ THE CALLER MUST SEND library_count — the count YouTube reports for the
// playlist — alongside the tracks it actually read. The 200-track cap is
// silent: get_dj_playlists mode=contents has no offset and no cursor, so a
// 223-track playlist returns 200 rows and looks exactly like a complete read.
// Comparing the two is the only way to catch it, and a mismatch is a STOP, not
// a warning. Recording 200 of 223 would produce a body that is wrong in a way
// nothing downstream could detect.
// The import targets: what Supabase has recorded, so the script never has to
// guess a playlist's `kind` from its YouTube title.
//
// ⚠️ THIS EXISTS SO THE SCRIPT NEEDS EXACTLY ONE CREDENTIAL. The obvious
// alternative — reading dj_playlists over PostgREST from the script — needs an
// `apikey` header as well as the bearer token, which is a second secret to
// fetch and paste for no gain. /import-takeout established the pattern: one
// pasted user JWT, nothing else. It calls the existing tool rather than
// querying, so RLS and the envelope are unchanged.
app.get("/import-playlist/targets", async (c) => {
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return c.json({ error: "Missing bearer token" }, 401);
  try {
    const result = await getDjManagedPlaylistsTool({ mode: "list", limit: 50 }, c.req.raw);
    return c.json(result.data as Record<string, unknown>);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.post("/import-playlist", async (c) => {
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
  if (!body?.yt_playlist_id || !Array.isArray(body?.tracks)) {
    return c.json(
      { error: "body must be { yt_playlist_id, name, kind, library_count, tracks: [...] }" },
      400,
    );
  }

  // --- The truncation guard, before anything else.
  const libraryCount = body.library_count;
  if (typeof libraryCount !== "number") {
    return c.json({
      error:
        "`library_count` is required — the track count YouTube reports for this " +
        "playlist. Without it a truncated read cannot be distinguished from a " +
        "complete one, because get_dj_playlists mode=contents caps at 200 with no " +
        "cursor and reports no error when it clips.",
    }, 400);
  }
  // ⚠️ THE CEILING COMES FROM THE CALLER, NOT FROM A CONSTANT HERE. A constant
  // made this guard measure one path and report on another: it held 200 while
  // the bulk path fetched 400, so every read over 200 read as clipped.
  // Requiring the caller to state the ceiling it used makes the assumption
  // explicit and impossible to get silently wrong — the same argument as
  // library_count. Defaulting it would recreate the bug quietly.
  const readCap = body.read_cap;
  if (typeof readCap !== "number") {
    return c.json({
      error:
        "`read_cap` is required — the track ceiling this caller read with. " +
        "Without it a clipped read cannot be told from a complete one, and a " +
        "guard holding its own copy of the number disagrees with the reader the " +
        "moment either changes.",
    }, 400);
  }

  const readCount = (body.tracks as unknown[]).length;
  const verdict = classifyRead(libraryCount, readCount, readCap);

  if (verdict.kind === "clipped_by_cap" || verdict.kind === "over_read") {
    return c.json({
      mode,
      stop: true,
      reason: verdict.kind,
      yt_playlist_id: body.yt_playlist_id,
      library_count: libraryCount,
      read_count: readCount,
      read_cap: readCap,
      error: verdict.message,
    }, 409);
  }
  if (verdict.kind === "shortfall") {
    // Recorded, not refused — but never silently.
    body.__shortfall_note = verdict.note;
  }


  try {
    // ⚠️ THE BULK VARIANT, NOT THE MCP ONE. Same handler, higher track ceiling —
    // the MCP tool's 300 exists to bound a payload a model composed, and nothing
    // here came through a conversation. Using recordDjPlaylistTool would refuse
    // Elise's fun list at 379 with a message about a cap that is not this path's.
    const tool = mode === "confirm" ? recordDjPlaylistBulkTool : dryRunDjPlaylistTool;
    const result = await tool(body, c.req.raw);
    return c.json({
      mode,
      library_count: libraryCount,
      read_count: readCount,
      read_cap: readCap,
      // ⚠️ ECHOED SO THE CALLER CAN VERIFY WHICH TOOL RAN. "Both tools produce
      // identical output from identical input" proves they do not drift; it does
      // NOT prove this endpoint picks the right one, and nothing exercised that.
      tool_used: mode === "confirm" ? "record_dj_playlist_bulk" : "dry_run_dj_playlist",
      ...(body.__shortfall_note ? { shortfall_note: body.__shortfall_note } : {}),
      ...(result.data as Record<string, unknown>),
    });
  } catch (e) {
    // Verbatim — a partial failure carries its own counts and must not be
    // reworded on the way out.
    return c.json({ mode, yt_playlist_id: body.yt_playlist_id, error: (e as Error).message }, 500);
  }
});

// Serve
Deno.serve(app.fetch);
