// ============================================================================
// supabase/functions/_shared/tools/signals.ts
//
// Signals: what apps and tasks raise for the dispatcher, which decides whether
// each is held, becomes an inbox item, pops or merges.
// Spec: docs/technical-spec-notification_routing-d7v.md §4.
//
//   raise_signal       tier 1  raise one signal (append-only, like create_inbox_item)
//   resolve_signal     tier 1  a subject is healthy again: its escalation count starts over
//   get_signals        tier 1  read signals, newest first
//   get_dispatch_plan  tier 1  what the dispatcher would do now (dispatch_signals, writes nothing)
//   deliver_signals    tier 1  do it: hold, inbox items, pops, merges; Claude only words what gets through
//
// Apps never pick a channel or check for an existing inbox item. Database
// access ONLY through ctx.db. push_subscriptions' endpoint and keys are read only
// to send, and never returned (as in send_alfred_push).
// ============================================================================

import { defineTool, envelope, readTable } from "../platform.ts";
import { loadVapid, sendToAll } from "../web-push-send.ts";
import type { PushSubscriptionRow } from "../web-push-send.ts";
import {
  dbError, fail, KINDS, logNotification, optionalText, requireAlfredPath, requireEnum, requireStartedBy, requireText,
} from "./claude-notifications.ts";
import { deliveryOutcome } from "./alfred-push.ts";

type Row = Record<string, unknown>;

export const SEVERITIES = ["low", "normal", "high", "urgent"];
export const STATES = ["queued", "held", "delivered", "merged", "dropped", "resolved"];
/** The same rule as the signals_subject_key_format constraint. */
const SUBJECT_KEY_RE = /^[a-z0-9][a-z0-9:_.-]{0,199}$/;

export function requireSubjectKey(tool: string, v: unknown): string {
  if (typeof v !== "string" || !SUBJECT_KEY_RE.test(v.trim())) {
    throw fail(tool, "`subject_key` must be lower case letters, digits and : _ . - (at most 200), " +
      `e.g. "wb-sync:failure", got ${JSON.stringify(v)}.`);
  }
  return v.trim();
}

