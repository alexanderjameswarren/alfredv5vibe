// Invented data only. Run: node --test tools/warren-buffet/import/history_import.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "./history_import.mjs";
import {
  CNB_FILE, cnbDate, money, pacificDate, pacificNoon, parseCsv, readCnb, readWellsFargo,
  splitAtCutoff, toRow, wfDate, withExternalIds,
} from "./history_lib.mjs";

const WF_HEAD = '"DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"\n';
const CNB_TOP = '"Accounts: x"\n"","","","","","",""\n"Date Range: x"\n""\n""\n""\n' +
  '"POSTED DATE","MERCHANT","ACCOUNT NUMBER","TRANSACTION TYPE","CATEGORY","CREDITS","DEBITS"\n';

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function folder(files) {
  const d = mkdtempSync(join(tmpdir(), "wb-import-test-"));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

// A fake PostgREST that records every call.
function fakeDb({ cutoffs = {}, present = [] } = {}) {
  const calls = [];
  const accounts = ["5239", "9881", "5819", "2756", "5485", "3782", "8560", "6900"].map((last4) => ({
    id: `acct-${last4}`, user_id: "u", context_id: "c", last4, history_from: null,
  }));
  const fetchFn = async (url, init) => {
    const path = url.split("/rest/v1/")[1];
    calls.push({ method: init.method, path, body: init.body && JSON.parse(init.body) });
    let data = [];
    if (init.method === "POST" && path.startsWith("wb_transactions")) data = JSON.parse(init.body).map((_, i) => ({ id: `t${i}` }));
    else if (init.method === "GET" && path.startsWith("wb_accounts")) data = accounts;
    else if (path.includes("posted_at=not.is.null")) {
      const a = accounts.find((x) => path.includes(x.id));
      data = cutoffs[a.last4] ? [{ posted_at: `${cutoffs[a.last4]}T19:00:00Z` }] : [];
    } else if (path.includes("external_id=in.")) data = present.filter((id) => path.includes(id)).map((external_id) => ({ external_id }));
    return { ok: true, status: 200, json: async () => data };
  };
  return { calls, fetchFn };
}

const env = { SUPABASE_SERVICE_ROLE_KEY: "invented-key" };
const ELISE = "CheckingElise5239.csv";
const wfFile = WF_HEAD + '"01/15/2025","ZZ SHOP","-1.50","","Posted"\n"02/01/2025","ZZ LATE","-2.00","","Posted"\n';

async function exec(args, db) {
  const lines = [];
  const code = await run(args, { env, fetchFn: db.fetchFn, log: (l) => lines.push(l) });
  return { code, out: lines.join("\n") };
}

test("wells fargo columns", () => {
  const { rows, bad } = readWellsFargo(WF_HEAD + '"01/15/2025","ZZ, SHOP","-1,234.50","","Pending"\n"bad","x","1","","Posted"\n', "9881");
  assert.deepEqual(bad, [3]);
  assert.equal(rows[0].date, "2025-01-15");
  assert.equal(rows[0].description, "ZZ, SHOP");
  assert.equal(rows[0].amount, "-1234.50");
  assert.throws(() => readWellsFargo('"DATE","AMOUNT"\n', "9881"), /Wells Fargo columns/);
});

test("check number goes in memo", () => {
  const { rows } = readWellsFargo(WF_HEAD + '"01/15/2025","ZZ CHECK","-5.00","1234","Posted"\n"01/16/2025","ZZ","-5.00",,"Posted"\n', "9881");
  assert.equal(rows[0].memo, "CHECK # 1234");
  assert.equal(rows[1].memo, null);
});

test("cnb columns and two amount columns", () => {
  const { rows, bad } = readCnb(CNB_TOP +
    '"Jan 05 2025","ZZ IN","*8560","T","C","+$1,000.25",""\n' +
    '"Feb 06 2025","ZZ, OUT","*6900","T","C","","-$20.5"\n' +
    '"Mar 07 2025","ZZ BOTH","*8560","T","C","+$1","-$1"\n' +
    '"Mar 08 2025","ZZ OTHER","*1111","T","C","+$1",""\n' +
    '"","","","","","",""\n');
  assert.deepEqual(rows.map((r) => [r.last4, r.date, r.amount]), [["8560", "2025-01-05", "1000.25"], ["6900", "2025-02-06", "-20.50"]]);
  assert.deepEqual(bad, [10, 11]);
  assert.ok(!JSON.stringify(rows).includes("*8560"));
});

test("dates and money", () => {
  assert.equal(wfDate("02/30/2025"), null);
  assert.equal(cnbDate("Mar 07 2025"), "2025-03-07");
  assert.equal(money("abc"), null);
  assert.equal(money("12"), "12.00");
  assert.equal(money("-$1,000.250"), "-1000.25");
  assert.equal(money("+$12.345"), null);
  assert.deepEqual(parseCsv('"a ""b""",c\r\n').map((r) => r.cells), [['a "b"', "c"]]);
});

test("cutoff keeps only earlier rows", () => {
  const rows = [{ date: "2026-07-09" }, { date: "2026-07-10" }, { date: "2026-07-11" }];
  assert.deepEqual(splitAtCutoff(rows, "2026-07-10"), { keep: [rows[0]], skipped: 2 });
  assert.equal(splitAtCutoff(rows, null).keep.length, 3);
});

test("identical rows get distinct occurrences, stable across runs", () => {
  const r = { last4: "3782", date: "2025-01-01", amount: "-1.00", description: "ZZ" };
  const a = withExternalIds([r, r, { ...r, date: "2025-01-02" }]);
  assert.deepEqual(a.map((x) => x.occurrence), [1, 2, 1]);
  assert.equal(new Set(a.map((x) => x.external_id)).size, 3);
  assert.ok(a[0].external_id.startsWith("history-import-"));
  assert.equal(withExternalIds([r])[0].external_id, a[0].external_id);
});

test("rows are posted, marked imported, at noon pacific on their date", () => {
  for (const d of ["2025-01-15", "2025-07-15", "2025-03-09", "2025-11-02"]) assert.equal(pacificDate(pacificNoon(d)), d);
  const row = toRow({ date: "2025-01-15", amount: "-1.00", description: "ZZ", memo: null, raw: {}, external_id: "x" },
    { id: "a", user_id: "u", context_id: "c" });
  assert.equal(row.source, "history_import");
  assert.equal(row.pending, false);
});

test("dry run writes nothing and prints no row contents", async () => {
  const db = fakeDb({ cutoffs: { 5239: "2025-02-01" } });
  const { code, out } = await exec([folder({ [ELISE]: wfFile }), "--only", ELISE], db);
  assert.equal(code, 0);
  assert.ok(db.calls.every((c) => c.method === "GET"));
  assert.match(out, /rows read: 2 {2}before cutoff: 1 {2}skipped: 1/);
  assert.match(out, /DRY RUN CLEAN/);
  assert.ok(!/ZZ SHOP|1\.50/.test(out));
});

test("present id makes the run unclean, with no code", async () => {
  const dir = folder({ [ELISE]: wfFile });
  const [first] = withExternalIds(readWellsFargo(wfFile, "5239").rows);
  const { code, out } = await exec([dir, "--only", ELISE], fakeDb({ present: [first.external_id] }));
  assert.equal(code, 1);
  assert.match(out, /already present 1/);
  assert.ok(!/Code for/.test(out));
});

test("unreadable row makes the run unclean", async () => {
  const dir = folder({ [ELISE]: WF_HEAD + '"bad","ZZ","-1.00","","Posted"\n' });
  const { code, out } = await exec([dir, "--only", ELISE], fakeDb());
  assert.equal(code, 1);
  assert.match(out, /unreadable: 1/);
});

test("write refuses without a code, or with one from different files", async () => {
  const db = fakeDb();
  const dir = folder({ [ELISE]: wfFile });
  assert.equal((await exec([dir, "--only", ELISE, "--write"], db)).code, 2);
  const code = /files and cutoffs: (\w+)/.exec((await exec([dir, "--only", ELISE], db)).out)[1];
  writeFileSync(join(dir, ELISE), wfFile + '"03/01/2025","ZZ NEW","-3.00","","Posted"\n');
  const r = await exec([dir, "--only", ELISE, "--write", "--confirm", code], db);
  assert.equal(r.code, 1);
  assert.match(r.out, /REFUSED/);
  assert.ok(db.calls.every((c) => c.method === "GET"));
});

test("write inserts, sets history_from, processes", async () => {
  const db = fakeDb();
  const dir = folder({ [CNB_FILE]: CNB_TOP + '"Jan 05 2025","ZZ IN","*8560","T","C","+$1.00",""\n' });
  const code = /files and cutoffs: (\w+)/.exec((await exec([dir, "--only", CNB_FILE], db)).out)[1];
  const r = await exec([dir, "--only", CNB_FILE, "--write", "--confirm", code], db);
  assert.equal(r.code, 0);
  const insert = db.calls.find((c) => c.method === "POST" && c.path.startsWith("wb_transactions"));
  assert.equal(insert.body[0].source, "history_import");
  assert.equal(insert.body[0].account_id, "acct-8560");
  assert.deepEqual(db.calls.find((c) => c.method === "PATCH").body, { history_from: "2025-01-05" });
  assert.ok(db.calls.some((c) => c.path === "rpc/wb_process_transactions"));
});

test("missing key is a clear error", async () => {
  const lines = [];
  const code = await run([folder({})], { env: {}, fetchFn: async () => assert.fail("no network"), log: (l) => lines.push(l) });
  assert.equal(code, 2);
  assert.match(lines.join(), /SUPABASE_SERVICE_ROLE_KEY is not set/);
});
