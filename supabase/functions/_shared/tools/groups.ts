// ============================================================================
// supabase/functions/_shared/tools/groups.ts
//
// Restructure P5 step 16: groups (menus, projects, series) for Claude.
//
//   get_groups  tier 1 — live groups with their type, context, status, pin,
//                        last_completed_at, the own intention's live date and
//                        their live members in position order.
//
// A null name is derived from live members ("Rice + Beans"), as the app does.
// Every read goes through ctx.db (RLS). Since MCP read access S8 the list is the
// shared readTable (limit, offset, ids, archived, no_context, include notes).
// ============================================================================

import { clampLimit, defineTool, readTable } from "../platform.ts";
import { withNotes } from "./records.ts";

export const NAME_JOINER = " + ";
const STATUSES = ["someday", "active", "background", "closed"];

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** The type ids a group_type label names (singular or plural, any case); null when no label given. */
export function typeIdsFor(label: string | undefined, types: Row[]): string[] | null {
  if (!label) return null;
  const want = label.trim().toLowerCase();
  return types
    .filter((t) => [t.label_singular, t.label_plural].some((l) => String(l || "").toLowerCase() === want))
    .map((t) => t.id);
}

/**
 * The tool's rows from the raw reads. Pure. Members whose record is archived or
 * gone are left out, as the app's liveMembers does; the own intention's live
 * date is its earliest live event.
 */
export function shapeGroups(
  groups: Row[],
  { types = [], contexts = [], members = [], items = [], intents = [], ownIntents = [], events = [] }: {
    types?: Row[]; contexts?: Row[]; members?: Row[]; items?: Row[]; intents?: Row[]; ownIntents?: Row[]; events?: Row[];
  },
): Row[] {
  const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));
  const typeOf = byId(types);
  const contextOf = byId(contexts);
  const itemOf = byId(items);
  const intentOf = byId(intents);
  return groups.map((g) => {
    const live = members
      .filter((m) => m.group_id === g.id && !m.removed_at)
      .sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)))
      .map((m) => {
        const rec = m.member_type === "item" ? itemOf.get(m.member_id) : intentOf.get(m.member_id);
        if (!rec || rec.archived) return null;
        return {
          type: m.member_type,
          id: rec.id,
          name: (m.member_type === "item" ? rec.name : rec.text) || "",
          status: rec.status ?? "someday",
        };
      })
      .filter(Boolean) as Row[];
    const own = ownIntents.find((i) => i.group_id === g.id) || null;
    const liveDate = own
      ? events
          .filter((e) => e.intent_id === own.id)
          .map((e) => String(e.time).slice(0, 10))
          .sort()[0] || null
      : null;
    const type = typeOf.get(g.group_type_id);
    return {
      id: g.id,
      name: g.name?.trim() || live.map((m) => m.name.trim()).filter(Boolean).join(NAME_JOINER) || "Untitled group",
      name_is_derived: !g.name?.trim(),
      description: g.description ?? null,
      type: type ? { id: type.id, label: type.label_singular, execution_mode: type.execution_mode } : null,
      context_id: g.context_id ?? null,
      context_name: g.context_id ? contextOf.get(g.context_id)?.name ?? null : null,
      status: g.status ?? "someday",
      pinned: Boolean(g.pinned),
      archived: Boolean(g.archived),
      last_completed_at: g.last_completed_at ?? null,
      own_intention_id: own?.id ?? null,
      scheduled_date: liveDate,
      members: live,
    };
  });
}

export const getGroupsTool = defineTool({
  name: "get_groups",
  tables: {
    reads: ["item_groups", "group_types", "item_group_members", "contexts", "intents", "items", "events", "notes"],
    writes: [],
  },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const status = (args.status as string[] | undefined)?.filter((s) => STATUSES.includes(s));

    const { data: types, error: typesError } = await ctx.db
      .from("group_types")
      .select("id, label_singular, label_plural, execution_mode")
      .limit(clampLimit(50));
    if (typesError) throw new Error(`get_groups: ${typesError.message}`);
    const typeIds = typeIdsFor(args.group_type as string | undefined, types ?? []);
    if (typeIds && typeIds.length === 0) {
      const labels = (types ?? []).map((t: Row) => t.label_singular).join(", ");
      throw new Error(`get_groups: no group type is called ${JSON.stringify(args.group_type)}. Types: ${labels}.`);
    }

    // Shared read (platform.ts readTable): limit, offset, ids, archived (default: live
    // groups only, as before), no_context, include notes, and the next-offset NOTE.
    return await readTable(ctx, {
      tool: "get_groups",
      table: "item_groups",
      args,
      allowedIncludes: ["notes"],
      filter: (query) => {
        let q = query;
        if (args.context_id) q = q.eq("context_id", args.context_id as string);
        if (status && status.length > 0) q = q.in("status", status);
        if (typeIds) q = q.in("group_type_id", typeIds);
        return q;
      },
      order: [{ column: "pinned", ascending: false }, { column: "updated_at", ascending: false }],
      attach: async (rows, opts) => {
        const data = await shapePage(ctx.db, rows as Row[], types ?? []);
        if (!opts.include.includes("notes")) return { rows: data };
        return await withNotes(ctx.db, "group", data, opts.ids !== null);
      },
    });
  },
});

/** Reads what shapeGroups needs for one page of groups, then shapes them. */
// deno-lint-ignore no-explicit-any
async function shapePage(db: any, rows: Row[], types: Row[]): Promise<Row[]> {
    const groupIds = rows.map((g: Row) => g.id);
    const contextIds = [...new Set(rows.map((g: Row) => g.context_id).filter(Boolean))];
    const [{ data: members }, { data: contexts }, { data: ownIntents }] = await Promise.all([
      db.from("item_group_members").select("id, group_id, member_type, member_id, position, removed_at")
        .in("group_id", groupIds).is("removed_at", null),
      contextIds.length ? db.from("contexts").select("id, name").in("id", contextIds) : Promise.resolve({ data: [] }),
      db.from("intents").select("id, group_id").in("group_id", groupIds).eq("archived", false),
    ]);
    const itemIds = (members ?? []).filter((m: Row) => m.member_type === "item").map((m: Row) => m.member_id);
    const intentIds = (members ?? []).filter((m: Row) => m.member_type === "intention").map((m: Row) => m.member_id);
    const ownIds = (ownIntents ?? []).map((i: Row) => i.id);
    const [{ data: items }, { data: intents }, { data: events }] = await Promise.all([
      itemIds.length ? db.from("items").select("id, name, status, archived").in("id", itemIds) : Promise.resolve({ data: [] }),
      intentIds.length ? db.from("intents").select("id, text, status, archived").in("id", intentIds) : Promise.resolve({ data: [] }),
      ownIds.length
        ? db.from("events").select("id, intent_id, time").in("intent_id", ownIds).eq("archived", false)
        : Promise.resolve({ data: [] }),
    ]);

    return shapeGroups(rows, {
      types, contexts: contexts ?? [], members: members ?? [], items: items ?? [],
      intents: intents ?? [], ownIntents: ownIntents ?? [], events: events ?? [],
    });
}
