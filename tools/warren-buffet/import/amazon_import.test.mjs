// Invented data only. Run: node --test tools/warren-buffet/import/amazon_import.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { ORDERS_FILE, REFUNDS_FILE, chooseMatches, placeRefunds } from "./amazon_lib.mjs";
import { run } from "./amazon_import.mjs";

const HEAD = "ASIN,Billing Address,Order Date,Order ID,Order Status,Original Quantity,Payment Method Type,Product Name,Department,Ship Date,Shipment Status,Shipping Address,Total Amount,Unit Price,Website\n";
const line = (id, tot, site = "Amazon.com", name = "ZZ THING") =>
  `ZZ1,ZZ STREET,2025-01-10T20:00:00Z,${id},Closed,2,Visa - 1111,${name},ZZ DEPT,2025-01-11T20:00:00Z,Shipped,ZZ ROAD,"${tot}",1.50,${site}\n`;
const FILE = HEAD + line("A-1", "10.00") + line("A-1", "2.50") + line("A-2", "7.00") + line("B-1", "3.00", "wholefoods.com", "ZZ BEANS") + line("A-3", "0");

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const REFUND_HEAD = "Order ID,Refund Amount,Refund Date,Payment Status\n";

function folder(text = FILE, refunds = REFUND_HEAD) {
  const d = mkdtempSync(join(tmpdir(), "wb-amazon-import-"));
  dirs.push(d);
  for (const [f, body] of [[ORDERS_FILE, text], [REFUNDS_FILE, refunds]]) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}

// A fake PostgREST that records every call.
function fakeDb({ existing = [], failOn = null } = {}) {
  const calls = [];
  const debit = (id, amount, day) => ({ id, account_id: "card", amount, description: "AMZN MKTP ZZ", payee: null, kind: "spend", posted_at: `2025-01-${day}T20:00:00Z`, transacted_at: null, source: "sync" });
  const fetchFn = async (url, init) => {
    const path = url.split("/rest/v1/")[1];
    const body = init.body && JSON.parse(init.body);
    calls.push({ method: init.method, path, body, prefer: init.headers.Prefer });
    if (failOn && init.method === "POST" && path.startsWith(failOn)) {
      return { ok: false, status: 409, json: async () => ({ code: "23505", message: "duplicate", details: "ZZ SECRET ROW" }) };
    }
    let data = [];
    if (path.startsWith("wb_accounts")) data = [{ id: "card", last4: "1111", role: "credit_card", user_id: "u", context_id: "c" }];
    else if (init.method === "GET" && path.startsWith("wb_transactions")) data = [debit("t1", -12.5, "12"), debit("t2", -7, "20"), debit("t3", -99, "12")];
    else if (init.method === "GET" && path.startsWith("wb_orders")) data = existing;
    else if (init.method === "POST" && path.startsWith("wb_orders")) data = body.map((o, i) => ({ id: `o${i}`, site: o.site, order_number: o.order_number, ship_date: o.ship_date }));
    else if (init.method === "POST") data = body.map((_, i) => ({ id: `r${i}` }));
    // As PostgREST: an insert answers 201, and return=minimal leaves the body empty.
    if (init.method === "POST" && !/return=representation/.test(init.headers.Prefer ?? "")) {
      return { ok: true, status: 201, json: async () => JSON.parse("") };
    }
    return { ok: true, status: init.method === "POST" ? 201 : 200, json: async () => data };
  };
  return { calls, fetchFn };
}

async function exec(args, db) {
  const lines = [];
  const code = await run(args, { env: { SUPABASE_SERVICE_ROLE_KEY: "invented-key" }, fetchFn: db.fetchFn, log: (l) => lines.push(l) });
  return { code, out: lines.join("\n") };
}
const codeOf = (out) => /these matches: (\w+)/.exec(out)[1];

