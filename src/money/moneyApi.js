import { supabase } from "../supabaseClient";
import { pacificToday } from "./moneyFormat";

/**
 * Warren Buffet persistence for the Money section. Spec:
 * docs/technical-spec-warren_buffet-w7b.md §9.
 *
 * Straight to PostgREST under RLS (owner OR shared Money context), so Alex and
 * Elise read the same rows. The write rules mirror the MCP tools in
 * supabase/functions/_shared/tools/warren-buffet.ts: human columns only, the
 * Money context on every write, balances on manual accounts only, and a sync
 * row is never replaced. `raw` is never selected.
 */

export const MONEY_CONTEXT_ID = "muvitejhrgt3rgi8t6q";

export const UPDATABLE_FIELDS = [
  "display_name", "owner", "role", "credit_limit", "reward_unit", "reward_value_per_unit",
  "expires_on", "active_from", "active_until", "is_hidden", "notes",
];

const LATEST_COLUMNS =
  "account_id, source, institution, label, display_name, name, last4, owner, role, currency, " +
  "credit_limit, reward_unit, reward_value_per_unit, expires_on, is_hidden, last_synced_at, " +
  "as_of, balance, available_balance, snapshot_source, staleness_days";
const ACCOUNT_COLUMNS =
  "id, source, institution, name, display_name, last4, owner, role, currency, credit_limit, " +
  "reward_unit, reward_value_per_unit, expires_on, active_from, active_until, is_hidden, " +
  "last_synced_at, notes";
const NET_WORTH_COLUMNS =
  "as_of, spending_cash, reserve_cash, credit_owed, loans, retirement, taxable_investments, " +
  "rewards, history_rollup, closed, unassigned, net_worth";
const TXN_COLUMNS = "id, posted_at, transacted_at, amount, description, payee, memo, pending";
const HOLDING_COLUMNS = "id, as_of, symbol, description, shares, market_value, cost_basis, purchase_price";

function fail(what, error) {
  throw new Error(`${what}: ${error.message}`);
}

/** Every account with its latest balance and staleness. */
export async function getAccounts() {
  const { data, error } = await supabase.from("wb_account_latest").select(LATEST_COLUMNS).limit(500);
  if (error) fail("Failed to read accounts", error);
  return data || [];
}

/** One account's own row merged with its latest balance; null if not visible. */
export async function getAccount(id) {
  const [{ data: row, error }, { data: latest, error: e2 }] = await Promise.all([
    supabase.from("wb_accounts").select(ACCOUNT_COLUMNS).eq("id", id).maybeSingle(),
    supabase.from("wb_account_latest").select("as_of, balance, available_balance, staleness_days")
      .eq("account_id", id).maybeSingle(),
  ]);
  if (error) fail("Failed to read the account", error);
  if (e2) fail("Failed to read the account balance", e2);
  return row ? { ...row, ...(latest || {}) } : null;
}

/** Net worth rows, oldest first, from `from` (YYYY-MM-DD) or all. */
export async function getNetWorth({ from = null } = {}) {
  let q = supabase.from("wb_net_worth_daily").select(NET_WORTH_COLUMNS);
  if (from) q = q.gte("as_of", from);
  const { data, error } = await q.order("as_of", { ascending: true }).limit(5000);
  if (error) fail("Failed to read net worth", error);
  return data || [];
}

/** The newest net worth row, or null. */
export async function getLatestNetWorth() {
  const { data, error } = await supabase.from("wb_net_worth_daily").select(NET_WORTH_COLUMNS)
    .order("as_of", { ascending: false }).limit(1).maybeSingle();
  if (error) fail("Failed to read net worth", error);
  return data || null;
}

/** The newest wb-sync run. platform_runs is owner-only, so Elise gets null. */
export async function getLatestSyncRun() {
  const { data, error } = await supabase.from("platform_runs")
    .select("status, started_at, finished_at, error_message")
    .eq("app", "warren_buffet").eq("job", "wb-sync")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) return null;
  return data || null;
}

export async function getBalanceHistory(accountId, { from = null } = {}) {
  let q = supabase.from("wb_balance_snapshots").select("as_of, balance, source").eq("account_id", accountId);
  if (from) q = q.gte("as_of", from);
  const { data, error } = await q.order("as_of", { ascending: true }).limit(2000);
  if (error) fail("Failed to read balance history", error);
  return data || [];
}

