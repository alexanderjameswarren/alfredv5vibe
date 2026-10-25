// ============================================================================
// supabase/functions/_shared/tools/overwatch-plan.ts
//
// Overwatch's own state. Spec: docs/technical-spec-overwatch-q4n.md 4.1, 4.5 to 4.11 and 7.
//
//   get_overwatch_plan       tier 1 — the active plan whole; history on request.
//   create_overwatch_plan    tier 3 — supersede the active plan (propose shows what changes).
//   update_overwatch_checks  tier 2 — replace checks_next_run on the active plan.
//   get_overwatch_watch      tier 1 — watch items, current ones by default.
//   create_overwatch_watch   tier 2 — add a dated focus, ease_off or keep_an_eye_on.
//   update_overwatch_watch   tier 2 — change one, or note that its expiry was mentioned.
//   get_overwatch_notes      tier 1 — the nightly and weekly notes, newest first.
//   create_overwatch_note    tier 2 — write the day's note; a re-run replaces it.
//   get_claim_blocks         tier 1 — claims block episodes between CLI threads.
//   update_app_profile       tier 2 — an app's activity recipe, rhythm and current state.
//   record_seen_releases     tier 1 — release-note entries seen, each once.
//   log_friction             tier 1 — a snag in how the work runs.
//   get_friction             tier 1 — friction entries, open ones by default.
//   update_friction          tier 2 — group entries into a pattern, or resolve them.
// ============================================================================

import { defineTool, describeDbError, readTable } from "../platform.ts";

