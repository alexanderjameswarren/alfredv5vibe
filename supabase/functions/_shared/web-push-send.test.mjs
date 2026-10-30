// Tests for web-push-send.ts: the VAPID check and the send loop.
//
// Run:
//   node --experimental-strip-types --test supabase/functions/_shared/web-push-send.test.mjs
//
// npm:web-push is replaced by a stub (Node cannot resolve npm: specifiers); node:crypto is real,
// so the keypair check runs against a real P-256 key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "web-push-send-"));
const IMPORT = 'import webpush from "npm:web-push@3.6.7";';
const src = readFileSync(join(HERE, "web-push-send.ts"), "utf-8");
if (!src.includes(IMPORT)) throw new Error("web-push-send.ts web-push import changed — update this test.");
writeFileSync(join(dir, "stub_webpush.ts"), "export default globalThis.__webpush;\n");
writeFileSync(join(dir, "web-push-send.ts"), src.replace(IMPORT, 'import webpush from "./stub_webpush.ts";'));
writeFileSync(join(dir, "push-options.ts"), readFileSync(join(HERE, "push-options.ts"), "utf-8"));
globalThis.Deno = { env: { get: () => undefined } };
const m = await import(pathToFileURL(join(dir, "web-push-send.ts")).href);

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const PRIVATE = ecdh.getPrivateKey().toString("base64url");
const PUBLIC = ecdh.getPublicKey().toString("base64url");
const env = (vars) => (name) => vars[name];
const recorder = () => {
  const seen = { vapid: null, sends: [] };
  return {
    seen,
    setVapidDetails: (...a) => { seen.vapid = a; },
    sendNotification: async (sub, payload, options) => {
      seen.sends.push({ sub, payload, options });
      if (sub.endpoint.includes("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410, body: "expired" });
      if (sub.endpoint.includes("busy")) throw Object.assign(new Error("Too many"), { statusCode: 429 });
      if (sub.endpoint.includes("offline")) throw new Error("getaddrinfo ENOTFOUND");
      return { statusCode: 201 };
    },
  };
};

test("the secret names are notify-dispatch's", () => {
  assert.deepEqual(m.VAPID_SECRET_NAMES, ["VAPID_SUBJECT", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]);
  const dispatch = readFileSync(join(HERE, "..", "notify-dispatch", "index.ts"), "utf-8");
  for (const n of m.VAPID_SECRET_NAMES) assert.ok(dispatch.includes(`"${n}"`), `notify-dispatch does not read ${n}`);
});

test("loadVapid: a matching pair is set and its public key returned", () => {
  const wp = recorder();
  const out = m.loadVapid(env({ VAPID_SUBJECT: "mailto:a@b.c", VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: PRIVATE }), wp);
  assert.equal(out, PUBLIC);
  assert.deepEqual(wp.seen.vapid, ["mailto:a@b.c", PUBLIC, PRIVATE]);
});

test("loadVapid: missing secrets are named; a mismatched pair is refused", () => {
  assert.throws(() => m.loadVapid(env({ VAPID_SUBJECT: "mailto:a@b.c" }), recorder()),
    /Missing edge function secret\(s\): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY/);
  const other = createECDH("prime256v1");
  other.generateKeys();
  assert.throws(() => m.loadVapid(env({ VAPID_SUBJECT: "s", VAPID_PUBLIC_KEY: other.getPublicKey().toString("base64url"),
    VAPID_PRIVATE_KEY: PRIVATE }), recorder()), /keypair mismatch/);
});

test("sendToAll: ok, dead (410), transient (429) and network failures, by subscription id only", async () => {
  const wp = recorder();
  const subs = ["ok", "gone", "busy", "offline"].map((s, i) => ({
    id: `sub-${i}`, endpoint: `https://push.example/${s}/secret-token`, p256dh: "p", auth_key: "a",
  }));
  const out = await m.sendToAll(subs, '{"title":"t"}', wp);
  assert.deepEqual(out.map((r) => [r.subscription_id, r.status, r.ok, r.dead]), [
    ["sub-0", 201, true, false],
    ["sub-1", 410, false, true],
    ["sub-2", 429, false, false],
    ["sub-3", null, false, false],
  ]);
  assert.equal(out[1].service_body, "expired");
  assert.ok(!JSON.stringify(out).includes("secret-token"), "results must not carry the endpoint");
  assert.deepEqual(wp.seen.sends[0].options, { urgency: "high", TTL: 900 });
  assert.deepEqual(wp.seen.sends[0].sub.keys, { p256dh: "p", auth: "a" });
});
