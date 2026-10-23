// ============================================================================
// supabase/functions/_shared/tools/warren-buffet-p3.ts
//
// Warren Buffet Phase 3 tools. Spec: docs/technical-spec-warren_buffet_p3-q5k.md §4.
//
//   get_wb_projects             tier 1 — projects
//   get_wb_planned_items        tier 1 — planned items, with what is confirmed and what remains
//   get_wb_planned_matches      tier 1 — suggested, confirmed or turned-down matches
//   get_wb_settings             tier 1 — safety floor and horizon
//   get_wb_free_cash            tier 1 — free cash, its low point, and the reserve line
//   get_wb_true_cost            tier 1 — monthly true cost, with the burn months as working
//   get_wb_cash_projection      tier 1 — the projection's event days and low point (never every day)
//   upsert_wb_project           tier 2 — create or edit a project
//   upsert_wb_planned_item      tier 2 — create or edit a planned item, then suggest matches
//   create_wb_planned_match     tier 3 — match a payment to a planned item by hand; the proposal shows it
//   update_wb_planned_match     tier 2 — confirm (optionally lower) or turn down a suggestion
//   set_wb_transaction_project  tier 2 — put up to 25 single-split transactions on a project, or clear it
//   update_wb_settings          tier 3 — safety floor, horizon, notes; the proposal shows old against new
//   get_wb_project_summary      tier 1 — per project: spent, received, net, budget left, still due, planning
//   get_wb_missed_dates         tier 1 — past due dates not fully matched
//   mark_wb_missed_dates_not_needed tier 2 — up to 25 missed dates marked Not needed, or undone
//   unconfirm_wb_planned_match  tier 2 — remove a confirmed match; never changes the stage
//   get_wb_action_items         tier 1 — the money to-do list (wb_action_items), every section in one object
//
// get_wb_free_cash takes an optional what_if list (A43): free cash with and without
// hypothetical items, writing nothing.
//
// Confirming always goes through wb_confirm_planned_match, so its rules apply (a
// fully covered one-off becomes paid; over-amount and already-decided refusals).
// Sign rule: money in positive, money out negative. No real amounts in this file.
// ============================================================================

import { defineTool, envelope } from "../platform.ts";
import {
  absent, checkRange, limitOf, listResult, MONEY_CONTEXT_ID, oneOf, optBool, optText, parseDate, parseMoney,
} from "./warren-buffet.ts";
import { dbError, HAND_SOURCES, idList, uuidOf } from "./warren-buffet-p2.ts";

type Obj = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;

export const PROJECT_STATUSES = ["active", "on_hold", "done", "cancelled"] as const;
export const PLANNED_STAGES = ["draft", "estimate", "quoted", "invoiced", "paid", "cancelled"] as const;
export const MATCH_STATUSES = ["suggested", "confirmed", "rejected"] as const;
export const MATCH_ACTIONS = ["confirm", "reject"] as const;
export const INTERVAL_UNITS = ["week", "month"] as const;
export const MAX_PROJECT_ROWS = 25;

const PROJECT_COLUMNS = "id, name, status, budget, starts_on, ends_on, notes, created_at, updated_at";
const ITEM_COLUMNS =
  "id, name, project_id, counterparty, merchant_id, amount, due_on, interval_count, interval_unit, ends_on, stage, " +
  "is_draft, tax_year, amount_tolerance, match_window_days, notes, created_at, updated_at";
const MATCH_COLUMNS =
  "id, planned_item_id, split_id, transaction_id, occurrence_on, amount_applied, status, source, decided_at, notes, " +
  "created_at, planned_item:wb_planned_items(name, amount, due_on, interval_count, stage)";
const PAYMENT_COLUMNS = "id, txn_date, amount, clean_description, payee, merchant_name, account_label, pending";

const optUuid = (T: string, key: string, v: unknown) => (absent(v) ? null : uuidOf(T, key, v));

