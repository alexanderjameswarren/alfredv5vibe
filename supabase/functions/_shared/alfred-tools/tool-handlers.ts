import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { ToolResult } from "./types.ts";
import { normaliseTags } from "../tags.ts";

export async function getContexts(
  client: SupabaseClient,
  params: { shared?: boolean }
): Promise<ToolResult> {
  try {
    let query = client
      .from("contexts")
      // No `tags`. The column is dropped by the tags project's Migration A —
      // it had a GIN index, two rows of data and no user interface, and was
      // never reachable from the app. `keywords` is the field that actually
      // does work during inbox triage. Selecting a dropped column is a hard
      // PostgREST error, so this had to stop before the migration ran.
      .select("id, name, description, keywords, shared, pinned, created_at")
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

    // Tag filtering, client-side. `items.tags` has been text[] since migration
    // 039 — this comment used to say jsonb, which stopped being true then — so
    // the array `.includes` below is correct rather than accidentally correct.
    //
    // This is the LEGACY reader, still live: ai-enrich calls it. The MCP
    // get_items tool does not — it goes through platform_search_items, which
    // filters in Postgres with `tags && p_tags`. Unlike getIntents below, this
    // query has no `.limit()`, so filtering after the fetch sees every row and
    // the page-not-table trap documented there does not apply here.
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

export async function getIntents(
  client: SupabaseClient,
  params: {
    context_id?: string;
    search_text?: string;
    tags?: string[];
    include_archived?: boolean;
    recurring_only?: boolean;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    const limit = params.limit || 50;

    let query = client
      .from("intents")
      .select(
        "id, text, is_intention, is_item, item_id, context_id, tags, collection_id, recurrence_config, target_start_date, end_date, created_at, updated_at"
      )
      .order("target_start_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (!params.include_archived) {
      query = query.eq("archived", false);
    }
    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }
    if (params.search_text) {
      query = query.ilike("text", `%${params.search_text}%`);
    }
    if (params.recurring_only) {
      query = query.not("recurrence_config", "is", null);
    }

    const { data: intents, error } = await query;
    if (error) return { error: error.message };
    if (!intents || intents.length === 0) return { data: [] };

    // Tag filter is client-side. `intents.tags` has been text[] since migration
    // 039 — this comment used to say jsonb, which stopped being true then — so
    // the array `.includes` below is correct rather than accidentally correct.
    // It no longer "matches get_items" either: the MCP get_items tool filters
    // in Postgres via platform_search_items (`tags && p_tags`).
    //
    // ⚠️ THIS FILTERS THE PAGE, NOT THE TABLE. The `.limit()` above is applied
    // by Postgres BEFORE this runs, so a matching row that sorts past the limit
    // is invisible. The limit is hard-capped at 50 by clampLimit, whatever the
    // caller asks for. With `include_archived: true` the archived rows crowd
    // that window and a tag that plainly exists comes back as an empty array —
    // which reads as "the tag filter is broken" and has already been
    // misdiagnosed once as a stale deploy. It is not broken; it is narrow.
    // Filed as its own item. The fix is to move the predicate into the query.
    let filtered = intents;
    if (params.tags && params.tags.length > 0) {
      filtered = intents.filter((row: { tags: string[] | null }) =>
        params.tags!.some((tag) => (row.tags || []).includes(tag))
      );
    }

    // Resolve context names (same pattern as search_items).
    const contextIds = [
      ...new Set(
        filtered
          .map((r: { context_id: string | null }) => r.context_id)
          .filter(Boolean)
      ),
    ];
    let contextMap: Record<string, string> = {};
    if (contextIds.length > 0) {
      const { data: contexts } = await client
        .from("contexts")
        .select("id, name")
        .in("id", contextIds);
      if (contexts) {
        contextMap = Object.fromEntries(
          contexts.map((c: { id: string; name: string }) => [c.id, c.name])
        );
      }
    }

    const results = filtered.map(
      (row: { context_id: string | null; [key: string]: unknown }) => ({
        ...row,
        context_name: row.context_id ? contextMap[row.context_id] || null : null,
      })
    );

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getEvents(
  client: SupabaseClient,
  params: {
    date_from?: string;
    date_to?: string;
    context_id?: string;
    intent_id?: string;
    include_archived?: boolean;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    const limit = params.limit || 50;

    let query = client
      .from("events")
      .select(
        "id, intent_id, time, item_ids, context_id, collection_id, text, created_at, updated_at"
      )
      .order("time", { ascending: true })
      .limit(limit);

    if (!params.include_archived) {
      query = query.eq("archived", false);
    }
    if (params.date_from) {
      query = query.gte("time", params.date_from);
    }
    if (params.date_to) {
      query = query.lte("time", params.date_to);
    }
    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }
    if (params.intent_id) {
      query = query.eq("intent_id", params.intent_id);
    }

    const { data: events, error } = await query;
    if (error) return { error: error.message };
    if (!events || events.length === 0) return { data: [] };

    // Resolve intent text.
    const intentIds = [
      ...new Set(
        events
          .map((e: { intent_id: string | null }) => e.intent_id)
          .filter(Boolean)
      ),
    ];
    let intentMap: Record<string, string> = {};
    if (intentIds.length > 0) {
      const { data: intents } = await client
        .from("intents")
        .select("id, text")
        .in("id", intentIds);
      if (intents) {
        intentMap = Object.fromEntries(
          intents.map((i: { id: string; text: string }) => [i.id, i.text])
        );
      }
    }

    // Resolve context names.
    const contextIds = [
      ...new Set(
        events
          .map((e: { context_id: string | null }) => e.context_id)
          .filter(Boolean)
      ),
    ];
    let contextMap: Record<string, string> = {};
    if (contextIds.length > 0) {
      const { data: contexts } = await client
        .from("contexts")
        .select("id, name")
        .in("id", contextIds);
      if (contexts) {
        contextMap = Object.fromEntries(
          contexts.map((c: { id: string; name: string }) => [c.id, c.name])
        );
      }
    }

    const results = events.map(
      (row: {
        context_id: string | null;
        intent_id: string | null;
        [key: string]: unknown;
      }) => ({
        ...row,
        intent_text: row.intent_id ? intentMap[row.intent_id] || null : null,
        context_name: row.context_id ? contextMap[row.context_id] || null : null,
      })
    );

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * List collections with their current membership.
 *
 * Membership comes from `collection_items`, one row per member, ordered by
 * `position` so it matches what the app shows. The `item_collections.items`
 * jsonb column is a frozen pre-migration snapshot — it is deliberately NOT
 * selected, because reading it reports membership as it stood before the
 * cutover and the stale data looks entirely plausible.
 *
 * Item names are resolved in one batched lookup. RLS filters that lookup, so an
 * id that comes back unmatched means the item was deleted OR is unreadable to
 * this caller — an item is readable through ownership or a shared context, and
 * collection membership grants nothing. The two are indistinguishable from here
 * and neither is an error. Such a member is reported as
 * `{ name: null, unavailable: true }` rather than falling back to its id, so
 * nothing downstream presents an opaque id as though it were a product name.
 *
 * `client` is always a user-scoped client supplied by the caller (`ctx.db` from
 * defineTool, `createUserClient` from ai-enrich). RLS is the access gate here;
 * the service role must never be passed in.
 */
export async function getCollections(
  client: SupabaseClient,
  params: { context_id?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("item_collections")
      .select("id, name, context_id, shared, is_capture_target")
      .order("name");

    if (params.context_id) {
      query = query.eq("context_id", params.context_id);
    }

    const { data: collections, error } = await query;
    if (error) return { error: error.message };

    const rows = (collections ?? []) as Array<Record<string, unknown> & { id: string }>;
    if (rows.length === 0) return { data: [] };

    const { data: memberData, error: memberError } = await client
      .from("collection_items")
      .select("collection_id, item_id, quantity, position")
      .in("collection_id", rows.map((c) => c.id))
      .order("collection_id")
      .order("position");

    if (memberError) return { error: memberError.message };
    const members = (memberData ?? []) as Array<{
      collection_id: string;
      item_id: string;
      quantity: string | null;
      position: number;
    }>;

    const names = new Map<string, string | null>();
    const itemIds = [...new Set(members.map((m) => m.item_id))];
    if (itemIds.length > 0) {
      const { data: itemData, error: itemError } = await client
        .from("items")
        .select("id, name")
        .in("id", itemIds);
      if (itemError) return { error: itemError.message };
      for (const item of (itemData ?? []) as Array<{ id: string; name: string | null }>) {
        names.set(item.id, item.name ?? null);
      }
    }

    const byCollection = new Map<string, Array<Record<string, unknown>>>();
    for (const member of members) {
      const name = names.get(member.item_id) ?? null;
      const entry: Record<string, unknown> = {
        item_id: member.item_id,
        name,
        quantity: member.quantity,
      };
      if (name === null) entry.unavailable = true;

      const list = byCollection.get(member.collection_id);
      if (list) list.push(entry);
      else byCollection.set(member.collection_id, [entry]);
    }

    return {
      data: rows.map((collection) => ({
        ...collection,
        items: byCollection.get(collection.id) ?? [],
      })),
    };
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
      // Normalised, not stored verbatim. A model supplies these, and they flow
      // into items.tags / intents.tags unchanged on triage if the user never
      // opens the tag box — so this is a write path that could otherwise put a
      // non-canonical tag in the database. See _shared/tags.ts.
      suggested_tags: normaliseTags(params.suggested_tags),
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
    // Normalised on the way in, same reasoning as createInboxItem above. Also
    // covers the MCP update_inbox_item tool, which delegates here.
    if (params.suggested_tags !== undefined) updates.suggested_tags = normaliseTags(params.suggested_tags);
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

/**
 * Which of these songs have a bar that is PLAYED more than once.
 *
 * Measures are stored written-out — a repeated bar becomes several rows with
 * the same `source_measure`, the printed number — so a repeat shows up as
 * source numbers that are not all distinct. A song whose measures carry no
 * source_measure at all cannot be judged and maps to null rather than false.
 *
 * Returns a map of song_id -> boolean | null. Never throws: an unreadable
 * answer is worth less than the rest of the row, so on error every song maps
 * to null and the listing still returns.
 */
async function songsWithRepeats(
  client: SupabaseClient,
  songIds: string[]
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  if (!songIds.length) return out;
  try {
    const { data, error } = await client
      .from("sam_song_measures")
      .select("song_id, source_measure")
      .in("song_id", songIds);
    if (error || !data) return out;
    const seen = new Map<string, { total: number; sources: Set<string>; withSource: number }>();
    for (const row of data as { song_id: string; source_measure: string | null }[]) {
      let e = seen.get(row.song_id);
      if (!e) { e = { total: 0, sources: new Set(), withSource: 0 }; seen.set(row.song_id, e); }
      e.total++;
      if (row.source_measure != null) { e.withSource++; e.sources.add(String(row.source_measure)); }
    }
    for (const [id, e] of seen) {
      out.set(id, e.withSource === 0 ? null : e.sources.size < e.withSource);
    }
    return out;
  } catch {
    return out;
  }
}

export async function getSamSongs(
  client: SupabaseClient,
  params: { search_text?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("sam_songs")
      // source_xml_path (M8 upload wiring) — populated by SongLoader
      // when a MusicXML import succeeds; null for JSON imports, drills,
      // or MusicXML imports whose Storage upload failed. Exposed here
      // so Alex can verify post-re-import coverage over MCP instead of
      // eyeballing the dashboard.
      // song_type / parent_song_id say what a row IS — an original, a
      // simplified arrangement of another song, or a drill — and which song it
      // belongs under. Without them a reader treats a drill's numbers as if
      // they were the real piece's.
      .select("id, title, artist, source, song_type, parent_song_id, audio_file_path, key_signature, time_signature, default_bpm, goal_bpm, goal_playback_speed, goal_effective_bpm, goal_set_at, source_xml_path, created_at, updated_at")
      .eq("archived", false)
      .order("title");

    if (params.search_text) {
      query = query.or(
        `title.ilike.%${params.search_text}%,artist.ilike.%${params.search_text}%`
      );
    }

    const { data, error } = await query;
    if (error) return { error: error.message };

    const songs = (data ?? []) as Record<string, unknown>[];
    const repeats = await songsWithRepeats(client, songs.map((s) => s.id as string));
    return {
      data: songs.map((s) => ({
        ...s,
        has_audio: s.audio_file_path != null,
        // Whether any bar is played more than once. A whole-song rollup over a
        // song with repeats counts those bars twice, which is right for "how
        // much did I play" and wrong for "how well do I know this bar".
        has_repeats: repeats.get(s.id as string) ?? null,
      })),
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getSamSessions(
  client: SupabaseClient,
  params: {
    song_id?: string;
    snippet_id?: string;
    date_from?: string;
    date_to?: string;
    plan_id?: string;
    plan_item_id?: string;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    let query = client
      .from("sam_sessions")
      .select("id, song_id, snippet_id, plan_id, plan_item_id, started_at, ended_at, settings, summary")
      .order("started_at", { ascending: false })
      .limit(params.limit || 20);

    if (params.song_id) {
      query = query.eq("song_id", params.song_id);
    }

    if (params.snippet_id) {
      query = query.eq("snippet_id", params.snippet_id);
    }

    if (params.date_from) {
      query = query.gte("started_at", params.date_from);
    }

    if (params.date_to) {
      query = query.lte("started_at", params.date_to);
    }

    // Practice plans (M3). plan_id is the plan active when the session began;
    // plan_item_id the item matching its song and snippet. History only.
    if (params.plan_id) {
      query = query.eq("plan_id", params.plan_id);
    }

    if (params.plan_item_id) {
      query = query.eq("plan_item_id", params.plan_item_id);
    }

    const { data: sessions, error } = await query;
    if (error) return { error: error.message };

    // Join song titles
    const songIds = [...new Set((sessions || []).map((s: { song_id: string | null }) => s.song_id).filter(Boolean))];
    let songMap: Record<string, { title: string; artist: string | null }> = {};

    if (songIds.length > 0) {
      const { data: songs } = await client
        .from("sam_songs")
        .select("id, title, artist")
        .in("id", songIds);
      if (songs) {
        songMap = Object.fromEntries(songs.map((s: { id: string; title: string; artist: string | null }) => [s.id, { title: s.title, artist: s.artist }]));
      }
    }

    // Join snippet titles
    const snippetIds = [...new Set((sessions || []).map((s: { snippet_id: string | null }) => s.snippet_id).filter(Boolean))];
    let snippetMap: Record<string, string> = {};

    if (snippetIds.length > 0) {
      const { data: snippets } = await client
        .from("sam_snippets")
        .select("id, title")
        .in("id", snippetIds);
      if (snippets) {
        snippetMap = Object.fromEntries(snippets.map((s: { id: string; title: string }) => [s.id, s.title]));
      }
    }

    const results = (sessions || []).map((session: { song_id: string | null; snippet_id: string | null; [key: string]: unknown }) => ({
      ...session,
      song_title: session.song_id ? songMap[session.song_id]?.title || null : null,
      song_artist: session.song_id ? songMap[session.song_id]?.artist || null : null,
      snippet_title: session.snippet_id ? snippetMap[session.snippet_id] || null : null,
    }));

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Completed playthroughs from sam_passes (M5).
 *
 * A pass is one complete playthrough of whatever range was loaded — the whole
 * song when snippet_id is null, otherwise that snippet. Practice instructions
 * are written as a tempo plus a number of passes ("Pastorale No. 3 at 60, four
 * to six passes"), so this is the tool that answers whether an instruction was
 * followed.
 *
 * `bpm` is the tempo at the instant the pass FINISHED, not when it started, and
 * is the authoritative per-pass tempo. `effective_bpm` is what was actually
 * heard: bpm scaled by playback_speed, generated by Postgres.
 *
 * `playback_speed` NULL means NOT RECORDED, not 100 — every pass written before
 * 2026-09-16 predates the column, and `effective_bpm` is NULL for those rows
 * too. Treat their tempo as "bpm, speed unknown" rather than assuming full
 * speed. The same convention covers hits, misses, notes_played, accuracy_percent
 * and hand_mode.
 *
 * `notes_played` is 0 for a playback test — a miss is raised on elapsed time
 * without consulting MIDI, so a pass with no keyboard attached scores 0 hits
 * and a full count of misses, indistinguishable from playing badly by any other
 * field. `accuracy_percent` is NULL rather than 0 for those rows: NULL means
 * unmeasurable, 0 means measured and every note wrong.
 */
export async function getSamPasses(
  client: SupabaseClient,
  params: {
    song_id?: string;
    snippet_id?: string;
    whole_song_only?: boolean;
    exclude_zero_note?: boolean;
    only_zero_note?: boolean;
    date_from?: string;
    date_to?: string;
    plan_id?: string;
    plan_item_id?: string;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    let query = client
      .from("sam_passes")
      .select("id, song_id, snippet_id, session_id, plan_id, plan_item_id, bpm, playback_speed, effective_bpm, hits, misses, notes_played, accuracy_percent, hand_mode, completed_at")
      .order("completed_at", { ascending: false })
      .limit(params.limit || 20);

    if (params.song_id) {
      query = query.eq("song_id", params.song_id);
    }

    if (params.snippet_id) {
      query = query.eq("snippet_id", params.snippet_id);
    }

    // Whole-song passes are rows with a NULL snippet_id. This is a different
    // question from "no snippet filter given", so it needs its own parameter
    // rather than being inferred from the absence of snippet_id.
    if (params.whole_song_only) {
      query = query.is("snippet_id", null);
    }

    // `notes_played` has THREE states, and these two filters are deliberately
    // NOT opposites:
    //
    //   > 0    played, and measurable
    //   = 0    a playback test — nothing arrived
    //   NULL   never recorded (the pass predates the column being deployed
    //          part-way through 2026-09-16)
    //
    // `.gt(0)` and `.eq(0)` both exclude NULL, so a caller applying one and
    // then the other does not cover the set. That is correct — an unknown is
    // not a known, and promoting NULL into either bucket would be a guess — but
    // it is easy to misread from the parameter names alone, so the tool
    // description says so explicitly.
    if (params.exclude_zero_note) {
      query = query.gt("notes_played", 0);
    }

    if (params.only_zero_note) {
      query = query.eq("notes_played", 0);
    }

    if (params.date_from) {
      query = query.gte("completed_at", params.date_from);
    }

    if (params.date_to) {
      query = query.lte("completed_at", params.date_to);
    }

    // Practice plans (M3). Recorded for history only: plan progress matches
    // passes on song and snippet, never on these columns.
    if (params.plan_id) {
      query = query.eq("plan_id", params.plan_id);
    }

    if (params.plan_item_id) {
      query = query.eq("plan_item_id", params.plan_item_id);
    }

    const { data: passes, error } = await query;
    if (error) return { error: error.message };

    const songIds = [...new Set((passes || []).map((p: { song_id: string | null }) => p.song_id).filter(Boolean))];
    let songMap: Record<string, { title: string; artist: string | null }> = {};

    if (songIds.length > 0) {
      const { data: songs } = await client
        .from("sam_songs")
        .select("id, title, artist")
        .in("id", songIds);
      if (songs) {
        songMap = Object.fromEntries(songs.map((s: { id: string; title: string; artist: string | null }) => [s.id, { title: s.title, artist: s.artist }]));
      }
    }

    const snippetIds = [...new Set((passes || []).map((p: { snippet_id: string | null }) => p.snippet_id).filter(Boolean))];
    let snippetMap: Record<string, string> = {};

    if (snippetIds.length > 0) {
      const { data: snippets } = await client
        .from("sam_snippets")
        .select("id, title")
        .in("id", snippetIds);
      if (snippets) {
        snippetMap = Object.fromEntries(snippets.map((s: { id: string; title: string }) => [s.id, s.title]));
      }
    }

    const results = (passes || []).map((pass: { song_id: string | null; snippet_id: string | null; [key: string]: unknown }) => ({
      ...pass,
      song_title: pass.song_id ? songMap[pass.song_id]?.title || null : null,
      song_artist: pass.song_id ? songMap[pass.song_id]?.artist || null : null,
      // Null snippet_id means the pass was the whole song, and saying so
      // explicitly stops a reader treating it as an unresolved lookup.
      range_title: pass.snippet_id ? snippetMap[pass.snippet_id] || null : "Whole song",
    }));

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getSamSnippets(
  client: SupabaseClient,
  params: { song_id?: string; search_text?: string }
): Promise<ToolResult> {
  try {
    let query = client
      .from("sam_snippets")
      .select("id, song_id, title, start_measure, end_measure, rest_measures, settings, tags, notes, created_at")
      .eq("archived", false)
      .order("song_id")
      .order("start_measure");

    if (params.song_id) {
      query = query.eq("song_id", params.song_id);
    }

    if (params.search_text) {
      query = query.or(
        `title.ilike.%${params.search_text}%,notes.ilike.%${params.search_text}%`
      );
    }

    const { data: snippets, error } = await query;
    if (error) return { error: error.message };

    // Join song titles
    const songIds = [...new Set((snippets || []).map((s: { song_id: string | null }) => s.song_id).filter(Boolean))];
    let songMap: Record<string, { title: string; artist: string | null }> = {};

    if (songIds.length > 0) {
      const { data: songs } = await client
        .from("sam_songs")
        .select("id, title, artist")
        .in("id", songIds);
      if (songs) {
        songMap = Object.fromEntries(songs.map((s: { id: string; title: string; artist: string | null }) => [s.id, { title: s.title, artist: s.artist }]));
      }
    }

    const results = (snippets || []).map((snippet: { song_id: string | null; [key: string]: unknown }) => ({
      ...snippet,
      song_title: snippet.song_id ? songMap[snippet.song_id]?.title || null : null,
      song_artist: snippet.song_id ? songMap[snippet.song_id]?.artist || null : null,
    }));

    return { data: results };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- SAM Song Measures & Lyrics ----

export async function getSamSongMeasures(
  client: SupabaseClient,
  params: { song_id: string; start_measure?: number; end_measure?: number }
): Promise<ToolResult> {
  try {
    // 1. Fetch song metadata
    const { data: song, error: songError } = await client
      .from("sam_songs")
      .select("id, title, artist, song_type, parent_song_id, audio_file_path, default_bpm, goal_bpm, goal_playback_speed, goal_effective_bpm, goal_set_at, time_signature, key_signature")
      .eq("id", params.song_id)
      .single();

    if (songError) return { error: songError.message };

    // 2. Fetch total measure count
    const { count: totalMeasures } = await client
      .from("sam_song_measures")
      .select("*", { count: "exact", head: true })
      .eq("song_id", params.song_id);

    // 3. Fetch measures with optional range filter
    let query = client
      .from("sam_song_measures")
      .select("number, rh, lh, time_signature, audio_offset_ms, chord, section, source_measure")
      .eq("song_id", params.song_id)
      .order("number", { ascending: true });

    if (params.start_measure) query = query.gte("number", params.start_measure);
    if (params.end_measure) query = query.lte("number", params.end_measure);

    const { data: measures, error: measError } = await query;
    if (measError) return { error: measError.message };

    // 4. Fetch placed lyrics for the same range
    let lyricsQuery = client
      .from("sam_song_lyrics")
      .select("measure_num, rh_index, syllable, word_order")
      .eq("song_id", params.song_id)
      .not("measure_num", "is", null)
      .order("word_order", { ascending: true });

    if (params.start_measure) lyricsQuery = lyricsQuery.gte("measure_num", params.start_measure);
    if (params.end_measure) lyricsQuery = lyricsQuery.lte("measure_num", params.end_measure);

    const { data: lyrics } = await lyricsQuery;

    // 4b. Fetch placed RH fingerings for the same range. Raw rows (both
    // 'manual' and 'musicxml' with their source), not render-resolved — an
    // authoring reader wants the full picture, and precedence is a render
    // concern. Coordinate is (measure_num, rh_index, note_index).
    let fingeringsQuery = client
      .from("sam_song_fingerings")
      .select("measure_num, rh_index, note_index, finger, source")
      .eq("song_id", params.song_id)
      .order("measure_num", { ascending: true })
      .order("rh_index", { ascending: true });

    if (params.start_measure) fingeringsQuery = fingeringsQuery.gte("measure_num", params.start_measure);
    if (params.end_measure) fingeringsQuery = fingeringsQuery.lte("measure_num", params.end_measure);

    const { data: fingerings } = await fingeringsQuery;

    // 5. Format measures for readability
    const formatted = (measures || []).map((m: { number: number; rh: unknown[] | null; lh: unknown[] | null; time_signature: unknown; audio_offset_ms: number | null; chord: string | null; section: string | null; source_measure: number | null }) => {
      const rhEvents = (m.rh || []) as { duration: string; notes?: { name: string }[] }[];
      const rhDisplay = rhEvents.map((evt, idx) => {
        const noteNames = (evt.notes || []).map(n => n.name).join("+") || "rest";
        return `[${idx}] ${evt.duration} - ${noteNames}`;
      });

      const lhEvents = (m.lh || []) as { duration: string; notes?: { name: string }[] }[];
      const lhDisplay = lhEvents.map((evt, idx) => {
        const noteNames = (evt.notes || []).map(n => n.name).join("+") || "rest";
        return `[${idx}] ${evt.duration} - ${noteNames}`;
      });

      const measLyrics = (lyrics || []).filter((l: { measure_num: number }) => l.measure_num === m.number);
      const measFingerings = (fingerings || []).filter((f: { measure_num: number }) => f.measure_num === m.number);

      return {
        number: m.number,
        // source_measure: printed number from the source XML. Populated
        // by M4 parser when it differs from `number` (repeat/D.S. plays
        // renumber; Für Elise pickup starts at "0"). Null = same as
        // `number` per the column comment.
        source_measure: m.source_measure,
        chord: m.chord || null,
        section: m.section || null,
        audio_offset_ms: m.audio_offset_ms,
        time_signature: m.time_signature,
        rh_events: rhDisplay,
        rh_event_count: rhEvents.length,
        lh_events: lhDisplay,
        lh_event_count: lhEvents.length,
        placed_lyrics: measLyrics.map((l: { rh_index: number; syllable: string; word_order: number }) => ({
          rh_index: l.rh_index,
          syllable: l.syllable,
          word_order: l.word_order,
        })),
        placed_fingerings: measFingerings.map((f: { rh_index: number; note_index: number; finger: number; source: string }) => ({
          rh_index: f.rh_index,
          note_index: f.note_index,
          finger: f.finger,
          source: f.source,
        })),
      };
    });

    // Asked over the WHOLE song, not the requested range: a range that happens
    // to hold no repeated bar says nothing about the piece.
    const repeatMap = await songsWithRepeats(client, [params.song_id]);

    return {
      data: {
        song: {
          title: song.title,
          artist: song.artist,
          // What this row IS, and what it hangs under: an original, a
          // simplified arrangement, or a drill. A drill's numbers are not the
          // real piece's.
          song_type: song.song_type ?? null,
          parent_song_id: song.parent_song_id ?? null,
          has_audio: song.audio_file_path != null,
          // Any bar played more than once. A whole-song rollup over a song
          // with repeats counts those bars twice — right for "how much did I
          // play", wrong for "how well do I know this bar".
          has_repeats: repeatMap.get(params.song_id) ?? null,
          bpm: song.default_bpm,
          goal_bpm: song.goal_bpm,
          goal_playback_speed: song.goal_playback_speed,
          goal_effective_bpm: song.goal_effective_bpm,
          // Null = the goal is a placeholder, not a confirmed target.
          goal_set_at: song.goal_set_at,
        },
        total_measures: totalMeasures || 0,
        measures: formatted,
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function getSamLyricWorkspace(
  client: SupabaseClient,
  params: { song_id: string; batch_size?: number }
): Promise<ToolResult> {
  try {
    const batchSize = params.batch_size || 8;

    // 1. Find the last measure that has any placed lyrics
    const { data: lastPlaced } = await client
      .from("sam_song_lyrics")
      .select("measure_num")
      .eq("song_id", params.song_id)
      .not("measure_num", "is", null)
      .order("measure_num", { ascending: false })
      .limit(1);

    const startFrom = (lastPlaced as { measure_num: number }[] | null)?.[0]?.measure_num || 1;
    const endAt = startFrom + batchSize - 1;

    // 2. Fetch measures for this range (reuse getSamSongMeasures logic)
    const measResult = await getSamSongMeasures(client, {
      song_id: params.song_id,
      start_measure: startFrom,
      end_measure: endAt,
    });

    if (measResult.error) return measResult;

    // 3. Fetch unplaced syllables (next 50)
    const { data: unplaced } = await client
      .from("sam_song_lyrics")
      .select("word_order, syllable")
      .eq("song_id", params.song_id)
      .is("measure_num", null)
      .order("word_order", { ascending: true })
      .limit(50);

    // 4. Get placement stats
    const { count: totalSyllables } = await client
      .from("sam_song_lyrics")
      .select("*", { count: "exact", head: true })
      .eq("song_id", params.song_id);

    const { count: placedCount } = await client
      .from("sam_song_lyrics")
      .select("*", { count: "exact", head: true })
      .eq("song_id", params.song_id)
      .not("measure_num", "is", null);

    const measData = measResult.data as { song: unknown; measures: unknown[] };

    return {
      data: {
        progress: `${placedCount || 0}/${totalSyllables || 0} syllables placed`,
        measures_shown: `${startFrom}-${endAt}`,
        song: measData.song,
        measures: measData.measures,
        unplaced_syllables: unplaced || [],
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function placeSamLyrics(
  client: SupabaseClient,
  params: { song_id: string; starting_word_order: number; placements: number[][] }
): Promise<ToolResult> {
  try {
    // 1. Validate starting_word_order is the next unplaced syllable
    const { data: nextUnplaced } = await client
      .from("sam_song_lyrics")
      .select("word_order")
      .eq("song_id", params.song_id)
      .is("measure_num", null)
      .order("word_order", { ascending: true })
      .limit(1);

    const nextOrder = (nextUnplaced as { word_order: number }[] | null)?.[0]?.word_order;
    if (nextOrder == null || nextOrder !== params.starting_word_order) {
      return {
        error: `Continuity error: next unplaced word_order is ${nextOrder}, but starting_word_order is ${params.starting_word_order}`,
      };
    }

    // 2. Validate monotonic ordering within batch
    for (let i = 1; i < params.placements.length; i++) {
      const [prevMeas, prevIdx] = params.placements[i - 1];
      const [curMeas, curIdx] = params.placements[i];
      if (curMeas < prevMeas || (curMeas === prevMeas && curIdx <= prevIdx)) {
        return {
          error: `Monotonic error at position ${i}: [${curMeas},${curIdx}] must be after [${prevMeas},${prevIdx}]`,
        };
      }
    }

    // 3. Validate first placement is after last placed syllable from prior batches
    const { data: lastPlacedRow } = await client
      .from("sam_song_lyrics")
      .select("measure_num, rh_index")
      .eq("song_id", params.song_id)
      .not("measure_num", "is", null)
      .order("word_order", { ascending: false })
      .limit(1);

    if ((lastPlacedRow as unknown[] | null)?.length) {
      const lp = (lastPlacedRow as { measure_num: number; rh_index: number }[])[0];
      const [firstMeas, firstIdx] = params.placements[0];
      if (firstMeas < lp.measure_num || (firstMeas === lp.measure_num && firstIdx <= lp.rh_index)) {
        return {
          error: `Continuity error: first placement [${firstMeas},${firstIdx}] must be after last placed [${lp.measure_num},${lp.rh_index}]`,
        };
      }
    }

    // 4. Validate rh_index bounds
    const measureNums = [...new Set(params.placements.map(p => p[0]))];
    const { data: measures } = await client
      .from("sam_song_measures")
      .select("number, rh")
      .eq("song_id", params.song_id)
      .in("number", measureNums);

    const measMap: Record<number, { notes?: unknown[] }[]> = {};
    for (const m of (measures as { number: number; rh: { notes?: unknown[] }[] }[] || [])) {
      measMap[m.number] = m.rh || [];
    }

    for (let i = 0; i < params.placements.length; i++) {
      const [measNum, rhIdx] = params.placements[i];
      const rh = measMap[measNum];
      if (!rh) {
        return { error: `Measure ${measNum} not found` };
      }
      if (rhIdx < 0 || rhIdx >= rh.length) {
        return { error: `rh_index ${rhIdx} out of bounds for measure ${measNum} (has ${rh.length} events)` };
      }
      const evt = rh[rhIdx];
      if (!evt.notes || evt.notes.length === 0) {
        return { error: `rh_index ${rhIdx} in measure ${measNum} is a rest — cannot place lyric` };
      }
    }

    // 5. Write placements
    for (let i = 0; i < params.placements.length; i++) {
      const wordOrder = params.starting_word_order + i;
      const [measNum, rhIdx] = params.placements[i];

      const { error } = await client
        .from("sam_song_lyrics")
        .update({
          measure_num: measNum,
          rh_index: rhIdx,
          updated_at: new Date().toISOString(),
        })
        .eq("song_id", params.song_id)
        .eq("word_order", wordOrder);

      if (error) return { error: error.message };
    }

    return {
      data: {
        placed: params.placements.length,
        word_orders: `${params.starting_word_order}-${params.starting_word_order + params.placements.length - 1}`,
        message: "Lyrics placed. Recompilation triggered — check the app to verify.",
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function updateSamSongMeasures(
  client: SupabaseClient,
  params: { song_id: string; updates: { measure_num: number; chord?: string; section?: string; audio_offset_ms?: number }[] }
): Promise<ToolResult> {
  try {
    const ALLOWED_FIELDS = ["chord", "section", "audio_offset_ms"] as const;

    for (const update of params.updates) {
      const fields: Record<string, unknown> = {};
      for (const key of ALLOWED_FIELDS) {
        if ((update as Record<string, unknown>)[key] !== undefined) {
          fields[key] = (update as Record<string, unknown>)[key];
        }
      }

      if (Object.keys(fields).length === 0) continue;

      fields.updated_at = new Date().toISOString();

      const { error } = await client
        .from("sam_song_measures")
        .update(fields)
        .eq("song_id", params.song_id)
        .eq("number", update.measure_num);

      if (error) return { error: error.message };
    }

    return {
      data: {
        updated: params.updates.length,
        message: "Measure metadata updated. Recompilation triggered.",
      },
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export async function loadSamLyrics(
  client: SupabaseClient,
  params: { song_id: string; syllables: string[]; replace?: boolean }
): Promise<ToolResult> {
  try {
    if (params.replace) {
      const { error: delError } = await client
        .from("sam_song_lyrics")
        .delete()
        .eq("song_id", params.song_id);
      if (delError) return { error: delError.message };
    }

    // Get current max word_order to append
    const { data: maxRow } = await client
      .from("sam_song_lyrics")
      .select("word_order")
      .eq("song_id", params.song_id)
      .order("word_order", { ascending: false })
      .limit(1);

    const startOrder = ((maxRow as { word_order: number }[] | null)?.[0]?.word_order || 0) + 1;

    const rows = params.syllables.map((syl, i) => ({
      song_id: params.song_id,
      word_order: startOrder + i,
      syllable: syl,
      measure_num: null,
      rh_index: null,
    }));

    // Insert in batches
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const { error } = await client
        .from("sam_song_lyrics")
        .insert(rows.slice(i, i + BATCH_SIZE));
      if (error) return { error: error.message };
    }

    return {
      data: {
        loaded: rows.length,
        word_orders: `${startOrder}-${startOrder + rows.length - 1}`,
        message: `${rows.length} syllables loaded. Use get_sam_lyric_workspace to begin placement.`,
      },
    };
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
