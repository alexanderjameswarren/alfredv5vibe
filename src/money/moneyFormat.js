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

export const STALE_SYNC_HOURS = 36;
// A synced account whose newest snapshot is this many days old counts as stale.
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

/** A typed amount: "1,234.56", "-50", "$12". Returns a number rounded to cents, or null. */
export function parseAmountInput(text) {
  if (typeof text !== "string") return null;
  const s = text.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}