function optInt(T: string, key: string, v: unknown, min: number, max: number): number | null {
  if (absent(v)) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${T}: ${key} must be a whole number from ${min} to ${max}.`);
  }
  return v;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const cents = (n: number) => Math.round(n * 100) / 100;

/** Whether an item is a "what if": stage draft (one-off) or is_draft (recurring). */
export const isDraft = (it: Obj) => it.stage === "draft" || it.is_draft === true;

/**
 * An item with plain flags and, from its confirmed matches, what is paid and what
 * remains. Both carry the item's sign, so amount = confirmed_total + remaining for a one-off.
 */
/** What is still due, as a positive number: 0 when what is left is within the tolerance (A45), as wb_planned_left. */
export const leftOf = (full: number, paid: number, tolerance: number) =>
  cents(full - paid) <= cents(tolerance) ? 0 : cents(full - paid);

export function annotateItem(it: Obj, confirmed: Obj[]): Obj {
  const recurring = it.interval_count !== null && it.interval_count !== undefined;
  const s = sign(num(it.amount));
  const full = Math.abs(num(it.amount));
  const tol = num(it.amount_tolerance);
  const mine = confirmed.filter((m) => m.planned_item_id === it.id);
  const paid = mine.reduce((t, m) => t + Math.abs(num(m.amount_applied)), 0);
  // More than planned (A37): a one-off in total, a recurring item on any one date, beyond
  // the tolerance (A45). A warning only.
  const perDate = new Map<string, number>();
  for (const m of mine) {
    const k = String(m.occurrence_on ?? "");
    perDate.set(k, (perDate.get(k) ?? 0) + Math.abs(num(m.amount_applied)));
  }
  const over = recurring ? [...perDate.values()].some((v) => cents(v - full) > cents(tol)) : cents(paid - full) > cents(tol);
  return {
    ...it,
    recurring,
    draft: isDraft(it),
    confirmed_total: cents(s * paid),
    ...(recurring ? {} : { remaining: leftOf(full, paid, tol) === 0 ? 0 : cents(s * leftOf(full, paid, tol)) }),
    over_matched: over,
  };
}

async function confirmedFor(T: string, db: Db, itemIds: string[]): Promise<Obj[]> {
  if (!itemIds.length) return [];
  const { data, error } = await db.from("wb_planned_matches")
    .select("planned_item_id, occurrence_on, amount_applied").in("planned_item_id", itemIds).eq("status", "confirmed")
    .limit(1000);
  if (error) throw new Error(dbError(T, error));
  return (data ?? []) as Obj[];
}

async function suggestFor(T: string, db: Db, itemId: string): Promise<Obj> {
  const { data, error } = await db.rpc("wb_suggest_planned_matches", { p_transaction_ids: null, p_planned_item_ids: [itemId] });
  if (error) throw new Error(dbError(T, error));
  return (data ?? {}) as Obj;
}

// ---------------------------------------------------------------------------
// get_wb_projects — tier 1
// ---------------------------------------------------------------------------

export const getWbProjectsTool = defineTool({
  name: "get_wb_projects",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_projects";
    const status = oneOf(T, "status", args.status, PROJECT_STATUSES);
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_projects").select(PROJECT_COLUMNS, { count: "exact" });
    if (status) q = q.eq("status", status);
    const { data, error, count } = await q.order("name").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_planned_items — tier 1 (drafts included by default, each marked)
// ---------------------------------------------------------------------------

export const getWbPlannedItemsTool = defineTool({
  name: "get_wb_planned_items",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_planned_items";
    const projectId = optUuid(T, "project_id", args.project_id);
    const stage = oneOf(T, "stage", args.stage, PLANNED_STAGES);
    const recurring = optBool(T, "recurring", args.recurring);
    const from = parseDate(T, "due_from", args.due_from);
    const to = parseDate(T, "due_to", args.due_to);
    checkRange(T, from, to, "due_from", "due_to");
    const includeDrafts = optBool(T, "include_drafts", args.include_drafts) ?? true;
    const LIMIT = limitOf(T, args.limit);

    let q = ctx.db.from("wb_planned_items").select(ITEM_COLUMNS, { count: "exact" });
    if (projectId) q = q.eq("project_id", projectId);
    if (stage) q = q.eq("stage", stage);
    if (recurring === true) q = q.not("interval_count", "is", null);
    if (recurring === false) q = q.is("interval_count", null);
    if (from) q = q.gte("due_on", from);
    if (to) q = q.lte("due_on", to);
    if (!includeDrafts) q = q.eq("is_draft", false).or("stage.is.null,stage.neq.draft");
    const { data, error, count } = await q.order("due_on").order("name").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    const rows = (data ?? []) as unknown as Obj[];
    const confirmed = await confirmedFor(T, ctx.db, rows.map((r) => r.id as string));
    return listResult(rows.map((r) => annotateItem(r, confirmed)), count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_planned_matches — tier 1
// ---------------------------------------------------------------------------

export const getWbPlannedMatchesTool = defineTool({
  name: "get_wb_planned_matches",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_planned_matches";
    const status = oneOf(T, "status", args.status, MATCH_STATUSES) ?? "suggested";
    const itemId = optUuid(T, "planned_item_id", args.planned_item_id);
    const txnId = optUuid(T, "transaction_id", args.transaction_id);
    const LIMIT = limitOf(T, args.limit);

    let q = ctx.db.from("wb_planned_matches").select(MATCH_COLUMNS, { count: "exact" }).eq("status", status);
    if (itemId) q = q.eq("planned_item_id", itemId);
    if (txnId) q = q.eq("transaction_id", txnId);
    const { data, error, count } = await q.order("created_at", { ascending: false }).limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    const rows = (data ?? []) as unknown as Obj[];
    const ids = [...new Set(rows.map((r) => r.transaction_id as string))];
    const payments = new Map<string, Obj>();
    if (ids.length) {
      const { data: tx, error: te } = await ctx.db.from("wb_transaction_list").select(PAYMENT_COLUMNS).in("id", ids);
      if (te) throw new Error(dbError(T, te));
      for (const p of (tx ?? []) as Obj[]) payments.set(p.id as string, p);
    }
    return listResult(rows.map((r) => ({ ...r, payment: payments.get(r.transaction_id as string) ?? null })), count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_settings — tier 1
// ---------------------------------------------------------------------------

async function currentSettings(T: string, db: Db): Promise<Obj> {
  const { data, error } = await db.from("wb_settings").select("id, safety_floor, horizon_months, notes, updated_at")
    .eq("context_id", MONEY_CONTEXT_ID).maybeSingle();
  if (error) throw new Error(dbError(T, error));
  const s = (data ?? null) as Obj | null;
  return {
    exists: !!s,
    safety_floor: s?.safety_floor ?? null,
    floor_missing: s?.safety_floor === null || s?.safety_floor === undefined,
    horizon_months: s?.horizon_months ?? 12,
    notes: s?.notes ?? null,
  };
}

export const getWbSettingsTool = defineTool({
  name: "get_wb_settings",
  tier: 1,
  handler: async (_args: Obj, ctx) => currentSettings("get_wb_settings", ctx.db),
});

// ---------------------------------------------------------------------------
// get_wb_free_cash — tier 1
// ---------------------------------------------------------------------------

export const MAX_WHAT_IF = 10;

/** ISO date plus n months, clamped to the month's last day, as Postgres date + interval does. */
export function addMonths(iso: string, n: number): string {
  const [y, mo, d] = iso.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  const ny = Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

/** The hypothetical items of a what-if, checked. Writes nothing. */
export function whatIfItems(T: string, raw: unknown): Obj[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${T}: what_if must be a list of 1 to ${MAX_WHAT_IF} items.`);
  if (raw.length > MAX_WHAT_IF) throw new Error(`${T}: at most ${MAX_WHAT_IF} what_if items per call; got ${raw.length}.`);
  return raw.map((r, i) => {
    const o = (r ?? {}) as Obj;
    const at = `what_if[${i}]`;
    const amount = parseMoney(T, `${at}.amount`, o.amount);
    if (amount === null || amount === 0) throw new Error(`${T}: ${at}.amount must be a non-zero number, signed: money out negative, money in positive.`);
    const date = parseDate(T, `${at}.date`, o.date);
    if (!date) throw new Error(`${T}: ${at}.date is required.`);
    const count = optInt(T, `${at}.interval_count`, o.interval_count, 1, 120);
    const unit = oneOf(T, `${at}.interval_unit`, o.interval_unit, INTERVAL_UNITS);
    if ((count === null) !== (unit === null)) throw new Error(`${T}: ${at} needs both interval_count and interval_unit to repeat, or neither.`);
    const ends = parseDate(T, `${at}.ends_on`, o.ends_on);
    if (ends && count === null) throw new Error(`${T}: ${at}.ends_on only goes with a repeating item.`);
    if (ends && ends < date) throw new Error(`${T}: ${at}.ends_on is before its date.`);
    return { name: optText(T, `${at}.name`, o.name) ?? `item ${i + 1}`, amount, date, interval_count: count, interval_unit: unit, ends_on: ends };
  });
}

