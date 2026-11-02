// Invented data only. Run: node --test tools/warren-buffet/import/amazon_match.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ORDERS_FILE, REFUNDS_FILE, candidates, cardOf, chargeType, matchAll, quarterOf, readOrders, readRefunds } from "./amazon_lib.mjs";
import { pickCharges, run } from "./amazon_match.mjs";

const HEAD = "ASIN,Billing Address,Order Date,Order ID,Order Status,Original Quantity,Payment Method Type,Product Name,Department,Ship Date,Shipment Status,Shipping Address,Total Amount,Unit Price,Website\n";
const line = (o = {}) => {
  const r = {
    asin: "ZZ1", bill: "ZZ STREET", od: "2025-01-10T20:00:00Z", id: "111-1", st: "Closed", q: "1", pay: "Visa - 1111",
    name: "ZZ THING", dep: "ZZ DEPT", sd: "2025-01-11T20:00:00Z", ss: "Shipped", ship: "ZZ ROAD", tot: "10.00", site: "Amazon.com", ...o,
  };
  return `${r.asin},${r.bill},${r.od},${r.id},${r.st},${r.q},${r.pay},${r.name},${r.dep},${r.sd},${r.ss},${r.ship},"${r.tot}",1.00,${r.site}\n`;
};
const REFUND_HEAD = "Order ID,Refund Amount,Refund Date,Payment Status,Reversal Reason\n";
const ship = (date, cents, card = "1111") => ({ ship_date: date, cents, card, part_gift_card: false });

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("keeps allowed columns only, by header", () => {
  const { shipments } = readOrders(HEAD + line());
  assert.deepEqual(Object.keys(shipments[0].items[0]).sort(), [
    "amount", "asin", "department", "order_date", "order_id", "order_status",
    "payment_method_type", "product_name", "quantity", "ship_date", "shipment_status", "site", "unit_amount",
  ]);
  assert.ok(!JSON.stringify(shipments).includes("ZZ STREET"));
  assert.ok(!JSON.stringify(shipments).includes("ZZ ROAD"));
  assert.throws(() => readOrders("Order ID,Website\nx,y\n"), /missing the column/);
});

test("date filter reads the pacific date", () => {
  const { shipments, counts } = readOrders(HEAD +
    line({ id: "old", od: "2024-09-01T06:00:00Z" }) +
    line({ id: "new", od: "2024-09-01T08:00:00Z" }));
  assert.equal(counts.before_from, 1);
  assert.deepEqual(shipments.map((s) => s.order_id), ["new"]);
});

test("groups by order and ship date, sums totals", () => {
  const { shipments } = readOrders(HEAD +
    line({ tot: "1,000.50" }) + line({ tot: "2.25" }) +
    line({ sd: "2025-01-12T20:00:00Z", tot: "3.00" }) +
    line({ id: "222-2", tot: "4.00" }));
  assert.deepEqual(shipments.map((s) => [s.order_id, s.ship_date, s.cents, s.items.length]), [
    ["111-1", "2025-01-11", 100275, 2], ["111-1", "2025-01-12", 300, 1], ["222-2", "2025-01-11", 400, 1],
  ]);
});

test("cancelled, unshipped, other sites and zero totals stay out, counted", () => {
  const { shipments, counts, otherSiteShipments, bad } = readOrders(HEAD +
    line({ st: "Cancelled" }) + line({ id: "a", sd: "Not Available" }) +
    line({ id: "b", site: "wholefoods.com" }) + line({ id: "c", tot: "0" }) +
    line({ id: "d", tot: "abc" }) + line({ id: "e" }));
  assert.deepEqual(shipments.map((s) => s.order_id), ["e"]);
  assert.equal(counts.cancelled, 1);
  assert.equal(counts.no_ship_date, 1);
  assert.deepEqual(counts.other_site, { "wholefoods.com": 1 });
  assert.equal(counts.zero_total, 1);
  assert.equal(otherSiteShipments.length, 1);
  assert.deepEqual(bad, [6]);
});

test("a row with several ship dates sits on the earliest", () => {
  const { shipments, counts } = readOrders(HEAD + line({ sd: "2025-01-13T20:00:00Z and 2025-01-11T20:00:00Z" }));
  assert.equal(shipments[0].ship_date, "2025-01-11");
  assert.equal(counts.several_ship_dates, 1);
});

test("card labels", () => {
  assert.equal(cardOf("Visa - 1111"), "1111");
  assert.equal(cardOf("Gift Certificate/Card and Visa - 1111"), "1111");
  assert.equal(cardOf("Gift Certificate/Card"), "gift card only");
  assert.equal(cardOf("Not Available"), "not available");
  assert.equal(readOrders(HEAD + line({ pay: "Gift Certificate/Card and Visa - 1111" })).shipments[0].part_gift_card, true);
});

test("refunds: only in-range orders, not-applicable counted", () => {
  const r = readRefunds(REFUND_HEAD +
    "keep,5.25,2025-02-01T20:00:00Z,Completed,ZZ\n" +
    "keep,Not Applicable,Not Applicable,Not Applicable,ZZ\n" +
    "other,1.00,2025-02-01T20:00:00Z,Completed,ZZ\n" +
    "keep,abc,2025-02-01T20:00:00Z,Completed,ZZ\n", new Set(["keep"]));
  assert.deepEqual(r.refunds, [{ order_id: "keep", refund_date: "2025-02-01", amount: "5.25", status: "Completed" }]);
  assert.deepEqual([r.rows, r.notApplicable, r.otherOrders, r.bad], [4, 1, 1, [5]]);
  assert.throws(() => readRefunds("Order ID\nx\n", new Set()), /missing the column/);
});

