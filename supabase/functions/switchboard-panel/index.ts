// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createServiceClient } from "../_shared/alfred-tools/supabase-client.ts";
import { type Deps, handle } from "./core.ts";

// switchboard-panel: what the Switchboard panel needs, read-only. Spec: docs/technical-spec-switchboard2-h8r.md 8.1.
//
// 🛑 A SERVER-TO-SERVER EXCEPTION, LIKE switchboard-runner. Not an MCP tool: no defineTool, no ctx.db.
//
//   GET /  x-switchboard-panel-key -> { ok, projects: { <code>: { report_unread, waiting_on_alex, lane, lane_order } } }
//
// ⚠️ verify_jwt must be false in config.toml: the panel has no user token, so this checks SWITCHBOARD_PANEL_KEY itself.
// After every deploy a GET without the key must come back 401 with this function's own body.
// ⚠️ THE SERVICE ROLE BYPASSES RLS, so every query filters on user_id, from CLIPBOARD_USER_ID. This file only reads.

const LIMIT = 500;

function deps(): Deps {
  const db = createServiceClient();
  const userId = Deno.env.get("CLIPBOARD_USER_ID") ?? "";
  const must = <T>(res: { data: unknown; error: { message: string } | null }): T => {
    if (res.error) throw new Error(res.error.message);
    return res.data as T;
  };
  const from = (table: string, columns: string) => db.from(table).select(columns).eq("user_id", userId);
  return {
    panelKey: Deno.env.get("SWITCHBOARD_PANEL_KEY") ?? "",
    latestCliClips: async () =>
      must(await from("clips", "run_tag, inbox_id").eq("source", "cli").not("run_tag", "is", null)
        .order("created_at", { ascending: false }).limit(LIMIT)),
    inboxRows: async (ids) => (ids.length ? must(await from("inbox", "id, archived").in("id", ids)) : []),
    waitingActions: async () =>
      must(await from("switchboard_actions", "project_code").eq("needs_click", true).is("link_used_at", null)
        .in("status", ["queued", "link_issued"]).limit(LIMIT)),
    portfolios: async () => must(await from("portfolios", "id, position").eq("archived", false).limit(LIMIT)),
    activePlans: async (ids) =>
      (ids.length ? must(await from("portfolio_plans", "id, portfolio_id").eq("active", true).in("portfolio_id", ids)) : []),
    lanes: async (ids) => (ids.length ? must(await from("portfolio_lanes", "id, plan_id, name, position").in("plan_id", ids)) : []),
    slices: async (ids) =>
      (ids.length ? must(await from("portfolio_slices", "plan_id, lane_id, position, group_id, status").in("plan_id", ids).limit(LIMIT)) : []),
    projectPlans: async (ids) =>
      (ids.length ? must(await from("project_plans", "group_id, project_code").in("group_id", ids)) : []),
  };
}

Deno.serve(async (req) => {
  try {
    return await handle(req, deps());
  } catch (e) {
    console.error("[switchboard-panel]", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ ok: false, error: "the panel endpoint hit an error; see its logs." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
