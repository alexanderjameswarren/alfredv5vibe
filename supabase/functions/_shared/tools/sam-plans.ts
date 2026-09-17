// ============================================================================
// supabase/functions/_shared/tools/sam-plans.ts
//
// SAM practice plans and goals — Claude's tools. Spec:
// docs/technical-spec-sam-practice-plans.md §6.
//
//   Reads (tier 1)   get_sam_practice_plan, get_sam_practice_plans,
//                    get_sam_plan_progress, get_sam_goals
//   Writes           create_sam_practice_plan   tier 3 (supersedes a plan)
//                    update_sam_plan_review_note tier 2
//                    update_sam_song_goal       tier 3
//                    create_sam_goal            tier 1
//                    update_sam_goal            tier 2
//
// Database access ONLY through ctx.db (platform contract). No deletes: plans
// are superseded, goals are dropped.
//
// Tier-3 tools pass `propose` to defineTool. The built-in gate still refuses
// every unconfirmed call; `propose` only makes the proposal readable (titles,
// measure ranges, heard tempos) and refuses a request that cannot succeed
// before anyone is asked to approve it.
// ============================================================================

import { defineTool, clampLimit, envelope } from "../platform.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
type Row = Record<string, unknown>;

/**
 * The rules every description in this family repeats. Exported so
 * mcp/index.ts appends the same text to each tool rather than paraphrasing it.
 */
export const SAM_DATA_RULES =
  "RULES FOR THIS DATA: (1) Compare HEARD tempos only — sam_passes.effective_bpm, plan item " +
  "target_effective_bpm, song goal_effective_bpm. NEVER read goal_bpm or default_bpm as a target: on " +
  "songs with audio, default_bpm is the scroll-sync calibration and goal_bpm is forced equal to it, so " +
  "they give a believable wrong number. BPM is quarter notes per minute, 6/8 included. (2) A pass with " +
  "notes_played 0 is test data (no keyboard attached) and never counts; a pass with null effective_bpm " +
  "(before 2026-09-16) never counts either. (3) Measure numbers are PLAYED numbers (repeats written out), " +
  "the numbers snippets use; add the printed number in parentheses when it helps, e.g. \"m.37 (22)\". " +
  "(4) A song goal whose goal_set_at is null is a PLACEHOLDER, not a target. (5) Days are Pacific " +
  "(America/Los_Angeles) dates.";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isSet = (v: unknown) => v !== undefined && v !== null;

export const PLAN_STATUSES = ["active", "superseded"];
export const GOAL_KINDS = ["song", "technique", "progression"];
export const GOAL_STATUSES = ["someday", "active", "done", "dropped"];
export const MAX_RANGE_DAYS = 31;
export const MAX_PLAN_ITEMS = 20;

function fail(tool: string, message: string): Error {
  return new Error(`${tool}: ${message}`);
}

function requireUuid(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) {
    throw fail(tool, `\`${name}\` must be a UUID, got ${JSON.stringify(v)}.`);
  }
  return v;
}

function optionalUuid(tool: string, name: string, v: unknown): string | undefined {
  return isSet(v) ? requireUuid(tool, name, v) : undefined;
}

function optionalEnum(tool: string, name: string, v: unknown, allowed: string[]): string | undefined {
  if (!isSet(v)) return undefined;
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw fail(tool, `\`${name}\` must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v)}.`);
  }
  return v;
}

function optionalText(tool: string, name: string, v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw fail(tool, `\`${name}\` must be a string.`);
  return v;
}

function requireText(tool: string, name: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw fail(tool, `\`${name}\` is required and must be non-empty text.`);
  }
  return v;
}

function positiveInt(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) > 0;
}

/**
 * A database error, worded by kind. RAISE EXCEPTION (P0001) and constraint or
 * data errors (classes 22, 23) are the database refusing the request: they
 * surface as validation errors with the database's message unchanged. Anything
 * else is operational and retryable, so it carries no do-not-retry wording.
 */
function dbError(tool: string, what: string, error: { code?: string; message?: string }): Error {
  const code = error.code ?? "";
  const message = error.message ?? "(no message)";
  if (code === "P0001" || code.startsWith("22") || code.startsWith("23")) {
    return fail(tool, `validation error: ${message}`);
  }
  return fail(tool, `${what} failed: ${message}${code ? ` [${code}]` : ""}`);
}

// --- Pacific dates ------------------------------------------------------------

const PT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" in America/Los_Angeles. */
export function ptDate(d: Date): string {
  return PT_DATE.format(d);
}

