// Handler tests for alfred-push.ts (send_alfred_push).
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/tools/alfred-push.test.mjs
//
// Loads _shared/ the way test-platform.mjs does (real platform.ts, defineTool returns its options), and also
// replaces npm:web-push with a stub that records sends, since Node cannot resolve npm: specifiers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "alfred-push-"));
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
  sendNotification: async (sub, payload) => {
    sends.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    if (sub.endpoint.includes("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
    return { statusCode: 201 };
  },
};
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID = { VAPID_SUBJECT: "mailto:a@b.c", VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString("base64url") };
let ENV = VAPID;
globalThis.Deno = { env: { get: (n) => ENV[n] } };
const m = await import(pathToFileURL(join(dir, "_shared", "tools", "alfred-push.ts")).href);

/** Fake db: push_subscriptions resolves to `subs`; the log rpc answers `logResult`. Every call is logged. */
function fakeDb({ subs = [], logResult = { data: { created: true, id: "n1" }, error: null } } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const b = new Proxy({}, {
        get: (_t, k) => {
          if (k === "then") return (res) => res({ data: table === "push_subscriptions" ? subs : null, error: null });
          return (...args) => { calls.push([table, k, ...args]); return b; };
        },
      });
      return b;
    },
    rpc(name, params) {
      calls.push(["rpc", name, params]);
      return Promise.resolve(logResult);
    },
  };
}

const ARGS = { app: "arnold", job: "arnold_hourly", kind: "nudge", title: "Microworkouts",
  body: "2 of 5 so far. One more now?", link: "/intentions/mur79qma8apmj8yc4i",
  dedupe_key: "arnold:2026-10-29:microworkout:behind_pace:14:00" };
const SUBS = [
  { id: "sub-phone", endpoint: "https://fcm.example/phone-secret", p256dh: "p", auth_key: "a" },
  { id: "sub-old", endpoint: "https://fcm.example/gone-secret", p256dh: "p", auth_key: "a" },
];

test("tier 1, and tables declared", () => {
  assert.equal(m.sendAlfredPushTool.tier, 1);
  assert.deepEqual(m.sendAlfredPushTool.tables.writes, ["claude_notifications"]);
});

test("logs first, sends to every device, records the result; dead devices reported, not deleted", async () => {
  sends.length = 0;
  const db = fakeDb({ subs: SUBS });
  const out = await m.sendAlfredPushTool.handler(ARGS, { db });

  const order = db.calls.map(([t, k]) => `${t}.${k}`);
  assert.ok(order.indexOf("rpc.log_claude_notification") < order.indexOf("push_subscriptions.select"));
  const [, , p] = db.calls.find(([t, n]) => t === "rpc" && n === "log_claude_notification");
  assert.equal(p.p_channel, "alfred_push");
  assert.equal(p.p_delivery_status, "pending");

  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0].payload, { title: "Microworkouts", body: "2 of 5 so far. One more now?",
    tag: `claude-arnold-${ARGS.dedupe_key}`, url: "/intentions/mur79qma8apmj8yc4i" });

  const update = db.calls.find(([t, k]) => t === "claude_notifications" && k === "update");
  assert.equal(update[2].delivery_status, "sent");
  assert.deepEqual(update[2].delivery_detail.dead_subscription_ids, ["sub-old"]);
  assert.ok(db.calls.some(([t, k, c, v]) => t === "claude_notifications" && k === "eq" && c === "id" && v === "n1"));
  assert.ok(!db.calls.some(([t, k]) => t === "push_subscriptions" && k === "delete"), "dead subscriptions are never deleted here");

  assert.equal(out.delivery_status, "sent");
  assert.equal(out.sent_to, 1);
  assert.deepEqual(out.dead_subscription_ids, ["sub-old"]);
  assert.ok(!JSON.stringify(out).includes("secret"), "the result must not carry any endpoint");
});

test("a used dedupe_key is refused and nothing is sent", async () => {
  sends.length = 0;
  const db = fakeDb({ subs: SUBS, logResult: { data: { created: false, id: "n0",
    duplicate_of: { title: "Microworkouts", channel: "alfred_push" } }, error: null } });
  await assert.rejects(m.sendAlfredPushTool.handler(ARGS, { db }),
    /refused: dedupe_key .* has already been used.*Nothing was sent/s);
  assert.equal(sends.length, 0);
  assert.ok(!db.calls.some(([t]) => t === "push_subscriptions"));
});

test("no devices: logged as no_subscription", async () => {
  const db = fakeDb({ subs: [] });
  const out = await m.sendAlfredPushTool.handler(ARGS, { db });
  assert.equal(out.delivery_status, "no_subscription");
  assert.equal(db.calls.find(([t, k]) => t === "claude_notifications" && k === "update")[2].delivery_status,
    "no_subscription");
});

test("every device failing: logged as failed", async () => {
  const db = fakeDb({ subs: [SUBS[1]] });
  const out = await m.sendAlfredPushTool.handler(ARGS, { db });
  assert.equal(out.delivery_status, "failed");
});

test("missing VAPID secrets: refused before anything is logged", async () => {
  ENV = {};
  try {
    const db = fakeDb({ subs: SUBS });
    await assert.rejects(m.sendAlfredPushTool.handler(ARGS, { db }), /push is not configured: Missing edge function secret/);
    assert.equal(db.calls.length, 0);
  } finally {
    ENV = VAPID;
  }
});

test("bad input is refused before the database: links must be Alfred paths", async () => {
  const db = fakeDb();
  for (const link of ["https://evil.example/x", "//evil.example", "inbox/1", "/a b"]) {
    await assert.rejects(m.sendAlfredPushTool.handler({ ...ARGS, link }, { db }), /must be an Alfred path/);
  }
  await assert.rejects(m.sendAlfredPushTool.handler({ ...ARGS, kind: "spam" }, { db }), /`kind` must be one of/);
  await assert.rejects(m.sendAlfredPushTool.handler({ ...ARGS, dedupe_key: "" }, { db }), /`dedupe_key` is required/);
  assert.equal(db.calls.length, 0);
  const out = await m.sendAlfredPushTool.handler({ ...ARGS, link: undefined }, { db: fakeDb({ subs: [SUBS[0]] }) });
  assert.equal(out.delivery_status, "sent");
});
