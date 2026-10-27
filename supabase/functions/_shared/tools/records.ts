// ============================================================================
// supabase/functions/_shared/tools/records.ts
//
// MCP read access: one read tool for every visible registered table, and the
// includes the Alfred list tools share.
//
//   get_records  tier 1 — rows of any table platform_read_settings() lists as
//                        visible, with the shared read options (limit, offset,
//                        ids, include, archived, no_context), plus context_id
//                        and status where the table has them.
//
// Includes (opt-in, page-scoped, bounded): notes on items, intentions and
// groups; memberships (the collections and groups an item or intention belongs
// to). Secret columns are never selected and shapeRows strips them again. Reads
// go through ctx.db, so RLS decides the rows. See
// docs/technical-spec-mcp-read-access.md.
// ============================================================================

import { clampLimit, defineTool, finishRead, readTable, requireSettings } from "../platform.ts";
import type { Attach, Context } from "../platform.ts";
import { parseReadOptions, shapeRows } from "../platform-read.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Db = any;
type Step = { rows: Row[]; notes?: string[] };

/** Tables whose rows can carry notes, and the notes.target_type that points at them. */
export const NOTE_TARGETS: Record<string, string> = {
  items: "item",
  intents: "intention",
  item_groups: "group",
};
/** Tables whose rows can belong to collections and groups, and their item_group_members.member_type. */
export const MEMBER_KINDS: Record<string, "item" | "intention"> = {
  items: "item",
  intents: "intention",
};

const NOTES_LIMIT = clampLimit(50);
// Membership rows for one page (at most 50 records): bounded, never a whole table.
const MEMBERSHIP_LIMIT = 500;
const NO_SETTINGS = { table: "", columns: [], has_context_id: false, has_archived: false, has_status: false };

const idsOf = (rows: Row[], key = "id") => [...new Set(rows.map((r) => r[key]).filter(Boolean))] as string[];

/** Adds context_name to rows that carry context_id. */
export async function withContextNames(db: Db, rows: Row[]): Promise<Step> {
  const ids = idsOf(rows, "context_id");
  if (ids.length === 0) return { rows: rows.map((r) => ("context_id" in r ? { ...r, context_name: null } : r)) };
  const { data, error } = await db.from("contexts").select("id, name").in("id", ids);
  if (error) throw new Error(`contexts: ${error.message}`);
  const names = new Map((data ?? []).map((c: Row) => [c.id, c.name]));
  return { rows: rows.map((r) => ("context_id" in r ? { ...r, context_name: names.get(r.context_id) ?? null } : r)) };
}

/** Adds intent_text to rows that carry intent_id (events). */
export async function withIntentText(db: Db, rows: Row[]): Promise<Step> {
  const ids = idsOf(rows, "intent_id");
  if (ids.length === 0) return { rows: rows.map((r) => ({ ...r, intent_text: null })) };
  const { data, error } = await db.from("intents").select("id, text").in("id", ids);
  if (error) throw new Error(`intents: ${error.message}`);
  const texts = new Map((data ?? []).map((i: Row) => [i.id, i.text]));
  return { rows: rows.map((r) => ({ ...r, intent_text: r.intent_id ? texts.get(r.intent_id) ?? null : null })) };
}

/** Adds notes (newest first, body previewed unless fetched by ids) to each row. */
export async function withNotes(db: Db, target: string, rows: Row[], byIds: boolean): Promise<Step> {
  const ids = idsOf(rows);
  const { data, error } = await db
    .from("notes")
    .select("id, target_id, body, execution_id, created_at")
    .eq("target_type", target)
    .in("target_id", ids)
    .order("created_at", { ascending: false })
    .limit(NOTES_LIMIT);
  if (error) throw new Error(`notes: ${error.message}`);
  const notes = shapeRows((data ?? []) as Row[], NO_SETTINGS, { byIds }).rows;
  const byTarget = new Map<string, Row[]>();
  for (const { target_id, ...rest } of notes) {
    const list = byTarget.get(target_id as string);
    if (list) list.push(rest);
    else byTarget.set(target_id as string, [rest]);
  }
  return {
    rows: rows.map((r) => ({ ...r, notes: byTarget.get(r.id) ?? [] })),
    notes: (data ?? []).length >= NOTES_LIMIT
      ? [`Only the newest ${NOTES_LIMIT} notes across these rows are included; fetch fewer rows by ids for the rest.`]
      : [],
  };
}

/**
 * Adds memberships: the collections and groups each item or intention belongs
 * to, as { kind: "collection" | "group", id, name, archived, group_type? }.
 * An intention's collection comes from its own collection_id.
 */
