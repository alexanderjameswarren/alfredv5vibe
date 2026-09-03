// describeDbError — does the message name the right LAYER?
//
//   node --test supabase/functions/_shared/platform-errors.test.mjs
//
// ===========================================================================
// 🛑 WHY THIS FILE EXISTS
// ===========================================================================
// "platform_check_call_budget failed: JWT expired" was true, and it sent two
// weeks of debugging to the connector layer. It names a TOOL, so it reads as a
// problem with the budget check; it says JWT EXPIRED, so it reads as "reconnect".
// The fault was in neither place.
//
// A diagnostic is a product with a failure mode of its own, and this one had it:
// §11.20 — a diagnostic that points at a cause it has not established is worse
// than no diagnostic. So the message is tested like any other output.
// ===========================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "platform-errors-"));

// platform.ts imports the Supabase client and std/crypto from jsr:. Neither is
// reachable here and neither is needed: describeDbError is a pure function.
// Strip the imports and the module loads under plain Node.
let src = readFileSync(join(HERE, "platform.ts"), "utf-8")
  .replace(/^import .*$/gm, "")
  .replace(/^import type .*$/gm, "");
if (/^import /m.test(src)) {
  throw new Error("an import survived the strip — update this test");
}
writeFileSync(join(dir, "probe.ts"), src);
const { describeDbError } = await import(pathToFileURL(join(dir, "probe.ts")).href);

const AUTH = { code: "PGRST301", message: "JWT expired" };

test("an auth failure says WHICH HOP failed, not which tool", () => {
  const msg = describeDbError("platform_check_call_budget", AUTH);
  assert.match(msg, /AUTH FAILED AT THE DATABASE HOP/);
  // ⚠️ THE OLD MESSAGE LED WITH THE TOOL NAME AND THAT IS THE WHOLE DEFECT.
  // The tool is where the failure was NOTICED, not where it happened.
  assert.ok(
    !/^platform_check_call_budget failed/.test(msg),
    "must not lead with the tool name — it reads as a fault in the budget check",
  );
});

test("it rules out the two layers that were repeatedly 'fixed'", () => {
  const msg = describeDbError("platform_check_call_budget", AUTH);
  // The function has no credentials of its own to be wrong.
  assert.match(msg, /NOT A PROBLEM WITH THIS FUNCTION'S OWN CREDENTIALS/);
  assert.match(msg, /never mints, caches or refreshes/);
  // And the request demonstrably arrived, so the bearer was present.
  assert.match(msg, /The request reached\s+here/);
});

test("🛑 IT POINTS AT THE REFRESH, WHICH IS THE INFERENCE THAT WAS MISSING", () => {
  // An expired token ARRIVING is a statement about the client's refresh: a
  // healthy client refreshes before expiry. That sentence is what turns a
  // symptom into a place to look.
  const msg = describeDbError("platform_check_call_budget", AUTH);
  assert.match(msg, /REFRESH IS FAILING/);
  assert.match(msg, /POST \/auth\/v1\/oauth\/token/);
  assert.match(msg, /refresh_token/);
});

test("it predicts the symptom that made this look like a connector problem", () => {
  // "Reconnect, works for minutes, stops" is the diagnosis rather than a
  // coincidence — and saying so is what stops the seventh reconnect.
  const msg = describeDbError("platform_check_call_budget", AUTH);
  assert.match(msg, /ONE ACCESS-TOKEN LIFETIME/);
});

test("it does NOT claim to have seen the refresh fail", () => {
  // §11.20. The Edge Function cannot observe the token endpoint. It reports
  // what it saw — a forwarded token refused — and names where to look. A
  // message asserting "your refresh token was revoked" would be inventing a
  // cause from one symptom, which is the failure this replaces.
  const msg = describeDbError("platform_check_call_budget", AUTH);
  assert.ok(!/revoked/i.test(msg), "must not assert a cause it cannot see");
  assert.ok(!/rotation/i.test(msg), "must not assert a cause it cannot see");
});

test("an ORDINARY database error is left alone and stays retryable", () => {
  // NEGATIVE CONTROL. If every error got the auth essay, the essay would fire
  // on the normal case and be skipped exactly like any other over-firing
  // signal (§11.7) — and a genuine SQL fault would be buried under it.
  const msg = describeDbError("dj_tag_coverage", {
    code: "42883",
    message: "function public.dj_tag_coverage(text, integer) does not exist",
  });
  assert.match(msg, /^dj_tag_coverage failed:/);
  assert.match(msg, /does not exist/);
  assert.ok(!/AUTH FAILED/.test(msg));
  // Operational and legitimately retryable once the migration lands, so it must
  // carry no do-not-retry wording (platform error contract).
  assert.ok(!/[Dd]o NOT retry/.test(msg));
});

test("auth is recognised by CODE or by message, since PostgREST varies", () => {
  for (const e of [
    { code: "PGRST301", message: "JWT expired" },
    { code: undefined, message: "JWSError JWSInvalidSignature" },
    { code: "42501", message: "permission denied for table dj_plays" },
    { code: undefined, message: "Unauthorized" },
  ]) {
    assert.match(
      describeDbError("some_rpc", e), /AUTH FAILED AT THE DATABASE HOP/,
      `not classified as auth: ${JSON.stringify(e)}`,
    );
  }
});

test("the code and details survive, because the raw error is still evidence", () => {
  const msg = describeDbError("some_rpc", AUTH);
  assert.match(msg, /JWT expired/);
  assert.match(msg, /PGRST301/);
});
