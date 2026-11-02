// ============================================================================
// supabase/functions/_shared/tools/overwatch-nightly.ts
//
// Overwatch's nightly counts in one read. Spec: docs/technical-spec-nightly_counts-f8k.md.
//
//   get_overwatch_nightly_counts  tier 1 — public.overwatch_nightly_counts as bare data.
// ============================================================================

import { defineTool, describeDbError } from "../platform.ts";

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

export const getOverwatchNightlyCountsTool = defineTool({
  name: "get_overwatch_nightly_counts",
  // overwatch_nightly_counts reads these, and through overwatch_project_progress item_groups, group_types, project_plans and clips.
  tables: {
    reads: ["overwatch_plans", "overwatch_watch", "overwatch_notes", "apps", "app_profiles", "activity", "platform_runs",
      "platform_schedules", "item_groups", "group_types", "project_plans", "clips", "project_estimates",
      "item_group_members", "items", "intents", "events", "executions", "inbox", "reminders", "claim_blocks",
      "project_links", "platform_inventory", "finish_summaries", "portfolios", "portfolio_plans"],
    writes: [],
  },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_overwatch_nightly_counts";
    const params: Record<string, unknown> = {};
    if (args.as_of !== undefined && args.as_of !== null) {
      const v = args.as_of;
      if (typeof v !== "string" || !WITH_OFFSET.test(v) || Number.isNaN(Date.parse(v))) {
        throw new Error(`${T}: as_of must be an ISO timestamp WITH offset, e.g. 2026-11-02T04:20:00-08:00; got ${JSON.stringify(v)}.`);
      }
      params.p_as_of = v;
    }
    const { data, error } = await ctx.db.rpc("overwatch_nightly_counts", params);
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});
