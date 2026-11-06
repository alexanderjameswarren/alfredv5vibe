// Handler tests for signals.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/signals.test.mjs
//
// Loads _shared/ as test-platform.mjs does, and also stubs npm:web-push (as alfred-push.test.mjs does), since
// deliver_signals sends pushes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settingsFor, withSettings } from "./test-platform.mjs";

const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "signals-"));
cpSync(SHARED, join(dir, "_shared"), { recursive: true, filter: (src) => !src.endsWith(".test.mjs") });
const platform = join(dir, "_shared", "platform.ts");
writeFileSync(platform, readFileSync(platform, "utf-8").split("\n").filter((l) => !/^import .*"jsr:/.test(l)).join("\n")
  .replace("export function defineTool<", "function realDefineTool<") + "\nexport const defineTool = (o) => o;\n");
const sender = join(dir, "_shared", "web-push-send.ts");
const IMPORT = 'import webpush from "npm:web-push@3.6.7";';
if (!readFileSync(sender, "utf-8").includes(IMPORT)) throw new Error("web-push-send.ts import changed — update this test.");
writeFileSync(sender, readFileSync(sender, "utf-8").replace(IMPORT, 'import webpush from "./stub_webpush.ts";'));
writeFileSync(join(dir, "_shared", "stub_webpush.ts"), "export default globalThis.__webpush;\n");

const sends = [];
globalThis.__webpush = {
  setVapidDetails: () => {},
  sendNotification: async (sub, payload) => { sends.push(JSON.parse(payload)); return { statusCode: 201 }; },
};
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID = { VAPID_SUBJECT: "mailto:a@b.c", VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString("base64url") };
let ENV = VAPID;
globalThis.Deno = { env: { get: (n) => ENV[n] } };
const m = await import(pathToFileURL(join(dir, "_shared", "tools", "signals.ts")).href);
const SIGNAL_SETTINGS = settingsFor("signals", ["id", "user_id", "app", "job", "severity", "subject_key", "title",
  "body", "link", "started_by", "source_ref", "state", "outcome", "reason", "decided_at", "decided_run_id", "inbox_id",
  "notification_id", "merged_into", "bundle_id", "details", "created_at", "updated_at"]);

/** Fake db: chains resolve to `rows`; rpc answers from `rpcs`. Every call is logged. */
function fakeDb({ rows = [], rpcs = {} } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") return (res) => res({ data: rows, error: null, count: rows.length });
          return (...args) => { calls.push([table, k, ...args]); return b; };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      return Promise.resolve(rpcs[name] ?? { data: null, error: null });
    },
  };
  return withSettings(db, [SIGNAL_SETTINGS]);
}

const ARGS = { app: "warren_buffet", job: "wb-sync", severity: "high", subject_key: "wb-sync:failure",
  title: "Bank sync failed", started_by: "task:wb-sync" };
const created = { raise_signal: { data: { created: true, id: "s1" }, error: null } };

test("both tools are tier 1 and declare their tables", () => {
  assert.equal(m.raiseSignalTool.tier, 1);
  assert.equal(m.getSignalsTool.tier, 1);
  assert.deepEqual(m.raiseSignalTool.tables.writes, ["signals"]);
  assert.deepEqual(m.getSignalsTool.tables.writes, []);
});

test("raise: passes every field, trimmed, nulls for what is absent", async () => {
  const db = fakeDb({ rpcs: created });
  const out = await m.raiseSignalTool.handler({ ...ARGS, body: "  HTTP 524  ", link: "/abc",
    source_ref: "run-1", details: { run_id: "r1" } }, { db });
  assert.deepEqual(out, { created: true, id: "s1" });
  const [, , p] = db.calls.find(([t, n]) => t === "rpc" && n === "raise_signal");
  assert.equal(p.p_body, "HTTP 524");
  assert.equal(p.p_link, "/abc");
  assert.equal(p.p_started_by, "task:wb-sync");
  assert.equal(p.p_source_ref, "run-1");
  assert.deepEqual(p.p_details, { run_id: "r1" });
  assert.ok(!("p_user_id" in p), "the tool never names a user");

  const db2 = fakeDb({ rpcs: created });
  await m.raiseSignalTool.handler(ARGS, { db: db2 });
  const [, , q] = db2.calls.find(([t, n]) => t === "rpc" && n === "raise_signal");
  assert.equal(q.p_body, null);
  assert.equal(q.p_link, null);
  assert.equal(q.p_source_ref, null);
  assert.equal(q.p_details, null);
});

