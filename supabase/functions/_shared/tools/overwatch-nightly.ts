// ============================================================================
// supabase/functions/_shared/tools/overwatch-nightly.ts
//
// Overwatch's nightly counts in one read. Spec: docs/technical-spec-nightly_counts-f8k.md.
//
//   get_overwatch_nightly_counts  tier 1 — public.overwatch_nightly_counts as bare data, plus
//   `dispatcher_checks` (importance, silence, failures), worked out here from signals, platform_runs
//   and the active plan. Spec: docs/technical-spec-notification_routing-d7v.md section 11.
// ============================================================================

import { defineTool, describeDbError } from "../platform.ts";

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const HOUR = 3_600_000;
/** Only for counts from before migration 219, which carry no limits; from 219 the counts apply the default. */
export const DEFAULT_SILENCE_HOURS = 36;
const SILENCE_KEY = "nightly_checks.silence_hours";
const positiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const MAX_SIGNALS = 1000;

type Row = Record<string, unknown>;

const kindOf = (s: Row) => ((s.details as Row | null)?.kind as string | undefined) ?? null;
const isFailureSignal = (s: Row) =>
  kindOf(s) === "failure" || String(s.subject_key ?? "").split(":").includes("failure");
const ms = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);

function inForce(o: Row, at: number): boolean {
  const w = (o.when as Row | undefined) ?? {};
  const starts = ms(w.starts_at), ends = ms(w.ends_at);
  return !(starts > at) && !(ends <= at);
}

/**
 * The three nightly checks on the dispatcher, from rows already read.
 * - importance: signals held in the last day that were a failure (details.kind) or High/Urgent.
 * - silence: hours since the last delivered signal against the plan's threshold, and overrides in
 *   force that hold or drop with no app, job, subject_key or started_by in their match.
 * - failures: failed or partial runs in the last day with no signal raised for them (a failed run
 *   needs a failure signal; a partial one any signal from its app and job).
 */
export function dispatcherChecks(input: {
  asOf: string;
  settings: Row | null;
  /** counts.limits; its silence value already holds the plan's or the default. */
  limits?: Row | null;
  signals: Row[];
  lastDeliveredAt: string | null;
  runs: Row[];
}) {
  const at = Date.parse(input.asOf);
  const since = at - 24 * HOUR;
  const nightly = (input.settings?.nightly_checks as Row | undefined) ?? {};
  const planHours = nightly.silence_hours;
  const fromLimits = input.limits?.[SILENCE_KEY];
  const threshold = positiveInt(fromLimits) ? fromLimits : positiveInt(planHours) ? planHours : DEFAULT_SILENCE_HOURS;

  const groups = new Map<string, Row>();
  for (const s of input.signals) {
    if (s.state !== "held" || !(ms(s.decided_at ?? s.created_at) >= since)) continue;
    const failure = kindOf(s) === "failure";
    if (!failure && s.severity !== "high" && s.severity !== "urgent") continue;
    const key = String(s.subject_key);
    const g = groups.get(key) ?? { subject_key: key, app: s.app, job: s.job, severity: s.severity,
      kind: kindOf(s), held: 0, last_title: s.title, last_reason: s.reason, signal_ids: [] as string[] };
    g.held = (g.held as number) + 1;
    if ((g.signal_ids as string[]).length < 5) (g.signal_ids as string[]).push(String(s.id));
    groups.set(key, g);
  }

  const overrides = ((input.settings?.delivery as Row | undefined)?.overrides as Row[] | undefined) ?? [];
  const broad = overrides.filter((o) => {
    const d = (o.effect as Row | undefined)?.decision;
    const m = (o.match as Row | undefined) ?? {};
    return (d === "hold" || d === "drop") && inForce(o, at) &&
      !["app", "job", "subject_key", "started_by"].some((k) => m[k] !== undefined && m[k] !== null);
  }).map((o) => ({ label: o.label, decision: (o.effect as Row).decision, match: o.match ?? {},
    ends_at: (o.when as Row | undefined)?.ends_at ?? null }));

  const last = input.lastDeliveredAt ? Date.parse(input.lastDeliveredAt) : NaN;
  const hours = Number.isNaN(last) ? null : Math.floor((at - last) / HOUR);
  const byState: Record<string, number> = {};
  for (const s of input.signals) {
    if (ms(s.created_at) >= since) byState[String(s.state)] = (byState[String(s.state)] ?? 0) + 1;
  }

  const failures = input.runs.filter((r) => {
    if (r.status !== "failed" && r.status !== "partial") return false;
    if (!(ms(r.started_at) >= since)) return false;
    if (r.status === "partial" && r.app === "overwatch" && r.job === "nightly") return false;
    const from = ms(r.started_at) - 5 * 60_000;
    const to = ms(r.finished_at ?? r.started_at) + 6 * HOUR;
    return !input.signals.some((s) => {
      if ((s.details as Row | null)?.run_id === r.id) return true;
      if (s.app !== r.app || s.job !== r.job) return false;
      const t = ms(s.created_at);
      return t >= from && t <= to && (r.status === "partial" || isFailureSignal(s));
    });
  }).map((r) => ({ run_id: r.id, app: r.app, job: r.job, status: r.status, started_at: r.started_at,
    failure_kind: (r.details as Row | null)?.failure_kind ?? null, error_message: r.error_message ?? null }));

  return {
    importance: [...groups.values()],
    silence: {
      last_delivered_at: input.lastDeliveredAt,
      hours_since: hours,
      threshold_hours: threshold,
      threshold_from: threshold === planHours ? "plan" : "default",
      silent: hours === null || hours > threshold,
      signals_last_day: byState,
      broad_overrides: broad,
    },
    failures,
  };
}