test("candidates: exact amount, shipped 0 to n days before", () => {
  const s = [ship("2025-01-10", 100)];
  assert.equal(candidates({ date: "2025-01-10", cents: 100 }, s, 3).length, 1);
  assert.equal(candidates({ date: "2025-01-13", cents: 100 }, s, 3).length, 1);
  assert.equal(candidates({ date: "2025-01-14", cents: 100 }, s, 3).length, 0);
  assert.equal(candidates({ date: "2025-01-09", cents: 100 }, s, 7).length, 0);
  assert.equal(candidates({ date: "2025-01-11", cents: 101 }, s, 7).length, 0);
});

test("each match outcome, by card and quarter", () => {
  const a = ship("2025-01-10", 100);
  const b1 = ship("2025-04-01", 200);
  const b2 = ship("2025-04-02", 200);
  const c = ship("2025-05-01", 300);
  const unmatched = ship("2025-06-01", 999, "2222");
  const r = matchAll([
    { date: "2025-01-11", cents: 100, card: "1111" }, // one in both windows
    { date: "2025-04-03", cents: 200, card: "1111" }, // many
    { date: "2025-05-06", cents: 300, card: "3333" }, // none at 3, one at 7
    { date: "2025-07-01", cents: 400, card: "3333" }, // none
  ], [a, b1, b2, c, unmatched]);
  assert.deepEqual(r.total, { charges: 4, d3_one: 1, d3_many: 1, d3_none: 2, d7_one: 2, d7_many: 1, d7_none: 1 });
  assert.equal(r.byCard["3333"].d7_one, 1);
  assert.equal(r.byCard["3333"].d7_none, 1);
  assert.equal(r.byQuarter["2025 Q2"].d3_many, 2 - 1);
  assert.equal(r.noCharge, 1);
  assert.deepEqual(r.shipByCard["2222"], { shipments: 1, no_charge: 1 });
  assert.equal(quarterOf("2025-12-31"), "2025 Q4");
});

test("charge types", () => {
  assert.equal(chargeType("AMZN MKTP US*ZZ"), "shipment");
  assert.equal(chargeType("AMAZON.COM*ZZ"), "shipment");
  assert.equal(chargeType("AMAZON PRIME*ZZ"), "prime or video");
  assert.equal(chargeType("AMZN DIGITAL*ZZ"), "digital");
  assert.equal(chargeType("AMAZON WEB SERVICES"), "web services");
  assert.equal(chargeType("AMAZON TIPS*ZZ"), "tips");
});

test("picks card spend only, counts the rest", () => {
  const byId = new Map([["card", { role: "credit_card", last4: "1111" }], ["bank", { role: "spending_cash", last4: "2222" }]]);
  const row = (o) => ({ account_id: "card", amount: -1.1, description: "AMZN MKTP ZZ", payee: null, kind: "spend", posted_at: "2025-01-11T20:00:00Z", transacted_at: null, ...o });
  const { charges, skipped } = pickCharges([
    row({}),
    row({ account_id: "bank" }),
    row({ kind: "transfer" }),
    row({ description: "AMAZON PRIME*ZZ" }),
    row({ posted_at: "2024-08-01T20:00:00Z" }),
    row({ posted_at: "2025-03-01T20:00:00Z" }),
    row({ posted_at: null }),
    row({ description: "ZZ SHOP" }),
  ], byId, "2025-02-01");
  assert.deepEqual(charges.map((c) => [c.date, c.cents, c.card]), [["2025-01-11", 110, "1111"]]);
  assert.deepEqual(skipped, { not_a_card: 1, transfer: 1, no_date: 1, before_from: 1, after_export: 1, type: { "prime or video": 1 } });
});

test("run reads only and prints no row contents", async () => {
  const d = mkdtempSync(join(tmpdir(), "wb-amazon-test-"));
  dirs.push(d);
  for (const [f, text] of [[ORDERS_FILE, HEAD + line({ tot: "12.34", id: "SECRET-ID" })], [REFUNDS_FILE, REFUND_HEAD]]) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), text);
  }
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(init.method);
    const data = url.includes("wb_accounts") ? [{ id: "card", last4: "1111", role: "credit_card" }] :
      [{ account_id: "card", amount: -12.34, description: "AMZN MKTP ZZ", payee: null, kind: "spend", posted_at: "2025-01-12T20:00:00Z" }];
    return { ok: true, status: 200, json: async () => data };
  };
  const lines = [];
  const code = await run([d], { env: { SUPABASE_SERVICE_ROLE_KEY: "invented" }, fetchFn, log: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.equal(code, 0);
  assert.ok(calls.every((m) => m === "GET"));
  assert.match(out, /0-3 days: one 1 \(100%\)/);
  assert.ok(!/SECRET-ID|ZZ THING|12\.34|1234|MKTP/.test(out));
});

test("missing key is a clear error", async () => {
  const d = mkdtempSync(join(tmpdir(), "wb-amazon-test-"));
  dirs.push(d);
  for (const f of [ORDERS_FILE, REFUNDS_FILE]) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), "x\n");
  }
  const lines = [];
  const code = await run([d], { env: {}, fetchFn: async () => assert.fail("no network"), log: (l) => lines.push(l) });
  assert.equal(code, 2);
  assert.match(lines.join(), /SUPABASE_SERVICE_ROLE_KEY is not set/);
});