/** Recent transactions, newest first; pending ones without a posted date first. */
export async function getTransactions(accountId, { limit = 50 } = {}) {
  const { data, error } = await supabase.from("wb_transactions").select(TXN_COLUMNS)
    .eq("account_id", accountId)
    .order("posted_at", { ascending: false, nullsFirst: true })
    .order("transacted_at", { ascending: false })
    .limit(limit);
  if (error) fail("Failed to read transactions", error);
  return data || [];
}

/** Holdings on the account's most recent holdings day. */
export async function getHoldings(accountId) {
  const { data: latest, error } = await supabase.from("wb_holding_snapshots").select("as_of")
    .eq("account_id", accountId).order("as_of", { ascending: false }).limit(1).maybeSingle();
  if (error) fail("Failed to read holdings", error);
  if (!latest) return [];
  const { data, error: e2 } = await supabase.from("wb_holding_snapshots").select(HOLDING_COLUMNS)
    .eq("account_id", accountId).eq("as_of", latest.as_of)
    .order("market_value", { ascending: false, nullsFirst: false }).limit(200);
  if (e2) fail("Failed to read holdings", e2);
  return data || [];
}

/** Edit human columns. Anything else in `patch` is refused. */
export async function updateAccount(id, patch) {
  const bad = Object.keys(patch).filter((k) => !UPDATABLE_FIELDS.includes(k));
  if (bad.length) throw new Error(`These fields cannot be edited here: ${bad.join(", ")}`);
  if (patch.active_from && patch.active_until && patch.active_from > patch.active_until) {
    throw new Error("Active from is after active until.");
  }
  const { data, error } = await supabase.from("wb_accounts")
    .update({ ...patch, context_id: MONEY_CONTEXT_ID }).eq("id", id).select(ACCOUNT_COLUMNS);
  if (error) fail("Failed to save the account", error);
  if (!data || data.length === 0) throw new Error("The account could not be saved.");
  return data[0];
}

/** A manual account in the Money context. Refuses a duplicate name. */
export async function createManualAccount(fields) {
  const name = (fields.name || "").trim();
  if (!name) throw new Error("A name is required.");
  const { data: dupes, error: de } = await supabase.from("wb_accounts").select("id")
    .eq("source", "manual").ilike("name", name.replace(/[\\%_]/g, (c) => `\\${c}`)).limit(1);
  if (de) fail("Failed to check for a duplicate", de);
  if (dupes && dupes.length) throw new Error(`A manual account named "${name}" already exists.`);

  const row = { role: "unassigned", is_hidden: false };
  for (const k of UPDATABLE_FIELDS) if (fields[k] !== undefined) row[k] = fields[k];
  if (row.active_from && row.active_until && row.active_from > row.active_until) {
    throw new Error("Active from is after active until.");
  }
  if (fields.institution) row.institution = fields.institution;
  const { data, error } = await supabase.from("wb_accounts")
    .insert({ ...row, name, source: "manual", external_id: null, context_id: MONEY_CONTEXT_ID })
    .select(ACCOUNT_COLUMNS);
  if (error) fail("Failed to create the account", error);
  return data[0];
}

/**
 * Record a balance on a manual account. Inserts the date, or replaces that
 * date's manual/import row in full. A sync row or a synced account is refused.
 */
export async function recordBalance(account, { asOf, balance, availableBalance = null, source = "manual", notes = null }) {
  if (account.source !== "manual") throw new Error("Balances for synced accounts come from the sync.");
  if (typeof balance !== "number" || !Number.isFinite(balance)) throw new Error("Enter a balance.");
  if (!asOf) throw new Error("Choose a date.");
  if (asOf > pacificToday()) throw new Error("The date is in the future.");
  if (!["manual", "import"].includes(source)) throw new Error("Source must be manual or import.");

  const { data: existing, error: ee } = await supabase.from("wb_balance_snapshots").select("id, source")
    .eq("account_id", account.id).eq("as_of", asOf).maybeSingle();
  if (ee) fail("Failed to check that date", ee);
  if (existing?.source === "sync") throw new Error("That date's balance came from the sync and is not replaced.");

  const fields = { balance, available_balance: availableBalance, source, notes, context_id: MONEY_CONTEXT_ID };
  const { data, error } = existing
    ? await supabase.from("wb_balance_snapshots").update(fields).eq("id", existing.id).select("id")
    : await supabase.from("wb_balance_snapshots").insert({ ...fields, account_id: account.id, as_of: asOf }).select("id");
  if (error) fail("Failed to record the balance", error);
  if (!data || data.length === 0) throw new Error("The balance could not be recorded.");
  return { replaced: existing ? existing.source : null };
}