/** The dates a hypothetical item lands on between today and end. A past one-off counts today (A7); past repeats do not (A25). */
export function whatIfDates(it: Obj, today: string, end: string): string[] {
  const count = it.interval_count as number | null;
  if (count === null) {
    const d = (it.date as string) < today ? today : (it.date as string);
    return d <= end ? [d] : [];
  }
  const out: string[] = [];
  for (let k = 0; k < 2000; k++) {
    const d = it.interval_unit === "month" ? addMonths(it.date as string, k * count) : addDays(it.date as string, 7 * k * count);
    if (d > end || (it.ends_on && d > (it.ends_on as string))) break;
    if (d >= today) out.push(d);
  }
  return out;
}

/** Free cash, the low point and the first day under the floor, from projection rows plus extra amounts by day. */
export function lowPoint(rows: Obj[], floor: number, extra: Map<string, number> = new Map()) {
  let add = 0;
  let low: { day: string; bal: number } | null = null;
  let below: string | null = null;
  for (const r of rows) {
    add += extra.get(String(r.day)) ?? 0;
    const bal = cents(num(r.closing) + add);
    if (!low || bal < low.bal) low = { day: String(r.day), bal };
    if (below === null && bal < floor) below = String(r.day);
  }
  return {
    free_cash: low ? cents(low.bal - floor) : null,
    low_balance: low?.bal ?? null,
    low_on: low?.day ?? null,
    first_below_floor_on: below,
  };
}

export const getWbFreeCashTool = defineTool({
  name: "get_wb_free_cash",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_free_cash";
    const includeDrafts = optBool(T, "include_drafts", args.include_drafts) ?? false;
    const items = absent(args.what_if) ? null : whatIfItems(T, args.what_if);
    const { data, error } = await ctx.db.rpc("wb_free_cash", { p_include_drafts: includeDrafts });
    if (error) throw new Error(dbError(T, error));
    const row = ((Array.isArray(data) ? data[0] : data) ?? null) as Obj | null;
    const base = { ...(row ?? {}), include_drafts: includeDrafts };
    if (!items) return base;

    // The what-if (A43): the same projection, with the hypothetical amounts added on their dates.
    const { data: proj, error: pe } = await ctx.db.rpc("wb_cash_projection", { p_include_drafts: includeDrafts });
    if (pe) throw new Error(dbError(T, pe));
    const rows = ((proj ?? []) as Obj[]).slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));
    if (!rows.length) throw new Error(`${T}: there is no projection to test against (no balances yet).`);
    const today = String(rows[0].day), end = String(rows[rows.length - 1].day);
    const floor = num(row?.safety_floor);
    const extra = new Map<string, number>();
    const counted = items.map((it) => {
      const dates = whatIfDates(it, today, end);
      for (const d of dates) extra.set(d, (extra.get(d) ?? 0) + (it.amount as number));
      return {
        ...it, dates_counted: dates.length, first_on: dates[0] ?? null, last_on: dates[dates.length - 1] ?? null,
        outside_horizon: !dates.length && (it.date as string) > end,
      };
    });
    const without = lowPoint(rows, floor);
    const withItems = lowPoint(rows, floor, extra);
    const sooner = without.first_below_floor_on && withItems.first_below_floor_on
      ? daysBetween(withItems.first_below_floor_on, without.first_below_floor_on) : null;
    return {
      ...base,
      what_if: {
        without, with: withItems,
        difference: without.free_cash === null || withItems.free_cash === null ? null : cents(withItems.free_cash - without.free_cash),
        days_sooner: sooner,
        horizon_end: end,
        items: counted,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// get_wb_true_cost — tier 1 (with the burn months as working)
// ---------------------------------------------------------------------------

export const getWbTrueCostTool = defineTool({
  name: "get_wb_true_cost",
  tier: 1,
  handler: async (_args: Obj, ctx) => {
    const T = "get_wb_true_cost";
    const { data, error } = await ctx.db.from("wb_true_cost").select("*").maybeSingle();
    if (error) throw new Error(dbError(T, error));
    const { data: months, error: me } = await ctx.db.from("wb_burn_rate")
      .select("month, included, project_excluded, matched_excluded, subscription_excluded").order("month").limit(12);
    if (me) throw new Error(dbError(T, me));
    return { ...((data ?? {}) as Obj), burn_months: months ?? [] };
  },
});

// ---------------------------------------------------------------------------
// get_wb_cash_projection — tier 1 (event days and the low point, never all 365 days)
// ---------------------------------------------------------------------------

export const getWbCashProjectionTool = defineTool({
  name: "get_wb_cash_projection",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_cash_projection";
    const includeDrafts = optBool(T, "include_drafts", args.include_drafts) ?? false;
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    const LIMIT = limitOf(T, args.limit);
    const { data, error } = await ctx.db.rpc("wb_cash_projection", { p_include_drafts: includeDrafts });
    if (error) throw new Error(dbError(T, error));
    const rows = ((data ?? []) as Obj[]).slice().sort((a, b) => String(a.day).localeCompare(String(b.day)));
    if (!rows.length) return { include_drafts: includeDrafts, start: null, low_point: null, end: null, days: [] };
    const low = rows.reduce((m, r) => (num(r.closing) < num(m.closing) ? r : m), rows[0]);
    const last = rows[rows.length - 1];
    const events = rows.filter((r) => (num(r.planned_in) !== 0 || num(r.planned_out) !== 0 || num(r.subscriptions) !== 0) &&
      (!from || String(r.day) >= from) && (!to || String(r.day) <= to));
    const days = events.slice(0, LIMIT);
    const truncated = events.length > days.length;
    return envelope({
      include_drafts: includeDrafts,
      start: { day: rows[0].day, opening: rows[0].opening },
      low_point: { day: low.day, closing: low.closing },
      end: { day: last.day, closing: last.closing },
      burn_per_day: rows[0].burn,
      days,
    }, { count: events.length, limit_applied: LIMIT, truncated, ...(truncated ? { total: events.length } : {}) });
  },
});

// ---------------------------------------------------------------------------
// upsert_wb_project — tier 2
// ---------------------------------------------------------------------------

export const upsertWbProjectTool = defineTool({
  name: "upsert_wb_project",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "upsert_wb_project";
    const id = optUuid(T, "id", args.id);
    const fields: Obj = {};
    if (args.name !== undefined) {
      const name = optText(T, "name", args.name);
      if (!name) throw new Error(`${T}: name cannot be empty.`);
      fields.name = name;
    }
    if (args.status !== undefined) fields.status = oneOf(T, "status", args.status, PROJECT_STATUSES);
    if (args.budget !== undefined) {
      const b = parseMoney(T, "budget", args.budget);
      if (b !== null && b < 0) throw new Error(`${T}: budget must be 0 or more.`);
      fields.budget = b;
    }
    if (args.starts_on !== undefined) fields.starts_on = parseDate(T, "starts_on", args.starts_on);
    if (args.ends_on !== undefined) fields.ends_on = parseDate(T, "ends_on", args.ends_on);
    if (args.notes !== undefined) fields.notes = optText(T, "notes", args.notes);

    if (!id) {
      if (!fields.name) throw new Error(`${T}: name is required for a new project.`);
      const { data, error } = await ctx.db.from("wb_projects").insert({ ...fields, context_id: MONEY_CONTEXT_ID })
        .select(PROJECT_COLUMNS).single();
      if (error) throw new Error(dbError(T, error));
      return { project: data, created: true };
    }
    if (!Object.keys(fields).length) throw new Error(`${T}: nothing to change.`);
    const { data, error } = await ctx.db.from("wb_projects").update(fields).eq("id", id).select(PROJECT_COLUMNS).maybeSingle();
    if (error) throw new Error(dbError(T, error));
    if (!data) throw new Error(`${T}: no project ${id} that you can see. Nothing was changed.`);
    return { project: data, created: false };
  },
});

