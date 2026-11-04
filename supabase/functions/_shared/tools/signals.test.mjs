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
function deliveryDb({ plan, signals = [], subs = [{ id: "sub1", endpoint: "https://e/secret", p256dh: "p", auth_key: "a" }] }) {
  const calls = [];
  const builder = (table) => {
    const chain = [];
    const answer = () => {
      const ops = chain.map(([k]) => k);
      if (table === "signals" && ops.includes("update")) return { data: [{ id: "x" }], error: null };
      if (table === "signals") return { data: signals, error: null };
      if (table === "push_subscriptions") return { data: subs, error: null };
      if (table === "inbox" && ops.includes("select")) return { data: { source_metadata: { repeat_count: 2 } }, error: null };
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

test("deliver: a pop for a subject with an open item points at it and adds a repeat", async () => {
  sends.length = 0;
  const plan = { at: "t", decisions: [dec(1, "pop", { inbox_id: "open-1", merge_target_signal_id: ID(8) })] };
  const db = deliveryDb({ plan, signals: [sig(1)] });
  await m.deliverSignalsTool.handler({}, { db });
  assert.equal(inserts(db).length, 0);
  assert.equal(sends[0].url, "/open-1");
  const bump = db.calls.find(([t, k]) => t === "inbox" && k === "update")[2];
  assert.equal(bump.source_metadata.repeat_count, 3);
  assert.deepEqual(bump.source_metadata.merged_signal_ids, [ID(1)]);
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

test("kindFor: details.kind wins, else flag for high and urgent, info otherwise", () => {
  assert.equal(m.kindFor({ severity: "low", details: { kind: "nudge" } }), "nudge");
  assert.equal(m.kindFor({ severity: "urgent", details: {} }), "flag");
  assert.equal(m.kindFor({ severity: "normal", details: { kind: "shout" } }), "info");
});