export const getOverwatchNightlyCountsTool = defineTool({
  name: "get_overwatch_nightly_counts",
  // overwatch_nightly_counts reads these, and through overwatch_project_progress item_groups, group_types, project_plans and clips.
  // The dispatcher checks read signals, platform_runs and overwatch_plans directly.
  tables: {
    reads: ["overwatch_plans", "overwatch_watch", "overwatch_notes", "apps", "app_profiles", "activity", "platform_runs",
      "platform_schedules", "item_groups", "group_types", "project_plans", "clips", "project_estimates",
      "item_group_members", "items", "intents", "events", "executions", "inbox", "reminders", "claim_blocks",
      "project_links", "platform_inventory", "finish_summaries", "portfolios", "portfolio_plans", "signals"],
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
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;

    // A failed check read never fails the counts: the nightly reports it and carries on.
    const asOf = new Date(params.p_as_of ? Date.parse(params.p_as_of as string) : Date.now()).toISOString();
    const fetchFrom = new Date(Date.parse(asOf) - 36 * HOUR).toISOString();
    const dayAgo = new Date(Date.parse(asOf) - 24 * HOUR).toISOString();
    try {
      const plan = await ctx.db.from("overwatch_plans").select("id, settings").eq("active", true).limit(1);
      if (plan.error) throw new Error(describeDbError(`${T} (overwatch_plans)`, plan.error));
      const sig = await ctx.db.from("signals")
        .select("id, app, job, severity, subject_key, title, state, reason, details, created_at, decided_at")
        .gte("created_at", fetchFrom).lte("created_at", asOf).order("created_at", { ascending: false }).limit(MAX_SIGNALS);
      if (sig.error) throw new Error(describeDbError(`${T} (signals)`, sig.error));
      const last = await ctx.db.from("signals").select("decided_at").eq("state", "delivered")
        .lte("decided_at", asOf).order("decided_at", { ascending: false }).limit(1);
      if (last.error) throw new Error(describeDbError(`${T} (signals)`, last.error));
      const runs = await ctx.db.from("platform_runs")
        .select("id, app, job, status, started_at, finished_at, details, error_message")
        .in("status", ["failed", "partial"]).gte("started_at", dayAgo).lte("started_at", asOf).limit(200);
      if (runs.error) throw new Error(describeDbError(`${T} (platform_runs)`, runs.error));
      const checks = dispatcherChecks({
        asOf,
        settings: ((plan.data ?? []) as Row[])[0]?.settings as Row ?? null,
        limits: ((data as Row).limits as Row | undefined) ?? null,
        signals: (sig.data ?? []) as Row[],
        lastDeliveredAt: (((last.data ?? []) as Row[])[0]?.decided_at as string | undefined) ?? null,
        runs: (runs.data ?? []) as Row[],
      });
      const truncated = ((sig.data ?? []) as Row[]).length >= MAX_SIGNALS;
      return { ...(data as Row), dispatcher_checks: truncated ? { ...checks, signals_truncated: true } : checks };
    } catch (e) {
      return { ...(data as Row), dispatcher_checks: { error: (e as Error).message } };
    }
  },
});