// ---------------------------------------------------------------------------
// upsert_wb_planned_item — tier 2 (then suggests matches, A19)
// ---------------------------------------------------------------------------

function itemFields(T: string, args: Obj): Obj {
  const out: Obj = {};
  if (args.name !== undefined) {
    const name = optText(T, "name", args.name);
    if (!name) throw new Error(`${T}: name cannot be empty.`);
    out.name = name;
  }
  if (args.amount !== undefined) {
    const a = parseMoney(T, "amount", args.amount);
    if (a === null || a === 0) throw new Error(`${T}: amount must be a non-zero number, signed: money out negative, money in positive.`);
    out.amount = a;
  }
  if (args.due_on !== undefined) {
    const d = parseDate(T, "due_on", args.due_on);
    if (!d) throw new Error(`${T}: due_on cannot be empty.`);
    out.due_on = d;
  }
  if (args.interval_count !== undefined) out.interval_count = optInt(T, "interval_count", args.interval_count, 1, 120);
  if (args.interval_unit !== undefined) out.interval_unit = oneOf(T, "interval_unit", args.interval_unit, INTERVAL_UNITS);
  if (args.ends_on !== undefined) out.ends_on = parseDate(T, "ends_on", args.ends_on);
  if (args.stage !== undefined) out.stage = oneOf(T, "stage", args.stage, PLANNED_STAGES);
  if (args.is_draft !== undefined) out.is_draft = optBool(T, "is_draft", args.is_draft) ?? false;
  if (args.project_id !== undefined) out.project_id = optUuid(T, "project_id", args.project_id);
  if (args.merchant_id !== undefined) out.merchant_id = optUuid(T, "merchant_id", args.merchant_id);
  if (args.counterparty !== undefined) out.counterparty = optText(T, "counterparty", args.counterparty);
  if (args.tax_year !== undefined) out.tax_year = optInt(T, "tax_year", args.tax_year, 2000, 2100);
  if (args.amount_tolerance !== undefined) {
    const t = parseMoney(T, "amount_tolerance", args.amount_tolerance) ?? 0;
    if (t < 0) throw new Error(`${T}: amount_tolerance must be 0 or more.`);
    out.amount_tolerance = t;
  }
  if (args.match_window_days !== undefined) out.match_window_days = optInt(T, "match_window_days", args.match_window_days, 0, 90) ?? 10;
  if (args.notes !== undefined) out.notes = optText(T, "notes", args.notes);
  return out;
}

