import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { HELP, HELP_HEADINGS } from "./helpText";
import * as N from "./ruleNumbers";
import {
  MONTHS_PER_YEAR, REVIEW_ORDER, REVIEW_SOON_DAYS, STALE_ACCOUNT_DAYS, STALE_SYNC_HOURS, SUB_GROUP_ORDER,
  WEEKS_PER_YEAR, monthlyEquivalent,
} from "./moneyFormat";

const MONEY = __dirname;
const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const screens = readdirSync(MONEY).filter((f) => f.endsWith(".jsx") && !f.includes(".test."))
  .map((f) => readFileSync(join(MONEY, f), "utf-8"));
const literalKeys = new Set(screens.flatMap((s) => [...s.matchAll(/helpKey="([^"]+)"/g)].map((m) => m[1])));
const families = [
  { marker: "helpKey={`review.${", keys: REVIEW_ORDER.map((r) => `review.${r}`) },
  { marker: "helpKey={`subscription.status.${", keys: SUB_GROUP_ORDER.map((s) => `subscription.status.${s}`) },
];
const familyKeys = new Set(families.filter((f) => screens.some((s) => s.includes(f.marker))).flatMap((f) => f.keys));

test("every entry has a title and four filled headings", () => {
  for (const [key, e] of Object.entries(HELP)) {
    expect([key, typeof e.title === "string" && e.title.trim() !== ""]).toEqual([key, true]);
    for (const h of HELP_HEADINGS) expect([key, h.field, (e[h.field] || "").trim() !== ""]).toEqual([key, h.field, true]);
  }
});

test("every ? on a screen points at a real, unreserved entry", () => {
  for (const key of [...literalKeys, ...familyKeys]) {
    expect([key, Boolean(HELP[key]), Boolean(HELP[key]?.reserved)]).toEqual([key, true, false]);
  }
});

test("every unreserved entry is used on a screen", () => {
  const unused = Object.keys(HELP).filter((k) => !HELP[k].reserved && !literalKeys.has(k) && !familyKeys.has(k));
  expect(unused).toEqual([]);
});

const says = (key, text) => expect([key, `${HELP[key].what} ${HELP[key].included} ${HELP[key].leftOut}`]).toEqual(
  [key, expect.stringContaining(text)]);

test("numbers in the wording match the code", () => {
  says("review.transfer_candidate", `within ${N.TRANSFER_WINDOW_DAYS} days`);
  says("transaction.transfer", `within ${N.TRANSFER_WINDOW_DAYS} days`);
  for (const key of ["review.new_recurring", "subscription.status.watching"]) {
    says(key, `${N.DETECT_MIN_CHARGES} or more charges in the last ${N.DETECT_LOOKBACK_DAYS} days`);
    says(key, `${N.DETECT_GAP_MIN_DAYS} to ${N.DETECT_GAP_MAX_DAYS} days`);
    says(key, `within ${N.DETECT_SPREAD_PERCENT}%`);
  }
  says("subscription.status.overdue", `More than ${N.OVERDUE_GRACE_DAYS} days`);
  says("subscription.next_expected", `${REVIEW_SOON_DAYS} days before`);
  says("subscriptions.monthly_total", `divided by ${MONTHS_PER_YEAR}; weekly ones are multiplied by ${WEEKS_PER_YEAR} and divided by ${MONTHS_PER_YEAR}`);
  says("subscriptions.breakdown", `÷${MONTHS_PER_YEAR} for yearly; ${WEEKS_PER_YEAR} weeks ÷ ${MONTHS_PER_YEAR} months for weekly`);
  says("overview.sync_status", `over ${STALE_SYNC_HOURS} hours`);
  says("overview.sync_status", `for ${STALE_ACCOUNT_DAYS} days or more`);
  says("rule_health.never_fires", `more than ${N.NEVER_FIRES_AFTER_DAYS} days`);
  says("rule_health.never_fires", `every ${N.NEVER_FIRES_SKIP_MONTHS} months or more`);
  says("rule_health.too_broad", `${N.TOO_BROAD_PAYEES} or more different payees`);
  says("rule_health.often_overridden", `at least ${N.OVERRIDDEN_MIN} of its matches and at least a quarter`);
  expect(N.OVERRIDDEN_SHARE_DIVISOR).toBe(4); // "a quarter"
  says("rule_health.duplicate_rules", `${N.DUPLICATE_RULES_MIN} or more active rules`);
  says("rule_health.rule_missing", `${N.RULE_MISSING_MIN} or more settled transactions`);
});

test("the yearly and weekly conversions are what monthlyEquivalent does", () => {
  expect(monthlyEquivalent({ current_price: 120, interval_count: 12, interval_unit: "month" })).toBe(120 / MONTHS_PER_YEAR);
  expect(monthlyEquivalent({ current_price: 12, interval_count: 1, interval_unit: "week" })).toBe((12 * WEEKS_PER_YEAR) / MONTHS_PER_YEAR);
});

/** The newest migration defining an object, cut to that definition. */
function latestDefinition(name) {
  const def = new RegExp(`create or replace (function|view) public\\.${name}\\b`, "i");
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const f of files.reverse()) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf-8");
    const at = sql.search(def);
    if (at < 0) continue;
    const rest = sql.slice(at + 1);
    const end = rest.search(/\ncreate or replace (function|view) /i);
    return end < 0 ? rest : rest.slice(0, end);
  }
  throw new Error(`no migration defines ${name}`);
}
const num = (sql, re) => {
  const m = sql.match(re);
  if (!m) throw new Error(`pattern not found: ${re}`);
  return m.slice(1).map(Number);
};

test("the JS mirrors match the SQL that really runs", () => {
  expect(num(latestDefinition("wb_transfer_match"), /abs\(p_a_date - p_b_date\) <= (\d+)/)).toEqual([N.TRANSFER_WINDOW_DAYS]);

  const detect = latestDefinition("wb_detect_subscriptions");
  expect(num(detect, /between v_today - (\d+) and v_today/)).toEqual([N.DETECT_LOOKBACK_DAYS]);
  expect(num(detect, /having count\(\*\) >= (\d+)/)).toEqual([N.DETECT_MIN_CHARGES]);
  expect(num(detect, /not between (\d+) and (\d+)/)).toEqual([N.DETECT_GAP_MIN_DAYS, N.DETECT_GAP_MAX_DAYS]);
  expect(num(detect, /> ([\d.]+) \* g\.med/).map((x) => Math.round(x * 100))).toEqual([N.DETECT_SPREAD_PERCENT]);

  expect(num(latestDefinition("wb_subscription_overview"), /next_expected_on \+ (\d+)/)).toEqual([N.OVERDUE_GRACE_DAYS]);

  const health = latestDefinition("wb_rule_health_all");
  expect(num(health, /interval '(\d+) days'/)).toEqual([N.NEVER_FIRES_AFTER_DAYS]);
  expect(num(health, /interval_unit = 'month' and s\.interval_count >= (\d+)/)).toEqual([N.NEVER_FIRES_SKIP_MONTHS]);
  expect(num(health, /cardinality\(mp\.payees\) >= (\d+)/)).toEqual([N.TOO_BROAD_PAYEES]);
  expect(num(health, /o\.n >= (\d+) and o\.n \* (\d+) >= o\.of_n/)).toEqual([N.OVERRIDDEN_MIN, N.OVERRIDDEN_SHARE_DIVISOR]);
  expect(num(health, /having count\(\*\) >= (\d+)/)).toEqual([N.DUPLICATE_RULES_MIN]);
  expect(num(health, /where t\.n >= (\d+)/)).toEqual([N.RULE_MISSING_MIN]);
});
