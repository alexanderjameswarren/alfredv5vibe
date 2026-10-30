// Handler tests for claude-notifications.ts.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/claude-notifications.test.mjs
//
// The real platform.ts and shared read run (test-platform.mjs); only defineTool is replaced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTool, settingsFor, withSettings } from "./test-platform.mjs";

const m = await loadTool("claude-notifications.ts");
const LOG_SETTINGS = settingsFor("claude_notifications", ["id", "user_id", "app", "job", "kind", "channel", "title",
  "body", "link", "local_date", "dedupe_key", "delivery_status", "delivery_detail", "created_at", "updated_at"]);

/** Fake db: chains on a table resolve to `rows`; rpc answers from `rpcs`. Every call is logged. */
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
  return withSettings(db, [LOG_SETTINGS]);
}

const LOG_ARGS = { app: "arnold", job: "arnold_morning_review", kind: "flag", channel: "inbox_item",
  title: "Yoga missed Tuesday", dedupe_key: "arnold:2026-10-29:yoga:missed" };

test("both tools are tier 1", () => {
  assert.equal(m.logClaudeNotificationTool.tier, 1);
  assert.equal(m.getClaudeNotificationsTool.tier, 1);
});

test("log: passes every field to log_claude_notification, status sent by default", async () => {
  const db = fakeDb({ rpcs: { log_claude_notification: { data: { created: true, id: "n1" }, error: null } } });
  const out = await m.logClaudeNotificationTool.handler({ ...LOG_ARGS, body: "  Paste this.  ",
    delivery_detail: { inbox_id: "i1" } }, { db });
  assert.deepEqual(out, { created: true, id: "n1" });
  const [, , p] = db.calls.find(([t, n]) => t === "rpc" && n === "log_claude_notification");
  assert.equal(p.p_channel, "inbox_item");
  assert.equal(p.p_body, "Paste this.");
  assert.equal(p.p_delivery_status, "sent");
  assert.deepEqual(p.p_delivery_detail, { inbox_id: "i1" });
  assert.equal(p.p_link, null);
});

test("log: a used dedupe_key comes back as created false, not an error", async () => {
  const db = fakeDb({ rpcs: { log_claude_notification: {
    data: { created: false, id: "n0", duplicate_of: { title: "Yoga missed Tuesday" } }, error: null } } });
  const out = await m.logClaudeNotificationTool.handler(LOG_ARGS, { db });
  assert.equal(out.created, false);
});

test("log: alfred_push is refused (send_alfred_push logs those) and bad input is named", async () => {
  const db = fakeDb();
  await assert.rejects(m.logClaudeNotificationTool.handler({ ...LOG_ARGS, channel: "alfred_push" }, { db }), /channel/);
  await assert.rejects(m.logClaudeNotificationTool.handler({ ...LOG_ARGS, kind: "nag" }, { db }), /`kind` must be one of/);
  await assert.rejects(m.logClaudeNotificationTool.handler({ ...LOG_ARGS, title: " " }, { db }), /`title` is required/);
  await assert.rejects(m.logClaudeNotificationTool.handler({ ...LOG_ARGS, delivery_detail: [1] }, { db }), /must be an object/);
  assert.equal(db.calls.length, 0);
});

test("log: an unknown app is the database's validation error", async () => {
  const db = fakeDb({ rpcs: { log_claude_notification: { data: null,
    error: { code: "22023", message: 'log_claude_notification: unknown app "arnie". Use an id from get_apps.' } } } });
  await assert.rejects(m.logClaudeNotificationTool.handler({ ...LOG_ARGS, app: "arnie" }, { db }),
    /validation error: log_claude_notification: unknown app "arnie"/);
});

test("todayCounts: by kind and channel, every kind present, sent and pending only", async () => {
  const db = fakeDb({ rows: [
    { kind: "nudge", channel: "alfred_push" }, { kind: "nudge", channel: "alfred_push" },
    { kind: "encouragement", channel: "alfred_push" },
  ] });
  const out = await m.todayCounts(db, "t", "arnold", "2026-10-29");
  assert.deepEqual(out.by_kind, { nudge: 2, encouragement: 1, flag: 0, info: 0 });
  assert.equal(out.by_channel.alfred_push, 3);
  assert.ok(db.calls.some(([t, k, c, v]) => k === "in" && c === "delivery_status" && v.join() === "pending,sent"));
  assert.ok(db.calls.some(([t, k, c, v]) => k === "eq" && c === "app" && v === "arnold"));
  assert.ok(db.calls.some(([t, k, c, v]) => k === "eq" && c === "local_date" && v === "2026-10-29"));
});

test("get: today's counts plus the filtered list in one call", async () => {
  const db = fakeDb({ rows: [{ id: "n1", kind: "nudge", channel: "alfred_push", title: "One more?" }] });
  const out = await m.getClaudeNotificationsTool.handler({ app: "arnold", kind: "nudge", date_from: "2026-10-28",
    date_to: "2026-10-29" }, { db });
  assert.equal(out.data.today.by_kind.nudge, 1);
  assert.equal(out.data.notifications.length, 1);
  for (const [c, v] of [["app", "arnold"], ["kind", "nudge"]]) {
    assert.ok(db.calls.some(([t, k, col, val]) => t === "claude_notifications" && k === "eq" && col === c && val === v));
  }
  assert.ok(db.calls.some(([, k, c, v]) => k === "gte" && c === "local_date" && v === "2026-10-28"));
  assert.ok(db.calls.some(([, k, c, v]) => k === "lte" && c === "local_date" && v === "2026-10-29"));
});

test("get: a reversed range or a bad channel is refused", async () => {
  const db = fakeDb();
  await assert.rejects(m.getClaudeNotificationsTool.handler({ date_from: "2026-10-29", date_to: "2026-10-01" }, { db }), /after/);
  await assert.rejects(m.getClaudeNotificationsTool.handler({ channel: "sms" }, { db }), /`channel` must be one of/);
});