export const upsertWbPlannedItemTool = defineTool({
  name: "upsert_wb_planned_item",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "upsert_wb_planned_item";
    const id = optUuid(T, "id", args.id);
    const fields = itemFields(T, args);
    const backdate = optBool(T, "backdate", args.backdate) ?? true;
    let item: Obj;
    let backdatedFrom: string | null = null;
    if (!id) {
      for (const k of ["name", "amount", "due_on"]) {
        if (fields[k] === undefined) throw new Error(`${T}: ${k} is required for a new planned item.`);
      }
      const recurring = fields.interval_count !== undefined && fields.interval_count !== null;
      if (!recurring && !fields.stage) {
        throw new Error(`${T}: a one-off planned item needs a stage (draft, estimate, quoted, invoiced, paid or cancelled).`);
      }
      // A34: a new repeating item starts from its first matching payment in the burn window,
      // so the payments the burn rate already counts get matched.
      if (recurring && backdate && fields.merchant_id) {
        const { data: first, error: he } = await ctx.db.rpc("wb_planned_start_from_history", {
          p_merchant_id: fields.merchant_id, p_amount: fields.amount, p_amount_tolerance: fields.amount_tolerance ?? 0,
        });
        if (he) throw new Error(dbError(T, he));
        if (typeof first === "string" && first < (fields.due_on as string)) {
          backdatedFrom = fields.due_on as string;
          fields.due_on = first;
        }
      }
      const { data, error } = await ctx.db.from("wb_planned_items").insert({ ...fields, context_id: MONEY_CONTEXT_ID })
        .select(ITEM_COLUMNS).single();
      if (error) throw new Error(dbError(T, error));
      item = data as unknown as Obj;
    } else {
      if (!Object.keys(fields).length) throw new Error(`${T}: nothing to change.`);
      const { data, error } = await ctx.db.from("wb_planned_items").update(fields).eq("id", id)
        .select(ITEM_COLUMNS).maybeSingle();
      if (error) throw new Error(dbError(T, error));
      if (!data) throw new Error(`${T}: no planned item ${id} that you can see. Nothing was changed.`);
      item = data as unknown as Obj;
    }
    const suggestions = await suggestFor(T, ctx.db, item.id as string);
    const confirmed = await confirmedFor(T, ctx.db, [item.id as string]);
    return { item: annotateItem(item, confirmed), created: !id, backdated_from: backdatedFrom, suggestions };
  },
});

// ---------------------------------------------------------------------------
// create_wb_planned_match — tier 3 (the proposal shows exactly what confirming does)
// ---------------------------------------------------------------------------

/**
 * Everything create_wb_planned_match needs, read and checked. propose and the
 * handler both call this, so the proposal refuses whatever the write would.
 */
export async function matchPlan(T: string, db: Db, args: Obj): Promise<Obj> {
  const itemId = uuidOf(T, "planned_item_id", args.planned_item_id);
  const txnId = optUuid(T, "transaction_id", args.transaction_id);
  const splitArg = optUuid(T, "split_id", args.split_id);
  if (!txnId === !splitArg) throw new Error(`${T}: pass transaction_id (a single-split payment) or split_id, not both.`);
  const occurrence = parseDate(T, "occurrence_on", args.occurrence_on);
  const amountArg = parseMoney(T, "amount", args.amount);
  if (amountArg !== null && amountArg === 0) throw new Error(`${T}: amount cannot be zero.`);

  const { data: item, error: ie } = await db.from("wb_planned_items")
    .select("id, name, amount, due_on, interval_count, stage, is_draft, amount_tolerance").eq("id", itemId).maybeSingle();
  if (ie) throw new Error(dbError(T, ie));
  if (!item) throw new Error(`${T}: no planned item ${itemId} that you can see. Nothing was changed.`);
  const it = item as Obj;
  const recurring = it.interval_count !== null && it.interval_count !== undefined;
  if (recurring && !occurrence) throw new Error(`${T}: ${it.name} repeats, so pass occurrence_on: the due date this payment settles.`);
  if (!recurring && occurrence) throw new Error(`${T}: ${it.name} is a one-off, so it takes no occurrence_on.`);
  if (it.stage === "cancelled") throw new Error(`${T}: ${it.name} is cancelled. Nothing was changed.`);

  let splitQ = db.from("wb_splits").select("id, transaction_id, amount");
  splitQ = splitArg ? splitQ.eq("id", splitArg) : splitQ.eq("transaction_id", txnId);
  const { data: splits, error: se } = await splitQ.limit(21);
  if (se) throw new Error(dbError(T, se));
  const parts = (splits ?? []) as Obj[];
  if (!parts.length) throw new Error(`${T}: no ${splitArg ? "split" : "transaction"} with that id that you can see. Nothing was changed.`);
  if (!splitArg && parts.length > 1) {
    throw new Error(`${T}: that payment is split into ${parts.length} parts; pass split_id for the part that pays ${it.name}.`);
  }
  const split = parts[0];
  const { data: pay, error: pe } = await db.from("wb_transaction_list").select(PAYMENT_COLUMNS)
    .eq("id", split.transaction_id).maybeSingle();
  if (pe) throw new Error(dbError(T, pe));
  const payment = (pay ?? {}) as Obj;
  if (payment.pending) throw new Error(`${T}: that charge is still pending; match it once it posts. Nothing was changed.`);
  if (sign(num(split.amount)) !== sign(num(it.amount))) {
    throw new Error(`${T}: the payment and ${it.name} go opposite ways (one is money in, the other money out). Nothing was changed.`);
  }

  const { data: existing, error: xe } = await db.from("wb_planned_matches")
    .select("id, planned_item_id, split_id, occurrence_on, amount_applied, status")
    .or(`split_id.eq.${split.id},planned_item_id.eq.${itemId}`).limit(1000);
  if (xe) throw new Error(dbError(T, xe));
  const rows = (existing ?? []) as Obj[];
  const same = rows.find((m) => m.planned_item_id === itemId && m.split_id === split.id &&
    (m.occurrence_on ?? null) === (occurrence ?? null));
  if (same) throw new Error(`${T}: that payment is already ${same.status} for ${it.name}${occurrence ? ` on ${occurrence}` : ""}. Nothing was changed.`);
  const confirmed = rows.filter((m) => m.status === "confirmed");
  const usedOnSplit = confirmed.filter((m) => m.split_id === split.id).reduce((t, m) => t + Math.abs(num(m.amount_applied)), 0);
  const paidOnItem = confirmed.filter((m) => m.planned_item_id === itemId && (m.occurrence_on ?? null) === (occurrence ?? null))
    .reduce((t, m) => t + Math.abs(num(m.amount_applied)), 0);
  const splitLeft = cents(Math.abs(num(split.amount)) - usedOnSplit);
  const itemLeft = cents(Math.abs(num(it.amount)) - paidOnItem);
  const tol = num(it.amount_tolerance);
  if (leftOf(Math.abs(num(it.amount)), paidOnItem, tol) === 0) {
    throw new Error(`${T}: ${it.name}${occurrence ? ` on ${occurrence}` : ""} is already paid in full. Nothing was changed.`);
  }
  if (splitLeft <= 0) throw new Error(`${T}: all of that payment is already matched to other planned items. Nothing was changed.`);
  const magnitude = amountArg === null ? Math.min(splitLeft, itemLeft) : Math.abs(amountArg);
  if (magnitude > splitLeft) {
    const why = usedOnSplit > 0 ? " (part of it is already matched to another planned item)" : "";
    throw new Error(`${T}: That is more than what's left of this payment${why}; lower the amount. Nothing was changed.`);
  }
  const applied = cents(sign(num(it.amount)) * magnitude);
  return {
    item: it, split, payment, occurrence, applied,
    wouldMarkPaid: !recurring && it.stage !== "paid" && leftOf(Math.abs(num(it.amount)), paidOnItem + magnitude, tol) === 0,
  };
}

