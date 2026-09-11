// ============================================================================
// supabase/functions/_shared/tools/ken.ts
//
// Ken's tool surface. Every handler reaches the database only through ctx.db.
//
// Naming follows the house verb_app_noun pattern (get_sam_songs, record_dj_plays),
// so the design doc's get_quiz_batch / record_attempt / add_item become
// get_ken_quiz_batch / record_ken_attempts / create_ken_item. Same tools, names
// that survive sharing one manifest with Alfred, SAM and DJ.
// ============================================================================

import { defineTool, clampLimit, envelope } from "../platform.ts";

// Columns that are safe to list. tricky_fragments is deliberately absent —
// it is heavy jsonb and is lazy-loaded by get_ken_lyric_fragments.
const ITEM_COLS =
  "id, area_id, subtopic, tags, mode, accuracy, volatility, prompt, " +
  "ground_truth, verified_at, mastery, priority, status, superseded_by, " +
  "last_seen, created_at";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A value inside a PostgREST or()/in() filter. Free text (a subtopic) can hold
// the filter grammar's reserved characters — , . : ( ) — so it is always
// double-quoted, with backslash and quote escaped.
const pgrstQuote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------------------
// get_ken_quiz_batch — tier 1
//
// Fat by design. One call returns the selected items, their recent attempts and
// the misconceptions that bear on them, so the following ten conversational
// turns need no further reads.
// ---------------------------------------------------------------------------

export const getKenQuizBatchTool = defineTool({
  name: "get_ken_quiz_batch",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);

    // Selection is weighted-random and must happen before the LIMIT, which is
    // why it lives in Postgres. .select() narrows the returned columns so the
    // heavy jsonb never rides along.
    const { data: items, error: itemsErr } = await ctx.db
      .rpc("ken_select_batch", {
        p_limit: LIMIT,
        p_area_id: (args.area_id as string | undefined) ?? null,
        p_mode: (args.mode as string | undefined) ?? null,
      })
      .select(ITEM_COLS);

    if (itemsErr) throw new Error(`get_ken_quiz_batch: ${itemsErr.message}`);

    const rows = items ?? [];
    if (rows.length === 0) {
      return envelope({ items: [], attempts: [], misconceptions: [] }, {
        limit_applied: LIMIT,
        truncated: false,
      });
    }

    const ids = rows.map((r: { id: string }) => r.id);
    const subtopics = [
      ...new Set(
        rows
          .map((r: { subtopic: string | null }) => r.subtopic)
          .filter((s: string | null): s is string => !!s),
      ),
    ];

    // Recent attempts across the batch. Bounded by construction: at most a
    // handful per item, and the batch itself is already clamped.
    const { data: attempts, error: attemptsErr } = await ctx.db
      .from("ken_attempts")
      .select("id, item_id, result, user_answer, ken_assessment, asked_at")
      .in("item_id", ids)
      .order("asked_at", { ascending: false })
      .limit(ids.length * 5);

    if (attemptsErr) throw new Error(`get_ken_quiz_batch: ${attemptsErr.message}`);

    // Misconceptions touching the batch: anchored to either side of a
    // confusion pair, OR scoped only to a subtopic (no item) that a batch item
    // sits in. Item-anchored misconceptions on items outside the batch are not
    // pulled in just for sharing a subtopic — only the subtopic-scoped ones.
    const idList = ids.join(",");
    const scopes = [`item_id.in.(${idList})`, `related_item_id.in.(${idList})`];
    if (subtopics.length > 0) {
      scopes.push(
        `and(item_id.is.null,subtopic.in.(${subtopics.map(pgrstQuote).join(",")}))`,
      );
    }
    const { data: misconceptions, error: miscErr } = await ctx.db
      .from("ken_misconceptions")
      .select("id, item_id, related_item_id, subtopic, note, status, updated_at")
      .eq("status", "active")
      .or(scopes.join(","))
      .limit(50);

    if (miscErr) throw new Error(`get_ken_quiz_batch: ${miscErr.message}`);

    return envelope(
      {
        items: rows,
        attempts: attempts ?? [],
        misconceptions: misconceptions ?? [],
      },
      { limit_applied: LIMIT, truncated: false },
    );
  },
});

// ---------------------------------------------------------------------------
// record_ken_attempts — tier 1 (append + own progress state)
//
// Takes the whole buffered batch. Ken holds results in the conversation and
// flushes at natural seams — a topic change, a pause, or the batch running dry.
// ---------------------------------------------------------------------------