function optionalTimestamp(tool: string, name: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw fail(tool, `\`${name}\` must be an ISO timestamp, e.g. "2026-11-03T05:00:00-08:00", got ${JSON.stringify(v)}.`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// raise_signal — tier 1 (append)
// ---------------------------------------------------------------------------

export const raiseSignalTool = defineTool({
  name: "raise_signal",
  tables: { reads: ["apps", "signals"], writes: ["signals"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "raise_signal";
    const details = args.details;
    if (details !== undefined && details !== null && (typeof details !== "object" || Array.isArray(details))) {
      throw fail(tool, "`details` must be an object.");
    }
    const sourceRef = optionalText(tool, "source_ref", args.source_ref);
    if (sourceRef && sourceRef.length > 300) throw fail(tool, "`source_ref` must be at most 300 characters.");

    const { data, error } = await ctx.db.rpc("raise_signal", {
      p_app: requireText(tool, "app", args.app, 100),
      p_job: requireText(tool, "job", args.job, 100),
      p_severity: requireEnum(tool, "severity", args.severity, SEVERITIES),
      p_subject_key: requireSubjectKey(tool, args.subject_key),
      p_title: requireText(tool, "title", args.title, 200),
      p_started_by: requireStartedBy(tool, args.started_by),
      p_body: optionalText(tool, "body", args.body),
      p_link: requireAlfredPath(tool, args.link),
      p_source_ref: sourceRef,
      p_details: (details as Row | null | undefined) ?? null,
    });
    if (error) throw dbError(tool, "raise_signal", error);
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    if (!row || typeof row.created !== "boolean") {
      throw fail(tool, `raise_signal returned an unexpected result: ${JSON.stringify(data)}.`);
    }
    return row;
  },
});

// ---------------------------------------------------------------------------
// resolve_signal — tier 1 (append)
// ---------------------------------------------------------------------------

export const resolveSignalTool = defineTool({
  name: "resolve_signal",
  tables: { reads: ["signals"], writes: ["signals"] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "resolve_signal";
    const { data, error } = await ctx.db.rpc("resolve_signal", {
      p_app: requireText(tool, "app", args.app, 100),
      p_subject_key: requireSubjectKey(tool, args.subject_key),
      p_started_by: requireStartedBy(tool, args.started_by),
    });
    if (error) throw dbError(tool, "resolve_signal", error);
    const row = (Array.isArray(data) ? data[0] : data) as Row | null;
    if (!row || !Array.isArray(row.resolved)) {
      throw fail(tool, `resolve_signal returned an unexpected result: ${JSON.stringify(data)}.`);
    }
    return row;
  },
});

// ---------------------------------------------------------------------------
// get_signals — tier 1
// ---------------------------------------------------------------------------

export const getSignalsTool = defineTool({
  name: "get_signals",
  tables: { reads: ["signals"], writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_signals";
    const app = optionalText(tool, "app", args.app);
    const job = optionalText(tool, "job", args.job);
    const state = args.state === undefined ? null : requireEnum(tool, "state", args.state, STATES);
    const severity = args.severity === undefined ? null : requireEnum(tool, "severity", args.severity, SEVERITIES);
    const subjectKey = args.subject_key === undefined ? null : requireSubjectKey(tool, args.subject_key);
    const since = optionalTimestamp(tool, "since", args.since);
    const until = optionalTimestamp(tool, "until", args.until);
    if (since && until && Date.parse(since) > Date.parse(until)) {
      throw fail(tool, `since (${since}) is after until (${until}).`);
    }

    const page = await readTable(ctx, {
      tool,
      table: "signals",
      args,
      filter: (query) => {
        let q = query;
        if (app) q = q.eq("app", app);
        if (job) q = q.eq("job", job);
        if (state) q = q.eq("state", state);
        if (severity) q = q.eq("severity", severity);
        if (subjectKey) q = q.eq("subject_key", subjectKey);
        if (since) q = q.gte("created_at", since);
        if (until) q = q.lt("created_at", until);
        return q;
      },
      order: [{ column: "created_at", ascending: false }, { column: "id", ascending: true }],
      fullText: ["body"],
    });
    return envelope(page.data, page.meta);
  },
});

// ---------------------------------------------------------------------------
// get_dispatch_plan — tier 1 (compute only)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPATCH_READS = ["signals", "overwatch_plans", "inbox", "claude_notifications"];

type Decision = {
  signal_id: string; app: string; severity: string; subject_key: string; decision: string; reason: string;
  repeats: number; merge_target_signal_id: string | null; inbox_id: string | null; bundle: boolean;
};
type Plan = { at: string; stopped?: string; decisions: Decision[]; [k: string]: unknown };

async function dispatchPlan(db: Db, tool: string, at: string | null): Promise<Plan> {
  const { data, error } = await db.rpc("dispatch_signals", at ? { p_now: at } : {});
  if (error) throw dbError(tool, "dispatch_signals", error);
  const plan = (Array.isArray(data) ? data[0] : data) as Plan | null;
  if (!plan || !Array.isArray(plan.decisions)) {
    throw fail(tool, `dispatch_signals returned an unexpected result: ${JSON.stringify(data)}.`);
  }
  return plan;
}

export const getDispatchPlanTool = defineTool({
  name: "get_dispatch_plan",
  tables: { reads: DISPATCH_READS, writes: [] },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_dispatch_plan";
    return await dispatchPlan(ctx.db, tool, optionalTimestamp(tool, "at", args.at));
  },
});

// ---------------------------------------------------------------------------
// deliver_signals — tier 1
// ---------------------------------------------------------------------------
// Recomputes the plan itself, so only the wording comes from Claude, never a decision. Each signal moves only
// from queued, so a second run cannot deliver it twice.

// deno-lint-ignore no-explicit-any
type Db = any;
type Words = { title: string; body: string | null };

/** The kind a pop is logged as: details.kind when the sender gave one, else by severity. */
export function kindFor(signal: Row): string {
  const k = (signal.details as Row | null)?.kind;
  if (typeof k === "string" && KINDS.includes(k)) return k;
  return signal.severity === "high" || signal.severity === "urgent" ? "flag" : "info";
}

function wordingArg(tool: string, v: unknown): Record<string, Words> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw fail(tool, "`wording` must be an object keyed by signal id.");
  const out: Record<string, Words> = {};
  for (const [id, w] of Object.entries(v as Row)) {
    if (!UUID_RE.test(id)) throw fail(tool, `\`wording\` keys must be signal ids, got ${JSON.stringify(id)}.`);
    out[id] = digestArg(tool, `wording.${id}`, w)!;
  }
  return out;
}

function digestArg(tool: string, name: string, v: unknown): Words | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw fail(tool, `\`${name}\` must be {title, body}.`);
  const w = v as Row;
  return { title: requireText(tool, `${name}.title`, w.title, 200), body: optionalText(tool, `${name}.body`, w.body) };
}

function capturedText(title: string, body: string | null, link: string | null): string {
  return [title, body, link ? `Link: ${link}` : null].filter(Boolean).join("\n\n");
}