export const createWbPlannedMatchTool = defineTool({
  name: "create_wb_planned_match",
  tier: 3,
  propose: async (args: Obj, ctx) => {
    const p = await matchPlan("create_wb_planned_match", ctx.db, args);
    const it = p.item as Obj;
    const pay = p.payment as Obj;
    return {
      planned_item: { id: it.id, name: it.name, due_on: it.due_on, occurrence_on: p.occurrence ?? null, amount: it.amount },
      payment: {
        transaction_id: (p.split as Obj).transaction_id, split_id: (p.split as Obj).id,
        date: pay.txn_date, description: pay.clean_description ?? pay.payee ?? null, amount: pay.amount,
      },
      amount_applied: p.applied,
      would_mark_paid: p.wouldMarkPaid,
    };
  },
  handler: async (args: Obj, ctx) => {
    const T = "create_wb_planned_match";
    const p = await matchPlan(T, ctx.db, args);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    const { data, error } = await ctx.db.from("wb_planned_matches").insert({
      planned_item_id: (p.item as Obj).id, split_id: (p.split as Obj).id, occurrence_on: p.occurrence ?? null,
      amount_applied: p.applied, status: "suggested", source,
    }).select("id").single();
    if (error) throw new Error(dbError(T, error));
    const matchId = (data as Obj).id as string;
    const { data: res, error: ce } = await ctx.db.rpc("wb_confirm_planned_match",
      { p_match_id: matchId, p_action: "confirm", p_amount: null });
    if (ce) {
      // Leave nothing half-made: the row was only a step towards the confirmed match.
      await ctx.db.from("wb_planned_matches").delete().eq("id", matchId).eq("status", "suggested");
      throw new Error(dbError(T, ce));
    }
    return { match_id: matchId, amount_applied: p.applied, ...((res ?? {}) as Obj) };
  },
});

// ---------------------------------------------------------------------------
// update_wb_planned_match — tier 2 (acts on a suggestion already shown)
// ---------------------------------------------------------------------------

export const updateWbPlannedMatchTool = defineTool({
  name: "update_wb_planned_match",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "update_wb_planned_match";
    const id = uuidOf(T, "match_id", args.match_id);
    const action = oneOf(T, "action", args.action, MATCH_ACTIONS);
    if (!action) throw new Error(`${T}: action must be confirm or reject.`);
    const amount = parseMoney(T, "amount", args.amount);
    if (amount !== null && action !== "confirm") throw new Error(`${T}: amount only goes with confirm.`);
    if (amount === 0) throw new Error(`${T}: amount cannot be zero.`);
    const { data, error } = await ctx.db.rpc("wb_confirm_planned_match",
      { p_match_id: id, p_action: action, p_amount: amount === null ? null : Math.abs(amount) });
    if (error) throw new Error(dbError(T, error));
    return { match_id: id, ...((data ?? {}) as Obj) };
  },
});

// ---------------------------------------------------------------------------
// set_wb_transaction_project — tier 2 (single-split transactions, at most 25)
// ---------------------------------------------------------------------------

export const setWbTransactionProjectTool = defineTool({
  name: "set_wb_transaction_project",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "set_wb_transaction_project";
    const ids = idList(T, "transaction_ids", args.transaction_ids, MAX_PROJECT_ROWS);
    if (args.project_id === undefined) throw new Error(`${T}: pass project_id, or null to take them off their project.`);
    const projectId = optUuid(T, "project_id", args.project_id);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";

    const { data, error } = await ctx.db.from("wb_splits").select("id, transaction_id").in("transaction_id", ids).limit(1000);
    if (error) throw new Error(dbError(T, error));
    const byTxn = new Map<string, string[]>();
    for (const s of (data ?? []) as Obj[]) {
      const k = s.transaction_id as string;
      byTxn.set(k, [...(byTxn.get(k) ?? []), s.id as string]);
    }
    const single = ids.filter((t) => byTxn.get(t)?.length === 1);
    const multi = ids.filter((t) => (byTxn.get(t)?.length ?? 0) > 1);
    const missing = ids.filter((t) => !byTxn.has(t));
    if (single.length) {
      const splitIds = single.map((t) => (byTxn.get(t) as string[])[0]);
      const { error: ue } = await ctx.db.from("wb_splits").update({ project_id: projectId, project_source: source })
        .in("id", splitIds);
      if (ue) throw new Error(dbError(T, ue));
    }
    return { updated: single.length, project_id: projectId, skipped_multi_split: multi, not_found: missing };
  },
});

