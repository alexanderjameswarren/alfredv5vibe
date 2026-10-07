// ============================================================================
// supabase/functions/_shared/tools/warren-buffet.ts
//
// Warren Buffet Phase 1 tools. Spec: docs/technical-spec-warren_buffet-w7b.md §8.
//
//   get_wb_accounts          tier 1 — accounts with latest balance and staleness
//   get_wb_balance_history   tier 1 — one account's snapshots, or a role group's daily total
//   get_wb_net_worth         tier 1 — rows from wb_net_worth_daily
//   get_wb_transactions      tier 1 — raw transactions, never the raw jsonb
//   get_wb_holdings          tier 1 — holdings on the latest (or a given) day
//   update_wb_account        tier 2 — human columns only
//   create_wb_manual_account tier 1 — a manual account in the Money context
//   record_wb_balance        tier 2 — manual/import balance; never touches sync rows
//
// Sign rule everywhere: money in positive, money out negative.
// ============================================================================

import { clampLimit, defineTool, describeDbError, envelope } from "../platform.ts";

// The shared Money context (spec §2). Every write lands here.
export const MONEY_CONTEXT_ID = "muvitejhrgt3rgi8t6q";

export const WB_ROLES = [
  "unassigned", "spending_cash", "reserve_cash", "credit_card", "emergency_credit",
  "loan", "retirement", "taxable_investment", "rewards", "history_rollup", "closed",
] as const;
export const WB_OWNERS = ["alex", "elise", "joint"] as const;
export const WB_BALANCE_SOURCES = ["manual", "import"] as const;

// Role -> its column in wb_net_worth_daily.
export const ROLE_GROUP: Record<string, string> = {
  spending_cash: "spending_cash",
  reserve_cash: "reserve_cash",
  credit_card: "credit_owed",
  emergency_credit: "credit_owed",
  loan: "loans",
  retirement: "retirement",
  taxable_investment: "taxable_investments",
  rewards: "rewards",
  history_rollup: "history_rollup",
  closed: "closed",
  unassigned: "unassigned",
};

export const UPDATABLE_FIELDS = [
  "display_name", "owner", "role", "credit_limit", "reward_unit", "reward_value_per_unit",
  "expires_on", "active_from", "active_until", "is_hidden", "notes",
] as const;
export const SYNC_OWNED_FIELDS = [
  "source", "external_id", "institution", "name", "last4", "currency", "last_synced_at",
  "user_id", "context_id", "created_at", "updated_at",
] as const;

const ACCOUNT_COLUMNS =
  "id, source, institution, name, display_name, last4, owner, role, currency, credit_limit, " +
  "reward_unit, reward_value_per_unit, expires_on, active_from, active_until, is_hidden, " +
  "last_synced_at, notes, context_id, created_at, updated_at";
const LATEST_COLUMNS =
  "account_id, source, institution, label, display_name, name, last4, owner, role, currency, " +
  "credit_limit, reward_unit, reward_value_per_unit, expires_on, is_hidden, last_synced_at, " +
  "as_of, balance, available_balance, snapshot_source, staleness_days";
const SNAPSHOT_COLUMNS = "id, account_id, as_of, balance, available_balance, source, reported_at, notes";
const NET_WORTH_COLUMNS =
  "as_of, spending_cash, reserve_cash, credit_owed, loans, retirement, taxable_investments, " +
  "rewards, history_rollup, closed, unassigned, net_worth";
// No `raw`: the full SimpleFIN object stays out of every list read.
const TXN_COLUMNS =
  "id, account_id, posted_at, transacted_at, amount, description, payee, memo, mcc, pending, " +
  "first_seen_at, last_seen_at, account:wb_accounts(display_name, name)";
const HOLDING_COLUMNS =
  "account_id, as_of, symbol, description, shares, market_value, cost_basis, purchase_price, " +
  "currency, account:wb_accounts(display_name, name)";

// ---------------------------------------------------------------------------
// Validation helpers (shared by the handlers; none read args directly)
// ---------------------------------------------------------------------------