test("raise: a repeated source_ref comes back as created false, not an error", async () => {
  const db = fakeDb({ rpcs: { raise_signal: { data: { created: false, id: "s0", duplicate_of: { state: "queued" } },
    error: null } } });
  const out = await m.raiseSignalTool.handler({ ...ARGS, source_ref: "run-1" }, { db });
  assert.equal(out.created, false);
});

test("raise: bad input is refused before the database", async () => {
  const db = fakeDb();
  const bad = [
    [{ severity: "loud" }, /`severity` must be one of/],
    [{ subject_key: "Has Spaces" }, /`subject_key` must be/],
    [{ started_by: "cron" }, /`started_by` must be/],
    [{ started_by: undefined }, /`started_by` must be/],
    [{ link: "https://x.example" }, /must be an Alfred path/],
    [{ title: " " }, /`title` is required/],
    [{ details: [1] }, /`details` must be an object/],
    [{ source_ref: "x".repeat(301) }, /at most 300/],
  ];
  for (const [patch, re] of bad) await assert.rejects(m.raiseSignalTool.handler({ ...ARGS, ...patch }, { db }), re);
  assert.equal(db.calls.length, 0);
});

test("raise: the database's refusal is a validation error", async () => {
  const db = fakeDb({ rpcs: { raise_signal: { data: null,
    error: { code: "22023", message: 'raise_signal: unknown app "wb". Use an id from get_apps.' } } } });
  await assert.rejects(m.raiseSignalTool.handler({ ...ARGS, app: "wb" }, { db }),
    /validation error: raise_signal: unknown app "wb"/);
});

test("resolve: tier 1; passes app, subject or prefix, and started_by; returns what was resolved", async () => {
  assert.equal(m.resolveSignalTool.tier, 1);
  const db = fakeDb({ rpcs: { resolve_signal: { data: { resolved: ["wb-sync:failure:wb-sync:1a2b3c4d"], dropped: 1 },
    error: null } } });
  const out = await m.resolveSignalTool.handler({ app: "warren_buffet", subject_key: "wb-sync:failure",
    started_by: "task:wb-sync" }, { db });
  assert.deepEqual(out.resolved, ["wb-sync:failure:wb-sync:1a2b3c4d"]);
  const [, , p] = db.calls.find(([t, n]) => t === "rpc" && n === "resolve_signal");
  assert.deepEqual(p, { p_app: "warren_buffet", p_subject_key: "wb-sync:failure", p_started_by: "task:wb-sync" });
});

test("resolve: bad input is refused before the database", async () => {
  const db = fakeDb();
  await assert.rejects(m.resolveSignalTool.handler({ app: "warren_buffet", subject_key: "Bad Key", started_by: "chat" }, { db }),
    /`subject_key` must be/);
  await assert.rejects(m.resolveSignalTool.handler({ app: "warren_buffet", subject_key: "x", started_by: "bot" }, { db }),
    /`started_by` must be/);
  assert.equal(db.calls.length, 0);
});

test("get: filters, newest first", async () => {
  const db = fakeDb({ rows: [{ id: "s1", state: "held" }] });
  const out = await m.getSignalsTool.handler({ app: "warren_buffet", state: "held", severity: "high",
    subject_key: "wb-sync:failure", since: "2026-11-01T00:00:00Z", until: "2026-11-03T00:00:00Z" }, { db });
  assert.equal(out.data.length, 1);
  for (const [c, v] of [["app", "warren_buffet"], ["state", "held"], ["severity", "high"], ["subject_key", "wb-sync:failure"]]) {
    assert.ok(db.calls.some(([t, k, col, val]) => t === "signals" && k === "eq" && col === c && val === v), c);
  }
  assert.ok(db.calls.some(([, k, c, v]) => k === "gte" && c === "created_at" && v === "2026-11-01T00:00:00Z"));
  assert.ok(db.calls.some(([, k, c, v]) => k === "lt" && c === "created_at" && v === "2026-11-03T00:00:00Z"));
  assert.ok(db.calls.some(([, k, c, o]) => k === "order" && c === "created_at" && o.ascending === false));
});

