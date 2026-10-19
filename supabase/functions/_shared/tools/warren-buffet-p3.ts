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
export function annotateItem(it: Obj, confirmed: Obj[]): Obj {
  const recurring = it.interval_count !== null && it.interval_count !== undefined;
  const s = sign(num(it.amount));
  const mine = confirmed.filter((m) => m.planned_item_id === it.id);
  const paid = mine.reduce((t, m) => t + Math.abs(num(m.amount_applied)), 0);
  return {
    ...it,
    recurring,
    draft: isDraft(it),
    confirmed_total: cents(s * paid),
    ...(recurring ? {} : { remaining: cents(s * Math.max(Math.abs(num(it.amount)) - paid, 0)) }),
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

export const getWbFreeCashTool = defineTool({
  name: "get_wb_free_cash",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_free_cash";
    const includeDrafts = optBool(T, "include_drafts", args.include_drafts) ?? false;
    const { data, error } = await ctx.db.rpc("wb_free_cash", { p_include_drafts: includeDrafts });
    if (error) throw new Error(dbError(T, error));
    const row = (Array.isArray(data) ? data[0] : data) ?? null;
    return { ...(row ?? {}), include_drafts: includeDrafts };
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
    let item: Obj;
    if (!id) {
      for (const k of ["name", "amount", "due_on"]) {
        if (fields[k] === undefined) throw new Error(`${T}: ${k} is required for a new planned item.`);
      }
      const recurring = fields.interval_count !== undefined && fields.interval_count !== null;
      if (!recurring && !fields.stage) {
        throw new Error(`${T}: a one-off planned item needs a stage (draft, estimate, quoted, invoiced, paid or cancelled).`);
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
    return { item: annotateItem(item, confirmed), created: !id, suggestions };
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
    .select("id, name, amount, due_on, interval_count, stage, is_draft").eq("id", itemId).maybeSingle();
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
  if (itemLeft <= 0) throw new Error(`${T}: ${it.name}${occurrence ? ` on ${occurrence}` : ""} is already paid in full. Nothing was changed.`);
  if (splitLeft <= 0) throw new Error(`${T}: all of that payment is already matched to other planned items. Nothing was changed.`);
  const magnitude = amountArg === null ? Math.min(splitLeft, itemLeft) : Math.abs(amountArg);
  if (magnitude > splitLeft) {
    const why = usedOnSplit > 0 ? " (part of it is already matched to another planned item)" : "";
    throw new Error(`${T}: That is more than what's left of this payment${why}; lower the amount. Nothing was changed.`);
  }
  const applied = cents(sign(num(it.amount)) * magnitude);
  return {
    item: it, split, payment, occurrence, applied,
    wouldMarkPaid: !recurring && it.stage !== "paid" && paidOnItem + magnitude >= Math.abs(num(it.amount)),
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
