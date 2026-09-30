// Handler tests for reminders.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/reminders.test.mjs
//
// platform.ts is stubbed: defineTool returns its options, so each handler is
// called directly with a fake ctx.db that records the query it was asked for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "reminders-"));
writeFileSync(join(dir, "platform.ts"), `
export const defineTool = (o) => o;
export const clampLimit = (n) => Math.min(n ?? 20, 50);
export const envelope = (data, meta = {}) => ({ data, meta });
export const describeDbError = (name, e) => name + " failed: " + e.message;
`);
const IMPORT = 'from "../platform.ts";';
const src = readFileSync(join(HERE, "reminders.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("reminders.ts import line changed — update this test.");
writeFileSync(join(dir, "reminders.ts"), src.replace(IMPORT, 'from "./platform.ts";'));
const m = await import(pathToFileURL(join(dir, "reminders.ts")).href);

const FUTURE = new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
const PAST = "2020-01-01T09:00:00-08:00";

/** Fake ctx.db: every chain resolves to `result`, and each call is logged. */
function fakeDb(result = { data: null, error: null }, rpcResult = { data: { id: "r1" }, error: null }) {
  const calls = [];
  const builder = (table) => {
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res) => res(typeof result === "function" ? result(calls) : result);
        if (k === "maybeSingle") return () => { calls.push([table, "maybeSingle"]); return Promise.resolve(typeof result === "function" ? result(calls) : result); };
        return (...a) => { calls.push([table, k, ...a]); return b; };
      },
    });
    return b;
  };
  return {
    calls,
    from: (t) => builder(t),
    rpc: (name, params) => { calls.push(["rpc", name, params]); return Promise.resolve(rpcResult); },
  };
}

test("parseDueAt accepts an offset and returns UTC", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.equal(m.parseDueAt("t", "2026-10-01T09:00:00-07:00", now), "2026-10-01T16:00:00.000Z");
  assert.equal(m.parseDueAt("t", "2026-10-01T16:00Z", now), "2026-10-01T16:00:00.000Z");
});

test("parseDueAt rejects no offset, the past, and junk", () => {
  const now = new Date("2026-09-30T12:00:00Z");
  assert.throws(() => m.parseDueAt("t", "2026-10-01T09:00:00", now), /WITH a UTC offset/);
  assert.throws(() => m.parseDueAt("t", "2026-10-01", now), /WITH a UTC offset/);
  assert.throws(() => m.parseDueAt("t", "2026-09-30T04:00:00-07:00", now), /in the past/);
  assert.throws(() => m.parseDueAt("t", undefined, now), /required/);
  assert.throws(() => m.parseDueAt("t", "2026-13-45T09:00:00Z", now), /not a real date/);
});

test("create_reminder calls the database function as claude", async () => {
  const db = fakeDb();
  const out = await m.createReminderTool.handler({ text: " Call Bob ", due_at: FUTURE }, { db });
  assert.deepEqual(out, { id: "r1" });
  const [, name, p] = db.calls[0];
  assert.equal(name, "create_reminder");
  assert.deepEqual(p, { p_text: "Call Bob", p_due_at: new Date(FUTURE).toISOString(), p_inbox_id: null, p_intent_id: null, p_created_by: "claude" });
});

test("create_reminder rejects both links, and writes nothing", async () => {
  const db = fakeDb();
  await assert.rejects(
    m.createReminderTool.handler({ text: "x", due_at: FUTURE, inbox_id: "a", intent_id: "b" }, { db }),
    /not both/,
  );
  await assert.rejects(m.createReminderTool.handler({ text: "x", due_at: PAST }, { db }), /in the past/);
  assert.equal(db.calls.length, 0);
});

test("create_reminder surfaces a database error", async () => {
  const db = fakeDb(undefined, { data: null, error: { message: "intention x not found" } });
  await assert.rejects(m.createReminderTool.handler({ text: "x", due_at: FUTURE, intent_id: "x" }, { db }), /not found/);
});

test("create_reminder: an unknown intent_id fails with the database's not-found wording", async () => {
  // No FK on intent_id; public.create_reminder (084) is the check. Pin the wording Claude sees.
  const db = fakeDb(undefined, {
    data: null,
    error: { code: "P0002", message: "create_reminder: intention not-a-real-intention not found" },
  });
  await assert.rejects(
    m.createReminderTool.handler({ text: "x", due_at: FUTURE, intent_id: "not-a-real-intention" }, { db }),
    /create_reminder: intention not-a-real-intention not found/,
  );
  assert.equal(db.calls[0][2].p_intent_id, "not-a-real-intention");
});

test("get_reminders defaults to scheduled, soonest first, and flags truncation", async () => {
  const db = fakeDb({ data: [{ id: "a" }], error: null, count: 3 });
  const out = await m.getRemindersTool.handler({ limit: 1 }, { db });
  assert.deepEqual(db.calls.find((c) => c[1] === "eq"), ["reminders", "eq", "state", "scheduled"]);
  assert.deepEqual(db.calls.find((c) => c[1] === "order"), ["reminders", "order", "due_at", { ascending: true }]);
  assert.deepEqual(out.meta, { count: 3, limit_applied: 1, truncated: true });
});

test("get_reminders with state all adds no state filter", async () => {
  const db = fakeDb({ data: [], error: null, count: 0 });
  await m.getRemindersTool.handler({ state: "all", intent_id: "i1" }, { db });
  const eqs = db.calls.filter((c) => c[1] === "eq");
  assert.deepEqual(eqs, [["reminders", "eq", "intent_id", "i1"]]);
  await assert.rejects(m.getRemindersTool.handler({ state: "done" }, { db }), /state must be/);
});

test("update_reminder reschedule re-arms the row", async () => {
  const db = fakeDb({ data: { id: "r1", state: "sent" }, error: null });
  await m.updateReminderTool.handler({ id: "r1", due_at: FUTURE }, { db });
  const patch = db.calls.find((c) => c[1] === "update")[2];
  assert.deepEqual(patch, { due_at: new Date(FUTURE).toISOString(), state: "scheduled", sent_at: null, cancel_reason: null });
});

test("update_reminder cancel sets reason manual", async () => {
  const db = fakeDb({ data: { id: "r1", state: "scheduled" }, error: null });
  await m.updateReminderTool.handler({ id: "r1", cancel: true }, { db });
  assert.deepEqual(db.calls.find((c) => c[1] === "update")[2], { state: "cancelled", cancel_reason: "manual" });
});

test("update_reminder refusals", async () => {
  const sent = fakeDb({ data: { id: "r1", state: "sent" }, error: null });
  await assert.rejects(m.updateReminderTool.handler({ id: "r1", cancel: true }, { db: sent }), /already sent/);
  await assert.rejects(m.updateReminderTool.handler({ id: "r1", cancel: true, text: "x" }, { db: sent }), /cannot be combined/);
  await assert.rejects(m.updateReminderTool.handler({ id: "r1" }, { db: sent }), /nothing to change/);
  const none = fakeDb({ data: null, error: null });
  await assert.rejects(m.updateReminderTool.handler({ id: "zz", text: "x" }, { db: none }), /no reminder zz/);
});