test("get: bad filters are refused", async () => {
  const db = fakeDb();
  await assert.rejects(m.getSignalsTool.handler({ state: "sent" }, { db }), /`state` must be one of/);
  await assert.rejects(m.getSignalsTool.handler({ since: "yesterday" }, { db }), /ISO timestamp/);
  await assert.rejects(m.getSignalsTool.handler({ since: "2026-11-03T00:00:00Z", until: "2026-11-01T00:00:00Z" }, { db }),
    /after/);
});

// ---------------------------------------------------------------------------
// get_dispatch_plan and deliver_signals
// ---------------------------------------------------------------------------

const ID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
const sig = (n, extra = {}) => ({ id: ID(n), app: "alfred", job: "nrd", severity: "normal", subject_key: `s:${n}`,
  title: `Title ${n}`, body: `Body ${n}`, link: null, started_by: "task:nrd", details: {}, state: "queued", ...extra });
const dec = (n, decision, extra = {}) => ({ signal_id: ID(n), app: "alfred", severity: "normal", subject_key: `s:${n}`,
  decision, reason: `because ${n}`, repeats: 0, merge_target_signal_id: null, inbox_id: null, bundle: false, ...extra });

/** Fake db for delivery: each chain is recorded and answered by table and the methods it used. */
function deliveryDb({ plan, signals = [], subs = [{ id: "sub1", endpoint: "https://e/secret", p256dh: "p", auth_key: "a" }],
  visibleInbox = [], openItem = { source_metadata: { repeat_count: 2 } } }) {
  const calls = [];
  const builder = (table) => {
    const chain = [];
    const answer = () => {
      const ops = chain.map(([k]) => k);
      // RLS: only the caller's own items come back; someone else's id looks missing.
      if (table === "inbox" && ops.includes("in")) {
        const asked = chain.find(([k]) => k === "in")[2];
        return { data: asked.filter((id) => visibleInbox.includes(id)).map((id) => ({ id })), error: null };
      }
      if (table === "signals" && ops.includes("update")) return { data: [{ id: "x" }], error: null };
      if (table === "signals") return { data: signals, error: null };
      if (table === "push_subscriptions") return { data: subs, error: null };
      if (table === "inbox" && ops.includes("select")) return { data: openItem, error: null };
      return { data: null, error: null };
    };
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer());
        if (k === "maybeSingle") return () => Promise.resolve(answer());
        return (...a) => { chain.push([k, ...a]); calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  let n = 0;
  return {
    calls,
    from: builder,
    rpc: (name, params) => {
      calls.push(["rpc", name, params]);
      if (name === "dispatch_signals") return Promise.resolve({ data: plan, error: null });
      if (name === "log_claude_notification") return Promise.resolve({ data: { created: true, id: `n${++n}` }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}
const logs = (db) => db.calls.filter(([t, n]) => t === "rpc" && n === "log_claude_notification").map(([, , p]) => p);
const signalUpdates = (db) => db.calls.filter(([t, k]) => t === "signals" && k === "update").map(([, , p]) => p);
const inserts = (db) => db.calls.filter(([t, k]) => t === "inbox" && k === "insert").map(([, , p]) => p);

test("dispatch tools are tier 1; deliver declares what it writes", () => {
  assert.equal(m.getDispatchPlanTool.tier, 1);
  assert.equal(m.deliverSignalsTool.tier, 1);
  assert.deepEqual(m.getDispatchPlanTool.tables.writes, []);
  assert.deepEqual(m.deliverSignalsTool.tables.writes, ["signals", "inbox", "claude_notifications"]);
});

test("get_dispatch_plan: the function's plan; at is passed only when given", async () => {
  const plan = { at: "t", decisions: [dec(1, "hold")] };
  const db = deliveryDb({ plan });
  assert.deepEqual(await m.getDispatchPlanTool.handler({}, { db }), plan);
  assert.deepEqual(db.calls.find(([, n]) => n === "dispatch_signals")[2], {});
  await m.getDispatchPlanTool.handler({ at: "2026-11-03T10:00:00-08:00" }, { db });
  assert.equal(db.calls.filter(([, n]) => n === "dispatch_signals")[1][2].p_now, "2026-11-03T10:00:00-08:00");
  await assert.rejects(m.getDispatchPlanTool.handler({ at: "soon" }, { db }), /ISO timestamp/);
});

test("deliver: hold, inbox, pop, merge each do their own thing; wait does nothing", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [
    dec(1, "hold"), dec(2, "inbox"), dec(3, "pop", { severity: "high" }), dec(4, "merge", { merge_target_signal_id: ID(2) }),
    dec(5, "wait"),
  ] };
  const db = deliveryDb({ plan, signals: [sig(1), sig(2), sig(3, { severity: "high" }), sig(4), sig(5)] });
  const out = await m.deliverSignalsTool.handler({ run_id: ID(9), wording: { [ID(3)]: { title: "Worded", body: "By Claude" } } },
    { db });
  assert.equal(out.errors, 0);
  assert.deepEqual(out.counts, { hold: 1, inbox: 1, pop: 1, merge: 1, wait: 1 });

  const ups = signalUpdates(db);
  assert.equal(ups[0].state, "held");
  assert.equal(ups[0].decided_run_id, ID(9));
  assert.equal(ups.find((u) => u.outcome === "inbox").state, "delivered");
  assert.ok(db.calls.some(([t, k, c, v]) => t === "signals" && k === "eq" && c === "state" && v === "queued"),
    "only queued signals move");

  const [inboxRow, popRow] = inserts(db);
  assert.equal(inboxRow.source_type, "task");
  assert.equal(inboxRow.source_app, "alfred");
  assert.equal(inboxRow.source_metadata.signal_id, ID(2));
  assert.match(popRow.captured_text, /^Worded\n\nBy Claude/);

  const [inboxLog, popLog] = logs(db);
  assert.equal(inboxLog.p_channel, "inbox_item");
  assert.equal(inboxLog.p_signal_id, ID(2));
  assert.equal(inboxLog.p_started_by, "task:nrd");
  assert.equal(popLog.p_channel, "alfred_push");
  assert.equal(popLog.p_kind, "flag");
  assert.equal(popLog.p_dedupe_key, `signal:${ID(3)}`);
  assert.equal(popLog.p_link, `/${popRow.id}`);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].title, "Worded");
  assert.equal(sends[0].url, `/${popRow.id}`);

  const merged = ups.find((u) => u.state === "merged");
  assert.equal(merged.merged_into, ID(2));
  assert.equal(merged.inbox_id, inboxRow.id, "a same-run merge joins the item just made");
  assert.ok(!JSON.stringify(out).includes("secret"));
  assert.equal(out.results.find((r) => r.signal_id === ID(5)), undefined);
});

test("deliver: a signal without details.inbox_id never looks one up", async () => {
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "inbox")] }, signals: [sig(1)] });
  await m.deliverSignalsTool.handler({}, { db });
  assert.ok(!db.calls.some(([t, k]) => t === "inbox" && k === "in"));
  assert.equal(inserts(db).length, 1);
});