// ---------------------------------------------------------------------------
// update_wb_settings — tier 3 (the proposal shows the current values against the new ones)
// ---------------------------------------------------------------------------

function settingsFields(T: string, args: Obj): Obj {
  const out: Obj = {};
  if (args.safety_floor !== undefined) {
    const f = parseMoney(T, "safety_floor", args.safety_floor);
    if (f !== null && f < 0) throw new Error(`${T}: safety_floor must be 0 or more (null clears it).`);
    out.safety_floor = f;
  }
  if (args.horizon_months !== undefined) {
    const h = optInt(T, "horizon_months", args.horizon_months, 1, 24);
    if (h === null) throw new Error(`${T}: horizon_months must be a whole number from 1 to 24.`);
    out.horizon_months = h;
  }
  if (args.notes !== undefined) out.notes = optText(T, "notes", args.notes);
  if (!Object.keys(out).length) throw new Error(`${T}: pass safety_floor, horizon_months or notes.`);
  return out;
}

export const updateWbSettingsTool = defineTool({
  name: "update_wb_settings",
  tier: 3,
  propose: async (args: Obj, ctx) => {
    const T = "update_wb_settings";
    const fields = settingsFields(T, args);
    const cur = await currentSettings(T, ctx.db);
    const current = { safety_floor: cur.safety_floor, horizon_months: cur.horizon_months, notes: cur.notes };
    return { current, proposed: { ...current, ...fields }, changing: Object.keys(fields) };
  },
  handler: async (args: Obj, ctx) => {
    const T = "update_wb_settings";
    const fields = settingsFields(T, args);
    const { data, error } = await ctx.db.from("wb_settings")
      .upsert({ ...fields, context_id: MONEY_CONTEXT_ID }, { onConflict: "context_id" })
      .select("safety_floor, horizon_months, notes, updated_at").single();
    if (error) throw new Error(dbError(T, error));
    const s = data as Obj;
    return { ...s, floor_missing: s.safety_floor === null || s.safety_floor === undefined };
  },
});

// ---------------------------------------------------------------------------
// get_wb_project_summary — tier 1 (Step 8b, A35, A36)
// ---------------------------------------------------------------------------

const SUMMARY_COLUMNS =
  "project_id, name, status, budget, starts_on, ends_on, spent, received, net, budget_left, planned_out_due, " +
  "planned_in_due, draft_out_due, draft_in_due, item_count, draft_count, payment_count, last_payment_on, planning";

