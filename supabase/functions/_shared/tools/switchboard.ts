// ============================================================================
// supabase/functions/_shared/tools/switchboard.ts
//
// The SQL approval queue, from Claude's side. Spec: docs/technical-spec-switchboard2-h8r.md §8.1.
//
//   get_switchboard_run     tier 1  an action (with its full SQL) and a run
//   issue_switchboard_link  tier 2  issue the approval link for the SQL Claude reviewed
//
// Database access ONLY through ctx.db.
// ============================================================================

import { defineTool } from "../platform.ts";
import { dbError, fail } from "./claude-notifications.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Named columns: link_hash is a secret column and must never be selected.
const ACTION_COLUMNS = "id, kind, project_code, status, headline, fingerprint, payload, chat_url, needs_click, " +
  "link_expires_at, link_used_at, created_by, created_at, updated_at";
const RUN_COLUMNS = "id, action_id, mode, summary, result, result_pruned_at, started_at, finished_at";
// switchboard_issue_link's own refusals: no user, no such action, not issuable or another link live.
const REFUSALS = new Set(["28000", "P0002", "55000"]);

function requireUuid(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v.trim())) throw fail(tool, `\`${name}\` must be a UUID.`);
  return v.trim();
}

export const getSwitchboardRunTool = defineTool({
  name: "get_switchboard_run",
  tier: 1,
  tables: { reads: ["switchboard_actions", "switchboard_runs"], writes: [] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_switchboard_run";
    if ((args.action_id == null) === (args.run_id == null)) throw fail(tool, "pass exactly one of `action_id` or `run_id`.");

    const readAction = async (id: string) => {
      const { data, error } = await ctx.db.from("switchboard_actions").select(ACTION_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the action", error);
      if (!data) throw fail(tool, `no such action: ${id}.`);
      return data as unknown as Record<string, unknown>;
    };

    if (args.run_id != null) {
      const id = requireUuid(tool, "run_id", args.run_id);
      const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw dbError(tool, "reading the run", error);
      if (!run) throw fail(tool, `no such run: ${id}.`);
      return { action: await readAction((run as Record<string, unknown>).action_id as string), run };
    }

    const id = requireUuid(tool, "action_id", args.action_id);
    const action = await readAction(id);
    const { data: run, error } = await ctx.db.from("switchboard_runs").select(RUN_COLUMNS).eq("action_id", id)
      .order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw dbError(tool, "reading the latest run", error);
    return { action, run: run ?? null };
  },
});

export const issueSwitchboardLinkTool = defineTool({
  name: "issue_switchboard_link",
  tier: 2,
  tables: { reads: ["switchboard_actions", "switchboard_settings"], writes: ["switchboard_actions"] },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "issue_switchboard_link";
    const actionId = requireUuid(tool, "action_id", args.action_id);
    if (typeof args.fingerprint !== "string" || !args.fingerprint.trim()) {
      throw fail(tool, "`fingerprint` is required: the fingerprint get_switchboard_run showed for the SQL you reviewed.");
    }
    const { data: action, error: readError } = await ctx.db.from("switchboard_actions").select("fingerprint")
      .eq("id", actionId).maybeSingle();
    if (readError) throw dbError(tool, "reading the action", readError);
    if (!action) throw fail(tool, `no such action: ${actionId}.`);
    if ((action as Record<string, unknown>).fingerprint !== args.fingerprint.trim()) {
      throw fail(tool, "refused: the fingerprint does not match this action. Read it again with get_switchboard_run and review that SQL.");
    }
    const { data, error } = await ctx.db.rpc("switchboard_issue_link", { p_action_id: actionId });
    if (error) {
      if (REFUSALS.has(error.code ?? "")) throw fail(tool, `refused: ${error.message}`);
      throw dbError(tool, "issuing the link", error);
    }
    return data;
  },
});
