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
