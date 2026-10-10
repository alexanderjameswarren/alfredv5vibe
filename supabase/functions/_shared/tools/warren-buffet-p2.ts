// ============================================================================
// supabase/functions/_shared/tools/warren-buffet-p2.ts
//
// Warren Buffet Phase 2 tools. Spec: docs/technical-spec-warren_buffet_p2-m4t.md §6 and §6.1.
//
//   get_wb_review_queue              tier 1 — items needing attention, with counts by reason
//   get_wb_tags                      tier 1 — tag groups and tags as a tree, with usage
//   create_wb_tag                    tier 1 — a tag in a group
//   update_wb_tag                    tier 2 — rename, re-parent, deactivate
//   get_wb_merchants                 tier 1 — merchants and their patterns
//   upsert_wb_merchant               tier 2 — create or edit a merchant, then reprocess
//   get_wb_rules                     tier 1 — rules with hit counts
//   create_wb_rule / update_wb_rule  tier 2 — rules, then reprocess
//   get_wb_rule_preview              tier 1 — dry-run count for a rule or a fix
//   create_wb_rule_from_transaction  tier 3 — "Always do this" (§6.1), with a proposal
//   tag_wb_transactions              tier 2 — tags on up to 25 transactions
//   set_wb_transaction_kind          tier 2 — kind, merchant, transfer pairing
//   split_wb_transaction             tier 2 — replace a transaction's splits
//   mark_wb_reviewed                 tier 2 — reviewed flag
//   reprocess_wb_transactions        tier 2 — re-run processing over ids or dates
//   get_wb_spending / get_wb_cash_flow  tier 1 — the two report views
//
// Multi-row writes go through the invoker functions from the Step 4 migration,
// so each is one transaction. Sign rule: money in positive, money out negative.
// ============================================================================

import { defineTool, describeDbError, envelope } from "../platform.ts";
import {
  absent, checkRange, escapeLike, limitOf, listResult, MONEY_CONTEXT_ID, nextDay, oneOf, optBool, optText,
  pacificMidnight, parseDate, parseMoney, requireId, searchTerm, WB_KINDS,
} from "./warren-buffet.ts";

type Obj = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;

export const HAND_SOURCES = ["claude", "manual"] as const;
export const REVIEW_REASONS = ["no_kind", "missing_required_tag", "transfer_candidate", "split_mismatch"] as const;
export const SPENDING_LEVELS = ["top", "leaf"] as const;
export const MATCH_KEYS = [
  "merchant_id", "payee_contains", "description_contains", "account_ids", "amount_min", "amount_max", "kind",
] as const;
export const MAX_TAG_ROWS = 25;
export const MAX_REVIEW_ROWS = 50;
export const MAX_SPLITS = 20;
export const MAX_REPROCESS = 2000;
export const PROCESS_CHUNK = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const QUEUE_COLUMNS =
  "reason, detail, transaction_id, account_id, account_label, txn_date, amount, description, clean_description, " +
  "payee, merchant_id, merchant_name, merchant_source, kind, kind_source, pending, reviewed, transfer_candidate, " +
  "transfer_pair_id, tag_names";
const MERCHANT_COLUMNS = "id, name, match_patterns, default_kind, notes, created_at, updated_at";
const RULE_COLUMNS =
  "id, name, priority, active, match, set_kind, set_merchant_id, add_tag_ids, created_by, " +
  "created_from_transaction_id, hit_count, last_hit_at, notes, created_at, updated_at";
const TAG_COLUMNS = "id, group_id, parent_id, name, is_active, sort_order, notes";
const LIST_COLUMNS =
  "id, account_label, txn_date, amount, description, clean_description, payee, merchant_id, merchant_name, " +
  "kind, kind_source, transfer_pair_id, reviewed, tag_names, split_count, needs_review";

// ---------------------------------------------------------------------------
// Database errors: known ones become plain sentences, never amounts or internals
// ---------------------------------------------------------------------------

const EXCLUSIVE = "A split can carry only one tag from an exclusive group (such as Category or Who).";
export const KNOWN_DB_ERRORS: Array<[RegExp, string]> = [
  [/splits sum to|split\(s\) of transaction .* sum to/, "Split amounts must add up to the transaction amount."],
  [/splits must be a non-empty array/, "Pass at least one split."],
  [/two tags from one exclusive group/, EXCLUSIVE],
  [/wb_split_tags_one_per_exclusive_group/, EXCLUSIVE],
  [/no transaction .* that you can see/, "No transaction with that id that you can see."],
  [/both rows are on the same account/, "A transfer pairs two different accounts."],
  [/one row out \(negative\) and one in \(positive\)/, "A transfer needs one row out (negative) and one in (positive)."],
  [/already paired with another/, "One of the rows is already paired with another transaction; unpair it first."],
  [/cannot pair with itself/, "A transaction cannot pair with itself."],
  [/a tag id does not exist|add_tag_ids holds a tag that does not exist|wb_split_tags: tag .* not found/, "One of the tag ids does not exist."],
  [/parent must be in the same group/, "A tag's parent must be in the same group."],
  [/would make a cycle/, "That parent would make a loop in the tag tree."],
  [/is in use and cannot move|has children and cannot move/, "A tag that is in use or has children cannot move to another group."],
  [/wb_rules_match_check/, "The rule's match is not valid: use only merchant_id, payee_contains, description_contains, account_ids, amount_min, amount_max and kind."],
  [/wb_merchants_name_key/, "A merchant with that name already exists."],
  [/wb_tags_group_name_key/, "A tag with that name already exists in that group."],
  [/wb_merchants_patterns_check/, "Merchant patterns cannot be empty."],
  [/pass exactly one of p_match or p_pattern/, "Pass a match or a pattern, not both."],
];

