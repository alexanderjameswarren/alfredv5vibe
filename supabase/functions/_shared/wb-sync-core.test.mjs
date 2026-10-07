// Tests for wb-sync-core.ts. Fake values only — no real financial data.
//
// Run:
//   node --test supabase/functions/_shared/wb-sync-core.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "./wb-sync-core.ts";

const DAY = 86_400_000;
const NOW = new Date("2026-10-06T13:00:00Z");

test("window: no previous ok run → 89 days back", () => {
  const start = core.chooseWindowStart(NOW, null);
  assert.equal(NOW - start, 89 * DAY);
});

test("window: recent ok run → 10 days before it", () => {
  const last = new Date(NOW - 1 * DAY);
  assert.equal(core.chooseWindowStart(NOW, last).getTime(), last - 10 * DAY);
});

test("window: old ok run is capped at 89 days", () => {
  const last = new Date(NOW - 200 * DAY);
  assert.equal(NOW - core.chooseWindowStart(NOW, last), 89 * DAY);
});

test("window: boundary at 79 days, overlap and cap meet", () => {
  const last = new Date(NOW - 79 * DAY);
  assert.equal(NOW - core.chooseWindowStart(NOW, last), 89 * DAY);
});

test("localDate uses Pacific time", () => {
  // 05:00 UTC on Oct 7 is still Oct 6 in Los Angeles.
  assert.equal(core.localDate(new Date("2026-10-07T05:00:00Z")), "2026-10-06");
  assert.equal(core.localDate(new Date("2026-10-07T08:00:00Z")), "2026-10-07");
});

test("buildRequest moves credentials to a header and strips them from the URL", () => {
  const { url, authorization } = core.buildRequest(
    "https://fakeuser:fakepass@bridge.example.test/simplefin",
    new Date(1_700_000_000_000),
  );
  assert.equal(url, "https://bridge.example.test/simplefin/accounts?start-date=1700000000&pending=1");
  assert.ok(!url.includes("fake"));
  assert.equal(authorization, `Basic ${btoa("fakeuser:fakepass")}`);
});

test("buildRequest refuses a URL with no credentials", () => {
  assert.throws(() => core.buildRequest("https://bridge.example.test/simplefin", NOW));
});

test("redact removes the URL and its credential parts", () => {
  const secret = "https://fakeuser:fakepass@bridge.example.test/simplefin";
  const msg = `error sending request for url (${secret}/accounts) as fakeuser with fakepass`;
  const out = core.redact(msg, core.secretParts(secret));
  assert.ok(!out.includes("fakeuser") && !out.includes("fakepass") && !out.includes(secret));
});

test("errors: 90-day cap notice is informational", () => {
  const msgs = core.errorMessages({ errors: ["You requested more than 90 days of data; only 90 days returned."] });
  const c = core.classifyErrors(msgs);
  assert.deepEqual(c.blocking, []);
  assert.equal(c.informational.length, 1);
  assert.equal(core.runStatus(c.blocking), "ok");
});

test("errors: the 45-day recommended-range message is a notice", () => {
  const msg = "Requested date range exceeds recommended range of 45 days. In the future, this may be capped.";
  const c = core.classifyErrors(core.errorMessages({ errors: [msg] }));
  assert.deepEqual(c.informational, [msg]);
  assert.deepEqual(c.blocking, []);
  assert.equal(core.runStatus(c.blocking), "ok");
});

test("errors: an unknown message is blocking and marks the run partial", () => {
  const c = core.classifyErrors(core.errorMessages({ errors: ["Connection to Example Bank may need attention"] }));
  assert.deepEqual(c.blocking, ["Connection to Example Bank may need attention"]);
  assert.equal(core.runStatus(c.blocking), "partial");
});

test("errors: a day count without range wording is still blocking", () => {
  const c = core.classifyErrors(["Example Bank has not updated in 5 days; please re-authenticate."]);
  assert.equal(c.blocking.length, 1);
});

test("errors: notices and a blocker together → partial, notice kept apart", () => {
  const c = core.classifyErrors(["Date range limit reached", "Login required for Example Bank"]);
  assert.deepEqual(c.informational, ["Date range limit reached"]);
  assert.deepEqual(c.blocking, ["Login required for Example Bank"]);
});

test("errors: errlist objects are read, duplicates collapse", () => {
  const msgs = core.errorMessages({
    errors: ["Re-login needed"],
    errlist: [{ code: "con.auth", msg: "Re-login needed" }, { message: "Other" }, 42],
  });
  assert.deepEqual(msgs, ["Re-login needed", "Other"]);
});

