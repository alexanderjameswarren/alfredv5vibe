import { supabase } from "../supabaseClient";
import { daysBefore, pacificToday } from "./moneyFormat";

/**
 * Warren Buffet persistence for the Money section. Spec:
 * docs/history/technical-spec-warren_buffet-w7b.md §9 (Phase 1) and
 * docs/technical-spec-warren_buffet_p2-m4t.md §6.1 and §7 (Phase 2).
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
const TXN_COLUMNS =
  "id, posted_at, transacted_at, txn_date, amount, description, clean_description, payee, pending, kind, merchant_name";
const HOLDING_COLUMNS = "id, as_of, symbol, description, shares, market_value, cost_basis, purchase_price";
const LIST_COLUMNS =
  "id, account_id, account_label, posted_at, transacted_at, txn_date, amount, description, clean_description, payee, " +
  "pending, merchant_id, merchant_name, merchant_source, kind, kind_source, transfer_pair_id, transfer_candidate, " +
  "reviewed, tag_names, split_count, needs_review, excluded_tags, notes";
const QUEUE_COLUMNS =
  "reason, detail, transaction_id, account_label, txn_date, amount, clean_description, payee, merchant_name, kind, tag_names";

// Database refusals people can act on, in plain words. Anything else becomes a
// generic sentence; the raw message goes to the console only, never the screen.
const KNOWN_ERRORS = [
  [/splits sum to|split\(s\) of transaction .* sum to/, "The split amounts must add up to the transaction amount."],
  [/two tags from one exclusive group|wb_split_tags_one_per_exclusive_group/, "A part can carry only one tag from that group."],
  [/both rows are on the same account/, "A transfer pairs two different accounts."],
  [/one row out \(negative\) and one in \(positive\)/, "A transfer needs one row going out and one coming in."],
  [/already paired with another/, "One of them is already paired; unpair it first."],
  [/rule already exists/, "This merchant already has a rule: update it or add another."],
  [/at least 3 characters/, "The match pattern needs at least 3 characters."],
  [/no distinctive word/, "There is no distinctive word to match on: type a pattern."],
  [/say what the rule does/, "Choose a kind or at least one tag for the rule."],
  [/wb_subscription_prices_amount_check/, "A price must be more than zero."],
  [/that you can see|not found/, "That record no longer exists, or you can't see it."],
  [/jwt|permission denied|row-level security/i, "You're signed out or not allowed to change this. Sign in again."],
  [/failed to fetch|networkerror|network request/i, "Couldn't reach the server. Check the connection and try again."],
];

/** A database error as a plain sentence for the screen. */
export function plainError(what, error) {
  const text = `${error?.message ?? ""} ${error?.details ?? ""}`;
  const known = KNOWN_ERRORS.find(([re]) => re.test(text));
  if (!known) console.warn(`[money] ${what}:`, error?.message); // eslint-disable-line no-console
  return new Error(known ? known[1] : `${what}. Please try again.`);
}

