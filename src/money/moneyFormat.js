// Pure helpers for the Money section: labels, amounts, rewards, cost basis and
// the sync status line. No React, no Supabase. Sign rule everywhere: money in
// positive, money out negative; a balance owed is negative.

export const ROLE_LABELS = {
  unassigned: "Unassigned",
  spending_cash: "Spending cash",
  reserve_cash: "Reserve cash",
  credit_card: "Credit cards",
  emergency_credit: "Emergency credit",
  loan: "Loans",
  retirement: "Retirement",
  taxable_investment: "Taxable investments",
  rewards: "Rewards",
  history_rollup: "History (spreadsheet)",
  closed: "Closed",
};

// Display order on the Accounts list; unassigned is shown separately on top.
export const ROLE_ORDER = [
  "spending_cash", "reserve_cash", "credit_card", "emergency_credit", "loan",
  "retirement", "taxable_investment", "rewards", "history_rollup", "closed",
];

export const OWNER_LABELS = { alex: "Alex", elise: "Elise", joint: "Joint" };

// Columns of wb_net_worth_daily shown on the Overview. `always: false` rows
// appear only when they are non-zero.
export const NET_WORTH_GROUPS = [
  { key: "spending_cash", label: "Spending cash", always: true },
  { key: "reserve_cash", label: "Reserve cash", always: true },
  { key: "credit_owed", label: "Credit owed", always: true },
  { key: "loans", label: "Loans", always: false },
  { key: "retirement", label: "Retirement", always: true },
  { key: "taxable_investments", label: "Taxable investments", always: true },
  { key: "rewards", label: "Rewards", always: true },
  { key: "history_rollup", label: "History (spreadsheet)", always: false },
  { key: "closed", label: "Closed accounts", always: false },
];

// If you change this, update help entry overview.sync_status in helpText.js and its test.
export const STALE_SYNC_HOURS = 36;
// A synced account whose newest snapshot is this many days old counts as stale.
// If you change this, update help entry overview.sync_status in helpText.js and its test.
export const STALE_ACCOUNT_DAYS = 2;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const count = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** PostgREST numeric arrives as a number or a string; null stays null. */
export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(value, { whole = false } = {}) {
  const n = toNumber(value);
  if (n === null) return "—";
  return (whole ? usdWhole : usd).format(n);
}

export function accountLabel(account) {
  return account?.display_name || account?.label || account?.name || "Unnamed account";
}

/** "Bank ••1234", or whichever half exists. */
export function accountSubtitle(account) {
  const parts = [];
  if (account?.institution) parts.push(account.institution);
  if (account?.last4) parts.push(`••${account.last4}`);
  return parts.join(" ");
}

/**
 * How a rewards balance reads: units always, dollars only where a value per
 * unit is set, and the expiry when there is one.
 */
export function rewardDisplay(account) {
  const units = toNumber(account?.balance);
  const rate = toNumber(account?.reward_value_per_unit);
  return {
    units: units === null ? "—" : `${count.format(units)} ${account?.reward_unit || "units"}`,
    dollars: units !== null && rate !== null ? formatMoney(Math.round(units * rate * 100) / 100) : null,
    expires: account?.expires_on || null,
  };
}

/** Banks that do not report cost basis send 0; that is not a $0 cost. */
export function costBasisReported(holding) {
  const n = toNumber(holding?.cost_basis);
  return n !== null && n !== 0;
}

export function costBasisLabel(holding) {
  return costBasisReported(holding) ? formatMoney(holding.cost_basis) : "not reported";
}

/** Gain only when a real cost basis exists; otherwise null (never a loss). */
export function holdingGain(holding) {
  if (!costBasisReported(holding)) return null;
  const value = toNumber(holding.market_value);
  if (value === null) return null;
  return Math.round((value - toNumber(holding.cost_basis)) * 100) / 100;
}

/** Accounts grouped for the list: { unassigned: [...], groups: [{role, label, accounts}] }. */
export function groupAccounts(accounts, { showHidden = false } = {}) {
  const visible = (accounts || []).filter((a) => showHidden || !a.is_hidden);
  const byLabel = (a, b) => accountLabel(a).localeCompare(accountLabel(b));
  const unassigned = visible.filter((a) => a.role === "unassigned").sort(byLabel);
  const groups = ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    accounts: visible.filter((a) => a.role === role).sort(byLabel),
  })).filter((g) => g.accounts.length > 0);
  return { unassigned, groups };
}