test("errors: none → ok", () => {
  assert.equal(core.runStatus(core.classifyErrors(core.errorMessages({ errors: [] })).blocking), "ok");
});

test("snapshots: today's manual and import rows are skipped, sync rows replaced", () => {
  const planned = [{ account_id: "a" }, { account_id: "b" }, { account_id: "c" }, { account_id: "d" }];
  const existing = [
    { account_id: "a", source: "manual" },
    { account_id: "b", source: "import" },
    { account_id: "c", source: "sync" },
  ];
  const { write, skipped } = core.filterSnapshotsForUpsert(planned, existing);
  assert.deepEqual(write.map((w) => w.account_id), ["c", "d"]);
  assert.equal(skipped, 2);
});

const pending = (over) => ({
  id: "row",
  account_id: "acct1",
  external_id: "p1",
  transacted_at: new Date(NOW - 5 * DAY).toISOString(),
  posted_at: null,
  first_seen_at: new Date(NOW - 5 * DAY).toISOString(),
  ...over,
});
const START = new Date(NOW - 30 * DAY);

test("pending: covered and not returned → deleted", () => {
  const returned = new Map([["acct1", new Set(["other"])]]);
  assert.deepEqual(core.pendingRowsToDelete([pending()], returned, START), ["row"]);
});

test("pending: run with blocking errors deletes nothing", () => {
  const returned = new Map([["acct1", new Set()]]);
  assert.deepEqual(core.pendingRowsToDelete([pending()], returned, START, true), []);
});

test("pending: returned again → kept", () => {
  const returned = new Map([["acct1", new Set(["p1"])]]);
  assert.deepEqual(core.pendingRowsToDelete([pending()], returned, START), []);
});

test("pending: dated before the window → kept", () => {
  const returned = new Map([["acct1", new Set()]]);
  const old = pending({ transacted_at: new Date(NOW - 60 * DAY).toISOString() });
  assert.deepEqual(core.pendingRowsToDelete([old], returned, START), []);
});

test("pending: account missing from the response → kept", () => {
  assert.deepEqual(core.pendingRowsToDelete([pending()], new Map(), START), []);
});

test("pending: no transacted or posted date falls back to first_seen_at", () => {
  const returned = new Map([["acct1", new Set()]]);
  const undated = pending({ transacted_at: null, first_seen_at: new Date(NOW - 60 * DAY).toISOString() });
  assert.deepEqual(core.pendingRowsToDelete([undated], returned, START), []);
});

test("parseLast4", () => {
  assert.equal(core.parseLast4("Example Checking (1234)"), "1234");
  assert.equal(core.parseLast4("Example Card ...5678"), "5678");
  assert.equal(core.parseLast4("Example Card 123456"), null);
  assert.equal(core.parseLast4("Savings"), null);
});

test("money keeps strings exact and rejects junk", () => {
  assert.equal(core.money("-12.34"), "-12.34");
  assert.equal(core.money(5), "5");
  assert.equal(core.money("abc"), null);
  assert.equal(core.money(""), null);
});

test("unixToIso: 0 and junk are null", () => {
  assert.equal(core.unixToIso(0), null);
  assert.equal(core.unixToIso("x"), null);
  assert.equal(core.unixToIso(1_700_000_000), "2023-11-14T22:13:20.000Z");
});

test("mapTransaction keeps the raw object and the sign", () => {
  const owner = { user_id: "u", context_id: "c" };
  const t = { id: "t1", posted: 0, transacted_at: 1_700_000_000, amount: "-9.99", description: "EXAMPLE", pending: true };
  const row = core.mapTransaction(t, "acct1", owner, "2026-10-06T00:00:00.000Z");
  assert.equal(row.amount, "-9.99");
  assert.equal(row.posted_at, null);
  assert.equal(row.pending, true);
  assert.equal(row.raw, t);
});

const OWNER = { user_id: "u", context_id: "c" };
const T1 = { id: "t1", posted: 1_700_000_000, transacted_at: 1_700_000_000, amount: "-9.90", description: "EXAMPLE", pending: false, extra: { a: 1, b: 2 } };
// What Postgres hands back: other timestamp text, numeric as a number, jsonb keys reordered.
const STORED = {
  posted_at: "2023-11-14T22:13:20+00:00",
  transacted_at: "2023-11-14T22:13:20+00:00",
  amount: -9.9,
  description: "EXAMPLE",
  payee: null,
  memo: null,
  mcc: null,
  pending: false,
  raw: { transacted_at: 1_700_000_000, pending: false, extra: { b: 2, a: 1 }, posted: 1_700_000_000, id: "t1", description: "EXAMPLE", amount: "-9.90" },
};