/** A known database refusal as a plain sentence; anything else as the platform's operational error. */
export function dbError(T: string, error: { code?: string; message?: string; details?: string; hint?: string }): string {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  const known = KNOWN_DB_ERRORS.find(([re]) => re.test(text));
  return known ? `${T}: ${known[1]} Nothing was changed.` : describeDbError(T, error);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function uuidOf(T: string, key: string, v: unknown): string {
  const s = requireId(T, key, v);
  if (!UUID_RE.test(s)) throw new Error(`${T}: ${key} must be an id (uuid). Got ${JSON.stringify(v)}.`);
  return s;
}

const optUuid = (T: string, key: string, v: unknown) => (absent(v) ? null : uuidOf(T, key, v));

/** A non-empty list of ids, deduped, at most `max`. */
export function idList(T: string, key: string, v: unknown, max: number): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${T}: ${key} must be a non-empty list of ids.`);
  const ids = [...new Set(v.map((x) => uuidOf(T, key, x)))];
  if (ids.length > max) throw new Error(`${T}: at most ${max} ${key} per call; got ${ids.length}. Nothing was changed.`);
  return ids;
}

/** A list of ids that may be empty. */
function optIdList(T: string, key: string, v: unknown, max: number): string[] {
  if (absent(v)) return [];
  if (Array.isArray(v) && v.length === 0) return [];
  return idList(T, key, v, max);
}

function optInt(T: string, key: string, v: unknown, min: number, max: number): number | null {
  if (absent(v)) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${T}: ${key} must be a whole number from ${min} to ${max}.`);
  }
  return v;
}

/** YYYY-MM to the first day of that month. */
export function parseMonth(T: string, key: string, v: unknown): string | null {
  if (absent(v)) return null;
  if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v.trim())) {
    throw new Error(`${T}: ${key} must be a month as YYYY-MM. Got ${JSON.stringify(v)}.`);
  }
  return `${v.trim()}-01`;
}