const absent = (v: unknown) => v === undefined || v === null;

export function requireId(T: string, key: string, v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${T}: ${key} is required.`);
  return v.trim();
}

function optText(T: string, key: string, v: unknown): string | null {
  if (absent(v)) return null;
  if (typeof v !== "string") throw new Error(`${T}: ${key} must be text.`);
  const s = v.trim();
  return s === "" ? null : s;
}

/** YYYY-MM-DD that is a real calendar date. */
export function parseDate(T: string, key: string, v: unknown): string | null {
  if (absent(v)) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    throw new Error(`${T}: ${key} must be a date as YYYY-MM-DD. Got ${JSON.stringify(v)}.`);
  }
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`${T}: ${key} ${s} is not a real date.`);
  }
  return s;
}

/** A dollar amount, rounded to cents. */
export function parseMoney(T: string, key: string, v: unknown): number | null {
  if (absent(v)) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) >= 1e12) {
    throw new Error(`${T}: ${key} must be a number (dollars). Got ${JSON.stringify(v)}.`);
  }
  return Math.round(v * 100) / 100;
}

function oneOf<T extends string>(T: string, key: string, v: unknown, allowed: readonly T[]): T | null {
  if (absent(v)) return null;
  if (!(allowed as readonly unknown[]).includes(v)) {
    throw new Error(`${T}: ${key} must be one of ${allowed.join(", ")}. Got ${JSON.stringify(v)}.`);
  }
  return v as T;
}

function optBool(T: string, key: string, v: unknown): boolean | null {
  if (absent(v)) return null;
  if (typeof v !== "boolean") throw new Error(`${T}: ${key} must be true or false.`);
  return v;
}

function rewardRate(T: string, v: unknown): number | null {
  if (absent(v)) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v >= 10000) {
    throw new Error(`${T}: reward_value_per_unit must be a non-negative number (dollars per unit).`);
  }
  return Math.round(v * 1e6) / 1e6;
}

function checkRange(T: string, a: string | null, b: string | null, aKey: string, bKey: string) {
  if (a && b && a > b) throw new Error(`${T}: ${aKey} ${a} is after ${bKey} ${b}. Nothing was changed.`);
}

/** Today's date in America/Los_Angeles, as YYYY-MM-DD. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Midnight Pacific at the start of `date`, as an ISO string with its offset. */
export function pacificMidnight(date: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "longOffset",
  }).formatToParts(noon).find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
  const offset = name.replace("GMT", "") || "+00:00";
  return `${date}T00:00:00${offset}`;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Text search term made safe for a PostgREST or() filter. */
export function searchTerm(T: string, v: unknown): string | null {
  if (absent(v)) return null;
  if (typeof v !== "string") throw new Error(`${T}: search must be text.`);
  const s = v.replace(/[,()*%\\:"]/g, " ").replace(/\s+/g, " ").trim();
  if (s === "") throw new Error(`${T}: search has no searchable characters.`);
  return s;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function limitOf(T: string, v: unknown): number {
  if (absent(v)) return clampLimit(undefined);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${T}: limit must be a positive whole number.`);
  }
  return clampLimit(v);
}

function listResult(rows: unknown[], count: number | null | undefined, LIMIT: number) {
  const total = count ?? rows.length;
  const truncated = total > rows.length;
  return envelope(rows, { count: total, limit_applied: LIMIT, truncated, ...(truncated ? { total } : {}) });
}

// ---------------------------------------------------------------------------
// get_wb_accounts — tier 1
// ---------------------------------------------------------------------------