test("deliver: inbox decision with the task's own item marks it delivered there, no new item", async () => {
  const own = "own-inbox-1";
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "inbox")] },
    signals: [sig(1, { details: { inbox_id: own } })], visibleInbox: [own] });
  const out = await m.deliverSignalsTool.handler({}, { db });
  assert.equal(inserts(db).length, 0);
  assert.equal(out.results[0].inbox_id, own);
  const up = signalUpdates(db)[0];
  assert.equal(up.inbox_id, own);
  assert.equal(up.outcome, "inbox");
  assert.match(up.reason, /own inbox item/);
  assert.equal(logs(db)[0].p_link, `/${own}`);
  assert.equal(logs(db)[0].p_delivery_detail.own_item, true);
});

test("deliver: pop with the task's own item links the push to it and adds a repeat, no new item", async () => {
  sends.length = 0;
  const own = "own-inbox-2";
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "pop", { severity: "high" })] },
    signals: [sig(1, { severity: "high", details: { inbox_id: own } })], visibleInbox: [own] });
  await m.deliverSignalsTool.handler({}, { db });
  assert.equal(inserts(db).length, 0);
  assert.equal(sends[0].url, `/${own}`);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "inbox" && k === "eq" && c === "id" && v === own));
  assert.deepEqual(db.calls.find(([t, k]) => t === "inbox" && k === "update")[2].source_metadata.merged_signal_ids, [ID(1)]);
  assert.match(signalUpdates(db)[0].reason, /points at the task's own inbox item/);
});