export async function withMemberships(db: Db, kind: "item" | "intention", rows: Row[]): Promise<Step> {
  const ids = idsOf(rows);
  const out = new Map<string, Row[]>(ids.map((id) => [id, []]));
  const notes: string[] = [];

  const collectionOf = new Map<string, string[]>();
  if (kind === "item") {
    const { data, error } = await db.from("collection_items").select("item_id, collection_id")
      .in("item_id", ids).limit(MEMBERSHIP_LIMIT);
    if (error) throw new Error(`collection_items: ${error.message}`);
    for (const m of data ?? []) collectionOf.set(m.item_id, [...(collectionOf.get(m.item_id) ?? []), m.collection_id]);
    if ((data ?? []).length >= MEMBERSHIP_LIMIT) notes.push("Collection memberships were cut; fetch fewer rows by ids.");
  } else {
    for (const r of rows) if (r.collection_id) collectionOf.set(r.id, [r.collection_id]);
  }
  const collectionIds = [...new Set([...collectionOf.values()].flat())];

  const { data: members, error: membersError } = await db.from("item_group_members")
    .select("group_id, member_id").eq("member_type", kind).in("member_id", ids).is("removed_at", null)
    .limit(MEMBERSHIP_LIMIT);
  if (membersError) throw new Error(`item_group_members: ${membersError.message}`);
  if ((members ?? []).length >= MEMBERSHIP_LIMIT) notes.push("Group memberships were cut; fetch fewer rows by ids.");
  const groupIds = [...new Set((members ?? []).map((m: Row) => m.group_id))] as string[];

  const [collections, groups] = await Promise.all([
    collectionIds.length
      ? db.from("item_collections").select("id, name, archived").in("id", collectionIds)
      : Promise.resolve({ data: [], error: null }),
    groupIds.length
      ? db.from("item_groups").select("id, name, group_type_id, archived").in("id", groupIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (collections.error) throw new Error(`item_collections: ${collections.error.message}`);
  if (groups.error) throw new Error(`item_groups: ${groups.error.message}`);
  const typeIds = [...new Set((groups.data ?? []).map((g: Row) => g.group_type_id).filter(Boolean))];
  const types = typeIds.length
    ? await db.from("group_types").select("id, label_singular").in("id", typeIds)
    : { data: [], error: null };
  if (types.error) throw new Error(`group_types: ${types.error.message}`);

  const collectionById = new Map((collections.data ?? []).map((c: Row) => [c.id, c]));
  const groupById = new Map((groups.data ?? []).map((g: Row) => [g.id, g]));
  const typeLabel = new Map((types.data ?? []).map((t: Row) => [t.id, t.label_singular]));

  for (const [id, cids] of collectionOf) {
    for (const cid of cids) {
      const c = collectionById.get(cid);
      if (c) out.get(id)?.push({ kind: "collection", id: c.id, name: c.name, archived: Boolean(c.archived) });
    }
  }
  for (const m of members ?? []) {
    const g = groupById.get(m.group_id);
    if (g) {
      out.get(m.member_id)?.push({
        kind: "group", id: g.id, name: g.name ?? null, archived: Boolean(g.archived),
        group_type: typeLabel.get(g.group_type_id) ?? null,
      });
    }
  }
  return { rows: rows.map((r) => ({ ...r, memberships: out.get(r.id) ?? [] })), notes };
}

/** The includes a table supports. */
export function includesFor(table: string): string[] {
  return [...(NOTE_TARGETS[table] ? ["notes"] : []), ...(MEMBER_KINDS[table] ? ["memberships"] : [])];
}

/**
 * One attach for a list tool: context names (when asked), intent text (when
 * asked), then whichever of notes and memberships the caller included.
 */
export function standardAttach(db: Db, table: string, extras: { contextNames?: boolean; intentText?: boolean } = {}): Attach {
  return async (rows, opts) => {
    let step: Step = { rows: rows as Row[] };
    const notes: string[] = [];
    const run = async (p: Promise<Step>) => {
      step = await p;
      notes.push(...(step.notes ?? []));
    };
    if (extras.contextNames) await run(withContextNames(db, step.rows));
    if (extras.intentText) await run(withIntentText(db, step.rows));
    if (opts.include.includes("notes") && NOTE_TARGETS[table]) {
      await run(withNotes(db, NOTE_TARGETS[table], step.rows, opts.ids !== null));
    }
    if (opts.include.includes("memberships") && MEMBER_KINDS[table]) {
      await run(withMemberships(db, MEMBER_KINDS[table], step.rows));
    }
    return { rows: step.rows, notes };
  };
}

// ---------------------------------------------------------------------------
// get_items and search_items
// ---------------------------------------------------------------------------

export const ITEM_INCLUDES = ["elements", "notes", "memberships"];
/** search_items' default: closed items are left out unless asked for. */
export const LIVE_STATUSES = ["someday", "active", "background"];

/** Includes for items: elements (lists leave it out as heavy), then the standard ones. */
function itemsAttach(db: Db, contextNames: boolean): Attach {
  const standard = standardAttach(db, "items", { contextNames });
  return async (rows, opts, settings) => {
    let out = rows as Row[];
    if (opts.include.includes("elements") && opts.ids === null) {
      const { data, error } = await db.from("items").select("id, elements").in("id", idsOf(out));
      if (error) throw new Error(`items elements: ${error.message}`);
      const byId = new Map((data ?? []).map((r: Row) => [r.id, r.elements]));
      out = out.map((r) => ({ ...r, elements: byId.get(r.id) ?? null }));
    }
    return await standard(out, opts, settings);
  };
}

/**
 * Lists through public.platform_search_items (migration 163): every filter, each
 * search word (name, description, notes), archived, no_context and the page
 * window run in Postgres under RLS, and { rows, total } come from one snapshot.
 * Reads by ids go through readTable for the whole row.
 */
export async function readItems(
  ctx: Context,
  tool: string,
  args: Record<string, unknown>,
  search: { text?: string; status?: string[]; contextNames: boolean },
) {
  const settings = await requireSettings(ctx, tool, "items");
  const opts = parseReadOptions(args, settings, ITEM_INCLUDES);
  if (opts.ids !== null) {
    return await readTable(ctx, {
      tool, table: "items", args, allowedIncludes: ITEM_INCLUDES, attach: itemsAttach(ctx.db, search.contextNames),
    });
  }
  const tags = args.tags as string[] | undefined;
  const { data, error } = await ctx.db.rpc("platform_search_items", {
    p_context_id: (args.context_id as string | undefined) ?? null,
    p_search_text: search.text ?? null,
    p_tags: tags && tags.length > 0 ? tags : null,
    p_limit: opts.limit,
    p_status: search.status && search.status.length > 0 ? search.status : null,
    p_offset: opts.offset,
    p_archived: opts.archived ?? "exclude",
    p_no_context: opts.no_context,
  });
  if (error) throw new Error(`${tool}: ${error.message}`);
  // elements asked for is not "left out", so the heavy-columns note does not name it.
  const shown = opts.include.includes("elements")
    ? { ...settings, heavy_columns: (settings.heavy_columns ?? []).filter((c) => c !== "elements") }
    : settings;
  return await finishRead({
    rows: (data?.rows as Row[]) ?? [],
    total: (data?.total as number) ?? null,
    opts,
    settings: shown,
    attach: itemsAttach(ctx.db, search.contextNames),
  });
}

/** get_collections: each collection's members in position order ({ item_id, name, quantity }; unavailable when unreadable). */
export async function withCollectionMembers(db: Db, rows: Row[]): Promise<Row[]> {
  const { data: memberData, error } = await db
    .from("collection_items")
    .select("collection_id, item_id, quantity, position")
    .in("collection_id", idsOf(rows))
    .order("collection_id")
    .order("position")
    .limit(MEMBERSHIP_LIMIT);
  if (error) throw new Error(`get_collections: ${error.message}`);
  const members = (memberData ?? []) as Row[];
  const itemIds = idsOf(members, "item_id");
  const names = new Map<string, string | null>();
  if (itemIds.length > 0) {
    const { data: items, error: itemError } = await db.from("items").select("id, name").in("id", itemIds);
    if (itemError) throw new Error(`get_collections: ${itemError.message}`);
    for (const i of (items ?? []) as Row[]) names.set(i.id, i.name ?? null);
  }
  const byCollection = new Map<string, Row[]>();
  for (const m of members) {
    const name = names.get(m.item_id) ?? null;
    const entry: Row = { item_id: m.item_id, name, quantity: m.quantity };
    if (name === null) entry.unavailable = true;
    byCollection.set(m.collection_id, [...(byCollection.get(m.collection_id) ?? []), entry]);
  }
  return rows.map((c) => ({ ...c, items: byCollection.get(c.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// get_records
// ---------------------------------------------------------------------------

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

export const getRecordsTool = defineTool({
  name: "get_records",
  // "*": whichever registered table `table` names; then the registry and what the includes read.
  tables: {
    reads: ["*", "platform.registry", "contexts", "notes", "item_group_members", "item_groups", "group_types", "collection_items", "item_collections"],
    writes: [],
  },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const table = args.table;
    if (typeof table !== "string" || !TABLE_NAME.test(table)) {
      throw new Error(`get_records: table must be a table name such as "items". Got ${JSON.stringify(table)}.`);
    }
    const contextId = args.context_id;
    if (contextId !== undefined && typeof contextId !== "string") {
      throw new Error("get_records: context_id must be a string.");
    }
    const status = args.status;
    if (status !== undefined && (!Array.isArray(status) || !status.every((s) => typeof s === "string"))) {
      throw new Error("get_records: status must be an array of strings.");
    }

    return await readTable(ctx, {
      tool: "get_records",
      table,
      args,
      allowedIncludes: includesFor(table),
      filter: (query, settings) => {
        let q = query;
        if (contextId) {
          if (!settings.has_context_id) throw new Error(`get_records: ${table} has no context_id column.`);
          q = q.eq("context_id", contextId);
        }
        if (status && (status as string[]).length > 0) {
          if (!settings.has_status) throw new Error(`get_records: ${table} has no status column.`);
          q = q.in("status", status);
        }
        return q;
      },
      attach: standardAttach(ctx.db, table),
    });
  },
});