/** A rule's match object (spec §4.7): known keys only, each of the right type. */
export function parseMatch(T: string, v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${T}: match must be an object.`);
  const m = v as Obj;
  const keys = Object.keys(m).filter((k) => m[k] !== undefined && m[k] !== null);
  if (!keys.length) throw new Error(`${T}: match needs at least one of ${MATCH_KEYS.join(", ")}.`);
  const unknown = keys.filter((k) => !(MATCH_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`${T}: match has unknown key(s) ${unknown.join(", ")}. Allowed: ${MATCH_KEYS.join(", ")}.`);
  const out: Obj = {};
  for (const k of keys) {
    const x = m[k];
    if (k === "merchant_id") out[k] = uuidOf(T, "match.merchant_id", x);
    else if (k === "account_ids") out[k] = idList(T, "match.account_ids", x, 50);
    else if (k === "kind") out[k] = oneOf(T, "match.kind", x, WB_KINDS);
    else if (k === "amount_min" || k === "amount_max") {
      const n = parseMoney(T, `match.${k}`, x);
      if (n === null || n < 0) throw new Error(`${T}: match.${k} compares the absolute amount, so it must be 0 or more.`);
      out[k] = n;
    } else {
      const s = optText(T, `match.${k}`, x);
      if (!s) throw new Error(`${T}: match.${k} must be non-empty text.`);
      out[k] = s;
    }
  }
  if (typeof out.amount_min === "number" && typeof out.amount_max === "number" && out.amount_min > out.amount_max) {
    throw new Error(`${T}: match.amount_min is greater than match.amount_max.`);
  }
  return out;
}

/** Merchant patterns: lower-case substrings, at least 3 characters each. */
export function parsePatterns(T: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`${T}: match_patterns must be a non-empty list of text.`);
  const out = [...new Set(v.map((x) => {
    if (typeof x !== "string") throw new Error(`${T}: match_patterns must be text.`);
    const s = x.trim().toLowerCase().replace(/\s+/g, " ");
    if (s.length < 3) throw new Error(`${T}: a match pattern needs at least 3 characters; ${JSON.stringify(x)} would catch too much.`);
    return s;
  }))];
  return out;
}

// Words that say nothing about who was paid.
export const STOP_WORDS = new Set([
  "the", "and", "inc", "llc", "ltd", "corp", "company", "www", "com", "net", "org", "online", "payment", "payments",
  "purchase", "pos", "debit", "credit", "card", "visa", "mastercard", "direct", "recurring", "autopay", "bill",
  "pay", "store", "shop", "market", "usa", "transfer", "deposit", "withdrawal", "mktp", "mktpl", "help", "check",
]);

/**
 * The short merchant pattern a fix proposes (spec §6.1): among the first three
 * words of the payee, else of the clean description, the shortest that is at
 * least 4 letters and not a stop word. Editable before saving.
 */
export function suggestPattern(payee: unknown, clean: unknown): string | null {
  for (const text of [payee, clean]) {
    if (typeof text !== "string") continue;
    const words = text.toLowerCase().split(/[^a-z0-9&'.-]+/).filter(Boolean).slice(0, 3)
      .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
      .filter((w) => /^[a-z][a-z&'.-]{3,}$/.test(w) && !STOP_WORDS.has(w));
    if (words.length) return words.reduce((a, b) => (b.length < a.length ? b : a));
  }
  return null;
}

export function titleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));
}

/** Groups and tags as a tree; usage is the number of splits carrying each tag. */
export function buildTagTree(groups: Obj[], tags: Obj[], usage: Map<string, number>) {
  const node = (t: Obj): Obj => ({
    id: t.id, name: t.name, is_active: t.is_active, sort_order: t.sort_order, notes: t.notes ?? null,
    usage: usage.get(t.id as string) ?? 0,
    children: tags.filter((c) => c.parent_id === t.id).map(node),
  });
  return groups.map((g) => ({
    id: g.id, name: g.name, exclusive: g.exclusive, required_for_kinds: g.required_for_kinds, notes: g.notes ?? null,
    tags: tags.filter((t) => t.group_id === g.id && !tags.some((p) => p.id === t.parent_id)).map(node),
  }));
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** wb_process_transactions over ids, in chunks. Returns summed counts. */
export async function reprocess(T: string, db: Db, ids: string[]) {
  const totals = { processed: 0, paired: 0, transfer_candidates: 0, rule_tags: 0 };
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += PROCESS_CHUNK) {
    const { data, error } = await db.rpc("wb_process_transactions", { ids: unique.slice(i, i + PROCESS_CHUNK) });
    if (error) throw new Error(dbError(T, error));
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[k] += typeof data?.[k] === "number" ? data[k] : 0;
    }
  }
  return totals;
}

async function preview(T: string, db: Db, match: Obj | null, pattern: string | null, samples = 5) {
  const { data, error } = await db.rpc("wb_rule_preview", { p_match: match, p_pattern: pattern, p_samples: samples });
  if (error) throw new Error(dbError(T, error));
  return data as { count: number; too_narrow: boolean; samples: Obj[]; ids: string[] };
}

/** Ids of transactions a rule matched at their last processing. */
async function idsMatchedBy(T: string, db: Db, ruleId: string): Promise<string[]> {
  const { data, error } = await db.from("wb_transactions").select("id").contains("matched_rule_ids", [ruleId]).limit(5000);
  if (error) throw new Error(dbError(T, error));
  return ((data ?? []) as Obj[]).map((r) => r.id as string);
}

async function rulesForMerchant(T: string, db: Db, merchantId: string): Promise<Obj[]> {
  const { data, error } = await db.from("wb_rules").select(RULE_COLUMNS)
    .eq("match->>merchant_id", merchantId).order("priority").order("created_at");
  if (error) throw new Error(dbError(T, error));
  return (data ?? []) as Obj[];
}

async function merchantByName(T: string, db: Db, name: string): Promise<Obj | null> {
  const { data, error } = await db.from("wb_merchants").select(MERCHANT_COLUMNS)
    .ilike("name", escapeLike(name)).limit(1).maybeSingle();
  if (error) throw new Error(dbError(T, error));
  return (data ?? null) as Obj | null;
}

/** Tag and merchant names for rules, so Claude reads names, not ids. */
async function describeRules(T: string, db: Db, rules: Obj[]): Promise<Obj[]> {
  const tagIds = [...new Set(rules.flatMap((r) => (r.add_tag_ids as string[]) ?? []))];
  const merchantIds = [...new Set(rules.flatMap((r) =>
    [r.set_merchant_id, (r.match as Obj | null)?.merchant_id].filter(Boolean) as string[]))];
  const tags = new Map<string, string>();
  const merchants = new Map<string, string>();
  if (tagIds.length) {
    const { data, error } = await db.from("wb_tags").select("id, name").in("id", tagIds);
    if (error) throw new Error(dbError(T, error));
    for (const t of (data ?? []) as Obj[]) tags.set(t.id as string, t.name as string);
  }
  if (merchantIds.length) {
    const { data, error } = await db.from("wb_merchants").select("id, name").in("id", merchantIds);
    if (error) throw new Error(dbError(T, error));
    for (const m of (data ?? []) as Obj[]) merchants.set(m.id as string, m.name as string);
  }
  return rules.map((r) => ({
    ...r,
    add_tags: ((r.add_tag_ids as string[]) ?? []).map((id) => ({ id, name: tags.get(id) ?? null })),
    match_merchant_name: merchants.get((r.match as Obj | null)?.merchant_id as string) ?? null,
    set_merchant_name: merchants.get(r.set_merchant_id as string) ?? null,
  }));
}

/** Rule fields shared by create_wb_rule and update_wb_rule. Only keys present in args are returned. */
function ruleFields(T: string, args: Obj): Obj {
  const out: Obj = {};
  if (args.name !== undefined) {
    const name = optText(T, "name", args.name);
    if (!name) throw new Error(`${T}: name cannot be empty.`);
    out.name = name;
  }
  if (args.priority !== undefined) out.priority = optInt(T, "priority", args.priority, 0, 10000) ?? 100;
  if (args.match !== undefined) out.match = parseMatch(T, args.match);
  if (args.set_kind !== undefined) out.set_kind = oneOf(T, "set_kind", args.set_kind, WB_KINDS);
  if (args.set_merchant_id !== undefined) out.set_merchant_id = optUuid(T, "set_merchant_id", args.set_merchant_id);
  if (args.add_tag_ids !== undefined) out.add_tag_ids = optIdList(T, "add_tag_ids", args.add_tag_ids, 20);
  if (args.notes !== undefined) out.notes = optText(T, "notes", args.notes);
  return out;
}

const hasAction = (r: Obj) => !!r.set_kind || !!r.set_merchant_id || ((r.add_tag_ids as string[] | undefined)?.length ?? 0) > 0;

const MERCHANT_FIRST =
  "Rules should match on the merchant (match.merchant_id), not on an exact description: create or fix the merchant first.";

// ---------------------------------------------------------------------------
// "Always do this" (spec §6.1): the plan shared by the preview, the proposal and the write
// ---------------------------------------------------------------------------

interface FixInput { transactionId: string; pattern: string | null; merchantName: string | null }

/** Fix arguments, read once for the preview, the proposal and the write. */
function fixArgs(T: string, args: Obj): FixInput {
  const pattern = optText(T, "pattern", args.pattern);
  return {
    transactionId: uuidOf(T, "transaction_id", args.transaction_id),
    pattern: pattern ? parsePatterns(T, [pattern])[0] : null,
    merchantName: optText(T, "merchant_name", args.merchant_name),
  };
}

export async function fixPlan(T: string, db: Db, input: FixInput) {
  const { data: txn, error } = await db.from("wb_transaction_list").select(LIST_COLUMNS)
    .eq("id", input.transactionId).maybeSingle();
  if (error) throw new Error(dbError(T, error));
  if (!txn) throw new Error(`${T}: no transaction ${input.transactionId} that you can see. Nothing was changed.`);
  const t = txn as Obj;

  let merchant: Obj;
  let pattern: string | null = null;
  if (t.merchant_id && !input.pattern) {
    merchant = { id: t.merchant_id, name: t.merchant_name, exists: true, add_pattern: null };
  } else {
    pattern = input.pattern ?? suggestPattern(t.payee, t.clean_description);
    if (!pattern) {
      throw new Error(`${T}: no distinctive word to match on in ${JSON.stringify(t.payee ?? t.clean_description)}; pass pattern. Nothing was changed.`);
    }
    let found: Obj | null = null;
    if (t.merchant_id) {
      const { data: own, error: oe } = await db.from("wb_merchants").select(MERCHANT_COLUMNS).eq("id", t.merchant_id).maybeSingle();
      if (oe) throw new Error(dbError(T, oe));
      found = (own ?? null) as Obj | null;
    }
    const name = input.merchantName ?? (t.merchant_name as string | null) ?? titleCase(pattern);
    found = found ?? await merchantByName(T, db, name);
    const patterns = (found?.match_patterns as string[] | undefined) ?? [];
    merchant = found
      ? { id: found.id, name: found.name, exists: true, add_pattern: patterns.includes(pattern) ? null : pattern }
      : { id: null, name, exists: false, add_pattern: pattern };
  }

  const dry = pattern
    ? await preview(T, db, null, pattern)
    : await preview(T, db, { merchant_id: merchant.id }, null);
  const existing = merchant.id ? await describeRules(T, db, await rulesForMerchant(T, db, merchant.id as string)) : [];
  const warnings: string[] = [];
  if (dry.too_narrow) {
    warnings.push(`This would catch only ${dry.count} past transaction(s): probably too narrow. Try a shorter pattern.`);
  }
  if (existing.length) {
    warnings.push(`A rule already exists for ${merchant.name}: pass update_rule_id to update it instead of adding another, or add_new_rule: true.`);
  }
  return {
    transaction: {
      id: t.id, txn_date: t.txn_date, amount: t.amount, account_label: t.account_label, payee: t.payee,
      clean_description: t.clean_description, kind: t.kind, tag_names: t.tag_names,
    },
    merchant,
    pattern,
    rule_match: merchant.id ? { merchant_id: merchant.id } : { merchant_id: "(the new merchant)" },
    dry_run: { count: dry.count, too_narrow: dry.too_narrow, samples: dry.samples },
    existing_rules: existing,
    warnings,
    ids: dry.ids,
  };
}

// ---------------------------------------------------------------------------
// get_wb_review_queue — tier 1
// ---------------------------------------------------------------------------

export const getWbReviewQueueTool = defineTool({
  name: "get_wb_review_queue",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_review_queue";
    const reason = oneOf(T, "reason", args.reason, REVIEW_REASONS);
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    const LIMIT = limitOf(T, args.limit);

    let cq = ctx.db.from("wb_review_queue").select("reason");
    if (from) cq = cq.gte("txn_date", from);
    if (to) cq = cq.lte("txn_date", to);
    const { data: all, error: ce } = await cq.limit(10000);
    if (ce) throw new Error(dbError(T, ce));
    const counts: Record<string, number> = {};
    for (const r of (all ?? []) as Obj[]) counts[r.reason as string] = (counts[r.reason as string] ?? 0) + 1;

    let q = ctx.db.from("wb_review_queue").select(QUEUE_COLUMNS, { count: "exact" });
    if (reason) q = q.eq("reason", reason);
    if (from) q = q.gte("txn_date", from);
    if (to) q = q.lte("txn_date", to);
    const { data, error, count } = await q.order("txn_date", { ascending: false }).order("transaction_id").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    const items = data ?? [];
    const total = count ?? items.length;
    const truncated = total > items.length;
    return envelope({ counts, items }, { count: total, limit_applied: LIMIT, truncated, ...(truncated ? { total } : {}) });
  },
});

// ---------------------------------------------------------------------------
// get_wb_tags — tier 1 (a small set: internal cap, no limit param)
// ---------------------------------------------------------------------------

export const getWbTagsTool = defineTool({
  name: "get_wb_tags",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_tags";
    const group = optText(T, "group", args.group);
    const includeInactive = optBool(T, "include_inactive", args.include_inactive) ?? false;

    let gq = ctx.db.from("wb_tag_groups").select("id, name, exclusive, required_for_kinds, sort_order, notes");
    if (group) gq = gq.ilike("name", escapeLike(group));
    const { data: groups, error: ge } = await gq.order("sort_order").order("name");
    if (ge) throw new Error(dbError(T, ge));
    if (group && !(groups ?? []).length) throw new Error(`${T}: no tag group named ${JSON.stringify(group)}.`);

    let tq = ctx.db.from("wb_tags").select(TAG_COLUMNS).in("group_id", ((groups ?? []) as Obj[]).map((g) => g.id));
    if (!includeInactive) tq = tq.eq("is_active", true);
    const { data: tags, error: te } = await tq.order("sort_order").order("name").limit(1000);
    if (te) throw new Error(dbError(T, te));

    const usage = new Map<string, number>();
    for (let from = 0; from < 50000; from += 1000) {
      const { data: page, error: ue } = await ctx.db.from("wb_split_tags").select("tag_id").order("id").range(from, from + 999);
      if (ue) throw new Error(dbError(T, ue));
      for (const r of (page ?? []) as Obj[]) usage.set(r.tag_id as string, (usage.get(r.tag_id as string) ?? 0) + 1);
      if ((page ?? []).length < 1000) break;
    }
    return { groups: buildTagTree((groups ?? []) as Obj[], (tags ?? []) as Obj[], usage) };
  },
});

// ---------------------------------------------------------------------------
// create_wb_tag — tier 1
// ---------------------------------------------------------------------------

export const createWbTagTool = defineTool({
  name: "create_wb_tag",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "create_wb_tag";
    const group = optText(T, "group", args.group);
    if (!group) throw new Error(`${T}: group is required (its name or id).`);
    const name = optText(T, "name", args.name);
    if (!name) throw new Error(`${T}: name is required.`);
    const parentId = optUuid(T, "parent_id", args.parent_id);
    const sortOrder = optInt(T, "sort_order", args.sort_order, 0, 10000) ?? 0;
    const notes = optText(T, "notes", args.notes);

    const gq = ctx.db.from("wb_tag_groups").select("id, name");
    const { data: g, error: ge } = await (UUID_RE.test(group) ? gq.eq("id", group) : gq.ilike("name", escapeLike(group)))
      .limit(1).maybeSingle();
    if (ge) throw new Error(dbError(T, ge));
    if (!g) throw new Error(`${T}: no tag group ${JSON.stringify(group)}. Groups: see get_wb_tags. Nothing was created.`);
    const groupId = (g as Obj).id as string;

    const { data: dupe, error: de } = await ctx.db.from("wb_tags").select("id, name, is_active")
      .eq("group_id", groupId).ilike("name", escapeLike(name)).limit(1).maybeSingle();
    if (de) throw new Error(dbError(T, de));
    if (dupe) {
      const d = dupe as Obj;
      throw new Error(`${T}: ${JSON.stringify(d.name)} already exists in ${(g as Obj).name} (id ${d.id}${d.is_active ? "" : ", inactive: reactivate it with update_wb_tag"}). Nothing was created.`);
    }

    const { data, error } = await ctx.db.from("wb_tags")
      .insert({ group_id: groupId, parent_id: parentId, name, sort_order: sortOrder, notes, context_id: MONEY_CONTEXT_ID })
      .select(TAG_COLUMNS).single();
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// update_wb_tag — tier 2
// ---------------------------------------------------------------------------

export const updateWbTagTool = defineTool({
  name: "update_wb_tag",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "update_wb_tag";
    const id = uuidOf(T, "tag_id", args.tag_id);
    const patch: Obj = {};
    if (args.name !== undefined) {
      const name = optText(T, "name", args.name);
      if (!name) throw new Error(`${T}: name cannot be empty.`);
      patch.name = name;
    }
    if (args.parent_id !== undefined) patch.parent_id = optUuid(T, "parent_id", args.parent_id);
    if (args.is_active !== undefined) {
      const active = optBool(T, "is_active", args.is_active);
      if (active === null) throw new Error(`${T}: is_active must be true or false.`);
      patch.is_active = active;
    }
    if (args.sort_order !== undefined) patch.sort_order = optInt(T, "sort_order", args.sort_order, 0, 10000) ?? 0;
    if (args.notes !== undefined) patch.notes = optText(T, "notes", args.notes);
    if (!Object.keys(patch).length) throw new Error(`${T}: nothing to change. Pass name, parent_id, is_active, sort_order or notes.`);
    patch.context_id = MONEY_CONTEXT_ID;

    const { data, error } = await ctx.db.from("wb_tags").update(patch).eq("id", id).select(TAG_COLUMNS).maybeSingle();
    if (error) throw new Error(dbError(T, error));
    if (!data) throw new Error(`${T}: no tag ${id} that you can see. Nothing was changed.`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// get_wb_merchants — tier 1
// ---------------------------------------------------------------------------

export const getWbMerchantsTool = defineTool({
  name: "get_wb_merchants",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_merchants";
    const search = searchTerm(T, args.search);
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_merchants").select(MERCHANT_COLUMNS, { count: "exact" });
    if (search) q = q.ilike("name", `%${escapeLike(search)}%`);
    const { data, error, count } = await q.order("name").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// upsert_wb_merchant — tier 2
// ---------------------------------------------------------------------------

export const upsertWbMerchantTool = defineTool({
  name: "upsert_wb_merchant",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "upsert_wb_merchant";
    const id = optUuid(T, "id", args.id);
    const name = optText(T, "name", args.name);
    if (!id && !name) throw new Error(`${T}: pass id to edit a merchant, or name to create or edit one by name.`);
    const patterns = args.match_patterns === undefined ? undefined : parsePatterns(T, args.match_patterns);
    const defaultKind = args.default_kind === undefined ? undefined : oneOf(T, "default_kind", args.default_kind, WB_KINDS);
    const notes = args.notes === undefined ? undefined : optText(T, "notes", args.notes);
    const doReprocess = optBool(T, "reprocess", args.reprocess) ?? true;

    let existing: Obj | null = null;
    if (id) {
      const { data, error } = await ctx.db.from("wb_merchants").select(MERCHANT_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(dbError(T, error));
      if (!data) throw new Error(`${T}: no merchant ${id} that you can see. Nothing was changed.`);
      existing = data as Obj;
    } else {
      existing = await merchantByName(T, ctx.db, name as string);
    }

    const fields: Obj = { context_id: MONEY_CONTEXT_ID };
    if (name !== null && (id || !existing)) fields.name = name;
    if (patterns !== undefined) fields.match_patterns = patterns;
    if (defaultKind !== undefined) fields.default_kind = defaultKind;
    if (notes !== undefined) fields.notes = notes;

    let merchant: Obj;
    if (existing) {
      const { data, error } = await ctx.db.from("wb_merchants").update(fields).eq("id", existing.id)
        .select(MERCHANT_COLUMNS).maybeSingle();
      if (error) throw new Error(dbError(T, error));
      merchant = data as Obj;
    } else {
      if (!patterns) throw new Error(`${T}: a new merchant needs match_patterns. Nothing was created.`);
      const { data, error } = await ctx.db.from("wb_merchants").insert(fields).select(MERCHANT_COLUMNS).single();
      if (error) throw new Error(dbError(T, error));
      merchant = data as Obj;
    }

    let reprocessed = null;
    if (doReprocess) {
      const ids: string[] = [];
      const { data: own, error: oe } = await ctx.db.from("wb_transactions").select("id").eq("merchant_id", merchant.id).limit(5000);
      if (oe) throw new Error(dbError(T, oe));
      ids.push(...((own ?? []) as Obj[]).map((r) => r.id as string));
      for (const p of (merchant.match_patterns as string[]) ?? []) ids.push(...(await preview(T, ctx.db, null, p, 0)).ids);
      reprocessed = await reprocess(T, ctx.db, ids);
    }
    return { merchant, created: !existing, reprocessed };
  },
});

// ---------------------------------------------------------------------------
// get_wb_rules — tier 1
// ---------------------------------------------------------------------------

export const getWbRulesTool = defineTool({
  name: "get_wb_rules",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_rules";
    const active = optBool(T, "active", args.active);
    const merchantId = optUuid(T, "merchant_id", args.merchant_id);
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_rules").select(RULE_COLUMNS, { count: "exact" });
    if (active !== null) q = q.eq("active", active);
    if (merchantId) q = q.eq("match->>merchant_id", merchantId);
    const { data, error, count } = await q.order("priority").order("created_at").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(await describeRules(T, ctx.db, (data ?? []) as unknown as Obj[]), count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// create_wb_rule — tier 2
// ---------------------------------------------------------------------------

export const createWbRuleTool = defineTool({
  name: "create_wb_rule",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "create_wb_rule";
    const fields = ruleFields(T, args);
    if (!fields.name) throw new Error(`${T}: name is required.`);
    if (!fields.match) throw new Error(`${T}: match is required. ${MERCHANT_FIRST}`);
    if (!hasAction(fields)) throw new Error(`${T}: a rule needs set_kind, set_merchant_id or add_tag_ids.`);
    const doReprocess = optBool(T, "reprocess", args.reprocess) ?? true;

    const { data, error } = await ctx.db.from("wb_rules")
      .insert({ priority: 100, ...fields, created_by: "claude", context_id: MONEY_CONTEXT_ID })
      .select(RULE_COLUMNS).single();
    if (error) throw new Error(dbError(T, error));
    const rule = data as unknown as Obj;
    const reprocessed = doReprocess ? await reprocess(T, ctx.db, (await preview(T, ctx.db, rule.match as Obj, null, 0)).ids) : null;
    const [described] = await describeRules(T, ctx.db, [rule]);
    return {
      rule: described,
      reprocessed,
      ...((rule.match as Obj).merchant_id ? {} : { warning: MERCHANT_FIRST }),
    };
  },
});

// ---------------------------------------------------------------------------
// update_wb_rule — tier 2
// ---------------------------------------------------------------------------

export const updateWbRuleTool = defineTool({
  name: "update_wb_rule",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "update_wb_rule";
    const id = uuidOf(T, "rule_id", args.rule_id);
    const fields = ruleFields(T, args);
    if (args.active !== undefined) {
      const active = optBool(T, "active", args.active);
      if (active === null) throw new Error(`${T}: active must be true or false.`);
      fields.active = active;
    }
    if (!Object.keys(fields).length) throw new Error(`${T}: nothing to change.`);
    const doReprocess = optBool(T, "reprocess", args.reprocess) ?? true;

    const { data: cur, error: ce } = await ctx.db.from("wb_rules").select(RULE_COLUMNS).eq("id", id).maybeSingle();
    if (ce) throw new Error(dbError(T, ce));
    if (!cur) throw new Error(`${T}: no rule ${id} that you can see. Nothing was changed.`);
    if (!hasAction({ ...(cur as unknown as Obj), ...fields })) {
      throw new Error(`${T}: a rule needs set_kind, set_merchant_id or add_tag_ids. Nothing was changed.`);
    }
    const before = doReprocess ? await idsMatchedBy(T, ctx.db, id) : [];

    const { data, error } = await ctx.db.from("wb_rules").update({ ...fields, context_id: MONEY_CONTEXT_ID })
      .eq("id", id).select(RULE_COLUMNS).maybeSingle();
    if (error) throw new Error(dbError(T, error));
    const rule = data as unknown as Obj;
    const after = doReprocess ? (await preview(T, ctx.db, rule.match as Obj, null, 0)).ids : [];
    const reprocessed = doReprocess ? await reprocess(T, ctx.db, [...before, ...after]) : null;
    const [described] = await describeRules(T, ctx.db, [rule]);
    return { rule: described, reprocessed };
  },
});

// ---------------------------------------------------------------------------
// get_wb_rule_preview — tier 1
// ---------------------------------------------------------------------------

export const getWbRulePreviewTool = defineTool({
  name: "get_wb_rule_preview",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_rule_preview";
    if (!absent(args.match)) {
      if (!absent(args.transaction_id)) throw new Error(`${T}: pass match, or transaction_id, not both.`);
      const match = parseMatch(T, args.match);
      const dry = await preview(T, ctx.db, match, null);
      const existing = match.merchant_id
        ? await describeRules(T, ctx.db, await rulesForMerchant(T, ctx.db, match.merchant_id as string)) : [];
      return {
        match, dry_run: { count: dry.count, too_narrow: dry.too_narrow, samples: dry.samples }, existing_rules: existing,
        ...(match.merchant_id ? {} : { warning: MERCHANT_FIRST }),
      };
    }
    const { ids: _ids, ...plan } = await fixPlan(T, ctx.db, fixArgs(T, args));
    return plan;
  },
});

// ---------------------------------------------------------------------------
// create_wb_rule_from_transaction — tier 3, with a proposal (spec §6.1)
// ---------------------------------------------------------------------------

/** The rule action of a fix. */
function fixAction(T: string, args: Obj) {
  const setKind = oneOf(T, "set_kind", args.set_kind, WB_KINDS);
  const tagIds = optIdList(T, "add_tag_ids", args.add_tag_ids, 20);
  if (!setKind && !tagIds.length) throw new Error(`${T}: say what the rule does: set_kind and/or add_tag_ids.`);
  return {
    setKind, tagIds,
    updateRuleId: optUuid(T, "update_rule_id", args.update_rule_id),
    addNew: optBool(T, "add_new_rule", args.add_new_rule) ?? false,
    notes: optText(T, "notes", args.notes),
  };
}

export const createWbRuleFromTransactionTool = defineTool({
  name: "create_wb_rule_from_transaction",
  tier: 3,
  propose: async (args: Obj, ctx) => {
    const T = "create_wb_rule_from_transaction";
    const action = fixAction(T, args);
    const { ids: _ids, ...plan } = await fixPlan(T, ctx.db, fixArgs(T, args));
    const steps = [
      plan.merchant.exists
        ? (plan.merchant.add_pattern ? `Add pattern "${plan.merchant.add_pattern}" to merchant ${plan.merchant.name}.` : `Use merchant ${plan.merchant.name}.`)
        : `Create merchant ${plan.merchant.name} with pattern "${plan.merchant.add_pattern}".`,
      action.updateRuleId ? `Update rule ${action.updateRuleId}.` : `Create a rule matching merchant ${plan.merchant.name}.`,
      [action.setKind ? `kind ${action.setKind}` : null, action.tagIds.length ? `${action.tagIds.length} tag(s)` : null]
        .filter(Boolean).join(", ") + `, on about ${plan.dry_run.count} past transaction(s), then reprocess them.`,
    ];
    return { ...plan, steps };
  },
  handler: async (args: Obj, ctx) => {
    const T = "create_wb_rule_from_transaction";
    const action = fixAction(T, args);
    const plan = await fixPlan(T, ctx.db, fixArgs(T, args));
    if (plan.existing_rules.length && !action.updateRuleId && !action.addNew) {
      throw new Error(`${T}: a rule already exists for ${plan.merchant.name} (${plan.existing_rules.map((r) => r.id).join(", ")}). Pass update_rule_id to update it, or add_new_rule: true. Nothing was changed.`);
    }

    // 1. The merchant: create it, or add the pattern.
    let merchantId = plan.merchant.id as string | null;
    if (!merchantId) {
      const { data, error } = await ctx.db.from("wb_merchants")
        .insert({ name: plan.merchant.name, match_patterns: [plan.merchant.add_pattern], context_id: MONEY_CONTEXT_ID })
        .select("id").single();
      if (error) throw new Error(dbError(T, error));
      merchantId = (data as Obj).id as string;
    } else if (plan.merchant.add_pattern) {
      const { data: m, error: me } = await ctx.db.from("wb_merchants").select("match_patterns").eq("id", merchantId).single();
      if (me) throw new Error(dbError(T, me));
      const patterns = [...new Set([...(((m as Obj).match_patterns as string[]) ?? []), plan.merchant.add_pattern as string])];
      const { error } = await ctx.db.from("wb_merchants").update({ match_patterns: patterns, context_id: MONEY_CONTEXT_ID }).eq("id", merchantId);
      if (error) throw new Error(dbError(T, error));
    }

    // 2. The rule, matching on the merchant.
    const match = { merchant_id: merchantId };
    const ruleFieldsOut: Obj = { match, ...(action.setKind ? { set_kind: action.setKind } : {}),
      ...(action.tagIds.length ? { add_tag_ids: action.tagIds } : {}), ...(action.notes ? { notes: action.notes } : {}) };
    let rule: Obj;
    const before = action.updateRuleId ? await idsMatchedBy(T, ctx.db, action.updateRuleId) : [];
    if (action.updateRuleId) {
      const { data, error } = await ctx.db.from("wb_rules").update({ ...ruleFieldsOut, context_id: MONEY_CONTEXT_ID })
        .eq("id", action.updateRuleId).select(RULE_COLUMNS).maybeSingle();
      if (error) throw new Error(dbError(T, error));
      if (!data) throw new Error(`${T}: no rule ${action.updateRuleId} that you can see. The merchant step was kept; no rule was changed.`);
      rule = data as unknown as Obj;
    } else {
      const { data, error } = await ctx.db.from("wb_rules").insert({
        name: `${plan.merchant.name}`, priority: 100, ...ruleFieldsOut, created_by: "claude",
        created_from_transaction_id: plan.transaction.id, context_id: MONEY_CONTEXT_ID,
      }).select(RULE_COLUMNS).single();
      if (error) throw new Error(dbError(T, error));
      rule = data as unknown as Obj;
    }

    // 3. Reprocess everything the merchant and the rule now touch.
    const { data: own, error: oe } = await ctx.db.from("wb_transactions").select("id").eq("merchant_id", merchantId).limit(5000);
    if (oe) throw new Error(dbError(T, oe));
    const reprocessed = await reprocess(T, ctx.db, [
      plan.transaction.id as string, ...plan.ids, ...before, ...((own ?? []) as Obj[]).map((r) => r.id as string),
    ]);
    const after = await preview(T, ctx.db, match, null, 0);
    const [described] = await describeRules(T, ctx.db, [rule]);
    return { merchant_id: merchantId, rule: described, matched_now: after.count, reprocessed };
  },
});

// ---------------------------------------------------------------------------
// tag_wb_transactions — tier 2, at most 25 transactions
// ---------------------------------------------------------------------------

export const tagWbTransactionsTool = defineTool({
  name: "tag_wb_transactions",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "tag_wb_transactions";
    const ids = idList(T, "transaction_ids", args.transaction_ids, MAX_TAG_ROWS);
    const tagIds = optIdList(T, "tag_ids", args.tag_ids, 20);
    const removeIds = optIdList(T, "remove_tag_ids", args.remove_tag_ids, 20);
    if (!tagIds.length && !removeIds.length) throw new Error(`${T}: pass tag_ids and/or remove_tag_ids.`);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    const { data, error } = await ctx.db.rpc("wb_apply_tags", {
      p_transaction_ids: ids, p_tag_ids: tagIds, p_source: source, p_remove_tag_ids: removeIds,
    });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// set_wb_transaction_kind — tier 2
// ---------------------------------------------------------------------------

export const setWbTransactionKindTool = defineTool({
  name: "set_wb_transaction_kind",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "set_wb_transaction_kind";
    const ids = idList(T, "transaction_ids", args.transaction_ids, MAX_TAG_ROWS);
    const kind = oneOf(T, "kind", args.kind, WB_KINDS);
    const setMerchant = args.merchant_id !== undefined;
    const merchantId = setMerchant ? optUuid(T, "merchant_id", args.merchant_id) : null;
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    const pairWith = optUuid(T, "pair_with", args.pair_with);
    const unpair = optBool(T, "unpair", args.unpair) ?? false;
    if (!kind && !setMerchant && !pairWith && !unpair) throw new Error(`${T}: pass kind, merchant_id, pair_with or unpair.`);
    if (pairWith && (ids.length !== 1 || kind || unpair)) {
      throw new Error(`${T}: pair_with takes exactly one transaction and no kind or unpair. Nothing was changed.`);
    }

    const touched = new Set(ids);
    if (pairWith) {
      const { error } = await ctx.db.rpc("wb_set_transfer_pair", { p_id: ids[0], p_pair_with: pairWith, p_source: source });
      if (error) throw new Error(dbError(T, error));
      touched.add(pairWith);
    }
    if (unpair) {
      for (const id of ids) {
        const { data, error } = await ctx.db.rpc("wb_set_transfer_pair", { p_id: id, p_pair_with: null, p_source: source });
        if (error) throw new Error(dbError(T, error));
        for (const x of ((data as Obj)?.unpaired as string[]) ?? []) touched.add(x);
      }
    }
    if (kind) {
      const { data: rows, error: re } = await ctx.db.from("wb_transactions").select("id, transfer_pair_id").in("id", ids);
      if (re) throw new Error(dbError(T, re));
      const paired = ((rows ?? []) as Obj[]).filter((r) => r.transfer_pair_id).map((r) => r.id);
      if (kind !== "transfer" && paired.length) {
        throw new Error(`${T}: ${paired.join(", ")} ${paired.length > 1 ? "are" : "is"} paired as a transfer; pass unpair: true to change the kind.`);
      }
      const { error } = await ctx.db.from("wb_transactions").update({ kind, kind_source: source }).in("id", ids);
      if (error) throw new Error(dbError(T, error));
    }
    if (setMerchant) {
      const { error } = await ctx.db.from("wb_transactions").update({ merchant_id: merchantId, merchant_source: source }).in("id", ids);
      if (error) throw new Error(dbError(T, error));
    }

    const reprocessed = await reprocess(T, ctx.db, [...touched]);
    const { data, error } = await ctx.db.from("wb_transaction_list").select(LIST_COLUMNS).in("id", [...touched]);
    if (error) throw new Error(dbError(T, error));
    return { transactions: data ?? [], reprocessed };
  },
});

// ---------------------------------------------------------------------------
// split_wb_transaction — tier 2
// ---------------------------------------------------------------------------

export const splitWbTransactionTool = defineTool({
  name: "split_wb_transaction",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "split_wb_transaction";
    const id = uuidOf(T, "transaction_id", args.transaction_id);
    const source = oneOf(T, "source", args.source, HAND_SOURCES) ?? "claude";
    if (!Array.isArray(args.splits) || args.splits.length === 0 || args.splits.length > MAX_SPLITS) {
      throw new Error(`${T}: splits must be a list of 1 to ${MAX_SPLITS} parts.`);
    }
    const splits = (args.splits as unknown[]).map((s, i) => {
      if (!s || typeof s !== "object") throw new Error(`${T}: split ${i + 1} must be an object.`);
      const o = s as Obj;
      const amount = parseMoney(T, `splits[${i}].amount`, o.amount);
      if (amount === null) throw new Error(`${T}: split ${i + 1} needs an amount (signed, like the transaction).`);
      return {
        amount,
        description: optText(T, `splits[${i}].description`, o.description),
        tax_year: optInt(T, `splits[${i}].tax_year`, o.tax_year, 2000, 2100),
        notes: optText(T, `splits[${i}].notes`, o.notes),
        tag_ids: optIdList(T, `splits[${i}].tag_ids`, o.tag_ids, 20),
      };
    });
    const { data, error } = await ctx.db.rpc("wb_replace_splits", { p_transaction_id: id, p_splits: splits, p_source: source });
    if (error) throw new Error(dbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// mark_wb_reviewed — tier 2
// ---------------------------------------------------------------------------

export const markWbReviewedTool = defineTool({
  name: "mark_wb_reviewed",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "mark_wb_reviewed";
    const ids = idList(T, "transaction_ids", args.transaction_ids, MAX_REVIEW_ROWS);
    const reviewed = optBool(T, "reviewed", args.reviewed) ?? true;
    const { data, error } = await ctx.db.from("wb_transactions").update({ reviewed }).in("id", ids).select("id");
    if (error) throw new Error(dbError(T, error));
    const updated = ((data ?? []) as Obj[]).map((r) => r.id);
    return { reviewed, updated: updated.length, not_found: ids.filter((id) => !updated.includes(id)) };
  },
});

// ---------------------------------------------------------------------------
// reprocess_wb_transactions — tier 2
// ---------------------------------------------------------------------------

export const reprocessWbTransactionsTool = defineTool({
  name: "reprocess_wb_transactions",
  tier: 2,
  handler: async (args: Obj, ctx) => {
    const T = "reprocess_wb_transactions";
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    let ids: string[];
    if (!absent(args.transaction_ids)) {
      if (from || to) throw new Error(`${T}: pass transaction_ids, or from/to, not both.`);
      ids = idList(T, "transaction_ids", args.transaction_ids, MAX_REPROCESS);
    } else {
      if (!from && !to) throw new Error(`${T}: pass transaction_ids, or a from/to range of posted dates.`);
      let q = ctx.db.from("wb_transactions").select("id", { count: "exact" });
      if (from) q = q.gte("posted_at", pacificMidnight(from));
      if (to) q = q.lt("posted_at", pacificMidnight(nextDay(to)));
      const { data, error, count } = await q.order("posted_at").limit(MAX_REPROCESS);
      if (error) throw new Error(dbError(T, error));
      if ((count ?? 0) > MAX_REPROCESS) {
        throw new Error(`${T}: ${count} transactions in that range; at most ${MAX_REPROCESS} per call. Narrow it. Nothing was changed.`);
      }
      ids = ((data ?? []) as Obj[]).map((r) => r.id as string);
    }
    return { requested: ids.length, ...(await reprocess(T, ctx.db, ids)) };
  },
});

// ---------------------------------------------------------------------------
// get_wb_spending — tier 1
// ---------------------------------------------------------------------------

export const getWbSpendingTool = defineTool({
  name: "get_wb_spending",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_spending";
    const fromMonth = parseMonth(T, "from_month", args.from_month);
    const toMonth = parseMonth(T, "to_month", args.to_month);
    checkRange(T, fromMonth, toMonth, "from_month", "to_month");
    const group = optText(T, "group", args.group) ?? "Category";
    const level = oneOf(T, "level", args.level, SPENDING_LEVELS) ?? "top";
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_spending_by_tag")
      .select("month, group_name, level, tag_id, tag_name, amount, splits", { count: "exact" })
      .ilike("group_name", escapeLike(group)).eq("level", level);
    if (fromMonth) q = q.gte("month", fromMonth);
    if (toMonth) q = q.lte("month", toMonth);
    const { data, error, count } = await q.order("month", { ascending: false }).order("amount").limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_cash_flow — tier 1
// ---------------------------------------------------------------------------

export const getWbCashFlowTool = defineTool({
  name: "get_wb_cash_flow",
  tier: 1,
  handler: async (args: Obj, ctx) => {
    const T = "get_wb_cash_flow";
    const fromMonth = parseMonth(T, "from_month", args.from_month);
    const toMonth = parseMonth(T, "to_month", args.to_month);
    checkRange(T, fromMonth, toMonth, "from_month", "to_month");
    const LIMIT = limitOf(T, args.limit);
    let q = ctx.db.from("wb_cash_flow_monthly").select("month, income, spending, net, unprocessed", { count: "exact" });
    if (fromMonth) q = q.gte("month", fromMonth);
    if (toMonth) q = q.lte("month", toMonth);
    const { data, error, count } = await q.order("month", { ascending: false }).limit(LIMIT);
    if (error) throw new Error(dbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});