test("deliver: a missing item, or someone else's (RLS hides it), falls back to a new item and says why", async () => {
  sends.length = 0;
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "inbox"), dec(2, "pop")] },
    signals: [sig(1, { details: { inbox_id: "gone-1" } }), sig(2, { details: { inbox_id: "not-mine-2" } })],
    visibleInbox: [] });
  await m.deliverSignalsTool.handler({}, { db });
  assert.equal(inserts(db).length, 2);
  const [a, b] = signalUpdates(db);
  assert.match(a.reason, /details\.inbox_id gone-1 was not found or is not yours, so a new item was made/);
  assert.match(b.reason, /details\.inbox_id not-mine-2 was not found or is not yours/);
  assert.equal(sends[0].url, `/${inserts(db)[1].id}`);
  const asked = db.calls.find(([t, k]) => t === "inbox" && k === "in")[3];
  assert.deepEqual(asked.sort(), ["gone-1", "not-mine-2"]);
});

test("deliver: a pop for a subject with an open item points at it and adds a repeat", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [dec(1, "pop", { inbox_id: "open-1", merge_target_signal_id: ID(8) })] };
  const db = deliveryDb({ plan, signals: [sig(1)] });
  await m.deliverSignalsTool.handler({}, { db });
  assert.equal(inserts(db).length, 0);
  assert.equal(sends[0].url, "/open-1");
  const bump = db.calls.find(([t, k]) => t === "inbox" && k === "update")[2];
  assert.equal(bump.source_metadata.repeats, 3, "an old repeat_count carries on as repeats");
  assert.ok(!("repeat_count" in bump.source_metadata));
  assert.deepEqual(bump.source_metadata.merged_signal_ids, [ID(1)]);
});

const ITEM = { captured_text: "Money: 3 transactions to review", source_app: "warren_buffet",
  source_metadata: { task_name: "money-cleanup", week: "2026-11-02" }, ai_reasoning: "Weekly cleanup." };

test("raise: details.item is checked, unknown keys and missing text refused", async () => {
  const db = fakeDb({ rpcs: created });
  await m.raiseSignalTool.handler({ ...ARGS, details: { kind: "flag", item: ITEM } }, { db });
  const [, , p] = db.calls.find(([t, n]) => t === "rpc" && n === "raise_signal");
  assert.deepEqual(p.p_details, { kind: "flag", item: ITEM });
  const bad = [
    [{ item: [] }, /`details.item` must be/],
    [{ item: { ...ITEM, colour: "red" } }, /unknown keys: colour/],
    [{ item: { ...ITEM, captured_text: " " } }, /captured_text` is required/],
    [{ item: { ...ITEM, source_metadata: "x" } }, /source_metadata` must be an object/],
  ];
  const db2 = fakeDb();
  for (const [details, re] of bad) await assert.rejects(m.raiseSignalTool.handler({ ...ARGS, details }, { db: db2 }), re);
  assert.equal(db2.calls.length, 0);
});

test("deliver: an inbox decision makes the item from details.item, exactly those fields", async () => {
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "inbox")] }, signals: [sig(1, { details: { item: ITEM } })] });
  await m.deliverSignalsTool.handler({}, { db });
  const [row] = inserts(db);
  assert.equal(row.captured_text, ITEM.captured_text);
  assert.equal(row.source_app, "warren_buffet");
  assert.deepEqual(row.source_metadata, ITEM.source_metadata);
  assert.equal(row.ai_reasoning, "Weekly cleanup.");
  assert.equal(row.source_type, "task");
  assert.equal(logs(db)[0].p_link, `/${row.id}`);
  assert.equal(signalUpdates(db)[0].inbox_id, row.id);
});

test("deliver: a notification whose signal has details.item makes that item and links to it", async () => {
  sends.length = 0;
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "pop", { severity: "high" })] },
    signals: [sig(1, { severity: "high", details: { item: { captured_text: "Ken: seed check failed" } } })] });
  await m.deliverSignalsTool.handler({}, { db });
  const [row] = inserts(db);
  assert.equal(row.captured_text, "Ken: seed check failed");
  assert.equal(row.source_app, "alfred", "the signal's app when the item names none");
  assert.deepEqual(row.source_metadata, { task_name: "Notification: Title 1" });
  assert.equal(sends[0].url, `/${row.id}`);
});