export const recordKenAttemptsTool = defineTool({
  name: "record_ken_attempts",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const attempts = args.attempts;

    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new Error("record_ken_attempts: attempts must be a non-empty array");
    }
    if (attempts.length > 50) {
      throw new Error(
        `record_ken_attempts: batch capped at 50, got ${attempts.length}. ` +
          "Flush more often.",
      );
    }

    const { data, error } = await ctx.db.rpc("ken_record_attempts", {
      p_attempts: attempts,
    });

    if (error) throw new Error(`record_ken_attempts: ${error.message}`);

    // Returns the new mastery per item so Ken can see the move without a re-read.
    return envelope(data ?? []);
  },
});

// ---------------------------------------------------------------------------
// create_ken_area / create_ken_item — tier 1, additive
// ---------------------------------------------------------------------------

export const createKenAreaTool = defineTool({
  name: "create_ken_area",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const { data, error } = await ctx.db
      .from("ken_areas")
      .insert({
        name: args.name as string,
        description: (args.description as string | undefined) ?? null,
        source_ref: (args.source_ref as string | undefined) ?? null,
        priority: (args.priority as number | undefined) ?? 1.0,
      })
      .select("id, name, description, source_ref, priority, created_at")
      .single();

    if (error) throw new Error(`create_ken_area: ${error.message}`);
    return envelope(data);
  },
});

export const createKenItemTool = defineTool({
  name: "create_ken_item",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const mode = args.mode as string;

    // Defaults live here, not in the schema, because any item may override them.
    const accuracy =
      (args.accuracy as string | undefined) ??
      (mode === "concept" ? "loose" : "strict");

    const volatility =
      accuracy === "strict"
        ? ((args.volatility as string | undefined) ?? "stable")
        : null;

    const { data, error } = await ctx.db
      .from("ken_items")
      .insert({
        area_id: args.area_id as string,
        subtopic: (args.subtopic as string | undefined) ?? null,
        tags: (args.tags as string[] | undefined) ?? [],
        mode,
        accuracy,
        volatility,
        prompt: args.prompt as string,
        ground_truth: mode === "procedure"
          ? null
          : ((args.ground_truth as string | undefined) ?? null),
        verified_at: (args.verified_at as string | undefined) ?? null,
        tricky_fragments: (args.tricky_fragments as unknown) ?? null,
        priority: (args.priority as number | undefined) ?? 1.0,
      })
      .select(ITEM_COLS)
      .single();

    if (error) throw new Error(`create_ken_item: ${error.message}`);
    return envelope(data);
  },
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const getKenAreasTool = defineTool({
  name: "get_ken_areas",
  tier: 1,
  handler: async (_args: Record<string, unknown>, ctx) => {
    // Small fixed collection — internal cap, no exposed limit knob.
    const LIMIT = clampLimit(undefined);

    const { data, error } = await ctx.db
      .from("ken_areas")
      .select("id, name, description, source_ref, priority, created_at")
      .order("name")
      .limit(LIMIT);

    if (error) throw new Error(`get_ken_areas: ${error.message}`);
    const rows = data ?? [];
    return envelope(rows, { limit_applied: LIMIT, truncated: rows.length >= LIMIT });
  },
});

export const getKenItemsTool = defineTool({
  name: "get_ken_items",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db.from("ken_items").select(ITEM_COLS);

    // Every filter is a predicate reaching Postgres, applied before the limit.
    q = q.eq("status", (args.status as string | undefined) ?? "active");
    if (args.area_id) q = q.eq("area_id", args.area_id as string);
    if (args.subtopic) q = q.eq("subtopic", args.subtopic as string);
    if (args.mode) q = q.eq("mode", args.mode as string);
    if (Array.isArray(args.tags) && args.tags.length) {
      q = q.overlaps("tags", args.tags as string[]); // tags is text[], not jsonb
    }
    if (args.search_text) {
      q = q.ilike("prompt", `%${args.search_text as string}%`);
    }

    q = q.order("created_at", { ascending: false }).limit(LIMIT);

    const { data, error } = await q;
    if (error) throw new Error(`get_ken_items: ${error.message}`);

    const rows = data ?? [];
    return envelope(rows, { limit_applied: LIMIT, truncated: rows.length >= LIMIT });
  },
});

// Lazy-load for the one heavy column. Called only when quizzing a lyric item.
export const getKenLyricFragmentsTool = defineTool({
  name: "get_ken_lyric_fragments",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const { data, error } = await ctx.db
      .from("ken_items")
      .select("id, prompt, tricky_fragments")
      .eq("id", args.item_id as string)
      .single();

    if (error) throw new Error(`get_ken_lyric_fragments: ${error.message}`);
    return envelope(data);
  },
});