test("match rule: 0 to 3 days, one shipment, one charge", () => {
  const ship = (d, cents) => ({ ship_date: d, cents });
  const one = ship("2025-01-10", 100);
  const twinA = ship("2025-02-01", 200);
  const twinB = ship("2025-02-02", 200);
  const claimed = ship("2025-03-01", 300);
  const late = ship("2025-04-01", 400);
  const { matches, shared } = chooseMatches([
    { id: "a", date: "2025-01-13", cents: 100 },
    { id: "b", date: "2025-02-03", cents: 200 },
    { id: "c", date: "2025-03-01", cents: 300 },
    { id: "d", date: "2025-03-02", cents: 300 },
    { id: "e", date: "2025-04-05", cents: 400 },
  ], [one, twinA, twinB, claimed, late]);
  assert.deepEqual(matches.map((m) => [m.charge.id, m.days_apart]), [["a", 3]]);
  assert.equal(shared, 1);
});

test("refunds land on the only line, or the line of exactly that total, never a guess", () => {
  const item = (amount) => ({ amount });
  const only = item("10.00"), a = item("3.00"), b = item("4.00"), c = item("5.00"), twinA = item("6.00"), twinB = item("6.00");
  const shipments = [
    { order_id: "one", items: [only] },
    { order_id: "many", items: [a] }, { order_id: "many", items: [b] },
    { order_id: "unsure", items: [c, item("7.00")] },
    { order_id: "twins", items: [twinA, twinB] },
  ];
  const r = (order_id, amount, refund_date) => ({ order_id, amount, refund_date });
  const res = placeRefunds(shipments, [
    r("one", "2.00", "2025-03-01"), r("one", "1.00", "2025-02-01"),
    r("many", "4.00", "2025-02-01"),
    r("unsure", "1.00", "2025-02-01"),
    r("twins", "6.00", "2025-02-01"), r("twins", "6.00", "2025-02-02"),
  ]);
  assert.deepEqual(res, { placed: 5, unplaced: 1 });
  assert.deepEqual([only.refunded_cents, only.refund_date], [300, "2025-03-01"]);
  assert.equal(b.refunded_cents, 400);
  assert.equal(a.refunded_cents, undefined);
  assert.equal(c.refunded_cents, undefined);
  assert.deepEqual([twinA.refunded_cents, twinB.refunded_cents], [600, 600]);
});

test("the writer stores placed refunds, and a changed refund file voids the code", async () => {
  const refunds = REFUND_HEAD + "A-2,7.00,2025-02-01T20:00:00Z,Completed\nA-1,1.00,2025-02-01T20:00:00Z,Completed\n";
  const db = fakeDb();
  const d = folder(FILE, refunds);
  const dry = await exec([d], db);
  assert.match(dry.out, /placed on an item 1, could not be placed 1/);
  assert.ok(!/7\.00/.test(dry.out));
  const code = codeOf(dry.out);
  assert.equal((await exec([d, "--write", "--confirm", code], db)).code, 0);
  const items = db.calls.find((c) => c.path.startsWith("wb_order_items")).body;
  assert.deepEqual(items.filter((i) => i.refunded_amount).map((i) => [i.order_id, i.refunded_amount, i.refund_date]), [["o1", "7.00", "2025-02-01"]]);
  assert.equal(items[0].refunded_amount, null);
  writeFileSync(join(d, REFUNDS_FILE), REFUND_HEAD);
  assert.equal((await exec([d, "--write", "--confirm", code], db)).code, 1);
});

test("an unreadable refund makes the run unclean", async () => {
  const { code, out } = await exec([folder(FILE, REFUND_HEAD + "A-1,abc,2025-02-01T20:00:00Z,Completed\n")], fakeDb());
  assert.equal(code, 1);
  assert.match(out, /NOT CLEAN/);
});

test("dry run writes nothing and prints no row contents", async () => {
  const db = fakeDb();
  const { code, out } = await exec([folder()], db);
  assert.equal(code, 0);
  assert.ok(db.calls.every((c) => c.method === "GET"));
  assert.match(out, /Amazon: shipments 3, items 4/);
  assert.match(out, /Whole Foods: shipments 1, items 1/);
  assert.match(out, /matches to write 1/);
  assert.match(out, /DRY RUN CLEAN/);
  assert.ok(!/A-1|ZZ THING|ZZ BEANS|12\.50/.test(out));
});