function fail(what, error) {
  throw plainError(what, error);
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
  const { data, error } = await supabase.from("wb_transaction_list").select(TXN_COLUMNS)
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

// ===========================================================================
// Phase 2: transactions, tags, splits, review, spending, "always do this".
// Multi-row writes go through the database functions (one transaction each),
// the same ones the MCP tools call. Hand edits carry source "manual".
// ===========================================================================

export const PAGE_SIZE = 50;

/** Text for a PostgREST or() filter: its syntax characters removed. */
export function searchText(text) {
  const s = String(text || "").replace(/[,()*%\\:"]/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

/**
 * One page of wb_transaction_list, newest first.
 * filters: accountId, month ("YYYY-MM"), kind, tag (a tag name), text, needsReview.
 */
export async function listTransactions(filters = {}, { offset = 0, limit = PAGE_SIZE } = {}) {
  let q = supabase.from("wb_transaction_list").select(LIST_COLUMNS, { count: "exact" });
  if (filters.accountId) q = q.eq("account_id", filters.accountId);
  if (filters.month) {
    const [y, m] = filters.month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    q = q.gte("txn_date", `${filters.month}-01`).lte("txn_date", `${filters.month}-${String(last).padStart(2, "0")}`);
  }
  if (filters.kind) q = q.eq("kind", filters.kind);
  if (filters.tag) q = q.overlaps("tag_names", [filters.tag]);
  const text = searchText(filters.text);
  if (text) q = q.or(`clean_description.ilike.*${text}*,description.ilike.*${text}*,payee.ilike.*${text}*,merchant_name.ilike.*${text}*`);
  if (filters.needsReview) q = q.eq("needs_review", true);
  const { data, error, count } = await q
    .order("posted_at", { ascending: false, nullsFirst: true })
    .order("id")
    .range(offset, offset + limit - 1);
  if (error) fail("Couldn't load transactions", error);
  return { rows: data || [], total: count ?? (data || []).length };
}

/** One transaction with its splits (and their tags) and its transfer partner; null if not visible. */
export async function getTransactionDetail(id) {
  const { data: txn, error } = await supabase.from("wb_transaction_list").select(LIST_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("Couldn't load the transaction", error);
  if (!txn) return null;
  const [{ data: splits, error: se }, pair] = await Promise.all([
    supabase.from("wb_splits")
      .select("id, amount, description, tax_year, notes, position, tags:wb_split_tags(tag_id, source, rule_id)")
      .eq("transaction_id", id).order("position"),
    txn.transfer_pair_id
      ? supabase.from("wb_transaction_list").select("id, account_label, txn_date, amount, clean_description")
        .eq("id", txn.transfer_pair_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (se) fail("Couldn't load the splits", se);
  if (pair.error) fail("Couldn't load the transfer", pair.error);
  return { ...txn, splits: splits || [], pair: pair.data || null };
}

/** Tag groups and tags, for pickers and the Spending tab. */
export async function getTagTree() {
  const [{ data: groups, error: ge }, { data: tags, error: te }] = await Promise.all([
    supabase.from("wb_tag_groups").select("id, name, exclusive, required_for_kinds, sort_order").order("sort_order"),
    supabase.from("wb_tags").select("id, group_id, parent_id, name, is_active, sort_order").limit(2000),
  ]);
  if (ge) fail("Couldn't load the tag groups", ge);
  if (te) fail("Couldn't load the tags", te);
  return { groups: groups || [], tags: tags || [] };
}

/** Re-run processing for some transactions. */
export async function reprocess(ids) {
  if (!ids.length) return null;
  const { data, error } = await supabase.rpc("wb_process_transactions", { ids });
  if (error) fail("Couldn't refresh the transaction", error);
  return data;
}

/** Set the kind by hand; rules never change it back. A paired transfer must be unpaired first. */
export async function setKind(txn, kind) {
  if (txn.transfer_pair_id && kind !== "transfer") {
    throw new Error("This is paired as a transfer. Unpair it first.");
  }
  const { error } = await supabase.from("wb_transactions").update({ kind, kind_source: "manual" }).eq("id", txn.id);
  if (error) fail("Couldn't change the kind", error);
  await reprocess([txn.id]);
}

/** Add and/or remove tags by hand. A removal is remembered, so no rule puts it back. */
export async function applyTags(transactionIds, addTagIds = [], removeTagIds = []) {
  const { data, error } = await supabase.rpc("wb_apply_tags", {
    p_transaction_ids: transactionIds, p_tag_ids: addTagIds, p_source: "manual", p_remove_tag_ids: removeTagIds,
  });
  if (error) fail("Couldn't change the tags", error);
  return data;
}

/** Replace a transaction's splits; amounts must add up. Parts: {amount, description, tag_ids}. */
export async function replaceSplits(transactionId, parts) {
  const { data, error } = await supabase.rpc("wb_replace_splits", {
    p_transaction_id: transactionId, p_splits: parts, p_source: "manual",
  });
  if (error) fail("Couldn't save the splits", error);
  await reprocess([transactionId]);
  return data;
}

/** Pair two transactions as a transfer, or unpair one (pairWith null). */
export async function setTransferPair(transactionId, pairWith) {
  const { data, error } = await supabase.rpc("wb_set_transfer_pair", {
    p_id: transactionId, p_pair_with: pairWith, p_source: "manual",
  });
  if (error) fail(pairWith ? "Couldn't pair the transfer" : "Couldn't unpair the transfer", error);
  await reprocess([transactionId, ...(pairWith ? [pairWith] : (data?.unpaired || []))]);
  return data;
}

/** Possible other sides of a transfer: opposite amount, another account, within 5 days, unpaired. */
export async function findPairCandidates(txn) {
  const day = txn.txn_date;
  const shift = (n) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const { data, error } = await supabase.from("wb_transaction_list")
    .select("id, account_label, txn_date, amount, clean_description")
    .eq("amount", -Number(txn.amount)).neq("account_id", txn.account_id).is("transfer_pair_id", null)
    .gte("txn_date", shift(-5)).lte("txn_date", shift(5)).order("txn_date").limit(10);
  if (error) fail("Couldn't look for the other side", error);
  return data || [];
}

export async function saveNotes(transactionId, notes) {
  const value = notes && notes.trim() ? notes.trim() : null;
  const { error } = await supabase.from("wb_transactions").update({ notes: value }).eq("id", transactionId);
  if (error) fail("Couldn't save the note", error);
}

export async function setReviewed(transactionIds, reviewed = true) {
  const { error } = await supabase.from("wb_transactions").update({ reviewed }).in("id", transactionIds);
  if (error) fail("Couldn't mark it reviewed", error);
}

/** The "Always do this" plan (spec §6.1): merchant, pattern, dry-run count, existing rules. */
export async function getFixPlan(transactionId, { pattern = null, merchantName = null } = {}) {
  const { data, error } = await supabase.rpc("wb_fix_plan", {
    p_transaction_id: transactionId, p_pattern: pattern, p_merchant_name: merchantName,
  });
  if (error) fail("Couldn't work out the rule", error);
  return data;
}

/** Do it: merchant, then a merchant rule (or an update to the existing one), then reprocess. */
export async function applyFix({ transactionId, setKind: kind = null, tagIds = [], pattern = null,
  merchantName = null, updateRuleId = null, addNewRule = false }) {
  if (!kind && !tagIds.length) throw new Error("Choose a kind or at least one tag for the rule.");
  const { data, error } = await supabase.rpc("wb_apply_fix", {
    p_transaction_id: transactionId, p_set_kind: kind, p_add_tag_ids: tagIds, p_pattern: pattern,
    p_merchant_name: merchantName, p_update_rule_id: updateRuleId, p_add_new_rule: addNewRule,
    p_notes: null, p_created_by: "manual",
  });
  if (error) fail("Couldn't save the rule", error);
  return data;
}

const SUB_REASONS = ["price_change", "new_recurring"];

/** The queue, newest first; subscription rows also carry their subscription_id. */
export async function getReviewQueue() {
  const { data, error } = await supabase.from("wb_review_queue").select(QUEUE_COLUMNS)
    .order("txn_date", { ascending: false }).limit(500);
  if (error) fail("Couldn't load the review queue", error);
  const rows = data || [];
  const ids = [...new Set(rows.filter((r) => SUB_REASONS.includes(r.reason)).map((r) => r.transaction_id))];
  if (!ids.length) return rows;
  const { data: links, error: e2 } = await supabase.from("wb_transactions").select("id, subscription_id").in("id", ids);
  if (e2) fail("Couldn't load the review queue", e2);
  const subOf = new Map((links || []).map((l) => [l.id, l.subscription_id]));
  return rows.map((r) => (SUB_REASONS.includes(r.reason) ? { ...r, subscription_id: subOf.get(r.transaction_id) || null } : r));
}

/** Accept a charge's amount as the subscription's price from that day (clears price_change). */
export async function recordSubscriptionPrice(subscriptionId, row) {
  const { error } = await supabase.from("wb_subscription_prices").upsert({
    subscription_id: subscriptionId, effective_on: row.txn_date, amount: Math.abs(Number(row.amount)),
    source: "manual", transaction_id: row.transaction_id,
  }, { onConflict: "subscription_id,effective_on" });
  if (error) fail("Couldn't record the new price", error);
}

/**
 * Not a subscription: mark the merchant so detection skips it, then delete the
 * watching row (its charges unlink). Only a watching row can be dismissed.
 */
export async function dismissSubscription(subscriptionId) {
  const { data: sub, error } = await supabase.from("wb_subscriptions").select("id, merchant_id, status")
    .eq("id", subscriptionId).maybeSingle();
  if (error) fail("Couldn't dismiss it", error);
  if (!sub) throw new Error("That record no longer exists, or you can't see it.");
  if (sub.status !== "watching") throw new Error("Only a detected subscription can be dismissed here.");
  if (sub.merchant_id) {
    const { error: me } = await supabase.from("wb_merchants").update({ not_subscription: true }).eq("id", sub.merchant_id);
    if (me) fail("Couldn't dismiss it", me);
  }
  const { error: de } = await supabase.from("wb_subscriptions").delete().eq("id", subscriptionId).eq("status", "watching");
  if (de) fail("Couldn't dismiss it", de);
}

/** Category spending rows (both levels) for months from..to ("YYYY-MM"). */
export async function getSpending(fromMonth, toMonth) {
  const { data, error } = await supabase.from("wb_spending_by_tag")
    .select("month, group_name, level, tag_id, tag_name, amount, splits")
    .eq("group_name", "Category").gte("month", `${fromMonth}-01`).lte("month", `${toMonth}-01`).limit(2000);
  if (error) fail("Couldn't load spending", error);
  return data || [];
}

/** Cash flow per month from fromMonth ("YYYY-MM"), oldest first. */
export async function getCashFlow(fromMonth) {
  const { data, error } = await supabase.from("wb_cash_flow_monthly")
    .select("month, income, spending, net, unprocessed").gte("month", `${fromMonth}-01`)
    .order("month", { ascending: true }).limit(60);
  if (error) fail("Couldn't load cash flow", error);
  return data || [];
}

// --- Subscriptions (spec §4.8, §7.5, Step 8) ---

const SUB_COLUMNS =
  "id, name, plan, status, cadence, interval_count, interval_unit, merchant_id, merchant_name, billed_through_id, " +
  "billed_through_name, bundle_id, bundle_name, current_price, previous_price, last_change_on, price_count, " +
  "expected_amount, amount_tolerance, term_end_date, auto_renew, review_date, last_charged_on, next_expected_on, " +
  "charge_count, overdue, days_past_expected, owner, notes";
const CHARGE_COLUMNS =
  "id, account_label, txn_date, amount, clean_description, payee, merchant_name, subscription_id, subscription_source";
export const LINK_LOOKBACK_DAYS = 180;

export async function getSubscriptions() {
  const { data, error } = await supabase.from("wb_subscription_overview").select(SUB_COLUMNS).order("name").limit(500);
  if (error) fail("Couldn't load subscriptions", error);
  return data || [];
}

/** One subscription with its price history (newest first) and linked charges (newest first); null if not visible. */
export async function getSubscriptionDetail(id) {
  const { data: sub, error } = await supabase.from("wb_subscription_overview").select(SUB_COLUMNS).eq("id", id).maybeSingle();
  if (error) fail("Couldn't load the subscription", error);
  if (!sub) return null;
  const [{ data: prices, error: pe }, { data: charges, error: ce }] = await Promise.all([
    supabase.from("wb_subscription_prices").select("id, effective_on, amount, source, transaction_id, notes")
      .eq("subscription_id", id).order("effective_on", { ascending: false }),
    supabase.from("wb_transaction_list").select(CHARGE_COLUMNS)
      .eq("subscription_id", id).order("txn_date", { ascending: false }).limit(200),
  ]);
  if (pe) fail("Couldn't load the price history", pe);
  if (ce) fail("Couldn't load the linked charges", ce);
  return { sub, prices: prices || [], charges: charges || [] };
}

/** Choices for the edit form: merchants, and other subscriptions for bundle and billed-through. */
export async function getSubscriptionChoices() {
  const [{ data: merchants, error: me }, { data: subs, error: se }] = await Promise.all([
    supabase.from("wb_merchants").select("id, name").order("name").limit(2000),
    supabase.from("wb_subscriptions").select("id, name, status").order("name").limit(500),
  ]);
  if (me) fail("Couldn't load merchants", me);
  if (se) fail("Couldn't load subscriptions", se);
  return { merchants: merchants || [], subscriptions: subs || [] };
}

async function refreshSubscription(id) {
  const { error } = await supabase.rpc("wb_refresh_subscriptions", { p_ids: [id] });
  if (error) fail("Couldn't refresh the subscription's dates", error);
}

async function reprocessMerchants(merchantIds) {
  const ids = merchantIds.filter(Boolean);
  if (!ids.length) return;
  const { data, error } = await supabase.from("wb_transactions").select("id").in("merchant_id", ids).limit(2000);
  if (error) fail("Couldn't relink the charges", error);
  await reprocess((data || []).map((r) => r.id));
}

/** Save edited fields; a new merchant reprocesses both merchants' charges so they relink. Dates refresh after. */
export async function updateSubscription(sub, patch) {
  const { error } = await supabase.from("wb_subscriptions").update(patch).eq("id", sub.id);
  if (error) fail("Couldn't save the subscription", error);
  if ("merchant_id" in patch && patch.merchant_id !== sub.merchant_id) {
    await reprocessMerchants([sub.merchant_id, patch.merchant_id]);
  }
  await refreshSubscription(sub.id);
}

/** Confirm (active), pause, cancel or reactivate. */
export async function setSubscriptionStatus(id, status) {
  const { error } = await supabase.from("wb_subscriptions").update({ status }).eq("id", id);
  if (error) fail("Couldn't change the status", error);
}

/** A price from a date, by hand; the same day again replaces it. */
export async function recordPrice(subscriptionId, amount, effectiveOn) {
  if (!(amount > 0)) throw new Error("A price must be more than zero.");
  if (!effectiveOn) throw new Error("Choose the date the price starts.");
  const { error } = await supabase.from("wb_subscription_prices").upsert(
    { subscription_id: subscriptionId, effective_on: effectiveOn, amount, source: "manual" },
    { onConflict: "subscription_id,effective_on" });
  if (error) fail("Couldn't record the price", error);
}

/** Link charges to a subscription, or unlink them (subscriptionId null), by hand: processing never moves them again. */
export async function linkCharges(transactionIds, subscriptionId) {
  const { error } = await supabase.rpc("wb_link_subscription", {
    p_transaction_ids: transactionIds, p_subscription_id: subscriptionId, p_source: "manual",
  });
  if (error) fail(subscriptionId ? "Couldn't link the charges" : "Couldn't unlink the charge", error);
}

/**
 * Charges that could be linked: unlinked spend from the last 180 days, the
 * subscription's merchant only unless text is given (text searches every merchant).
 */
export async function findLinkCandidates(sub, text) {
  let q = supabase.from("wb_transaction_list").select(CHARGE_COLUMNS)
    .eq("kind", "spend").lt("amount", 0).is("subscription_id", null)
    .gte("txn_date", daysBefore(pacificToday(), LINK_LOOKBACK_DAYS));
  const s = searchText(text);
  if (s) q = q.or(`clean_description.ilike.*${s}*,description.ilike.*${s}*,payee.ilike.*${s}*,merchant_name.ilike.*${s}*`);
  else if (sub.merchant_id) q = q.eq("merchant_id", sub.merchant_id);
  else return [];
  const { data, error } = await q.order("txn_date", { ascending: false }).limit(50);
  if (error) fail("Couldn't look for charges", error);
  return data || [];
}
