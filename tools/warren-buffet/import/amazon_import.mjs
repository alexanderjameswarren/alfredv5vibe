/*
Warren Buffet - write Amazon and Whole Foods orders, items and matches (spec P4-D7).

Dry run, the default. Writes nothing anywhere:
    node amazon_import.mjs <amazon history folder>
    -> prints counts and dates and, if clean, a code for that exact run.

Write. Repeats every check, then refuses unless the code still matches:
    node amazon_import.mjs <amazon history folder> --write --confirm <code>

A write that fails stops where it is; nothing retries. A later dry run then reports the
rows already there and issues no code. The service-role key comes from
SUPABASE_SERVICE_ROLE_KEY only and is never written to a file. Output is counts and dates
only: never amounts, products or order ids. Splits are a later step; this writes none.
*/
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ORDERS_FILE, REFUNDS_FILE, chooseMatches, placeRefunds, readOrders, readRefunds } from "./amazon_lib.mjs";
import { pickCharges, readDebits } from "./amazon_match.mjs";
import { rest } from "./history_import.mjs";

const KEY_VAR = "SUPABASE_SERVICE_ROLE_KEY";
const CHUNK = 200;

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function parseArgs(argv) {
  const opts = { folder: null, write: false, confirm: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--confirm") opts.confirm = argv[++i] ?? null;
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}.`);
    else if (!opts.folder) opts.folder = a;
    else throw new Error("Pass one folder.");
  }
  if (!opts.folder) throw new Error("Pass the folder: node amazon_import.mjs <amazon history folder>");
  if (opts.write && !opts.confirm) throw new Error("--write needs --confirm <code> from a clean dry run of the same files.");
  return opts;
}

const keyOf = (s) => `${s.site}|${s.order_id}|${s.ship_date}`;

async function buildPlan(opts, db) {
  const bytes = readFileSync(join(opts.folder, ORDERS_FILE));
  const orders = readOrders(bytes.toString("utf8"));
  const { rows, byId } = await readDebits(db);
  const owners = [...byId.values()].filter((a) => a.role === "credit_card");
  if (!owners.length) throw new Error("No credit_card account found.");
  const owner = owners[0];
  const { charges } = pickCharges(rows, byId, orders.latest ?? "2024-09-01");
  const { matches, shared } = chooseMatches(charges, orders.shipments);
  const existing = await db("wb_orders?select=id&limit=1");
  const shipments = [...orders.shipments, ...orders.zeroShipments, ...orders.otherSiteShipments];
  const items = shipments.reduce((n, s) => n + s.items.length, 0);
  const refundBytes = readFileSync(join(opts.folder, REFUNDS_FILE));
  const refunds = readRefunds(refundBytes.toString("utf8"), new Set(shipments.map((s) => s.order_id)));
  const placed = placeRefunds(shipments, refunds.refunds);
  const hash = createHash("sha256").update(bytes).update(refundBytes);
  for (const m of matches.map((x) => `${keyOf(x.shipment)}|${x.charge.id}`).sort()) hash.update(m);
  return {
    orders, shipments, items, matches, shared, owner, refunds, placed,
    chargeCount: charges.length,
    existing: existing.length,
    clean: orders.bad.length === 0 && refunds.bad.length === 0 && existing.length === 0,
    code: hash.digest("hex").slice(0, 16),
  };
}

function report(plan, log) {
  const site = (name) => plan.shipments.filter((s) => s.site === name);
  const items = (list) => list.reduce((n, s) => n + s.items.length, 0);
  log(`Unreadable rows: ${plan.orders.bad.length}. Already in wb_orders: ${plan.existing ? "yes" : "none"}.`);
  log(`Date range: ${plan.orders.earliest ?? "none"} to ${plan.orders.latest ?? "none"}`);
  log(`Amazon: shipments ${site("amazon").length}, items ${items(site("amazon"))}`);
  log(`Whole Foods: shipments ${site("wholefoods").length}, items ${items(site("wholefoods"))}`);
  log(`Amazon charges ${plan.chargeCount}; matches to write ${plan.matches.length}; shipments two charges claim, left unmatched ${plan.shared}`);
  log(`Refunds on these orders ${plan.refunds.refunds.length}, unreadable ${plan.refunds.bad.length}: placed on an item ${plan.placed.placed}, could not be placed ${plan.placed.unplaced}`);
}

async function write(plan, db, log) {
  const base = { user_id: plan.owner.user_id, context_id: plan.owner.context_id };
  const ids = new Map();
  const orderRows = plan.shipments.map((s) => ({
    ...base,
    site: s.site,
    order_number: s.order_id,
    order_date: s.order_date,
    ship_date: s.ship_date,
    amount: (s.cents / 100).toFixed(2),
    order_status: s.items[0].order_status || null,
    shipment_status: s.items[0].shipment_status || null,
    payment_method_type: s.items[0].payment_method_type || null,
  }));
  for (const part of chunks(orderRows, CHUNK)) {
    const made = await db("wb_orders?select=id,site,order_number,ship_date", { method: "POST", body: part, prefer: "return=representation" });
    for (const m of made) ids.set(`${m.site}|${m.order_number}|${m.ship_date}`, m.id);
  }
  log(`Inserted orders: ${ids.size}.`);

  const itemRows = plan.shipments.flatMap((s) => s.items.map((i, n) => ({
    ...base,
    order_id: ids.get(keyOf(s)),
    line_no: n + 1,
    site: s.site,
    asin: i.asin || null,
    product_name: i.product_name,
    department: i.department || null,
    quantity: Number(i.quantity),
    unit_amount: i.unit_amount,
    line_amount: i.amount,
    refunded_amount: i.refunded_cents ? (i.refunded_cents / 100).toFixed(2) : null,
    refund_date: i.refund_date ?? null,
    order_date: i.order_date,
    ship_date: i.ship_date,
  })));
  for (const part of chunks(itemRows, CHUNK)) await db("wb_order_items?select=id", { method: "POST", body: part, prefer: "return=representation" });
  log(`Inserted items: ${itemRows.length}.`);

  const matchRows = plan.matches.map((m) => ({
    ...base,
    order_id: ids.get(keyOf(m.shipment)),
    transaction_id: m.charge.id,
    days_apart: m.days_apart,
  }));
  for (const part of chunks(matchRows, CHUNK)) await db("wb_order_matches?select=id", { method: "POST", body: part, prefer: "return=representation" });
  log(`Inserted matches: ${matchRows.length}.`);
  log("WRITE DONE. No splits written.");
}

/** Returns the exit code. Dependencies are passed in so tests never touch a real database. */
export async function run(argv, { env = process.env, fetchFn = fetch, log = console.log } = {}) {
  let key;
  try {
    const opts = parseArgs(argv);
    for (const f of [ORDERS_FILE, REFUNDS_FILE]) if (!existsSync(join(opts.folder, f))) throw new Error(`Missing file: ${f}`);
    key = env[KEY_VAR]?.trim();
    if (!key) throw new Error(`${KEY_VAR} is not set. Set it in this terminal session only; never in a file.`);
    log(opts.write ? "MODE: write" : "MODE: dry run (writes nothing)");
    const db = rest(key, fetchFn);
    const plan = await buildPlan(opts, db);
    report(plan, log);
    if (!plan.clean) {
      log("NOT CLEAN. No code issued; --write will refuse.");
      return 1;
    }
    if (!opts.write) {
      log(`DRY RUN CLEAN. Code for this exact file and these matches: ${plan.code}`);
      return 0;
    }
    if (opts.confirm !== plan.code) {
      log("REFUSED: this code does not match a clean dry run. Nothing written. Dry-run again.");
      return 1;
    }
    await write(plan, db, log);
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