export const getKenMisconceptionsTool = defineTool({
  name: "get_ken_misconceptions",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const LIMIT = clampLimit(args.limit as number | undefined);

    let q = ctx.db
      .from("ken_misconceptions")
      .select("id, item_id, related_item_id, subtopic, note, status, created_at, updated_at");

    q = q.eq("status", (args.status as string | undefined) ?? "active");
    if (args.item_id) {
      // Either side of a confusion pair — the pair is the unit, so a read that
      // sees only the anchor side is half-blind. Validated first because the
      // value is interpolated into a PostgREST or() filter.
      const itemId = args.item_id as string;
      if (!UUID_RE.test(itemId)) {
        throw new Error(
          `get_ken_misconceptions: item_id must be a uuid, got ${JSON.stringify(itemId)}.`,
        );
      }
      q = q.or(`item_id.eq.${itemId},related_item_id.eq.${itemId}`);
    }
    if (args.subtopic) q = q.eq("subtopic", args.subtopic as string);

    q = q.order("updated_at", { ascending: false }).limit(LIMIT);

    const { data, error } = await q;
    if (error) throw new Error(`get_ken_misconceptions: ${error.message}`);

    const rows = data ?? [];
    return envelope(rows, { limit_applied: LIMIT, truncated: rows.length >= LIMIT });
  },
});

// ---------------------------------------------------------------------------
// Misconceptions — split by tier, because inserting one and rewriting one are
// different blast radii.
// ---------------------------------------------------------------------------

export const createKenMisconceptionTool = defineTool({
  name: "create_ken_misconception",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const { data, error } = await ctx.db
      .from("ken_misconceptions")
      .insert({
        item_id: (args.item_id as string | undefined) ?? null,
        related_item_id: (args.related_item_id as string | undefined) ?? null,
        subtopic: (args.subtopic as string | undefined) ?? null,
        note: args.note as string,
      })
      .select("id, item_id, related_item_id, subtopic, note, status, created_at")
      .single();

    if (error) throw new Error(`create_ken_misconception: ${error.message}`);
    return envelope(data);
  },
});

export const updateKenMisconceptionTool = defineTool({
  name: "update_ken_misconception",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (args.note !== undefined) patch.note = args.note as string;
    if (args.status !== undefined) patch.status = args.status as string;

    const { data, error } = await ctx.db
      .from("ken_misconceptions")
      .update(patch)
      .eq("id", args.id as string)
      .select("id, item_id, related_item_id, subtopic, note, status, updated_at")
      .single();

    if (error) throw new Error(`update_ken_misconception: ${error.message}`);
    return envelope(data);
  },
});

// ---------------------------------------------------------------------------
// propose_ken_fact_update — tier 3
//
// The reconcile path. A changed fact is never an overwrite: the new value is a
// new row, and the old row is deprecated with a pointer to its replacement, so
// Ken keeps the history he needs to un-teach the old answer.
//
// defineTool intercepts any call without confirmed === true and returns a
// proposal. Do not add a confirmation check here — that gate already exists.
// ---------------------------------------------------------------------------

export const proposeKenFactUpdateTool = defineTool({
  name: "propose_ken_fact_update",
  tier: 3,
  handler: async (args: Record<string, unknown>, ctx) => {
    const oldId = args.item_id as string;

    const { data: oldItem, error: readErr } = await ctx.db
      .from("ken_items")
      .select(ITEM_COLS)
      .eq("id", oldId)
      .single();

    if (readErr) throw new Error(`propose_ken_fact_update: ${readErr.message}`);
    if (oldItem.status !== "active") {
      throw new Error(
        `propose_ken_fact_update: item ${oldId} is already deprecated.`,
      );
    }

    // New row first: the old row's superseded_by has to point at something, and
    // the constraint refuses a pointer without the deprecated status.
    const { data: newItem, error: insertErr } = await ctx.db
      .from("ken_items")
      .insert({
        area_id: oldItem.area_id,
        subtopic: oldItem.subtopic,
        tags: oldItem.tags,
        mode: oldItem.mode,
        accuracy: oldItem.accuracy,
        volatility: oldItem.volatility,
        prompt: (args.prompt as string | undefined) ?? oldItem.prompt,
        ground_truth: args.ground_truth as string,
        verified_at: (args.verified_at as string | undefined) ??
          new Date().toISOString(),
        priority: oldItem.priority,
      })
      .select(ITEM_COLS)
      .single();

    if (insertErr) throw new Error(`propose_ken_fact_update: ${insertErr.message}`);

    const { data: deprecated, error: updateErr } = await ctx.db
      .from("ken_items")
      .update({
        status: "deprecated",
        superseded_by: newItem.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", oldId)
      .select("id, prompt, ground_truth, status, superseded_by")
      .single();

    if (updateErr) throw new Error(`propose_ken_fact_update: ${updateErr.message}`);

    return envelope({ deprecated, replacement: newItem });
  },
});