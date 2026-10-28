// ============================================================================
// supabase/functions/_shared/tools/inbox-groups.ts
//
// The suggested group on inbox rows (Overwatch 8c, spec 4.17): checking the value create_inbox_item and
// update_inbox_item take, the guard's refusal in plain words, and the group's name and type label attached to every
// row get_inbox returns, so a reader never sees a bare id. The database guard (inbox_check_suggested_group,
// migration 184) decides what is allowed: one of the user's groups of any type, not closed and not archived.
// ============================================================================

type Row = Record<string, unknown>;
type Db = { from: (table: string) => any };

/** undefined = not given; null = clear it (update only); else a non-empty group id. */
export function checkSuggestedGroupId(tool: string, value: unknown, { allowNull = false } = {}): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (allowNull) return null;
    throw new Error(`${tool}: suggested_group_id must be a group id from get_groups; leave it out when no group fits.`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${tool}: suggested_group_id must be a group id from get_groups; got ${JSON.stringify(value)}.`);
  }
  return value.trim();
}

/** The guard's refusal, said plainly; any other message unchanged. */
export function suggestedGroupError(tool: string, message: string, groupId?: string | null): string {
  if (/not one of your open groups/.test(message)) {
    return `${tool}: suggested group ${groupId ? `${groupId} ` : ""}was refused: it is not one of your open groups (it is ` +
      `closed, archived, someone else's, or does not exist). Pick an open group with get_groups, or leave ` +
      `suggested_group_id out.`;
  }
  return `${tool}: ${message}`;
}

/** Each row with suggested_group: { id, name, type_label } (null when it has none, or the group is gone). */
export async function withSuggestedGroups(db: Db, rows: Row[]): Promise<Row[]> {
  const ids = [...new Set(rows.map((r) => r.suggested_group_id).filter((v): v is string => typeof v === "string"))];
  if (!ids.length) return rows.map((r) => ("suggested_group_id" in r ? { ...r, suggested_group: null } : r));
  const { data: groups, error } = await db.from("item_groups").select("id, name, group_type_id").in("id", ids);
  if (error) return rows;
  const typeIds = [...new Set(((groups ?? []) as Row[]).map((g) => g.group_type_id as string))];
  const { data: types } = typeIds.length
    ? await db.from("group_types").select("id, label_singular").in("id", typeIds)
    : { data: [] };
  const label = new Map(((types ?? []) as Row[]).map((t) => [t.id, t.label_singular]));
  const byId = new Map(((groups ?? []) as Row[]).map((g) => [g.id, {
    id: g.id,
    // A null name is derived from the members in the app; a reader just needs to know it has none of its own.
    name: g.name ?? "(unnamed group)",
    type_label: label.get(g.group_type_id) ?? "Group",
  }]));
  return rows.map((r) => {
    if (!("suggested_group_id" in r)) return r;
    return { ...r, suggested_group: r.suggested_group_id ? byId.get(r.suggested_group_id) ?? null : null };
  });
}