/**
 * The Overview's sync line.
 * @param accounts  rows from wb_account_latest
 * @param latestRun the newest wb-sync platform_runs row, or null (Elise cannot read them)
 */
export function syncStatus(accounts, latestRun, now = new Date()) {
  const synced = (accounts || []).filter((a) => a.source === "simplefin");
  const times = synced.map((a) => a.last_synced_at).filter(Boolean).map((t) => new Date(t).getTime());
  const last = times.length ? new Date(Math.max(...times)) : null;
  const problems = [];

  if (!last) problems.push("No sync recorded yet");
  else if (now.getTime() - last.getTime() > STALE_SYNC_HOURS * 3600_000) {
    problems.push(`Last sync is over ${STALE_SYNC_HOURS} hours old`);
  }
  const stale = synced.filter(
    (a) => !a.is_hidden && a.role !== "closed" && (a.staleness_days === null || a.staleness_days >= STALE_ACCOUNT_DAYS),
  );
  if (stale.length) {
    problems.push(`${stale.length} account${stale.length > 1 ? "s" : ""} not updated: ${stale.map(accountLabel).join(", ")}`);
  }
  if (latestRun && latestRun.status !== "ok" && latestRun.status !== "running") {
    problems.push(`Last sync ${latestRun.status.replace("_", " ")}${latestRun.error_message ? `: ${latestRun.error_message}` : ""}`);
  }
  return { ok: problems.length === 0, last, problems };
}