test("rows already present make the run unclean, with no code", async () => {
  const { code, out } = await exec([folder()], fakeDb({ existing: [{ id: "x" }] }));
  assert.equal(code, 1);
  assert.match(out, /NOT CLEAN/);
  assert.ok(!/Code for/.test(out));
});

test("an unreadable row makes the run unclean", async () => {
  const { code, out } = await exec([folder(HEAD + line("A-1", "abc"))], fakeDb());
  assert.equal(code, 1);
  assert.match(out, /Unreadable rows: 1/);
});

test("write refuses without a code, or with one from a different file", async () => {
  const db = fakeDb();
  const d = folder();
  assert.equal((await exec([d, "--write"], db)).code, 2);
  const code = codeOf((await exec([d], db)).out);
  writeFileSync(join(d, ORDERS_FILE), FILE + line("A-9", "1.00"));
  const r = await exec([d, "--write", "--confirm", code], db);
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSED/);
  assert.ok(db.calls.every((c) => c.method === "GET"));
});

test("write inserts orders, items and matches, and no splits", async () => {
  const db = fakeDb();
  const d = folder();
  const code = codeOf((await exec([d], db)).out);
  const r = await exec([d, "--write", "--confirm", code], db);
  assert.equal(r.code, 0);
  const posts = db.calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => c.path.split("?")[0]), ["wb_orders", "wb_order_items", "wb_order_matches"]);
  const [orders, items, matches] = posts.map((c) => c.body);
  assert.deepEqual(orders.map((o) => [o.site, o.order_number, o.amount]), [
    ["amazon", "A-1", "12.50"], ["amazon", "A-2", "7.00"], ["amazon", "A-3", "0.00"], ["wholefoods", "B-1", "3.00"],
  ]);
  assert.deepEqual(items.map((i) => [i.order_id, i.line_no, i.site, i.quantity, i.unit_amount, i.line_amount]), [
    ["o0", 1, "amazon", 2, "1.50", "10.00"], ["o0", 2, "amazon", 2, "1.50", "2.50"], ["o1", 1, "amazon", 2, "1.50", "7.00"],
    ["o2", 1, "amazon", 2, "1.50", "0.00"], ["o3", 1, "wholefoods", 2, "1.50", "3.00"],
  ]);
  assert.deepEqual(matches, [{ user_id: "u", context_id: "c", order_id: "o0", transaction_id: "t1", days_apart: 1 }]);
  const stored = JSON.stringify([orders, items]);
  assert.ok(!/ZZ STREET|ZZ ROAD/.test(stored));
});

test("an insert's reply never stops the write, across chunks", async () => {
  const many = Array.from({ length: 450 }, (_, i) => line(`A-${i}`, "1.00")).join("");
  const db = fakeDb();
  const d = folder(HEAD + line("A-M", "12.50") + many);
  const code = codeOf((await exec([d], db)).out);
  const r = await exec([d, "--write", "--confirm", code], db);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Inserted items: 451/);
  assert.match(r.out, /Inserted matches: 1/);
  assert.match(r.out, /WRITE DONE/);
  const posts = db.calls.filter((c) => c.method === "POST");
  assert.equal(posts.filter((c) => c.path.startsWith("wb_order_items")).length, 3);
  assert.ok(posts.every((c) => /return=representation/.test(c.prefer)));
});

test("a failed write stops there, with no retry and no row detail", async () => {
  const db = fakeDb({ failOn: "wb_order_items" });
  const d = folder();
  const code = codeOf((await exec([d], db)).out);
  const r = await exec([d, "--write", "--confirm", code], db);
  assert.equal(r.code, 2);
  assert.match(r.out, /POST wb_order_items failed: 409 23505 duplicate/);
  assert.ok(!r.out.includes("ZZ SECRET ROW"));
  const posts = db.calls.filter((c) => c.method === "POST").map((c) => c.path.split("?")[0]);
  assert.deepEqual(posts, ["wb_orders", "wb_order_items"]);
});