test("transactionChanged: same values in Postgres form → unchanged", () => {
  assert.equal(core.transactionChanged(STORED, core.mapTransaction(T1, "acct1", OWNER, "x")), false);
});

test("transactionChanged: a pending row that posts → changed", () => {
  const was = { ...STORED, posted_at: null, pending: true, raw: { ...STORED.raw, posted: 0, pending: true } };
  assert.equal(core.transactionChanged(was, core.mapTransaction(T1, "acct1", OWNER, "x")), true);
});

test("transactionChanged: amount or description change → changed", () => {
  assert.equal(core.transactionChanged(STORED, core.mapTransaction({ ...T1, amount: "-10.00" }, "acct1", OWNER, "x")), true);
  assert.equal(core.transactionChanged(STORED, core.mapTransaction({ ...T1, description: "OTHER" }, "acct1", OWNER, "x")), true);
});

const RUN = "00000000-0000-0000-0000-000000000001";

test("alert: names the institution when the message mentions it", () => {
  const a = core.alertFor(
    { message: "Connection to Example Bank may need attention", failureKind: null },
    ["Example Bank", "Other Credit Union"], RUN, "2026-10-07",
  );
  assert.equal(a.title, "Example Bank connection needs attention in SimpleFIN");
  assert.ok(a.text.startsWith(a.title));
  assert.ok(a.text.includes('SimpleFIN said: "Connection to Example Bank may need attention"'));
  assert.ok(a.text.includes(RUN));
});

test("alert: generic title when no institution matches", () => {
  const a = core.alertFor({ message: "Something odd", failureKind: null }, ["Example Bank"], RUN, "2026-10-07");
  assert.equal(a.title, "A bank connection needs attention in SimpleFIN");
});

test("alert: failed runs get a sync-level title", () => {
  assert.match(core.alertFor({ message: "HTTP 403", failureKind: "auth" }, [], RUN, "d").title, /access URL may need renewing/);
  assert.equal(core.alertFor({ message: "x", failureKind: "network" }, [], RUN, "d").title, "The daily money sync failed");
});

test("alert: no URLs survive into the item", () => {
  const a = core.alertFor(
    { message: "Fix it at https://bridge.example.test/connections/42 now", failureKind: null }, [], RUN, "d",
  );
  assert.ok(!/https?:\/\//.test(a.text));
  assert.ok(a.text.includes("[link removed]"));
});

test("errorKey: ignores case, spacing and numbers; differs for different problems", () => {
  assert.equal(core.errorKey("Not updated in 3 days"), core.errorKey("not  updated in 14 DAYS"));
  assert.notEqual(core.errorKey("Login required for Example Bank"), core.errorKey("Login required for Other Bank"));
  assert.match(core.errorKey("x"), /^wb-sync:[0-9a-f]{8}$/);
});

test("planAlerts: one per distinct error, none while one is open", () => {
  const a = core.alertFor({ message: "Login required for Example Bank", failureKind: null }, [], RUN, "d");
  const b = core.alertFor({ message: "Login required for Other Bank", failureKind: null }, [], RUN, "d");
  const a2 = core.alertFor({ message: "login required for example bank", failureKind: null }, [], RUN, "d");
  assert.deepEqual(core.planAlerts([a, b, a2], new Set()).map((x) => x.key), [a.key, b.key]);
  assert.deepEqual(core.planAlerts([a, b], new Set([a.key])).map((x) => x.key), [b.key]);
  assert.deepEqual(core.planAlerts([a], new Set([a.key])), []);
});

test("simulated message classifies as blocking", () => {
  assert.deepEqual(core.classifyErrors([core.SIMULATED_MESSAGE]).blocking, [core.SIMULATED_MESSAGE]);
});

test("mapAccount sets only sync-owned columns", () => {
  const row = core.mapAccount(
    { id: "ACT-1", name: "Example Card (4321)", currency: "USD", org: { name: "Example Bank" } },
    { user_id: "u", context_id: "c" },
    "2026-10-06T00:00:00.000Z",
  );
  assert.deepEqual(Object.keys(row).sort(), [
    "context_id", "currency", "external_id", "institution", "last4", "last_synced_at", "name", "source", "user_id",
  ]);
  assert.equal(row.last4, "4321");
});
