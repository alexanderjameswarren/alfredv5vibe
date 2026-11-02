/*
Warren Buffet - Amazon match test (spec P4-D7). A dry run: it only ever reads.
    node amazon_match.mjs <amazon history folder>

The service-role key comes from SUPABASE_SERVICE_ROLE_KEY only and is never written
to a file. Output is counts and dates only: never amounts, products or order ids.
*/
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FROM_DATE, ORDERS_FILE, REFUNDS_FILE, chargeType, isAmazonText, matchAll, readOrders, readRefunds, toCents } from "./amazon_lib.mjs";
import { pacificDate } from "./history_lib.mjs";
import { rest } from "./history_import.mjs";

const KEY_VAR = "SUPABASE_SERVICE_ROLE_KEY";
const PAGE = 1000;
const SLACK_DAYS = 7;

export async function readDebits(db) {
  const accounts = await db("wb_accounts?select=id,last4,role,user_id,context_id");
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await db(
      "wb_transactions?amount=lt.0&pending=eq.false" +
      "&or=(description.ilike.*amazon*,description.ilike.*amzn*,payee.ilike.*amazon*,payee.ilike.*amzn*)" +
      `&select=id,account_id,amount,description,payee,kind,posted_at,transacted_at,source&order=id.asc&limit=${PAGE}&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, byId };
}

function plusDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** Which debits count as Amazon card charges, and a count for every one that does not. */
export function pickCharges(rows, byId, latestOrder) {
  const lastUsable = plusDays(latestOrder, SLACK_DAYS);
  const skipped = { not_a_card: 0, transfer: 0, no_date: 0, before_from: 0, after_export: 0, type: {} };
  const charges = [];
  for (const r of rows) {
    const text = `${r.payee ?? ""} ${r.description ?? ""}`;
    if (!isAmazonText(text)) continue;
    const account = byId.get(r.account_id);
    if (account?.role !== "credit_card") { skipped.not_a_card++; continue; }
    if (r.kind === "transfer") { skipped.transfer++; continue; }
    const when = r.posted_at ?? r.transacted_at;
    if (!when) { skipped.no_date++; continue; }
    const date = pacificDate(when);
    if (date < FROM_DATE) { skipped.before_from++; continue; }
    // The export stops; a later charge has no order to find.
    if (date > lastUsable) { skipped.after_export++; continue; }
    const type = chargeType(text);
    if (type !== "shipment") { skipped.type[type] = (skipped.type[type] ?? 0) + 1; continue; }
    charges.push({ id: r.id, date, cents: Math.round(Math.abs(Number(r.amount)) * 100), card: account.last4 ?? "no last4", source: r.source });
  }
  return { charges, skipped };
}

function pct(n, of) {
  return of ? `${Math.round((n / of) * 100)}%` : "n/a";
}

function chargeLine(label, l) {
  return `  ${label}: charges ${l.charges} | 0-3 days: one ${l.d3_one}, many ${l.d3_many}, none ${l.d3_none} | 0-7 days: one ${l.d7_one}, many ${l.d7_many}, none ${l.d7_none}`;
}

function report(orders, refunds, picked, result, otherMatches, log) {
  const { counts } = orders;
  log("MODE: match test (reads only, writes nothing)");
  log(`ORDERS: rows ${counts.rows}, unreadable ${orders.bad.length}, before ${FROM_DATE} ${counts.before_from}`);
  log(`  in range: ${orders.earliest ?? "none"} to ${orders.latest ?? "none"}`);
  log(`  left out: cancelled ${counts.cancelled}, no ship date ${counts.no_ship_date}, other sites ${JSON.stringify(counts.other_site)}`);
  log(`  rows with several ship dates: ${counts.several_ship_dates}; shipments totalling zero, left out: ${counts.zero_total}`);
  log(`REFUNDS: rows ${refunds.rows}, on in-range orders ${refunds.refunds.length}, other orders ${refunds.otherOrders}, no refund date or amount ${refunds.notApplicable}, unreadable ${refunds.bad.length}`);
  log(`AMAZON-NAMED DEBITS NOT COUNTED: ${JSON.stringify(picked.skipped)}`);
  const t = result.total;
  log(`CHARGES: ${t.charges}`);
  log(`  0-3 days: one ${t.d3_one} (${pct(t.d3_one, t.charges)}), many ${t.d3_many}, none ${t.d3_none}`);
  log(`  0-7 days: one ${t.d7_one} (${pct(t.d7_one, t.charges)}), many ${t.d7_many}, none ${t.d7_none}`);
  log(`  charges with no match at 0-7 days that do match another site's order: ${otherMatches}`);
  log("BY CARD:");
  for (const k of Object.keys(result.byCard).sort()) log(chargeLine(k, result.byCard[k]));
  log("BY QUARTER:");
  for (const k of Object.keys(result.byQuarter).sort()) log(chargeLine(k, result.byQuarter[k]));
  log(`SHIPMENTS: ${result.shipments}; no charge at 0-7 days ${result.noCharge} (part paid by gift card ${result.noChargePartGift}); matched by more than one charge ${result.sharedShipments}`);
  log("SHIPMENTS BY CARD:");
  for (const k of Object.keys(result.shipByCard).sort()) log(`  ${k}: shipments ${result.shipByCard[k].shipments}, no charge ${result.shipByCard[k].no_charge}`);
  log("SHIPMENTS BY QUARTER:");
  for (const k of Object.keys(result.shipByQuarter).sort()) log(`  ${k}: shipments ${result.shipByQuarter[k].shipments}, no charge ${result.shipByQuarter[k].no_charge}`);
}

/** Returns the exit code. Dependencies are passed in so tests never touch a real database. */
export async function run(argv, { env = process.env, fetchFn = fetch, log = console.log } = {}) {
  let key;
  try {
    if (argv.length !== 1 || argv[0].startsWith("--")) throw new Error("Pass one folder: node amazon_match.mjs <amazon history folder>");
    const [folder] = argv;
    for (const f of [ORDERS_FILE, REFUNDS_FILE]) if (!existsSync(join(folder, f))) throw new Error(`Missing file: ${f}`);
    key = env[KEY_VAR]?.trim();
    if (!key) throw new Error(`${KEY_VAR} is not set. Set it in this terminal session only; never in a file.`);
    const orders = readOrders(readFileSync(join(folder, ORDERS_FILE), "utf8"));
    const ids = new Set(orders.shipments.map((s) => s.order_id));
    const refunds = readRefunds(readFileSync(join(folder, REFUNDS_FILE), "utf8"), ids);
    const { rows, byId } = await readDebits(rest(key, fetchFn));
    const picked = pickCharges(rows, byId, orders.latest ?? FROM_DATE);
    const result = matchAll(picked.charges, orders.shipments);
    const unmatched = picked.charges.filter((c) => !orders.shipments.some((s) => s.cents === c.cents && s.ship_date <= c.date && c.date <= plusDays(s.ship_date, SLACK_DAYS)));
    const otherMatches = unmatched.filter((c) => orders.otherSiteShipments.some((s) => s.cents === c.cents && s.ship_date <= c.date && c.date <= plusDays(s.ship_date, SLACK_DAYS))).length;
    report(orders, refunds, picked, result, otherMatches, log);
    log("DONE. Nothing was written.");
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${key ? msg.split(key).join("[key]") : msg}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