export const WATCH_KINDS = ["focus", "ease_off", "keep_an_eye_on"] as const;
export const NOTE_PERIODS = ["nightly", "weekly"] as const;
export const RELEASE_SOURCES = ["claude_release_notes", "claude_code_changelog", "api_release_notes"] as const;
export const FRICTION_PROCESSES = ["cli_testing_steps", "cli_prompt", "todos", "closeout", "inbox", "other"] as const;
const AUTHORS = ["alex", "overwatch"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[a-z0-9_-]{1,40}$/;
const SKILL = /^skill:[a-z0-9_-]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

const WATCH_COLUMNS = "id, kind, text, app_id, group_id, starts_on, ends_on, created_by, expiry_noted_at, created_at";
const NOTE_COLUMNS = "id, period, for_date, body, flags, plan_id, created_at";
const PROFILE_COLUMNS = "id, app_id, activity_recipe, rhythm_days, current_state, current_state_updated_at, updated_at";
const FRICTION_COLUMNS =
  "id, occurred_at, what_happened, process, project_code, suggested_fix, pattern_id, resolved_by, resolved_at, created_at";

/** Today in America/Los_Angeles, YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(now);
}

function given(args: Record<string, unknown>, k: string) {
  return args[k] !== undefined && args[k] !== null;
}

function text(T: string, key: string, value: unknown, { required = false } = {}): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${T}: ${key} is required.`);
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${T}: ${key} must be non-empty text.`);
  return value.trim();
}

function day(T: string, key: string, value: unknown, { required = false } = {}): string | null {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${T}: ${key} is required, YYYY-MM-DD.`);
    return null;
  }
  if (typeof value !== "string" || !DAY.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${T}: ${key} must be a date, YYYY-MM-DD; got ${JSON.stringify(value)}.`);
  }
  return value;
}

function oneOf<V extends string>(T: string, key: string, value: unknown, allowed: readonly V[]): V {
  if (!(allowed as readonly unknown[]).includes(value)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}.`);
  }
  return value as V;
}

function object(T: string, key: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${T}: ${key} must be a JSON object.`);
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// get_overwatch_plan — tier 1
// ---------------------------------------------------------------------------

export const getOverwatchPlanTool = defineTool({
  name: "get_overwatch_plan",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_overwatch_plan";
    if (given(args, "history") && typeof args.history !== "boolean") throw new Error(`${T}: history must be true or false.`);
    return await readTable(ctx, {
      tool: T,
      table: "overwatch_plans",
      args,
      filter: (q) => (args.history === true ? q : q.eq("active", true)),
      order: [{ column: "created_at", ascending: false }, { column: "id", ascending: true }],
      // The rulebook is read whole, even in a history list.
      fullText: ["instructions", "settings", "checks_next_run"],
    });
  },
});

// ---------------------------------------------------------------------------
// create_overwatch_plan — tier 3
// ---------------------------------------------------------------------------
// Supersedes the active plan: the gate in principle 4. propose shows what changes before Alex confirms.

export function planInput(T: string, args: Record<string, unknown>) {
  const instructions = text(T, "instructions", args.instructions, { required: true })!;
  const settings = object(T, "settings", args.settings);
  const reason = text(T, "reason", args.reason, { required: true })!;
  const writtenBy = given(args, "written_by") ? oneOf(T, "written_by", args.written_by, AUTHORS) : "alex";
  let checks: unknown[] | null = null;
  if (given(args, "checks")) {
    if (!Array.isArray(args.checks)) throw new Error(`${T}: checks must be a list.`);
    checks = args.checks;
  }
  return { instructions, settings, reason, writtenBy, checks };
}

async function activePlan(T: string, ctx: { db: any }) {
  const { data, error } = await ctx.db.from("overwatch_plans")
    .select("id, instructions, settings, checks_next_run, created_at").eq("active", true).maybeSingle();
  if (error) throw new Error(describeDbError(T, error));
  return data as { id: string; instructions: string; settings: Record<string, unknown>; checks_next_run: unknown[] } | null;
}

export function describeChange(
  current: { instructions: string; settings: Record<string, unknown>; checks_next_run: unknown[] } | null,
  next: ReturnType<typeof planInput>,
): string[] {
  const lines = [`NEW OVERWATCH PLAN (written by ${next.writtenBy}). Reason: ${next.reason}`];
  if (!current) {
    lines.push("There is no active plan; this becomes the first.");
    return lines;
  }
  lines.push(current.instructions === next.instructions ? "Instructions: unchanged." : `Instructions, new text:\n${next.instructions}`);
  const keys = [...new Set([...Object.keys(current.settings ?? {}), ...Object.keys(next.settings)])].sort();
  const changed = keys.filter((k) => JSON.stringify(current.settings?.[k]) !== JSON.stringify(next.settings[k]));
  lines.push(changed.length
    ? `Settings changed: ${changed.map((k) => `${k} ${JSON.stringify(current.settings?.[k] ?? null)} -> ${JSON.stringify(next.settings[k] ?? null)}`).join("; ")}.`
    : "Settings: unchanged.");
  lines.push(next.checks ? `Checks for next run: replaced with ${next.checks.length}.` :
    `Checks for next run: the current ${current.checks_next_run?.length ?? 0} carry over.`);
  return lines;
}

export const createOverwatchPlanTool = defineTool({
  name: "create_overwatch_plan",
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => {
    const T = "create_overwatch_plan";
    const next = planInput(T, args);
    return { text: describeChange(await activePlan(T, ctx), next).join("\n") };
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_overwatch_plan";
    const next = planInput(T, args);
    const { data, error } = await ctx.db.rpc("create_overwatch_plan", {
      p_instructions: next.instructions,
      p_settings: next.settings,
      p_reason: next.reason,
      p_written_by: next.writtenBy,
      p_checks: next.checks,
    });
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// update_overwatch_checks — tier 2
// ---------------------------------------------------------------------------

export const updateOverwatchChecksTool = defineTool({
  name: "update_overwatch_checks",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_overwatch_checks";
    if (!Array.isArray(args.checks)) throw new Error(`${T}: checks is required, a list of { text, check_on, about }.`);
    args.checks.forEach((c, i) => {
      const o = object(T, `checks[${i}]`, c);
      text(T, `checks[${i}].text`, o.text, { required: true });
      day(T, `checks[${i}].check_on`, o.check_on, { required: true });
    });
    const { data, error } = await ctx.db.rpc("update_overwatch_checks", { p_checks: args.checks });
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// watch items
// ---------------------------------------------------------------------------

export const getOverwatchWatchTool = defineTool({
  name: "get_overwatch_watch",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_overwatch_watch";
    const kind = given(args, "kind") ? oneOf(T, "kind", args.kind, WATCH_KINDS) : null;
    const appId = text(T, "app_id", args.app_id);
    const groupId = text(T, "group_id", args.group_id);
    if (given(args, "current") && typeof args.current !== "boolean") throw new Error(`${T}: current must be true or false.`);
    const today = pacificToday();
    return await readTable(ctx, {
      tool: T,
      table: "overwatch_watch",
      args,
      filter: (query) => {
        let q = query;
        // Current by default: started and not yet ended, in Pacific days.
        if (args.current !== false) q = q.lte("starts_on", today).gte("ends_on", today);
        if (kind) q = q.eq("kind", kind);
        if (appId) q = q.eq("app_id", appId);
        if (groupId) q = q.eq("group_id", groupId);
        return q;
      },
      order: [{ column: "ends_on", ascending: true }, { column: "id", ascending: true }],
      fullText: ["text"],
    });
  },
});

export const createOverwatchWatchTool = defineTool({
  name: "create_overwatch_watch",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_overwatch_watch";
    const row = {
      kind: oneOf(T, "kind", args.kind, WATCH_KINDS),
      text: text(T, "text", args.text, { required: true }),
      app_id: text(T, "app_id", args.app_id),
      group_id: text(T, "group_id", args.group_id),
      starts_on: day(T, "starts_on", args.starts_on) ?? pacificToday(),
      ends_on: day(T, "ends_on", args.ends_on, { required: true }),
      created_by: given(args, "created_by") ? oneOf(T, "created_by", args.created_by, AUTHORS) : "alex",
    };
    if (row.ends_on! < row.starts_on) throw new Error(`${T}: ends_on ${row.ends_on} is before starts_on ${row.starts_on}.`);
    const { data, error } = await ctx.db.from("overwatch_watch").insert(row).select(WATCH_COLUMNS).maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

export const updateOverwatchWatchTool = defineTool({
  name: "update_overwatch_watch",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_overwatch_watch";
    const id = text(T, "id", args.id, { required: true })!;
    const patch: Record<string, unknown> = {};
    if (given(args, "text")) patch.text = text(T, "text", args.text);
    if (given(args, "starts_on")) patch.starts_on = day(T, "starts_on", args.starts_on);
    if (given(args, "ends_on")) patch.ends_on = day(T, "ends_on", args.ends_on);
    if (given(args, "expiry_noted")) {
      if (args.expiry_noted !== true) throw new Error(`${T}: expiry_noted can only be true.`);
      patch.expiry_noted_at = new Date().toISOString();
    }
    if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change; pass text, starts_on, ends_on or expiry_noted.`);
    const { data, error } = await ctx.db.from("overwatch_watch").update(patch).eq("id", id).select(WATCH_COLUMNS).maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    if (!data) throw new Error(`${T}: no watch item ${id} that you can see. Nothing was changed.`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export const getOverwatchNotesTool = defineTool({
  name: "get_overwatch_notes",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_overwatch_notes";
    const period = given(args, "period") ? oneOf(T, "period", args.period, NOTE_PERIODS) : null;
    const from = day(T, "from", args.from);
    const to = day(T, "to", args.to);
    return await readTable(ctx, {
      tool: T,
      table: "overwatch_notes",
      args,
      filter: (query) => {
        let q = query;
        if (period) q = q.eq("period", period);
        if (from) q = q.gte("for_date", from);
        if (to) q = q.lte("for_date", to);
        return q;
      },
      order: [{ column: "for_date", ascending: false }, { column: "period", ascending: true }],
      fullText: ["body", "flags"],
    });
  },
});

export const createOverwatchNoteTool = defineTool({
  name: "create_overwatch_note",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_overwatch_note";
    const period = oneOf(T, "period", args.period, NOTE_PERIODS);
    const forDate = day(T, "for_date", args.for_date) ?? pacificToday();
    const body = text(T, "body", args.body, { required: true });
    const flags = given(args, "flags") ? object(T, "flags", args.flags) : {};
    const plan = await activePlan(T, ctx);
    const { data, error } = await ctx.db
      .from("overwatch_notes")
      .upsert({ period, for_date: forDate, body, flags, plan_id: plan?.id ?? null }, { onConflict: "user_id,period,for_date" })
      .select(NOTE_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// claim blocks
// ---------------------------------------------------------------------------

export const getClaimBlocksTool = defineTool({
  name: "get_claim_blocks",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_claim_blocks";
    const projectCode = (k: string, v: unknown) => {
      const s = text(T, k, v);
      if (s && !CODE.test(s)) throw new Error(`${T}: ${k} must be a project code, e.g. overwatch-q4n.`);
      return s;
    };
    const waiter = projectCode("waiter_code", args.waiter_code);
    const holder = projectCode("holder_code", args.holder_code);
    // code goes into a PostgREST or() string; the pattern above keeps it to code characters.
    const code = projectCode("code", args.code);
    const since = day(T, "since", args.since);
    if (given(args, "open") && typeof args.open !== "boolean") throw new Error(`${T}: open must be true or false.`);
    return await readTable(ctx, {
      tool: T,
      table: "claim_blocks",
      args,
      filter: (query) => {
        let q = query;
        if (waiter) q = q.eq("waiter_code", waiter);
        if (holder) q = q.eq("holder_code", holder);
        // Either side of the block.
        if (code) q = q.or(`waiter_code.eq.${code},holder_code.eq.${code}`);
        if (since) q = q.gte("blocked_at", since);
        if (args.open === true) q = q.is("cleared_at", null);
        if (args.open === false) q = q.not("cleared_at", "is", null);
        return q;
      },
      order: [{ column: "blocked_at", ascending: false }, { column: "id", ascending: true }],
    });
  },
});

// ---------------------------------------------------------------------------
// app profiles
// ---------------------------------------------------------------------------

export const updateAppProfileTool = defineTool({
  name: "update_app_profile",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_app_profile";
    const appId = text(T, "app_id", args.app_id, { required: true })!;
    const patch: Record<string, unknown> = {};
    if (args.activity_recipe !== undefined) patch.activity_recipe = text(T, "activity_recipe", args.activity_recipe);
    if (args.current_state !== undefined) patch.current_state = text(T, "current_state", args.current_state);
    if (args.rhythm_days !== undefined) {
      const v = args.rhythm_days;
      if (v !== null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 365)) {
        throw new Error(`${T}: rhythm_days is a whole number of days, 1 to 365, or null for an app with no rhythm.`);
      }
      patch.rhythm_days = v;
    }
    if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change; pass activity_recipe, rhythm_days or current_state.`);
    const { data, error } = await ctx.db
      .from("app_profiles")
      .upsert({ app_id: appId, ...patch }, { onConflict: "user_id,app_id" })
      .select(PROFILE_COLUMNS)
      .maybeSingle();
    if (error?.code === "23503") throw new Error(`${T}: no app ${JSON.stringify(appId)}; use an id from get_apps.`);
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// seen releases — tier 1
// ---------------------------------------------------------------------------

export const recordSeenReleasesTool = defineTool({
  name: "record_seen_releases",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "record_seen_releases";
    if (!Array.isArray(args.entries) || args.entries.length === 0) throw new Error(`${T}: entries is required, a non-empty list.`);
    if (args.entries.length > 50) throw new Error(`${T}: at most 50 entries per call; got ${args.entries.length}.`);
    const rows = args.entries.map((e, i) => {
      const o = object(T, `entries[${i}]`, e);
      return {
        source: oneOf(T, `entries[${i}].source`, o.source, RELEASE_SOURCES),
        entry_key: text(T, `entries[${i}].entry_key`, o.entry_key, { required: true }),
        title: text(T, `entries[${i}].title`, o.title, { required: true }),
        summary: text(T, `entries[${i}].summary`, o.summary),
      };
    });
    // Which are new decides what the weekly item lists, so the seen ones are found first.
    const { data: seen, error: readError } = await ctx.db.from("overwatch_seen_releases")
      .select("source, entry_key").in("entry_key", rows.map((r) => r.entry_key));
    if (readError) throw new Error(describeDbError(T, readError));
    const known = new Set(((seen ?? []) as { source: string; entry_key: string }[]).map((s) => `${s.source}|${s.entry_key}`));
    const fresh = rows.filter((r, i) => !known.has(`${r.source}|${r.entry_key}`) &&
      rows.findIndex((x) => x.source === r.source && x.entry_key === r.entry_key) === i);
    if (fresh.length) {
      const { error } = await ctx.db.from("overwatch_seen_releases")
        .upsert(fresh, { onConflict: "user_id,source,entry_key", ignoreDuplicates: true });
      if (error) throw new Error(describeDbError(T, error));
    }
    return {
      recorded: fresh.map((r) => ({ source: r.source, entry_key: r.entry_key, title: r.title })),
      already_seen: rows.filter((r) => !fresh.includes(r)).map((r) => ({ source: r.source, entry_key: r.entry_key })),
    };
  },
});

// ---------------------------------------------------------------------------
// friction
// ---------------------------------------------------------------------------

function frictionProcess(T: string, value: unknown): string {
  if (typeof value === "string" && ((FRICTION_PROCESSES as readonly string[]).includes(value) || SKILL.test(value))) return value;
  throw new Error(`${T}: process must be one of ${FRICTION_PROCESSES.join(", ")}, or skill:<name>; got ${JSON.stringify(value)}.`);
}

export const logFrictionTool = defineTool({
  name: "log_friction",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "log_friction";
    const code = text(T, "project_code", args.project_code);
    if (code && !CODE.test(code)) throw new Error(`${T}: project_code must be a project code, e.g. overwatch-q4n.`);
    let occurredAt: string | undefined;
    if (given(args, "occurred_at")) {
      if (typeof args.occurred_at !== "string" || !WITH_OFFSET.test(args.occurred_at) || Number.isNaN(Date.parse(args.occurred_at))) {
        throw new Error(`${T}: occurred_at must be an ISO time WITH offset.`);
      }
      occurredAt = new Date(args.occurred_at).toISOString();
    }
    const row = {
      what_happened: text(T, "what_happened", args.what_happened, { required: true }),
      process: frictionProcess(T, args.process),
      project_code: code,
      suggested_fix: text(T, "suggested_fix", args.suggested_fix),
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    };
    const { data, error } = await ctx.db.from("process_friction").insert(row).select(FRICTION_COLUMNS).maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

export const getFrictionTool = defineTool({
  name: "get_friction",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_friction";
    const proc = given(args, "process") ? frictionProcess(T, args.process) : null;
    const code = text(T, "project_code", args.project_code);
    const patternId = text(T, "pattern_id", args.pattern_id);
    const since = day(T, "since", args.since);
    if (given(args, "open") && typeof args.open !== "boolean") throw new Error(`${T}: open must be true or false.`);
    return await readTable(ctx, {
      tool: T,
      table: "process_friction",
      args,
      filter: (query) => {
        let q = query;
        // Open by default: what the weekly grouping works on.
        if (args.open !== false) q = q.is("resolved_at", null);
        if (proc) q = q.eq("process", proc);
        if (code) q = q.eq("project_code", code);
        if (patternId) q = q.eq("pattern_id", patternId);
        if (since) q = q.gte("occurred_at", since);
        return q;
      },
      order: [{ column: "occurred_at", ascending: false }, { column: "id", ascending: true }],
      fullText: ["what_happened", "suggested_fix"],
    });
  },
});

export const updateFrictionTool = defineTool({
  name: "update_friction",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_friction";
    if (!Array.isArray(args.ids) || args.ids.length === 0 || args.ids.some((i) => typeof i !== "string" || !UUID.test(i))) {
      throw new Error(`${T}: ids is required, a list of friction entry ids.`);
    }
    if (args.ids.length > 50) throw new Error(`${T}: at most 50 ids per call.`);
    const patch: Record<string, unknown> = {};
    if (given(args, "pattern_id")) {
      if (args.pattern_id === "new") patch.pattern_id = crypto.randomUUID();
      else if (typeof args.pattern_id === "string" && UUID.test(args.pattern_id)) patch.pattern_id = args.pattern_id;
      else throw new Error(`${T}: pattern_id must be an existing pattern's uuid, or "new" to start one.`);
    }
    if (given(args, "resolved_by")) {
      patch.resolved_by = text(T, "resolved_by", args.resolved_by);
      patch.resolved_at = new Date().toISOString();
    }
    if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change; pass pattern_id or resolved_by.`);
    const { data, error } = await ctx.db.from("process_friction").update(patch).in("id", args.ids).select(FRICTION_COLUMNS);
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as { id: string }[];
    const missing = (args.ids as string[]).filter((i) => !rows.some((r) => r.id === i));
    return { updated: rows, ...(missing.length ? { not_found: missing } : {}) };
  },
});