export function formatDateTime(date) {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/** "2026-10-07" -> "Oct 7, 2026", without a time-zone shift. */
export function formatDay(day) {
  if (!day) return "—";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export function pacificToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function daysBefore(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// --- Phase 2: kinds, months, review, tags, spending (docs/technical-spec-warren_buffet_p2-m4t.md §7) ---

export const KIND_LABELS = {
  spend: "Spending", income: "Income", transfer: "Transfer", refund: "Refund",
  investment: "Investment", interest: "Interest", fee: "Fee",
};
export const KIND_ORDER = ["spend", "refund", "fee", "income", "interest", "transfer", "investment"];

export const REVIEW_LABELS = {
  no_kind: "Not processed yet",
  missing_required_tag: "Needs a category",
  transfer_candidate: "Looks like a transfer",
  split_mismatch: "Splits don't add up",
  price_change: "Subscription price changed",
  new_recurring: "Looks like a subscription",
};
export const REVIEW_ORDER = [
  "missing_required_tag", "transfer_candidate", "price_change", "new_recurring", "split_mismatch", "no_kind",
];

/** "2026-10-07" -> "2026-10". */
export function monthOf(day) {
  return day ? day.slice(0, 7) : null;
}

/** "2026-10" -> { from: "2026-10-01", to: "2026-10-31" }. */
export function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** "2026-01" plus -2 -> "2025-11". */
export function addMonths(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** "2026-10" or "2026-10-01" -> "Oct 2026". */
export function formatMonth(month) {
  if (!month) return "—";
  const [y, m] = month.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Review rows grouped by reason, in REVIEW_ORDER, newest first inside each group. */
export function groupQueue(rows) {
  const byReason = new Map();
  for (const r of rows || []) {
    if (!byReason.has(r.reason)) byReason.set(r.reason, []);
    byReason.get(r.reason).push(r);
  }
  return REVIEW_ORDER.filter((reason) => byReason.has(reason)).map((reason) => ({
    reason,
    label: REVIEW_LABELS[reason],
    rows: byReason.get(reason).slice().sort((a, b) => (b.txn_date || "").localeCompare(a.txn_date || "")),
  }));
}

/** The top-level ancestor of each tag: Map(tagId -> topTagId). */
export function tagTops(tags) {
  const byId = new Map((tags || []).map((t) => [t.id, t]));
  const tops = new Map();
  for (const t of tags || []) {
    let cur = t;
    const seen = new Set();
    while (cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
    tops.set(t.id, cur.id);
  }
  return tops;
}

/** Picker options for one group: parents first, each followed by its children as "Parent › Child". */
export function tagOptions(tags, groupId, { includeInactive = false } = {}) {
  const inGroup = (tags || []).filter((t) => t.group_id === groupId && (includeInactive || t.is_active !== false));
  const byName = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name);
  const out = [];
  const walk = (parentId, prefix, depth) => {
    for (const t of inGroup.filter((x) => (x.parent_id || null) === parentId).sort(byName)) {
      if (depth > 10) return;
      out.push({ id: t.id, label: prefix ? `${prefix} › ${t.name}` : t.name, name: t.name });
      walk(t.id, prefix ? `${prefix} › ${t.name}` : t.name, depth + 1);
    }
  };
  walk(null, "", 0);
  return out;
}

/**
 * A month's Category spending for the Spending tab: top-level tags, each with
 * its leaf rows, most spent first; the untagged row last. Amounts are signed
 * (spending negative), as the view stores them.
 */
export function spendingForMonth(rows, tags, month) {
  const tops = tagTops(tags);
  const names = new Map((tags || []).map((t) => [t.id, t.name]));
  const inMonth = (rows || []).filter((r) => monthOf(r.month) === month);
  const groups = inMonth.filter((r) => r.level === "top" && r.tag_id).map((r) => ({
    tagId: r.tag_id,
    name: r.tag_name,
    amount: toNumber(r.amount) ?? 0,
    // Splits tagged with the parent itself show as "<parent> (general)" beside its children.
    children: inMonth
      .filter((l) => l.level === "leaf" && l.tag_id && tops.get(l.tag_id) === r.tag_id)
      .map((l) => ({
        tagId: l.tag_id,
        name: l.tag_id === r.tag_id ? `${r.tag_name} (general)` : l.tag_name || names.get(l.tag_id),
        amount: toNumber(l.amount) ?? 0,
      }))
      .sort((a, b) => a.amount - b.amount),
  })).sort((a, b) => a.amount - b.amount);
  const untagged = inMonth.find((r) => r.level === "top" && !r.tag_id);
  const total = groups.reduce((s, g) => s + g.amount, 0) + (untagged ? toNumber(untagged.amount) ?? 0 : 0);
  return {
    groups,
    untagged: untagged ? toNumber(untagged.amount) ?? 0 : 0,
    total: Math.round(total * 100) / 100,
  };
}

/** What is left to place when splitting: transaction amount minus the parts entered so far. */
export function splitRemainder(amount, parts) {
  const total = (parts || []).reduce((s, p) => s + (toNumber(p.amount) ?? 0), 0);
  return Math.round(((toNumber(amount) ?? 0) - total) * 100) / 100;
}

/** "removed by you" / "removed by Claude", for a wb_transaction_list excluded_tags entry. */
export function exclusionLabel(exclusion) {
  return exclusion?.source === "claude" ? "removed by Claude" : "removed by you";
}

/** A typed amount: "1,234.56", "-50", "$12". Returns a number rounded to cents, or null. */
export function parseAmountInput(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}

// --- Subscriptions (spec §4.8, §7.5, Step 8) ---

export const SUB_STATUS_LABELS = {
  overdue: "Overdue", active: "Active", watching: "Watching", paused: "Paused", cancelled: "Cancelled",
};
export const SUB_GROUP_ORDER = ["overdue", "active", "watching", "paused", "cancelled"];
// If you change this, update help entry subscription.next_expected in helpText.js and its test.
export const REVIEW_SOON_DAYS = 30;
// The monthly conversion. If you change these, update help entries subscriptions.monthly_total
// and subscriptions.breakdown in helpText.js, its test, and wb_ SQL that normalizes to a month.
export const WEEKS_PER_YEAR = 52;
export const MONTHS_PER_YEAR = 12;

/** "Monthly", "Every 2 weeks", "Irregular" — from cadence and the billing interval. */
export function intervalLabel(sub) {
  const named = { monthly: "Monthly", quarterly: "Quarterly", annual: "Annual" }[sub?.cadence];
  if (named) return named;
  const n = sub?.interval_count;
  if (!n || !sub?.interval_unit) return "Irregular";
  if (n === 1) return sub.interval_unit === "week" ? "Weekly" : "Monthly";
  return `Every ${n} ${sub.interval_unit}s`;
}

/** Today's price as a monthly cost: months ÷ count, weeks × 52 ÷ 12 ÷ count; null when it cannot be known. */
export function monthlyEquivalent(sub) {
  const price = toNumber(sub?.current_price);
  const n = sub?.interval_count;
  if (price === null || !n) return null;
  if (sub.interval_unit === "month") return price / n;
  if (sub.interval_unit === "week") return (price * WEEKS_PER_YEAR) / MONTHS_PER_YEAR / n;
  return null;
}

/** The monthly multiplier in plain words: "×1", "÷12", "÷2", "×4.33", "×2.17". */
export function multiplierLabel(sub) {
  const n = sub?.interval_count;
  if (!n) return null;
  if (sub.interval_unit === "month") return n === 1 ? "×1" : `÷${n}`;
  if (sub.interval_unit === "week") return `×${(WEEKS_PER_YEAR / MONTHS_PER_YEAR / n).toFixed(2)}`;
  return null;
}

/**
 * Every active subscription's monthly cost, high to low, with the total and the
 * per-owner subtotals. Each row is rounded to the cent first and the totals are
 * sums of those rounded rows (in whole cents), so the rows add up to the total
 * exactly. Rows that cannot be counted are listed with the reason.
 */
export function subscriptionBreakdown(subs) {
  const rows = [];
  const notCounted = [];
  for (const s of subs || []) {
    if (s.status !== "active") continue;
    if (toNumber(s.current_price) === null) { notCounted.push({ sub: s, reason: "No price recorded" }); continue; }
    const m = monthlyEquivalent(s);
    if (m === null) { notCounted.push({ sub: s, reason: "No regular billing interval" }); continue; }
    rows.push({ sub: s, owner: OWNER_LABELS[s.owner] ? s.owner : "unassigned", cents: Math.round(m * 100) });
  }
  rows.sort((a, b) => b.cents - a.cents || (a.sub.name || "").localeCompare(b.sub.name || ""));
  const ownerCents = { alex: 0, elise: 0, joint: 0, unassigned: 0 };
  let totalCents = 0;
  for (const r of rows) { ownerCents[r.owner] += r.cents; totalCents += r.cents; }
  return {
    rows: rows.map((r) => ({ sub: r.sub, owner: r.owner, multiplier: multiplierLabel(r.sub), monthly: r.cents / 100 })),
    total: totalCents / 100,
    byOwner: Object.fromEntries(Object.entries(ownerCents).map(([k, v]) => [k, v / 100])),
    notCounted,
  };
}

/** Monthly-equivalent total of active subscriptions, split by owner, and the ones that cannot be counted. */
export function subscriptionTotals(subs) {
  const b = subscriptionBreakdown(subs);
  return { total: b.total, byOwner: b.byOwner, notCounted: b.notCounted.map((n) => n.sub) };
}

/** Groups in SUB_GROUP_ORDER; an overdue active subscription goes to Overdue. Names A–Z inside each. */
export function groupSubscriptions(subs) {
  const groups = new Map(SUB_GROUP_ORDER.map((k) => [k, []]));
  for (const s of subs || []) {
    const key = s.status === "active" && s.overdue ? "overdue" : s.status;
    if (groups.has(key)) groups.get(key).push(s);
  }
  return SUB_GROUP_ORDER.filter((k) => groups.get(k).length).map((k) => ({
    key: k, label: SUB_STATUS_LABELS[k],
    rows: groups.get(k).slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")),
  }));
}

/** A review date within REVIEW_SOON_DAYS of today, or past. */
export function reviewSoon(sub, today) {
  if (!sub?.review_date || !today) return false;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + REVIEW_SOON_DAYS);
  return sub.review_date <= d.toISOString().slice(0, 10);
}

export const BILLING_CHOICES = [
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "annual", label: "Annual" },
  { key: "weeks", label: "Every N weeks" },
  { key: "months", label: "Every N months" },
  { key: "irregular", label: "Irregular (no next date)" },
];

/** The billing choice and N shown in the edit form for a subscription. */
export function billingChoice(sub) {
  if (["monthly", "quarterly", "annual"].includes(sub?.cadence)) return { choice: sub.cadence, count: "" };
  if (sub?.interval_count && sub?.interval_unit) {
    return { choice: sub.interval_unit === "week" ? "weeks" : "months", count: String(sub.interval_count) };
  }
  return { choice: "irregular", count: "" };
}

/** The cadence and interval columns for a billing choice; null when N is not a whole number from 1 to 104. */
export function billingFields(choice, countText) {
  if (choice === "monthly" || choice === "quarterly" || choice === "annual") return { cadence: choice };
  if (choice === "irregular") return { cadence: "other", interval_count: null, interval_unit: null };
  const n = Number(countText);
  if (!Number.isInteger(n) || n < 1 || n > 104) return null;
  const unit = choice === "weeks" ? "week" : "month";
  const named = unit === "month" && { 1: "monthly", 3: "quarterly", 12: "annual" }[n];
  return named ? { cadence: named } : { cadence: "other", interval_count: n, interval_unit: unit };
}
