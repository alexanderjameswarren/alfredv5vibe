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

    if (params.ai_status) {
      query = query.eq("ai_status", params.ai_status);
    }

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

export async function updateInboxItem(
  client: SupabaseClient,
  params: {
    inbox_id: string;
    ai_confidence: number;
    ai_reasoning: string;
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
  }
): Promise<ToolResult> {
  try {
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user) {
      return { error: "Could not identify authenticated user" };
    }

    // Verify ownership
    const { data: existing, error: fetchError } = await client
      .from("inbox")
      .select("id, user_id")
      .eq("id", params.inbox_id)
      .single();

    if (fetchError || !existing) {
      return { error: "Inbox item not found" };
    }
    if (existing.user_id !== user.id) {
      return { error: "Unauthorized: inbox item does not belong to current user" };
    }

    // Build update object with only explicitly provided fields
    const updates: Record<string, unknown> = {
      ai_confidence: params.ai_confidence,
      ai_reasoning: params.ai_reasoning,
      ai_status: params.ai_status ?? "enriched",
    };

    if (params.suggested_context_id !== undefined) updates.suggested_context_id = params.suggested_context_id;
    if (params.suggest_item !== undefined) updates.suggest_item = params.suggest_item;
    if (params.suggested_item_text !== undefined) updates.suggested_item_text = params.suggested_item_text;
    if (params.suggested_item_description !== undefined) updates.suggested_item_description = params.suggested_item_description;
    if (params.suggested_item_elements !== undefined) updates.suggested_item_elements = params.suggested_item_elements;
    if (params.suggested_item_id !== undefined) updates.suggested_item_id = params.suggested_item_id;
    if (params.suggest_intent !== undefined) updates.suggest_intent = params.suggest_intent;
    if (params.suggested_intent_text !== undefined) updates.suggested_intent_text = params.suggested_intent_text;
    if (params.suggested_intent_recurrence !== undefined) updates.suggested_intent_recurrence = params.suggested_intent_recurrence;
    if (params.suggest_event !== undefined) updates.suggest_event = params.suggest_event;
    if (params.suggested_event_date !== undefined) updates.suggested_event_date = params.suggested_event_date;
    if (params.suggested_tags !== undefined) updates.suggested_tags = params.suggested_tags;
    if (params.suggested_collection_id !== undefined) updates.suggested_collection_id = params.suggested_collection_id;

    const { data, error } = await client
      .from("inbox")
      .update(updates)
      .eq("id", params.inbox_id)
      .select()
      .single();

    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getDatabaseSchema(
  client: SupabaseClient,
  params: { table_name?: string }
): Promise<ToolResult> {
  try {
    const targetTable = params.table_name && params.table_name !== "all"
      ? params.table_name
      : "";

    const { data, error } = await client.rpc("get_schema_info", {
      target_table: targetTable,
    });

    if (error) return { error: error.message };
    return { data };
  } catch (e) {
    return { error: String(e) };
  }
}