export const deliverSignalsTool = defineTool({
  name: "deliver_signals",
  tables: {
    reads: [...DISPATCH_READS, "push_subscriptions"],
    writes: ["signals", "inbox", "claude_notifications"],
  },
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "deliver_signals";
    const db = ctx.db as Db;
    const runId = optionalText(tool, "run_id", args.run_id);
    if (runId && !UUID_RE.test(runId)) throw fail(tool, "`run_id` must be the dispatcher's platform_runs id.");
    const wording = wordingArg(tool, args.wording);
    const digestWords = digestArg(tool, "digest", args.digest);

    const plan = await dispatchPlan(db, tool, null);
    if (plan.stopped) return { at: plan.at, stopped: plan.stopped, results: [] };
    const decisions = plan.decisions.filter((d) => d.decision !== "wait");
    const pops = decisions.some((d) => d.decision === "pop" || d.decision === "digest");
    if (pops) {
      try {
        loadVapid();
      } catch (e) {
        throw fail(tool, `push is not configured: ${(e as Error).message}. Nothing was delivered.`);
      }
    }

    const ids = decisions.map((d) => d.signal_id);
    const { data: rows, error: rowsError } = ids.length
      ? await db.from("signals")
        .select("id, app, job, severity, subject_key, title, body, link, started_by, details, state").in("id", ids)
      : { data: [], error: null };
    if (rowsError) throw dbError(tool, "reading signals", rowsError);
    const signals = new Map(((rows ?? []) as Row[]).map((r) => [r.id as string, r]));

    let subs: PushSubscriptionRow[] | null = null;
    const devices = async () => {
      if (subs) return subs;
      const { data, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth_key");
      if (error) throw dbError(tool, "push_subscriptions read", error);
      subs = (data ?? []) as PushSubscriptionRow[];
      return subs;
    };
    const now = () => new Date().toISOString();

    /** Move one signal on from queued; false when something else moved it first. */
    const decide = async (id: string, patch: Row) => {
      const { data, error } = await db.from("signals")
        .update({ decided_at: now(), decided_run_id: runId, ...patch }).eq("id", id).eq("state", "queued").select("id");
      if (error) throw dbError(tool, `updating signal ${id}`, error);
      return ((data ?? []) as Row[]).length > 0;
    };

    const newInbox = async (text: string, app: string, meta: Row) => {
      const id = crypto.randomUUID();
      const { error } = await db.from("inbox").insert({
        id, archived: false, triaged_at: null, captured_text: text, source_type: "task",
        source_metadata: { task_name: "dispatcher", app, ...meta }, source_app: app,
        ai_status: "not_started", suggest_item: false, suggest_intent: false, suggest_event: false,
        suggested_tags: [], suggested_status: "active",
      });
      if (error) throw dbError(tool, "creating the inbox item", error);
      return id;
    };

    const bumpRepeat = async (inboxId: string, signalId: string) => {
      const { data, error } = await db.from("inbox").select("source_metadata").eq("id", inboxId).maybeSingle();
      if (error) throw dbError(tool, "reading the inbox item to merge into", error);
      const meta = ((data as Row | null)?.source_metadata ?? {}) as Row;
      const merged = Array.isArray(meta.merged_signal_ids) ? meta.merged_signal_ids : [];
      const { error: upError } = await db.from("inbox").update({ source_metadata: {
        ...meta, repeat_count: (Number(meta.repeat_count) || 1) + 1, merged_signal_ids: [...merged, signalId],
      } }).eq("id", inboxId);
      if (upError) throw dbError(tool, "updating the inbox item merged into", upError);
    };

    const pop = async (p: { app: string; job: string; kind: string; title: string; body: string | null;
      inboxId: string; dedupe: string; startedBy: string | null; signalId: string | null; bundleId?: string }) => {
      const link = `/${p.inboxId}`;
      const logged = await logNotification(db, tool, {
        app: p.app, job: p.job, kind: p.kind, channel: "alfred_push", title: p.title, body: p.body, link,
        dedupe_key: p.dedupe, started_by: p.startedBy, signal_id: p.signalId,
        delivery_detail: p.bundleId ? { bundle_id: p.bundleId } : null,
      });
      if (!logged.created) return { notification_id: logged.id, delivery_status: "duplicate" };
      const results = await sendToAll(await devices(), JSON.stringify({
        title: p.title, body: p.body ?? "", tag: `signal-${p.dedupe}`, url: link,
      }));
      const outcome = deliveryOutcome(results);
      const { error } = await db.from("claude_notifications")
        .update({ delivery_status: outcome.status, delivery_detail: { ...outcome.detail, ...(p.bundleId ? { bundle_id: p.bundleId } : {}) } })
        .eq("id", logged.id);
      return { notification_id: logged.id, delivery_status: outcome.status, sent_to: outcome.detail.sent_to,
        ...(error ? { warning: `The push result could not be recorded: ${error.message}` } : {}) };
    };

    const delivered = new Map<string, string>();   // signal id -> inbox id, for same-run merges
    const results: Row[] = [];
    const digest: Row[] = [];

    for (const d of decisions) {
      const s = signals.get(d.signal_id);
      const result: Row = { signal_id: d.signal_id, decision: d.decision };
      results.push(result);
      try {
        if (!s || s.state !== "queued") { result.skipped = "no longer queued"; continue; }
        const words = wording[d.signal_id] ?? { title: s.title as string, body: (s.body as string | null) ?? null };
        const meta = { signal_id: d.signal_id, subject_key: s.subject_key, job: s.job, started_by: s.started_by };

        if (d.decision === "hold") {
          if (!await decide(d.signal_id, { state: "held", reason: d.reason })) result.skipped = "no longer queued";
        } else if (d.decision === "inbox") {
          const inboxId = await newInbox(capturedText(words.title, words.body, s.link as string | null), s.app as string, meta);
          await logNotification(db, tool, {
            app: s.app as string, job: s.job as string, kind: kindFor(s), channel: "inbox_item", title: words.title,
            body: words.body, link: `/${inboxId}`, dedupe_key: `signal:${d.signal_id}`, delivery_status: "sent",
            delivery_detail: { inbox_id: inboxId }, started_by: s.started_by as string, signal_id: d.signal_id,
          });
          await decide(d.signal_id, { state: "delivered", outcome: "inbox", reason: d.reason, inbox_id: inboxId });
          delivered.set(d.signal_id, inboxId);
          result.inbox_id = inboxId;
        } else if (d.decision === "merge") {
          const target = d.merge_target_signal_id;
          const inboxId = d.inbox_id ?? (target ? delivered.get(target) ?? null : null);
          if (!target) throw fail(tool, "merge with no target signal.");
          if (inboxId) await bumpRepeat(inboxId, d.signal_id);
          await decide(d.signal_id, { state: "merged", merged_into: target, reason: d.reason, inbox_id: inboxId });
          result.inbox_id = inboxId;
        } else if (d.decision === "pop") {
          const inboxId = d.inbox_id ??
            await newInbox(capturedText(words.title, words.body, s.link as string | null), s.app as string, meta);
          if (d.inbox_id) await bumpRepeat(inboxId, d.signal_id);
          Object.assign(result, await pop({ app: s.app as string, job: s.job as string, kind: kindFor(s),
            title: words.title, body: words.body, inboxId, dedupe: `signal:${d.signal_id}`,
            startedBy: s.started_by as string, signalId: d.signal_id }));
          await decide(d.signal_id, { state: "delivered", outcome: "pop", reason: d.reason, inbox_id: inboxId,
            notification_id: result.notification_id });
          delivered.set(d.signal_id, inboxId);
          result.inbox_id = inboxId;
        } else if (d.decision === "digest") {
          digest.push({ d, s, words, result });
        } else {
          throw fail(tool, `unknown decision ${JSON.stringify(d.decision)} from dispatch_signals.`);
        }
      } catch (e) {
        result.error = (e as Error).message;
      }
    }

    let digestResult: Row | null = null;
    if (digest.length) {
      const bundleId = crypto.randomUUID();
      const first = digest[0].s as Row;
      const words = digestWords ?? { title: `${digest.length} updates`, body: null };
      const list = digest.map(({ words: w, s }) =>
        `- ${(w as Words).title}${(s as Row).link ? ` (${(s as Row).link})` : ""}`).join("\n");
      try {
        const inboxId = await newInbox(capturedText(words.title, [words.body, list].filter(Boolean).join("\n\n"), null),
          first.app as string, { bundle_id: bundleId, signal_ids: digest.map(({ d }) => (d as Decision).signal_id) });
        digestResult = { bundle_id: bundleId, inbox_id: inboxId, ...(await pop({ app: first.app as string,
          job: "dispatcher_digest", kind: "info", title: words.title, body: words.body ?? list, inboxId,
          dedupe: `digest:${bundleId}`, startedBy: first.started_by as string, signalId: null, bundleId })) };
        for (const { d, result } of digest) {
          await decide((d as Decision).signal_id, { state: "delivered", outcome: "pop", reason: (d as Decision).reason,
            inbox_id: inboxId, bundle_id: bundleId, notification_id: digestResult.notification_id });
          Object.assign(result as Row, { inbox_id: inboxId, bundle_id: bundleId });
        }
      } catch (e) {
        for (const { result } of digest) (result as Row).error = (e as Error).message;
      }
    }

    const counts: Record<string, number> = {};
    for (const d of plan.decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;
    return { at: plan.at, counts, results, ...(digestResult ? { digest: digestResult } : {}),
      errors: results.filter((r) => r.error).length };
  },
});