test("deliver: an item's title is never the job name", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [dec(1, "inbox"), dec(2, "inbox"), dec(3, "pop", { severity: "high" }),
    dec(4, "pop", { severity: "high" })] };
  const noName = { captured_text: "Drive Mix problem", source_metadata: { run_date: "2026-11-06" } };
  const db = deliveryDb({ plan, signals: [sig(1, { details: { item: ITEM } }), sig(2, { details: { item: noName } }),
    sig(3, { severity: "high", details: { item: ITEM } }), sig(4, { severity: "high" })] });
  await m.deliverSignalsTool.handler({ wording: { [ID(2)]: { title: "Worded 2" }, [ID(4)]: { title: "Worded 4" } } }, { db });
  const names = inserts(db).map((r) => r.source_metadata.task_name);
  assert.deepEqual(names, ["money-cleanup", "Worded 2", "Notification: Title 3", "Notification: Worded 4"]);
  assert.equal(inserts(db)[1].source_metadata.run_date, "2026-11-06", "run_date is kept");
  assert.ok(!names.includes("dispatcher"));
});

test("deliver: a digest's item is titled after its notification", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [dec(1, "digest"), dec(2, "digest"), dec(3, "digest")] };
  const db = deliveryDb({ plan, signals: [sig(1), sig(2), sig(3)] });
  await m.deliverSignalsTool.handler({ digest: { title: "3 things from Alfred" } }, { db });
  assert.equal(inserts(db)[0].source_metadata.task_name, "Notification: 3 things from Alfred");
});

test("deliver: a merge counts repeats and keeps one 'Seen n times' line, replacing the last", async () => {
  const openItem = { captured_text: "Bank sync failed\n\nSeen 2 times since Nov 3, 6:00 AM",
    created_at: "2026-11-03T14:00:00Z",
    source_metadata: { repeats: 2, first_seen: "2026-11-03T14:00:00Z", merged_signal_ids: [ID(7)] } };
  const plan = { at: "t", decisions: [dec(1, "merge", { inbox_id: "open-1", merge_target_signal_id: ID(8) })] };
  const db = deliveryDb({ plan, signals: [sig(1)], openItem });
  await m.deliverSignalsTool.handler({}, { db });
  const bump = db.calls.find(([t, k]) => t === "inbox" && k === "update")[2];
  assert.equal(bump.source_metadata.repeats, 3);
  assert.equal(bump.source_metadata.first_seen, "2026-11-03T14:00:00Z");
  assert.ok(Date.parse(bump.source_metadata.last_seen) > Date.parse("2026-11-03T14:00:00Z"));
  assert.deepEqual(bump.source_metadata.merged_signal_ids, [ID(7), ID(1)]);
  assert.equal(bump.captured_text, "Bank sync failed\n\nSeen 3 times since Nov 3, 6:00 AM");
  assert.equal((bump.captured_text.match(/Seen \d+ times/g) || []).length, 1);
});

test("deliver: a first merge starts first_seen from the item and adds the line", async () => {
  const openItem = { captured_text: "Bank sync failed", created_at: "2026-11-05T16:10:00Z", source_metadata: {} };
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "merge", { inbox_id: "open-1", merge_target_signal_id: ID(8) })] },
    signals: [sig(1)], openItem });
  await m.deliverSignalsTool.handler({}, { db });
  const bump = db.calls.find(([t, k]) => t === "inbox" && k === "update")[2];
  assert.equal(bump.source_metadata.repeats, 2);
  assert.equal(bump.captured_text, "Bank sync failed\n\nSeen 2 times since Nov 5, 8:10 AM");
});

test("deliver: outside the window, inbox, hold, merge and drop are delivered; only the notification waits", async () => {
  sends.length = 0;
  const plan = { at: "t", in_window: false, decisions: [dec(1, "inbox"), dec(2, "hold"), dec(3, "drop"),
    dec(4, "merge", { merge_target_signal_id: ID(1) }), dec(5, "wait", { severity: "high" })] };
  const db = deliveryDb({ plan, signals: [1, 2, 3, 4, 5].map((n) => sig(n)) });
  const out = await m.deliverSignalsTool.handler({}, { db });
  assert.equal(out.errors, 0);
  const states = signalUpdates(db).map((u) => u.state);
  assert.deepEqual(states, ["delivered", "held", "dropped", "merged"]);
  assert.equal(signalUpdates(db)[2].reason, "because 3");
  assert.equal(inserts(db).length, 1);
  assert.equal(sends.length, 0);
});

