// ============================================================================
// supabase/functions/_shared/tools/apps.ts
//
// public.apps (migration 116, Restructure P3): the apps Alfred is made of.
//
//   get_apps  tier 1 — every app with its description, so enrichment can choose
//                      inbox.source_app the way context descriptions choose a context.
//
// checkSourceApp is shared by create_inbox_item, update_inbox_item and
// archive_inbox_item, so a bad app id reads the same everywhere.
// ============================================================================

import { defineTool, readTable } from "../platform.ts";

export const APP_COLUMNS = "id, name, description, icon, path, button_name";

export const getAppsTool = defineTool({
  name: "get_apps",
  tables: { reads: ["apps"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    // A small fixed list: up to 50 by default, by name. Shared read (MCP read access S8b).
    return await readTable(ctx, {
      tool: "get_apps",
      table: "apps",
      args: { ...args, limit: args.limit ?? 50 },
      order: [{ column: "name", ascending: true }],
      fullText: ["description"],
    });
  },
});

/**
 * source_app as given to a tool:
 * - undefined: not given, leave it alone
 * - null or "": clear it
 * - an app id: must exist in public.apps; otherwise a readable error listing the valid ids
 */
// deno-lint-ignore no-explicit-any
export async function checkSourceApp(tool: string, value: unknown, db: any): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`${tool}: source_app must be an app id string (see get_apps). Got ${JSON.stringify(value)}.`);
  }
  const { data, error } = await db.from("apps").select("id").order("id");
  if (error) throw new Error(`${tool}: could not read apps: ${error.message}`);
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  if (!ids.includes(value)) {
    throw new Error(`${tool}: unknown source_app ${JSON.stringify(value)}. Valid ids: ${ids.join(", ")}.`);
  }
  return value;
}