export const getWbProjectSummaryTool = defineTool({
  name: "get_wb_project_summary",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_project_summary";
    const projectId = optUuid(T, "project_id", args.project_id);
    const status = oneOf(T, "status", args.status, PROJECT_STATUSES);
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_project_summary").select(SUMMARY_COLUMNS, { count: "exact" });
    if (projectId) q = q.eq("project_id", projectId);
    if (status) q = q.eq("status", status);
    const { data, error, count } = await q.order("name").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_missed_dates — tier 1 (Step 8b, A25, A40)
// ---------------------------------------------------------------------------

const MISSED_COLUMNS =
  "planned_item_id, name, project_id, project_name, merchant_id, merchant_name, recurring, due_on, occurrence_on, " +
  "stage, amount, confirmed_total, remaining, days_late, within_window, has_suggestion";

export const getWbMissedDatesTool = defineTool({
  name: "get_wb_missed_dates",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_missed_dates";
    const projectId = optUuid(T, "project_id", args.project_id);
    const itemId = optUuid(T, "planned_item_id", args.planned_item_id);
    const withinWindow = optBool(T, "include_within_window", args.include_within_window) ?? true;
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_planned_unmatched").select(MISSED_COLUMNS, { count: "exact" });
    if (projectId) q = q.eq("project_id", projectId);
    if (itemId) q = q.eq("planned_item_id", itemId);
    if (!withinWindow) q = q.eq("within_window", false);
    const { data, error, count } = await q.order("due_on").order("name").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// mark_wb_missed_dates_not_needed — tier 2 (Step 8b, A40; up to 25, with undo)
// ---------------------------------------------------------------------------

export const MAX_SKIPS = 25;

/** The dates to mark, checked against the items: a repeating item needs occurrence_on, a one-off has none. */
export function skipDates(T: string, raw: unknown): Obj[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${T}: dates must be a list of 1 to ${MAX_SKIPS} entries.`);
  if (raw.length > MAX_SKIPS) throw new Error(`${T}: at most ${MAX_SKIPS} dates per call; got ${raw.length}. Nothing was changed.`);
  return raw.map((r, i) => {
    const o = (r ?? {}) as Obj;
    return {
      planned_item_id: uuidOf(T, `dates[${i}].planned_item_id`, o.planned_item_id),
      occurrence_on: parseDate(T, `dates[${i}].occurrence_on`, o.occurrence_on),
      reason: optText(T, `dates[${i}].reason`, o.reason),
    };
  });
}

const dateKey = (itemId: unknown, occ: unknown) => `${itemId}|${occ ?? ""}`;

export const markWbMissedDatesNotNeededTool = defineTool({
  name: "mark_wb_missed_dates_not_needed",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "mark_wb_missed_dates_not_needed";
    const dates = skipDates(T, args.dates);
    const undo = optBool(T, "undo", args.undo) ?? false;
    const itemIds = [...new Set(dates.map((d) => d.planned_item_id as string))];

    const { data: items, error: ie } = await ctx.db.from("wb_planned_items").select("id, name, interval_count")
      .in("id", itemIds).limit(MAX_SKIPS);
    if (ie) throw new Error(dbError(T, ie));
    const byId = new Map(((items ?? []) as Obj[]).map((it) => [it.id as string, it]));
    for (const d of dates) {
      const it = byId.get(d.planned_item_id as string);
      if (!it) throw new Error(`${T}: no planned item ${d.planned_item_id} that you can see. Nothing was changed.`);
      const recurring = it.interval_count !== null && it.interval_count !== undefined;
      if (recurring && !d.occurrence_on) throw new Error(`${T}: ${it.name} repeats, so pass occurrence_on: the missed due date. Nothing was changed.`);
      if (!recurring && d.occurrence_on) throw new Error(`${T}: ${it.name} is a one-off, so it takes no occurrence_on. Nothing was changed.`);
    }
    const { data: skips, error: se } = await ctx.db.from("wb_planned_skips").select("id, planned_item_id, occurrence_on")
      .in("planned_item_id", itemIds).limit(1000);
    if (se) throw new Error(dbError(T, se));
    const existing = new Map(((skips ?? []) as Obj[]).map((s) => [dateKey(s.planned_item_id, s.occurrence_on), s.id as string]));
    const label = (d: Obj) => ({ planned_item_id: d.planned_item_id, name: byId.get(d.planned_item_id as string)?.name, occurrence_on: d.occurrence_on });

    if (undo) {
      const found = dates.filter((d) => existing.has(dateKey(d.planned_item_id, d.occurrence_on)));
      const notMarked = dates.filter((d) => !existing.has(dateKey(d.planned_item_id, d.occurrence_on)));
      if (found.length) {
        const ids = found.map((d) => existing.get(dateKey(d.planned_item_id, d.occurrence_on)) as string);
        const { error } = await ctx.db.from("wb_planned_skips").delete().in("id", ids);
        if (error) throw new Error(dbError(T, error));
      }
      return { undone: found.map(label), not_marked: notMarked.map(label) };
    }

    // Only a date that is missed now can be marked, so a typo cannot hide a real due date.
    const { data: missed, error: me } = await ctx.db.from("wb_planned_unmatched").select("planned_item_id, occurrence_on")
      .in("planned_item_id", itemIds).limit(1000);
    if (me) throw new Error(dbError(T, me));
    const missedKeys = new Set(((missed ?? []) as Obj[]).map((r) => dateKey(r.planned_item_id, r.occurrence_on)));
    const already = dates.filter((d) => existing.has(dateKey(d.planned_item_id, d.occurrence_on)));
    const todo = dates.filter((d) => !existing.has(dateKey(d.planned_item_id, d.occurrence_on)));
    for (const d of todo) {
      if (!missedKeys.has(dateKey(d.planned_item_id, d.occurrence_on))) {
        const it = byId.get(d.planned_item_id as string) as Obj;
        throw new Error(`${T}: ${it.name}${d.occurrence_on ? ` on ${d.occurrence_on}` : ""} is not a missed date (get_wb_missed_dates lists them). Nothing was changed.`);
      }
    }
    if (todo.length) {
      const { error } = await ctx.db.from("wb_planned_skips").insert(todo.map((d) => ({
        planned_item_id: d.planned_item_id, occurrence_on: d.occurrence_on ?? null, reason: d.reason ?? null, context_id: MONEY_CONTEXT_ID,
      })));
      if (error) throw new Error(dbError(T, error));
    }
    return { marked: todo.map(label), already_marked: already.map(label) };
  },
});

// ---------------------------------------------------------------------------
// unconfirm_wb_planned_match — tier 2 (Step 8b, A39; never changes the stage)
// ---------------------------------------------------------------------------

export const SET_BACK_HINT =
  "This one-off is still at stage paid but is no longer fully covered. Ask Alex whether to set it back to invoiced " +
  "(upsert_wb_planned_item with stage invoiced). Do not change the stage without asking.";

export const unconfirmWbPlannedMatchTool = defineTool({
  name: "unconfirm_wb_planned_match",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "unconfirm_wb_planned_match";
    const id = uuidOf(T, "match_id", args.match_id);
    const { data: cur, error: ce } = await ctx.db.from("wb_planned_matches")
      .select("id, status, planned_item:wb_planned_items(name)").eq("id", id).maybeSingle();
    if (ce) throw new Error(dbError(T, ce));
    if (!cur) throw new Error(`${T}: no match ${id} that you can see. Nothing was changed.`);
    const m = cur as Obj;
    const name = ((m.planned_item ?? {}) as Obj).name ?? "the planned item";
    if (m.status !== "confirmed") {
      throw new Error(`${T}: that match to ${name} is ${m.status}, not confirmed; only a confirmed match can be removed. Nothing was changed.`);
    }
    const { data, error } = await ctx.db.rpc("wb_unconfirm_planned_match", { p_match_id: id });
    if (error) throw new Error(dbError(T, error));
    const res = (data ?? {}) as Obj;
    return { match_id: id, planned_item_name: name, ...res, ...(res.paid_not_covered ? { hint: SET_BACK_HINT } : {}) };
  },
});

// ---------------------------------------------------------------------------
// get_wb_action_items — tier 1 (Step 9c, A49, A50, A51)
// ---------------------------------------------------------------------------
// One object from wb_action_items, so no limit applies. Arguments left out keep the
// SQL defaults (14 days, 1000, 60 days).

export const getWbActionItemsTool = defineTool({
  name: "get_wb_action_items",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_action_items";
    const params: Obj = {};
    const days = optInt(T, "days", args.days, 1, 90);
    if (days !== null) params.p_days = days;
    if (!absent(args.big_amount)) {
      const big = args.big_amount;
      if (typeof big !== "number" || !Number.isFinite(big) || big <= 0 || big >= 1e9) {
        throw new Error(`${T}: big_amount must be a positive number of dollars. Got ${JSON.stringify(big)}.`);
      }
      params.p_big_amount = cents(big);
    }
    const bigDays = optInt(T, "big_days", args.big_days, 1, 366);
    if (bigDays !== null) params.p_big_days = bigDays;
    const { data, error } = await ctx.db.rpc("wb_action_items", params);
    if (error) throw new Error(`${T}: could not read the action items: ${error.message ?? "database error"}.`);
    if (!data) throw new Error(`${T}: the database returned no action items.`);
    return data as Obj;
  },
});