export const getWbAccountsTool = defineTool({
  name: "get_wb_accounts",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_wb_accounts";
    const role = oneOf(T, "role", args.role, WB_ROLES);
    const owner = oneOf(T, "owner", args.owner, [...WB_OWNERS, "none"] as const);
    const includeHidden = optBool(T, "include_hidden", args.include_hidden) ?? false;
    const LIMIT = limitOf(T, args.limit);

    let q = ctx.db.from("wb_account_latest").select(LATEST_COLUMNS, { count: "exact" });
    if (role) q = q.eq("role", role);
    if (owner === "none") q = q.is("owner", null);
    else if (owner) q = q.eq("owner", owner);
    if (!includeHidden) q = q.eq("is_hidden", false);
    const { data, error, count } = await q.order("role").order("label").limit(LIMIT);
    if (error) throw new Error(describeDbError(T, error));
    const rows = (data ?? []) as unknown as Record<string, unknown>[];

    // Notes and the rollup window are not in the view; Claude reads notes first.
    if (rows.length) {
      const { data: extra, error: e2 } = await ctx.db
        .from("wb_accounts")
        .select("id, notes, active_from, active_until")
        .in("id", rows.map((r) => r.account_id));
      if (e2) throw new Error(describeDbError(T, e2));
      const byId = new Map(((extra ?? []) as Record<string, unknown>[]).map((r) => [r.id, r]));
      for (const r of rows) {
        const x = byId.get(r.account_id);
        r.notes = x?.notes ?? null;
        r.active_from = x?.active_from ?? null;
        r.active_until = x?.active_until ?? null;
      }
    }
    return listResult(rows, count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_balance_history — tier 1
// ---------------------------------------------------------------------------
// Account mode reads the snapshots themselves. Role mode reads the role's
// column in wb_net_worth_daily, so it carries balances forward exactly as the
// net worth does (credit_card and emergency_credit share credit_owed).

export const getWbBalanceHistoryTool = defineTool({
  name: "get_wb_balance_history",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_wb_balance_history";
    const accountId = absent(args.account_id) ? null : requireId(T, "account_id", args.account_id);
    const role = oneOf(T, "role", args.role, WB_ROLES);
    if (!!accountId === !!role) throw new Error(`${T}: pass exactly one of account_id or role.`);
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    const LIMIT = limitOf(T, args.limit);

    if (accountId) {
      let q = ctx.db.from("wb_balance_snapshots").select(SNAPSHOT_COLUMNS, { count: "exact" })
        .eq("account_id", accountId);
      if (from) q = q.gte("as_of", from);
      if (to) q = q.lte("as_of", to);
      const { data, error, count } = await q.order("as_of", { ascending: false }).limit(LIMIT);
      if (error) throw new Error(describeDbError(T, error));
      return listResult(data ?? [], count, LIMIT);
    }

    const col = ROLE_GROUP[role as string];
    let q = ctx.db.from("wb_net_worth_daily").select(`as_of, ${col}`, { count: "exact" });
    if (from) q = q.gte("as_of", from);
    if (to) q = q.lte("as_of", to);
    const { data, error, count } = await q.order("as_of", { ascending: false }).limit(LIMIT);
    if (error) throw new Error(describeDbError(T, error));
    const rows = ((data ?? []) as unknown as Record<string, unknown>[])
      .map((r) => ({ as_of: r.as_of, role_group: col, total: r[col] }));
    return listResult(rows, count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_net_worth — tier 1
// ---------------------------------------------------------------------------

export const getWbNetWorthTool = defineTool({
  name: "get_wb_net_worth",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_wb_net_worth";
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    const LIMIT = limitOf(T, args.limit);

    let q = ctx.db.from("wb_net_worth_daily").select(NET_WORTH_COLUMNS, { count: "exact" });
    if (from) q = q.gte("as_of", from);
    if (to) q = q.lte("as_of", to);
    const { data, error, count } = await q.order("as_of", { ascending: false }).limit(LIMIT);
    if (error) throw new Error(describeDbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_transactions — tier 1
// ---------------------------------------------------------------------------

export const getWbTransactionsTool = defineTool({
  name: "get_wb_transactions",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_wb_transactions";
    const accountId = absent(args.account_id) ? null : requireId(T, "account_id", args.account_id);
    const from = parseDate(T, "from", args.from);
    const to = parseDate(T, "to", args.to);
    checkRange(T, from, to, "from", "to");
    const search = searchTerm(T, args.search);
    const min = parseMoney(T, "min_amount", args.min_amount);
    const max = parseMoney(T, "max_amount", args.max_amount);
    if (min !== null && max !== null && min > max) {
      throw new Error(`${T}: min_amount ${min} is greater than max_amount ${max}.`);
    }
    const pending = optBool(T, "pending", args.pending);
    const LIMIT = limitOf(T, args.limit);

    let q = ctx.db.from("wb_transactions").select(TXN_COLUMNS, { count: "exact" });
    if (accountId) q = q.eq("account_id", accountId);
    if (from) q = q.gte("posted_at", pacificMidnight(from));
    if (to) q = q.lt("posted_at", pacificMidnight(nextDay(to)));
    if (search) q = q.or(`description.ilike.*${search}*,payee.ilike.*${search}*`);
    if (min !== null) q = q.gte("amount", min);
    if (max !== null) q = q.lte("amount", max);
    if (pending !== null) q = q.eq("pending", pending);
    const { data, error, count } = await q
      .order("posted_at", { ascending: false, nullsFirst: true })
      .order("transacted_at", { ascending: false })
      .limit(LIMIT);
    if (error) throw new Error(describeDbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// get_wb_holdings — tier 1
// ---------------------------------------------------------------------------
// The sync writes every account's holdings together, so "latest" is the most
// recent day with any holdings (for one account, that account's latest day).

export const getWbHoldingsTool = defineTool({
  name: "get_wb_holdings",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "get_wb_holdings";
    const accountId = absent(args.account_id) ? null : requireId(T, "account_id", args.account_id);
    let asOf = parseDate(T, "as_of", args.as_of);
    const LIMIT = limitOf(T, args.limit);

    if (!asOf) {
      let lq = ctx.db.from("wb_holding_snapshots").select("as_of");
      if (accountId) lq = lq.eq("account_id", accountId);
      const { data: latest, error: le } = await lq.order("as_of", { ascending: false }).limit(1).maybeSingle();
      if (le) throw new Error(describeDbError(T, le));
      if (!latest) return listResult([], 0, LIMIT);
      asOf = (latest as { as_of: string }).as_of;
    }

    let q = ctx.db.from("wb_holding_snapshots").select(HOLDING_COLUMNS, { count: "exact" }).eq("as_of", asOf);
    if (accountId) q = q.eq("account_id", accountId);
    const { data, error, count } = await q
      .order("market_value", { ascending: false, nullsFirst: false })
      .limit(LIMIT);
    if (error) throw new Error(describeDbError(T, error));
    return listResult(data ?? [], count, LIMIT);
  },
});

// ---------------------------------------------------------------------------
// update_wb_account — tier 2
// ---------------------------------------------------------------------------
// Human columns only. Anything the sync owns is refused by name. Pass null to
// clear a nullable field.

const UPDATE_KEYS = new Set<string>(["id", ...UPDATABLE_FIELDS]);

export const updateWbAccountTool = defineTool({
  name: "update_wb_account",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "update_wb_account";
    const unknown = Object.keys(args).filter((k) => !UPDATE_KEYS.has(k));
    if (unknown.length) {
      const synced = unknown.filter((k) => (SYNC_OWNED_FIELDS as readonly string[]).includes(k));
      throw new Error(
        synced.length
          ? `${T}: ${synced.join(", ")} ${synced.length > 1 ? "are" : "is"} owned by the sync and cannot be edited. Editable: ${UPDATABLE_FIELDS.join(", ")}. Nothing was changed.`
          : `${T}: unknown field(s) ${unknown.join(", ")}. Editable: ${UPDATABLE_FIELDS.join(", ")}. Nothing was changed.`,
      );
    }
    const id = requireId(T, "id", args.id);

    const patch: Record<string, unknown> = {};
    if (args.display_name !== undefined) patch.display_name = optText(T, "display_name", args.display_name);
    if (args.owner !== undefined) patch.owner = oneOf(T, "owner", args.owner, WB_OWNERS);
    if (args.role !== undefined) {
      if (args.role === null) throw new Error(`${T}: role cannot be cleared; set it to unassigned instead.`);
      patch.role = oneOf(T, "role", args.role, WB_ROLES);
    }
    if (args.credit_limit !== undefined) patch.credit_limit = parseMoney(T, "credit_limit", args.credit_limit);
    if (args.reward_unit !== undefined) patch.reward_unit = optText(T, "reward_unit", args.reward_unit);
    if (args.reward_value_per_unit !== undefined) patch.reward_value_per_unit = rewardRate(T, args.reward_value_per_unit);
    if (args.expires_on !== undefined) patch.expires_on = parseDate(T, "expires_on", args.expires_on);
    if (args.active_from !== undefined) patch.active_from = parseDate(T, "active_from", args.active_from);
    if (args.active_until !== undefined) patch.active_until = parseDate(T, "active_until", args.active_until);
    if (args.is_hidden !== undefined) {
      const hidden = optBool(T, "is_hidden", args.is_hidden);
      if (hidden === null) throw new Error(`${T}: is_hidden must be true or false.`);
      patch.is_hidden = hidden;
    }
    if (args.notes !== undefined) patch.notes = optText(T, "notes", args.notes);
    if (Object.keys(patch).length === 0) {
      throw new Error(`${T}: nothing to change. Pass at least one of ${UPDATABLE_FIELDS.join(", ")}.`);
    }

    const { data: current, error: readError } = await ctx.db
      .from("wb_accounts").select("id, active_from, active_until").eq("id", id).maybeSingle();
    if (readError) throw new Error(describeDbError(T, readError));
    if (!current) throw new Error(`${T}: no account ${id} that you can see. Nothing was changed.`);
    const cur = current as { active_from: string | null; active_until: string | null };
    checkRange(
      T,
      "active_from" in patch ? patch.active_from as string | null : cur.active_from,
      "active_until" in patch ? patch.active_until as string | null : cur.active_until,
      "active_from", "active_until",
    );

    patch.context_id = MONEY_CONTEXT_ID;
    const { data, error } = await ctx.db
      .from("wb_accounts").update(patch).eq("id", id).select(ACCOUNT_COLUMNS).maybeSingle();
    if (error) throw new Error(describeDbError(T, error));
    if (!data) throw new Error(`${T}: account ${id} could not be updated. Nothing was changed.`);
    return data;
  },
});

// ---------------------------------------------------------------------------
// create_wb_manual_account — tier 1
// ---------------------------------------------------------------------------

export const createWbManualAccountTool = defineTool({
  name: "create_wb_manual_account",
  tier: 1,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "create_wb_manual_account";
    const name = optText(T, "name", args.name);
    if (!name) throw new Error(`${T}: name is required.`);
    const last4 = optText(T, "last4", args.last4);
    if (last4 && !/^\d{4}$/.test(last4)) throw new Error(`${T}: last4 must be exactly four digits, or omitted.`);
    const currency = optText(T, "currency", args.currency)?.toUpperCase() ?? "USD";
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${T}: currency must be a three-letter code such as USD.`);
    const activeFrom = parseDate(T, "active_from", args.active_from);
    const activeUntil = parseDate(T, "active_until", args.active_until);
    checkRange(T, activeFrom, activeUntil, "active_from", "active_until");

    const row = {
      source: "manual",
      external_id: null,
      context_id: MONEY_CONTEXT_ID,
      name,
      institution: optText(T, "institution", args.institution),
      display_name: optText(T, "display_name", args.display_name),
      last4,
      owner: oneOf(T, "owner", args.owner, WB_OWNERS),
      role: oneOf(T, "role", args.role, WB_ROLES) ?? "unassigned",
      currency,
      credit_limit: parseMoney(T, "credit_limit", args.credit_limit),
      reward_unit: optText(T, "reward_unit", args.reward_unit),
      reward_value_per_unit: rewardRate(T, args.reward_value_per_unit),
      expires_on: parseDate(T, "expires_on", args.expires_on),
      active_from: activeFrom,
      active_until: activeUntil,
      is_hidden: optBool(T, "is_hidden", args.is_hidden) ?? false,
      notes: optText(T, "notes", args.notes),
    };

    const { data: dupe, error: dupeError } = await ctx.db
      .from("wb_accounts").select("id, name").eq("source", "manual")
      .ilike("name", escapeLike(name)).limit(1).maybeSingle();
    if (dupeError) throw new Error(describeDbError(T, dupeError));
    if (dupe) {
      throw new Error(
        `${T}: a manual account named ${JSON.stringify((dupe as { name: string }).name)} already exists ` +
          `(id ${(dupe as { id: string }).id}). Use update_wb_account to change it. Nothing was created.`,
      );
    }

    const { data, error } = await ctx.db.from("wb_accounts").insert(row).select(ACCOUNT_COLUMNS).single();
    if (error) throw new Error(describeDbError(T, error));
    return data;
  },
});

// ---------------------------------------------------------------------------
// record_wb_balance — tier 2
// ---------------------------------------------------------------------------
// Manual accounts only. Inserts the day, or replaces that day's manual/import
// row in full. A sync row is never touched. Tier 2 because it can replace.

export const recordWbBalanceTool = defineTool({
  name: "record_wb_balance",
  tier: 2,
  handler: async (args: Record<string, unknown>, ctx) => {
    const T = "record_wb_balance";
    const accountId = requireId(T, "account_id", args.account_id);
    const asOf = parseDate(T, "as_of", args.as_of) ?? pacificToday();
    if (asOf > pacificToday()) throw new Error(`${T}: as_of ${asOf} is in the future. Nothing was recorded.`);
    const balance = parseMoney(T, "balance", args.balance);
    if (balance === null) throw new Error(`${T}: balance is required (dollars; debts are negative).`);
    const available = parseMoney(T, "available_balance", args.available_balance);
    const source = oneOf(T, "source", args.source, WB_BALANCE_SOURCES) ?? "manual";
    const notes = optText(T, "notes", args.notes);

    const { data: account, error: ae } = await ctx.db
      .from("wb_accounts").select("id, source, name, display_name").eq("id", accountId).maybeSingle();
    if (ae) throw new Error(describeDbError(T, ae));
    if (!account) throw new Error(`${T}: no account ${accountId} that you can see. Nothing was recorded.`);
    const acct = account as { source: string; name: string; display_name: string | null };
    if (acct.source !== "manual") {
      throw new Error(
        `${T}: ${JSON.stringify(acct.display_name ?? acct.name)} is synced from SimpleFIN; its balances come ` +
          `from the sync. record_wb_balance works on manual accounts only. Nothing was recorded.`,
      );
    }

    const { data: existing, error: ee } = await ctx.db
      .from("wb_balance_snapshots").select("id, source").eq("account_id", accountId).eq("as_of", asOf).maybeSingle();
    if (ee) throw new Error(describeDbError(T, ee));
    const prior = existing as { id: string; source: string } | null;
    if (prior?.source === "sync") {
      throw new Error(`${T}: the ${asOf} balance for this account came from the sync and is never replaced. Nothing was recorded.`);
    }

    const fields = { balance, available_balance: available, source, notes, context_id: MONEY_CONTEXT_ID };
    const write = prior
      ? ctx.db.from("wb_balance_snapshots").update(fields).eq("id", prior.id).select(SNAPSHOT_COLUMNS).maybeSingle()
      : ctx.db.from("wb_balance_snapshots").insert({ ...fields, account_id: accountId, as_of: asOf })
        .select(SNAPSHOT_COLUMNS).single();
    const { data, error } = await write;
    if (error) throw new Error(describeDbError(T, error));
    if (!data) throw new Error(`${T}: the ${asOf} balance could not be written. Nothing was recorded.`);
    return { ...(data as Record<string, unknown>), replaced: prior ? prior.source : null };
  },
});