test("deliver: a digest is one inbox item and one pop for all its signals", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [1, 2, 3].map((n) => dec(n, "digest", { bundle: true })) };
  const db = deliveryDb({ plan, signals: [sig(1), sig(2), sig(3)] });
  const out = await m.deliverSignalsTool.handler({ digest: { title: "Three things", body: "Nothing urgent." } }, { db });
  assert.equal(inserts(db).length, 1);
  assert.match(inserts(db)[0].captured_text, /- Title 1\n- Title 2\n- Title 3/);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].title, "Three things");
  assert.match(logs(db)[0].p_dedupe_key, /^digest:/);
  const ups = signalUpdates(db);
  assert.equal(ups.length, 3);
  assert.ok(ups.every((u) => u.bundle_id === out.digest.bundle_id && u.outcome === "pop"));
});

test("deliver: a signal no longer queued is skipped; no rules stops; no VAPID refuses before anything", async () => {
  const db = deliveryDb({ plan: { at: "t", decisions: [dec(1, "inbox")] }, signals: [sig(1, { state: "held" })] });
  const out = await m.deliverSignalsTool.handler({}, { db });
  assert.equal(out.results[0].skipped, "no longer queued");
  assert.equal(inserts(db).length, 0);

  const stopped = await m.deliverSignalsTool.handler({}, { db: deliveryDb({ plan: { at: "t", stopped: "no rules", decisions: [] } }) });
  assert.equal(stopped.stopped, "no rules");

  ENV = {};
  try {
    const db2 = deliveryDb({ plan: { at: "t", decisions: [dec(1, "pop")] }, signals: [sig(1)] });
    await assert.rejects(m.deliverSignalsTool.handler({}, { db: db2 }), /push is not configured/);
    assert.equal(db2.calls.filter(([t]) => t !== "rpc").length, 0);
  } finally {
    ENV = VAPID;
  }
});

test("deliver: bad wording or run_id is refused", async () => {
  const db = deliveryDb({ plan: { at: "t", decisions: [] } });
  await assert.rejects(m.deliverSignalsTool.handler({ wording: { nope: { title: "x" } } }, { db }), /must be signal ids/);
  await assert.rejects(m.deliverSignalsTool.handler({ wording: { [ID(1)]: { title: "" } } }, { db }), /title/);
  await assert.rejects(m.deliverSignalsTool.handler({ run_id: "r1" }, { db }), /run_id/);
  await assert.rejects(m.deliverSignalsTool.handler({ digest: "x" }, { db }), /`digest` must be/);
});

// ---------------------------------------------------------------------------
// update_signal
// ---------------------------------------------------------------------------

