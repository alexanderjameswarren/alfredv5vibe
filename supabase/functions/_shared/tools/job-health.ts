// get_job_health — what the job-health watchdog knows (docs/technical-spec-job_health-t4m.md 8.1).
//
// A thin, read-only wrapper over the get_job_health RPC (migration 238), which reads platform_runs,
// platform_schedules and job_health_state for the caller only. The RPC does the counting, so the scheduled
// health check and a chat ("review missed jobs since 9:40 AM") always see the same answer.

import { defineTool } from "../platform.ts";
import { dbError, fail } from "./claude-notifications.ts";

type Row = Record<string, unknown>;

/** An ISO 8601 timestamp, with a time and an offset or Z, as Postgres timestamptz reads it unambiguously. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function parseSince(tool: string, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO_RE.test(value.trim()) || Number.isNaN(Date.parse(value.trim()))) {
    throw fail(tool, `since must be an ISO timestamp with a time zone, e.g. "2026-11-17T09:40:00-08:00" (got ${JSON.stringify(value)}).`);
  }
  return value.trim();
}

export const getJobHealthTool = defineTool({
  name: "get_job_health",
  // Through the get_job_health RPC.
  tables: { reads: ["platform_runs", "platform_schedules", "job_health_state"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_job_health";
    const since = parseSince(tool, args.since);
    const { data, error } = await ctx.db.rpc("get_job_health", since ? { p_since: since } : {});
    if (error) throw dbError(tool, "get_job_health", error);
    const out = (data ?? {}) as Row;
    if (!out.watchdog || !out.outage) throw fail(tool, "get_job_health returned an unexpected shape.");
    return out;
  },
});