function validDate(tool: string, name: string, v: unknown): string | undefined {
  if (!isSet(v)) return undefined;
  if (typeof v !== "string" || !DATE_RE.test(v) ||
      new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw fail(tool, `\`${name}\` must be a Pacific date "YYYY-MM-DD", got ${JSON.stringify(v)}.`);
  }
  return v;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The date range get_sam_plan_progress reads. Defaults: from the plan's
 * starts_on; to today (Pacific) for an active plan, or the Pacific date the
 * plan ended for a superseded one. Longer than 31 days keeps the LATEST 31.
 */
export function resolveProgressRange(
  plan: { status: string; starts_on: string; ended_at: string | null },
  dateFrom: string | undefined,
  dateTo: string | undefined,
  now: Date = new Date(),
) {
  const tool = "get_sam_plan_progress";
  const to = dateTo ??
    (plan.status !== "active" && plan.ended_at ? ptDate(new Date(plan.ended_at)) : ptDate(now));
  const from = dateFrom ?? plan.starts_on;
  if (from > to) {
    throw fail(tool, `date_from (${from}) is after date_to (${to}).`);
  }
  const days = daysInclusive(from, to);
  if (days <= MAX_RANGE_DAYS) {
    return { date_from: from, date_to: to, days, capped: false };
  }
  const cappedFrom = addDays(to, -(MAX_RANGE_DAYS - 1));
  return {
    date_from: cappedFrom,
    date_to: to,
    days: MAX_RANGE_DAYS,
    capped: true,
    requested_from: from,
    note: `The requested range ${from} to ${to} is ${days} days; only the latest ${MAX_RANGE_DAYS} ` +
      `(${cappedFrom} to ${to}) were read. Ask again with an earlier date_to for the rest.`,
  };
}

// --- lookups ------------------------------------------------------------------

const PLAN_COLS =
  "id, status, starts_on, ended_at, supersedes_plan_id, day_note, internal_notes, " +
  "review_instructions, review_note, review_noted_at, created_at, updated_at";
const PLAN_SONG_COLS = "id, plan_id, song_id, position, song_note, internal_notes, created_at";
const ITEM_COLS =
  "id, plan_id, plan_song_id, song_id, snippet_id, position, is_free_play, target_bpm, " +
  "target_playback_speed, target_effective_bpm, target_passes, accuracy_target, instruction, created_at";
const SONG_COLS =
  "id, title, archived, audio_file_path, default_bpm, goal_bpm, goal_playback_speed, " +
  "goal_effective_bpm, goal_set_at";
const SNIPPET_COLS = "id, song_id, title, start_measure, end_measure, settings, archived";
const GOAL_COLS = "id, title, kind, status, song_id, notes, completed_at, created_at, updated_at";

async function byId(db: Db, tool: string, table: string, cols: string, ids: unknown[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, Row>();
  if (unique.length === 0) return map;
  const { data, error } = await db.from(table).select(cols).in("id", unique);
  if (error) throw dbError(tool, `${table} lookup`, error);
  for (const r of (data ?? []) as Row[]) map.set(r.id as string, r);
  return map;
}

const handLabel = (m: string) => (m === "lh" ? "LH" : m === "rh" ? "RH" : "Both");

/** Range fields for an item or pass. A null snippet is the whole song. */
function rangeOf(snippetId: unknown, snippets: Map<string, Row>) {
  if (!snippetId) {
    return { snippet_title: "Whole song", start_measure: null, end_measure: null, hand_mode: null };
  }
  const s = snippets.get(snippetId as string);
  if (!s) return { snippet_title: null, start_measure: null, end_measure: null, hand_mode: null };
  return {
    snippet_title: s.title,
    start_measure: s.start_measure,
    end_measure: s.end_measure,
    hand_mode: ((s.settings as Row | null)?.handMode as string) || "both",
  };
}

function rangeText(snippetId: unknown, snippets: Map<string, Row>): string {
  const r = rangeOf(snippetId, snippets);
  if (!snippetId) return "Whole song";
  return `${r.snippet_title} (m.${r.start_measure}–${r.end_measure}, ${handLabel(r.hand_mode as string)})`;
}

async function findPlan(db: Db, tool: string, planId: string | undefined): Promise<Row | null> {
  let q = db.from("sam_practice_plans").select(PLAN_COLS);
  q = planId ? q.eq("id", planId) : q.eq("status", "active");
  const { data, error } = await q.maybeSingle();
  if (error) throw dbError(tool, "plan lookup", error);
  if (!data && planId) throw fail(tool, `plan ${planId} not found.`);
  return data ?? null;
}

/** The full plan view: every plan column, songs and items in position order. */
export async function planView(db: Db, tool: string, plan: Row) {
  const [songsRes, itemsRes] = await Promise.all([
    db.from("sam_practice_plan_songs").select(PLAN_SONG_COLS).eq("plan_id", plan.id).order("position"),
    db.from("sam_practice_plan_items").select(ITEM_COLS).eq("plan_id", plan.id).order("position"),
  ]);
  if (songsRes.error) throw dbError(tool, "plan songs lookup", songsRes.error);
  if (itemsRes.error) throw dbError(tool, "plan items lookup", itemsRes.error);
  const planSongs = (songsRes.data ?? []) as Row[];
  const items = (itemsRes.data ?? []) as Row[];

  const songs = await byId(db, tool, "sam_songs", SONG_COLS, planSongs.map((s) => s.song_id));
  const snippets = await byId(db, tool, "sam_snippets", SNIPPET_COLS, items.map((i) => i.snippet_id));

  return {
    plan,
    songs: planSongs.map((ps) => {
      const s = songs.get(ps.song_id as string);
      return {
        ...ps,
        song_title: s?.title ?? null,
        has_audio: s ? s.audio_file_path != null : null,
        default_bpm: s?.default_bpm ?? null,
        goal_effective_bpm: s?.goal_effective_bpm ?? null,
        goal_set_at: s?.goal_set_at ?? null,
      };
    }),
    items: items.map((it) => ({
      ...it,
      song_title: songs.get(it.song_id as string)?.title ?? null,
      ...rangeOf(it.snippet_id, snippets),
    })),
  };
}

// ---------------------------------------------------------------------------
// get_sam_practice_plan — tier 1
// ---------------------------------------------------------------------------

export const getSamPracticePlanTool = defineTool({
  name: "get_sam_practice_plan",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sam_practice_plan";
    const planId = optionalUuid(tool, "plan_id", args.plan_id);
    const plan = await findPlan(ctx.db, tool, planId);
    if (!plan) return { plan: null };
    return await planView(ctx.db, tool, plan);
  },
});

// ---------------------------------------------------------------------------
// get_sam_practice_plans — tier 1
// ---------------------------------------------------------------------------

export const getSamPracticePlansTool = defineTool({
  name: "get_sam_practice_plans",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sam_practice_plans";
    const status = optionalEnum(tool, "status", args.status, PLAN_STATUSES);
    const songId = optionalUuid(tool, "song_id", args.song_id);
    const LIMIT = clampLimit(args.limit as number | undefined);

    // With song_id: only plans containing that song.
    let planSongRows: Row[] = [];
    if (songId) {
      const { data, error } = await ctx.db
        .from("sam_practice_plan_songs").select(PLAN_SONG_COLS).eq("song_id", songId);
      if (error) throw dbError(tool, "plan songs lookup", error);
      planSongRows = (data ?? []) as Row[];
      if (planSongRows.length === 0) {
        return envelope([], { limit_applied: LIMIT, truncated: false });
      }
    }

    let q = ctx.db.from("sam_practice_plans").select(PLAN_COLS, { count: "exact" });
    if (status) q = q.eq("status", status);
    if (songId) q = q.in("id", planSongRows.map((r) => r.plan_id));
    const { data, count, error } = await q
      .order("created_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw dbError(tool, "plans lookup", error);
    const plans = (data ?? []) as unknown as Row[];
    const meta = typeof count === "number" && count > plans.length
      ? { limit_applied: LIMIT, truncated: true, total: count }
      : { limit_applied: LIMIT, truncated: false };

    if (!songId) return envelope(plans, meta);

    // That song's plan-song row and items from each plan.
    const planIds = plans.map((p) => p.id);
    const { data: itemData, error: itemErr } = planIds.length
      ? await ctx.db.from("sam_practice_plan_items").select(ITEM_COLS)
          .eq("song_id", songId).in("plan_id", planIds).order("position")
      : { data: [], error: null };
    if (itemErr) throw dbError(tool, "plan items lookup", itemErr);
    const items = (itemData ?? []) as Row[];
    const snippets = await byId(ctx.db, tool, "sam_snippets", SNIPPET_COLS, items.map((i) => i.snippet_id));
    const songs = await byId(ctx.db, tool, "sam_songs", SONG_COLS, [songId]);
    const title = songs.get(songId)?.title ?? null;

    const out = plans.map((p) => ({
      ...p,
      song: { ...planSongRows.find((r) => r.plan_id === p.id), song_title: title },
      items: items
        .filter((i) => i.plan_id === p.id)
        .map((i) => ({ ...i, song_title: title, ...rangeOf(i.snippet_id, snippets) })),
    }));
    return envelope(out, meta);
  },
});

// ---------------------------------------------------------------------------
// get_sam_plan_progress — tier 1
// ---------------------------------------------------------------------------

export const getSamPlanProgressTool = defineTool({
  name: "get_sam_plan_progress",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sam_plan_progress";
    const planId = optionalUuid(tool, "plan_id", args.plan_id);
    const dateFrom = validDate(tool, "date_from", args.date_from);
    const dateTo = validDate(tool, "date_to", args.date_to);

    const plan = await findPlan(ctx.db, tool, planId);
    if (!plan) return { plan: null };

    const range = resolveProgressRange(
      plan as { status: string; starts_on: string; ended_at: string | null },
      dateFrom, dateTo,
    );
    const rpcArgs = { p_plan_id: plan.id, p_from: range.date_from, p_to: range.date_to };

    const [progressRes, unplannedRes, itemsRes] = await Promise.all([
      ctx.db.rpc("sam_plan_item_progress", rpcArgs),
      ctx.db.rpc("sam_plan_unplanned_practice", rpcArgs),
      ctx.db.from("sam_practice_plan_items").select(ITEM_COLS).eq("plan_id", plan.id).order("position"),
    ]);
    if (progressRes.error) throw dbError(tool, "sam_plan_item_progress", progressRes.error);
    if (unplannedRes.error) throw dbError(tool, "sam_plan_unplanned_practice", unplannedRes.error);
    if (itemsRes.error) throw dbError(tool, "plan items lookup", itemsRes.error);

    const progress = (progressRes.data ?? []) as Row[];
    const unplanned = (unplannedRes.data ?? []) as Row[];
    const items = new Map(((itemsRes.data ?? []) as unknown as Row[]).map((i) => [i.id as string, i]));

    const songIds = [...[...items.values()].map((i) => i.song_id), ...unplanned.map((u) => u.song_id)];
    const snippetIds = [...[...items.values()].map((i) => i.snippet_id), ...unplanned.map((u) => u.snippet_id)];
    const songs = await byId(ctx.db, tool, "sam_songs", SONG_COLS, songIds);
    const snippets = await byId(ctx.db, tool, "sam_snippets", SNIPPET_COLS, snippetIds);

    return {
      plan: { id: plan.id, status: plan.status, starts_on: plan.starts_on, ended_at: plan.ended_at },
      range,
      items: progress.map((p): Row => {
        const it = items.get(p.plan_item_id as string);
        return {
          ...p,
          position: it?.position ?? null,
          song_title: it ? songs.get(it.song_id as string)?.title ?? null : null,
          snippet_title: it ? rangeOf(it.snippet_id, snippets).snippet_title : null,
          is_free_play: it?.is_free_play ?? null,
          target_effective_bpm: it?.target_effective_bpm ?? null,
          target_passes: it?.target_passes ?? null,
          accuracy_target: it?.accuracy_target ?? null,
        };
      }).sort((a, b) =>
        String(a.day).localeCompare(String(b.day)) ||
        ((a.position as number) ?? 0) - ((b.position as number) ?? 0)),
      unplanned: unplanned.map((u) => ({
        ...u,
        song_title: songs.get(u.song_id as string)?.title ?? null,
        snippet_title: rangeOf(u.snippet_id, snippets).snippet_title,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// get_sam_goals — tier 1
// ---------------------------------------------------------------------------

export const getSamGoalsTool = defineTool({
  name: "get_sam_goals",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "get_sam_goals";
    const status = optionalEnum(tool, "status", args.status, GOAL_STATUSES);
    const kind = optionalEnum(tool, "kind", args.kind, GOAL_KINDS);
    const songId = optionalUuid(tool, "song_id", args.song_id);
    // Default 50 here, not 20: the goals list is read whole.
    const LIMIT = clampLimit((args.limit as number | undefined) ?? 50);

    let q = ctx.db.from("sam_goals").select(GOAL_COLS, { count: "exact" });
    if (status) q = q.eq("status", status);
    if (kind) q = q.eq("kind", kind);
    if (songId) q = q.eq("song_id", songId);
    const { data, count, error } = await q.order("updated_at", { ascending: false }).limit(LIMIT);
    if (error) throw dbError(tool, "goals lookup", error);
    const goals = (data ?? []) as Row[];
    const songs = await byId(ctx.db, tool, "sam_songs", SONG_COLS, goals.map((g) => g.song_id));
    const rows = goals.map((g) => ({
      ...g,
      song_title: g.song_id ? songs.get(g.song_id as string)?.title ?? null : null,
    }));
    return envelope(rows, typeof count === "number" && count > rows.length
      ? { limit_applied: LIMIT, truncated: true, total: count }
      : { limit_applied: LIMIT, truncated: false });
  },
});

// ---------------------------------------------------------------------------
// create_sam_practice_plan — tier 3
// ---------------------------------------------------------------------------

interface PlanItemInput {
  snippet_id?: string | null;
  is_free_play: boolean;
  target_bpm?: number;
  target_playback_speed?: number;
  target_passes: number;
  accuracy_target?: number;
  instruction?: string | null;
}
interface PlanSongInput {
  song_id: string;
  song_note?: string | null;
  internal_notes?: string | null;
  items: PlanItemInput[];
}
interface PlanInput {
  day_note?: string | null;
  internal_notes?: string | null;
  review_instructions: string;
  songs: PlanSongInput[];
}

/**
 * Shape checks, and the plan exactly as sam_create_practice_plan receives it
 * (spec §6.2). Collects every problem rather than stopping at the first.
 */
export function normalisePlanInput(args: Record<string, unknown>): PlanInput {
  const tool = "create_sam_practice_plan";
  const errors: string[] = [];
  const text = (v: unknown, where: string) => {
    if (v === undefined || v === null) return v as null | undefined;
    if (typeof v !== "string") { errors.push(`${where} must be text.`); return undefined; }
    return v;
  };

  if (typeof args.review_instructions !== "string" || args.review_instructions.trim() === "") {
    errors.push("`review_instructions` is required and must be non-empty text.");
  }
  const songsIn = args.songs;
  if (!Array.isArray(songsIn) || songsIn.length === 0) {
    errors.push("`songs` must be a non-empty array.");
  }

  const songs: PlanSongInput[] = [];
  const seen = new Set<string>();
  let itemCount = 0;
  for (const [si, raw] of (Array.isArray(songsIn) ? songsIn : []).entries()) {
    const s = (raw ?? {}) as Row;
    const where = `songs[${si}]`;
    if (typeof s.song_id !== "string" || !UUID_RE.test(s.song_id)) {
      errors.push(`${where}.song_id must be a UUID.`);
    } else if (seen.has(s.song_id)) {
      errors.push(`${where}.song_id appears twice; list each song once with all its items.`);
    } else {
      seen.add(s.song_id);
    }
    const itemsIn = s.items ?? [];
    if (!Array.isArray(itemsIn)) errors.push(`${where}.items must be an array.`);
    const items: PlanItemInput[] = [];
    for (const [ii, rawItem] of (Array.isArray(itemsIn) ? itemsIn : []).entries()) {
      itemCount++;
      const it = (rawItem ?? {}) as Row;
      const iw = `${where}.items[${ii}]`;
      if (isSet(it.snippet_id) && (typeof it.snippet_id !== "string" || !UUID_RE.test(it.snippet_id))) {
        errors.push(`${iw}.snippet_id must be a UUID or omitted (omitted = whole song).`);
      }
      if (isSet(it.is_free_play) && typeof it.is_free_play !== "boolean") {
        errors.push(`${iw}.is_free_play must be true or false.`);
      }
      for (const k of ["target_bpm", "target_playback_speed", "target_passes"]) {
        if (isSet(it[k]) && !positiveInt(it[k])) errors.push(`${iw}.${k} must be a positive whole number.`);
      }
      if (!isSet(it.target_passes)) errors.push(`${iw}.target_passes is required.`);
      if (isSet(it.accuracy_target) &&
          !(Number.isInteger(it.accuracy_target) && (it.accuracy_target as number) >= 1 &&
            (it.accuracy_target as number) <= 100)) {
        errors.push(`${iw}.accuracy_target must be a whole number from 1 to 100.`);
      }
      items.push({
        snippet_id: (it.snippet_id as string | null | undefined) ?? null,
        is_free_play: it.is_free_play === true,
        ...(isSet(it.target_bpm) ? { target_bpm: it.target_bpm as number } : {}),
        ...(isSet(it.target_playback_speed) ? { target_playback_speed: it.target_playback_speed as number } : {}),
        target_passes: it.target_passes as number,
        ...(isSet(it.accuracy_target) ? { accuracy_target: it.accuracy_target as number } : {}),
        instruction: text(it.instruction, `${iw}.instruction`) ?? null,
      });
    }
    songs.push({
      song_id: s.song_id as string,
      song_note: text(s.song_note, `${where}.song_note`) ?? null,
      internal_notes: text(s.internal_notes, `${where}.internal_notes`) ?? null,
      items,
    });
  }
  if (itemCount > MAX_PLAN_ITEMS) {
    errors.push(`A plan holds at most ${MAX_PLAN_ITEMS} items; this one has ${itemCount}.`);
  }

  const plan: PlanInput = {
    day_note: text(args.day_note, "`day_note`") ?? null,
    internal_notes: text(args.internal_notes, "`internal_notes`") ?? null,
    review_instructions: args.review_instructions as string,
    songs,
  };
  if (errors.length) {
    throw fail(tool, `${errors.length} validation error(s). Nothing was proposed or written:\n` + errors.join("\n"));
  }
  return plan;
}

const heard = (bpm: number, speed: number) => Math.round((bpm * speed) / 100);

/**
 * The readable proposal. Looks up every song and snippet, applies the §6.2
 * rules the database will apply on confirm (so a plan that would be refused is
 * refused now, before approval), and describes the plan in plain lines.
 */
export async function proposePlan(db: Db, plan: PlanInput) {
  const tool = "create_sam_practice_plan";
  const songs = await byId(db, tool, "sam_songs", SONG_COLS, plan.songs.map((s) => s.song_id));
  const snippets = await byId(db, tool, "sam_snippets", SNIPPET_COLS,
    plan.songs.flatMap((s) => s.items.map((i) => i.snippet_id)));
  const active = await findPlan(db, tool, undefined);

  const errors: string[] = [];
  const lines: string[] = [];
  const supersedes = active
    ? `Supersedes the active plan that started ${active.starts_on} (id ${active.id}). ` +
      `That plan becomes superseded and stays readable in plan history.`
    : "There is no active plan, so nothing is superseded.";
  lines.push(`NEW PRACTICE PLAN — active immediately.`, supersedes, "");
  lines.push(`Day note (shown on the Sam tab): ${plan.day_note ?? "(none)"}`);
  lines.push(`Review instructions (for the daily review job): ${plan.review_instructions}`);
  if (plan.internal_notes) lines.push(`Internal notes: ${plan.internal_notes}`);

  let position = 0;
  let freePlay = 0;
  for (const [si, ps] of plan.songs.entries()) {
    const song = songs.get(ps.song_id);
    const where = `songs[${si}]`;
    if (!song) { errors.push(`${where}: song ${ps.song_id} not found.`); continue; }
    if (song.archived) errors.push(`${where}: "${song.title}" is archived.`);
    const hasAudio = song.audio_file_path != null;

    lines.push("", `SONG: ${song.title}${hasAudio ? " (has audio)" : ""}`);
    lines.push(`  Song note (shown in the player): ${ps.song_note ?? "(none)"}`);
    if (ps.internal_notes) lines.push(`  Internal notes: ${ps.internal_notes}`);
    if (ps.items.length === 0) lines.push("  (no items — song note only)");

    for (const [ii, it] of ps.items.entries()) {
      position++;
      const iw = `${where}.items[${ii}]`;
      if (it.snippet_id) {
        const sn = snippets.get(it.snippet_id);
        if (!sn) errors.push(`${iw}: snippet ${it.snippet_id} not found.`);
        else if (sn.song_id !== ps.song_id) errors.push(`${iw}: snippet "${sn.title}" belongs to a different song.`);
        else if (sn.archived) errors.push(`${iw}: snippet "${sn.title}" is archived.`);
      }
      if (!it.is_free_play) {
        if (!isSet(it.target_bpm)) errors.push(`${iw}: a non-free-play item needs target_bpm.`);
        if (!isSet(it.accuracy_target)) errors.push(`${iw}: a non-free-play item needs accuracy_target.`);
      } else {
        freePlay++;
        if (isSet(it.accuracy_target)) errors.push(`${iw}: a Free Play item must not have accuracy_target.`);
      }
      if (hasAudio && isSet(it.target_bpm) && it.target_bpm !== song.default_bpm) {
        errors.push(`${iw}: "${song.title}" has audio, so target_bpm must equal its default_bpm ` +
          `(${song.default_bpm}); express the target through target_playback_speed.`);
      }
      if (!hasAudio && isSet(it.target_playback_speed) && it.target_playback_speed !== 100) {
        errors.push(`${iw}: "${song.title}" has no audio, so target_playback_speed must be 100; ` +
          `express the target through target_bpm.`);
      }

      let tempo: string;
      if (isSet(it.target_bpm)) {
        const speed = it.target_playback_speed ?? 100;
        tempo = `${heard(it.target_bpm!, speed)} BPM heard` +
          (speed !== 100 ? ` (${it.target_bpm} BPM at ${speed}%)` : "");
      } else {
        tempo = `${song.goal_effective_bpm} BPM heard (the song's goal` +
          (song.goal_set_at ? ")" : " — an unconfirmed placeholder)");
      }
      const parts = [
        `${position}. ${rangeText(it.snippet_id, snippets)}`,
        tempo,
        `${it.target_passes} pass${it.target_passes === 1 ? "" : "es"}`,
        it.is_free_play ? "Free Play" : `${it.accuracy_target}% accuracy`,
      ];
      lines.push(`  ${parts.join(" · ")}${it.instruction ? ` — "${it.instruction}"` : ""}`);
    }
  }
  if (errors.length) {
    throw fail(tool, `${errors.length} validation error(s). Nothing was proposed or written:\n` + errors.join("\n"));
  }
  return {
    text: lines.join("\n"),
    supersedes_plan: active ? { id: active.id, starts_on: active.starts_on } : null,
    song_count: plan.songs.length,
    item_count: position,
    free_play_count: freePlay,
  };
}

export const createSamPracticePlanTool = defineTool({
  name: "create_sam_practice_plan",
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => proposePlan(ctx.db, normalisePlanInput(args)),
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_sam_practice_plan";
    const plan = normalisePlanInput(args);
    const { data, error } = await ctx.db.rpc("sam_create_practice_plan", { p_plan: plan });
    if (error) throw dbError(tool, "sam_create_practice_plan", error);
    // The function returns the new plan's id; tolerate a row-shaped reply.
    const newId = typeof data === "string"
      ? data
      : ((Array.isArray(data) ? data[0] : data) as Row | null)?.id ??
        ((Array.isArray(data) ? data[0] : data) as Row | null)?.sam_create_practice_plan;
    if (typeof newId !== "string") {
      throw fail(tool, `sam_create_practice_plan returned no plan id (got ${JSON.stringify(data)}).`);
    }
    const created = await findPlan(ctx.db, tool, newId);
    return await planView(ctx.db, tool, created!);
  },
});

// ---------------------------------------------------------------------------
// update_sam_plan_review_note — tier 2
// ---------------------------------------------------------------------------

export const updateSamPlanReviewNoteTool = defineTool({
  name: "update_sam_plan_review_note",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_sam_plan_review_note";
    const planId = requireUuid(tool, "plan_id", args.plan_id);
    const note = requireText(tool, "review_note", args.review_note);

    const plan = await findPlan(ctx.db, tool, planId);
    if (plan!.status !== "active") {
      throw fail(tool, `plan ${planId} is ${plan!.status}; a review note can only be written on the active plan.`);
    }
    // Checked here, not left to the trigger: a second note is a no-op that
    // reports the first, never an error and never an overwrite.
    if (plan!.review_note != null) {
      return { already_noted: true, review_note: plan!.review_note, review_noted_at: plan!.review_noted_at };
    }

    const { data, error } = await ctx.db
      .from("sam_practice_plans")
      .update({ review_note: note, review_noted_at: new Date().toISOString() })
      .eq("id", planId)
      .eq("status", "active")
      .is("review_note", null)
      .select("id, review_note, review_noted_at")
      .maybeSingle();
    if (error) throw dbError(tool, "review note update", error);
    if (!data) {
      // Lost a race: someone noted it (or superseded it) between read and write.
      const now = await findPlan(ctx.db, tool, planId);
      if (now!.review_note != null) {
        return { already_noted: true, review_note: now!.review_note, review_noted_at: now!.review_noted_at };
      }
      throw fail(tool, `plan ${planId} is ${now!.status}; a review note can only be written on the active plan.`);
    }
    return { already_noted: false, plan_id: data.id, review_note: data.review_note, review_noted_at: data.review_noted_at };
  },
});

// ---------------------------------------------------------------------------
// update_sam_song_goal — tier 3
// ---------------------------------------------------------------------------

/**
 * Validate the request against the song and work out the write. Shared by the
 * proposal and the handler so the two can never disagree.
 */
export async function planSongGoal(db: Db, args: Record<string, unknown>) {
  const tool = "update_sam_song_goal";
  const songId = requireUuid(tool, "song_id", args.song_id);
  const given = ["goal_bpm", "goal_playback_speed", "confirm_only"].filter((k) =>
    k === "confirm_only" ? args.confirm_only === true : isSet(args[k])
  );
  if (isSet(args.confirm_only) && typeof args.confirm_only !== "boolean") {
    throw fail(tool, "`confirm_only` must be true or omitted.");
  }
  if (given.length !== 1) {
    throw fail(tool, "pass exactly one of `goal_bpm` (songs without audio), `goal_playback_speed` " +
      `(songs with audio) or \`confirm_only: true\`; got ${given.length ? given.join(", ") : "none"}.`);
  }
  for (const k of ["goal_bpm", "goal_playback_speed"]) {
    if (isSet(args[k]) && !positiveInt(args[k])) {
      throw fail(tool, `\`${k}\` must be a positive whole number, got ${JSON.stringify(args[k])}.`);
    }
  }

  const { data: song, error } = await db.from("sam_songs").select(SONG_COLS).eq("id", songId).maybeSingle();
  if (error) throw dbError(tool, "song lookup", error);
  if (!song) throw fail(tool, `song ${songId} not found.`);
  const hasAudio = song.audio_file_path != null;

  if (hasAudio && isSet(args.goal_bpm)) {
    throw fail(tool, `"${song.title}" has audio, so its goal is set with \`goal_playback_speed\`, not ` +
      `\`goal_bpm\`. Its BPM stays at default_bpm (${song.default_bpm}), the scroll-sync calibration; ` +
      `the heard goal is default_bpm × speed / 100.`);
  }
  if (!hasAudio && isSet(args.goal_playback_speed)) {
    throw fail(tool, `"${song.title}" has no audio, so its goal is set with \`goal_bpm\`, not ` +
      `\`goal_playback_speed\` (always 100 for songs without audio).`);
  }

  // §4: audio songs keep BPM at default_bpm; others keep speed at 100.
  const goalBpm = hasAudio ? song.default_bpm as number : (args.goal_bpm as number | undefined) ?? song.goal_bpm as number;
  const goalSpeed = hasAudio ? (args.goal_playback_speed as number | undefined) ?? song.goal_playback_speed as number : 100;
  return {
    song,
    hasAudio,
    mode: given[0],
    update: { goal_bpm: goalBpm, goal_playback_speed: goalSpeed },
    newHeard: heard(goalBpm, goalSpeed),
  };
}

export const updateSamSongGoalTool = defineTool({
  name: "update_sam_song_goal",
  tier: 3,
  propose: async (args: Record<string, unknown>, ctx) => {
    const p = await planSongGoal(ctx.db, args);
    const placeholder = p.song.goal_set_at == null;
    const current = p.song.goal_effective_bpm;
    return {
      text: [
        `UPDATE SONG GOAL: ${p.song.title}${p.hasAudio ? " (has audio)" : ""}`,
        `Current goal: ${current} BPM heard` +
          (placeholder ? " — a PLACEHOLDER, never confirmed" : ` — confirmed ${p.song.goal_set_at}`),
        p.mode === "confirm_only"
          ? `New goal: ${p.newHeard} BPM heard — confirming the current goal as a real target`
          : `New goal: ${p.newHeard} BPM heard`,
        p.hasAudio
          ? `Writes goal_playback_speed ${p.update.goal_playback_speed}% with goal_bpm held at default_bpm ${p.update.goal_bpm}.`
          : `Writes goal_bpm ${p.update.goal_bpm} with goal_playback_speed 100.`,
        "Marks the goal confirmed (goal_set_at = now).",
      ].join("\n"),
      song_title: p.song.title,
      has_audio: p.hasAudio,
      current_goal_effective_bpm: current,
      current_goal_is_placeholder: placeholder,
      new_goal_effective_bpm: p.newHeard,
      writes: { ...p.update, goal_set_at: "now" },
    };
  },
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_sam_song_goal";
    const p = await planSongGoal(ctx.db, args);
    const { data, error } = await ctx.db
      .from("sam_songs")
      .update({ ...p.update, goal_set_at: new Date().toISOString() })
      .eq("id", p.song.id)
      .select("id, title, default_bpm, goal_bpm, goal_playback_speed, goal_effective_bpm, goal_set_at")
      .single();
    if (error) throw dbError(tool, "goal update", error);
    return { ...data, has_audio: p.hasAudio, previous_goal_effective_bpm: p.song.goal_effective_bpm };
  },
});

// ---------------------------------------------------------------------------
// create_sam_goal — tier 1
// ---------------------------------------------------------------------------

async function withSongTitle(db: Db, tool: string, goal: Row) {
  const songs = await byId(db, tool, "sam_songs", SONG_COLS, [goal.song_id]);
  return { ...goal, song_title: goal.song_id ? songs.get(goal.song_id as string)?.title ?? null : null };
}

export const createSamGoalTool = defineTool({
  name: "create_sam_goal",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "create_sam_goal";
    const title = requireText(tool, "title", args.title);
    const kind = optionalEnum(tool, "kind", args.kind, GOAL_KINDS);
    if (!kind) throw fail(tool, `\`kind\` is required: ${GOAL_KINDS.join(" | ")}.`);
    const status = optionalEnum(tool, "status", args.status, GOAL_STATUSES);
    const songId = optionalUuid(tool, "song_id", args.song_id);
    const notes = optionalText(tool, "notes", args.notes);

    const record: Row = { title, kind };
    if (status) record.status = status;
    if (status === "done") record.completed_at = new Date().toISOString();
    if (songId) record.song_id = songId;
    if (notes !== undefined) record.notes = notes;

    const { data, error } = await ctx.db.from("sam_goals").insert(record).select(GOAL_COLS).single();
    if (error) throw dbError(tool, "goal insert", error);
    return await withSongTitle(ctx.db, tool, data);
  },
});

// ---------------------------------------------------------------------------
// update_sam_goal — tier 2
// ---------------------------------------------------------------------------

export const updateSamGoalTool = defineTool({
  name: "update_sam_goal",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const tool = "update_sam_goal";
    const goalId = requireUuid(tool, "goal_id", args.goal_id);
    const changes: Row = {};
    if (args.title !== undefined) changes.title = requireText(tool, "title", args.title);
    const status = optionalEnum(tool, "status", args.status, GOAL_STATUSES);
    if (status) changes.status = status;
    // song_id: a UUID links, an explicit null unlinks.
    if (args.song_id === null) changes.song_id = null;
    else if (args.song_id !== undefined) changes.song_id = requireUuid(tool, "song_id", args.song_id);
    const notes = optionalText(tool, "notes", args.notes);
    if (notes !== undefined) changes.notes = notes;
    if (Object.keys(changes).length === 0) {
      throw fail(tool, "pass at least one of `title`, `status`, `song_id` or `notes`.");
    }

    const { data: current, error: readErr } = await ctx.db
      .from("sam_goals").select(GOAL_COLS).eq("id", goalId).maybeSingle();
    if (readErr) throw dbError(tool, "goal lookup", readErr);
    if (!current) throw fail(tool, `goal ${goalId} not found.`);

    if (status === "done" && current.status !== "done") changes.completed_at = new Date().toISOString();
    if (status && status !== "done" && current.status === "done") changes.completed_at = null;

    const { data, error } = await ctx.db
      .from("sam_goals").update(changes).eq("id", goalId).select(GOAL_COLS).single();
    if (error) throw dbError(tool, "goal update", error);
    return await withSongTitle(ctx.db, tool, data);
  },
});