/** Fake db for update_signal: the signal by id, the subject's delivered signals, open items, and updates. */
function actionDb({ signal, prior = [], openIds = [], moved = true }) {
  const calls = [];
  const builder = (table) => {
    const chain = [];
    const answer = () => {
      const ops = chain.map(([k]) => k);
      if (table === "signals" && ops.includes("update")) return { data: moved ? [{ id: signal.id }] : [], error: null };
      if (table === "signals" && ops.includes("not")) return { data: prior, error: null };
      if (table === "signals") return { data: signal, error: null };
      if (table === "inbox" && ops.includes("in")) return { data: openIds.map((id) => ({ id })), error: null };
      if (table === "inbox" && ops.includes("select")) return { data: { source_metadata: {}, captured_text: "Open", created_at: "2026-11-05T16:10:00Z" }, error: null };
      if (table === "push_subscriptions") return { data: [{ id: "sub1", endpoint: "https://e/x", p256dh: "p", auth_key: "a" }], error: null };
      return { data: null, error: null };
    };
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(answer());
        if (k === "maybeSingle") return () => Promise.resolve(answer());
        return (...a) => { chain.push([k, ...a]); calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  let n = 0;
  return {
    calls,
    from: builder,
    rpc: (name, params) => {
      calls.push(["rpc", name, params]);
      if (name === "log_claude_notification") return Promise.resolve({ data: { created: true, id: `n${++n}` }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
}
const U = m.updateSignalTool;

test("update_signal: tier 2, declares its tables", () => {
  assert.equal(U.tier, 2);
  assert.deepEqual(U.tables.writes, ["signals", "inbox", "claude_notifications"]);
});

test("update_signal: hold moves only a queued signal, with who and when", async () => {
  const db = actionDb({ signal: sig(1) });
  const out = await U.handler({ signal_id: ID(1), action: "hold" }, { db });
  assert.equal(out.state, "held");
  const up = signalUpdates(db)[0];
  assert.equal(up.reason, "held by Alex");
  assert.equal(up.decided_by, "chat");
  assert.ok(up.decided_at);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "signals" && k === "in" && c === "state" && v.join() === "queued"));
  await assert.rejects(U.handler({ signal_id: ID(1), action: "hold" }, { db: actionDb({ signal: sig(1, { state: "held" }) }) }),
    /is held, so it cannot be held/);
});

test("update_signal: drop takes queued or held; final ones are refused", async () => {
  const db = actionDb({ signal: sig(1, { state: "held" }) });
  assert.equal((await U.handler({ signal_id: ID(1), action: "drop" }, { db })).state, "dropped");
  assert.equal(signalUpdates(db)[0].reason, "dropped by Alex");
  await assert.rejects(U.handler({ signal_id: ID(1), action: "drop" }, { db: actionDb({ signal: sig(1, { state: "delivered" }) }) }),
    /is delivered, so it cannot be dropped/);
});

test("update_signal: deliver as inbox makes the item from details.item and logs it", async () => {
  const db = actionDb({ signal: sig(1, { state: "held", details: { item: ITEM } }) });
  const out = await U.handler({ signal_id: ID(1), action: "deliver" }, { db });
  assert.equal(out.as, "inbox");
  assert.equal(out.state, "delivered");
  assert.equal(inserts(db)[0].captured_text, ITEM.captured_text);
  assert.equal(inserts(db)[0].source_metadata.task_name, "money-cleanup");
  const log = logs(db)[0];
  assert.equal(log.p_channel, "inbox_item");
  assert.equal(signalUpdates(db)[0].outcome, "inbox");
  assert.equal(signalUpdates(db)[0].decided_by, "chat");
});

test("update_signal: deliver still folds into an open item for the subject", async () => {
  const db = actionDb({ signal: sig(1), prior: [{ id: ID(7), inbox_id: "open-1" }], openIds: ["open-1"] });
  const out = await U.handler({ signal_id: ID(1), action: "deliver", as: "inbox" }, { db });
  assert.equal(out.state, "merged");
  assert.equal(inserts(db).length, 0);
  const up = signalUpdates(db).find((u) => u.state === "merged");
  assert.equal(up.merged_into, ID(7));
  assert.match(up.reason, /folded into the open inbox item/);
  assert.ok(db.calls.some(([t, k]) => t === "inbox" && k === "update"), "the open item gets its repeat");
});

test("update_signal: deliver as a notification skips window and limits, links to its item", async () => {
  sends.length = 0;
  const db = actionDb({ signal: sig(1, { severity: "high" }) });
  const out = await U.handler({ signal_id: ID(1), action: "deliver" }, { db });
  assert.equal(out.as, "notification");
  assert.ok(!db.calls.some(([t, n]) => t === "rpc" && n === "dispatch_signals"), "no dispatch plan consulted");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, `/${inserts(db)[0].id}`);
  assert.equal(inserts(db)[0].source_metadata.task_name, "Notification: Title 1");
  assert.equal(logs(db)[0].p_started_by, "chat");
  assert.equal(signalUpdates(db)[0].outcome, "pop");
});

test("update_signal: bad input, as without deliver, and a race are refused", async () => {
  const db = actionDb({ signal: sig(1) });
  await assert.rejects(U.handler({ signal_id: ID(1), action: "snooze" }, { db }), /action/);
  await assert.rejects(U.handler({ signal_id: "nope", action: "hold" }, { db }), /signal's id/);
  await assert.rejects(U.handler({ signal_id: ID(1), action: "hold", as: "inbox" }, { db }), /only for action "deliver"/);
  await assert.rejects(U.handler({ signal_id: ID(1), action: "hold" }, { db: actionDb({ signal: null }) }), /no signal/);
  await assert.rejects(U.handler({ signal_id: ID(1), action: "hold" }, { db: actionDb({ signal: sig(1), moved: false }) }),
    /changed while this ran/);
});

test("kindFor: details.kind wins, else flag for high and urgent, info otherwise", () => {
  assert.equal(m.kindFor({ severity: "low", details: { kind: "nudge" } }), "nudge");
  assert.equal(m.kindFor({ severity: "urgent", details: {} }), "flag");
  assert.equal(m.kindFor({ severity: "normal", details: { kind: "shout" } }), "info");
});
